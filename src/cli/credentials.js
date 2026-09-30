// Operator command for credentials. See docs/authentication.md#operator-command.
//
//   npm run credentials -- staff-password <email>
//   npm run credentials -- provisioner-password <username>
//   npm run credentials -- device-secret <meter-id>
//
// Passwords are never taken from arguments: they are typed at a hidden prompt (twice), or read
// from the first line of standard input when it is not a terminal. A generated device secret is
// written once to standard output; every other message goes to standard error. Secrets and
// hashes are never logged.
require('dotenv').config({ quiet: true });

const { Client } = require('pg');
const { hashSecret, generateDeviceSecret } = require('../auth/credentialHash');

const MIN_PASSWORD_LENGTH = 15;
const MAX_PASSWORD_LENGTH = 128;

const USAGE = `Usage:
  npm run credentials -- staff-password <email>
  npm run credentials -- provisioner-password <username>
  npm run credentials -- device-secret <meter-id>`;

const say = (message) => process.stderr.write(`${message}\n`);

// Read a line from the terminal without echoing it.
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin } = process;
    let value = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (ch === '\u0003' || ch === '\u0004') {
          cleanup();
          reject(new Error('Cancelled.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = Array.from(value).slice(0, -1).join('');
        } else if (ch >= ' ') {
          value += ch;
        }
      }
    };
    process.stderr.write(question);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function readFirstLine() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input.split(/\r?\n/, 1)[0];
}

async function readNewPassword() {
  let password;
  if (process.stdin.isTTY) {
    password = await promptHidden('New password: ');
    const repeated = await promptHidden('Repeat password: ');
    if (password !== repeated) throw new Error('The passwords do not match.');
  } else {
    password = await readFirstLine();
  }
  const length = Array.from(password.normalize('NFC')).length;
  if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
    throw new Error(`The password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters long.`);
  }
  return password;
}

async function setStaffPassword(db, email) {
  const user = (await db.query(
    'SELECT id, name FROM users WHERE lower(email) = lower(btrim($1))',
    [email],
  )).rows[0];
  if (!user) throw new Error(`No staff user has the email ${email}.`);

  const hash = await hashSecret(await readNewPassword());
  const existed = (await db.query('SELECT 1 FROM user_credentials WHERE user_id = $1', [user.id])).rowCount > 0;
  await db.query(
    `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [user.id, hash],
  );
  say(`${existed ? 'Changed' : 'Set'} the password for staff user ${user.name} (${user.id}).`);
  if (existed) say('Tokens issued with the old password no longer work.');
}

async function setProvisionerPassword(db, username) {
  if (username.trim() === '') throw new Error('The username must not be blank.');
  const existing = (await db.query(
    'SELECT id FROM provisioners WHERE lower(btrim(username)) = lower(btrim($1))',
    [username],
  )).rows[0];

  const hash = await hashSecret(await readNewPassword());
  if (existing) {
    await db.query('UPDATE provisioners SET password_hash = $2 WHERE id = $1', [existing.id, hash]);
    say(`Changed the password for provisioner ${username} (${existing.id}).`);
    say('Tokens issued with the old password no longer work.');
  } else {
    const created = (await db.query(
      'INSERT INTO provisioners (username, password_hash) VALUES (btrim($1), $2) RETURNING id',
      [username, hash],
    )).rows[0];
    say(`Created provisioner ${username.trim()} (${created.id}).`);
  }
}

// Returns the new secret; the caller prints it only after it has been stored.
async function rotateDeviceSecret(db, meterId) {
  const installation = (await db.query(
    'SELECT id, meter_id FROM solar_installations WHERE lower(btrim(meter_id)) = lower(btrim($1))',
    [meterId],
  )).rows[0];
  if (!installation) throw new Error(`No installation has the meter ID ${meterId}.`);

  const secret = generateDeviceSecret();
  const hash = await hashSecret(secret);
  const existed = (await db.query('SELECT 1 FROM device_credentials WHERE installation_id = $1', [installation.id])).rowCount > 0;
  await db.query(
    `INSERT INTO device_credentials (installation_id, secret_hash) VALUES ($1, $2)
     ON CONFLICT (installation_id) DO UPDATE SET secret_hash = EXCLUDED.secret_hash`,
    [installation.id, hash],
  );
  return { secret, installation, existed };
}

async function main() {
  const [action, target, ...extra] = process.argv.slice(2);
  const actions = ['staff-password', 'provisioner-password', 'device-secret'];
  if (!actions.includes(action) || !target) throw new Error(USAGE);
  if (extra.length > 0) {
    throw new Error(`Unexpected extra arguments. Passwords are never passed as arguments; you will be asked for them.\n${USAGE}`);
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Add it to .env or the environment first.');
  }

  // Each action looks up its target, reads any password, and then stores the hash in a single
  // statement, so no transaction stays open while someone is typing.
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    let device;
    if (action === 'staff-password') await setStaffPassword(db, target);
    if (action === 'provisioner-password') await setProvisionerPassword(db, target);
    if (action === 'device-secret') device = await rotateDeviceSecret(db, target);

    if (device) {
      const { secret, installation, existed } = device;
      say(`${existed ? 'Rotated' : 'Created'} the device secret for ${installation.meter_id} (${installation.id}).`);
      if (existed) say('The old secret and tokens issued with it no longer work.');
      say('Store this secret on the device now. It is shown only once and cannot be recovered:');
      process.stdout.write(`${secret}\n`);
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  say(`Credentials error: ${err.message}`);
  process.exitCode = 1;
});
