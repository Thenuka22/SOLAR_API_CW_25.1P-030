// Database tests for the credential tables (migration 007). They run against DATABASE_URL
// inside one transaction that is rolled back, so they leave no data behind. Without
// DATABASE_URL they are skipped. Run `npm run db:migrate` and `npm run db:seed` first.
require('dotenv').config({ quiet: true });

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { hashSecret, verifySecret } = require('../../src/auth/credentialHash');

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

describe('credential tables', { skip }, () => {
  let db;
  let hash;
  let userId;
  let freeInstallationId; // no readings, so it can be deleted
  let seededInstallationId; // has readings

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  // Run a statement that must fail; the savepoint keeps the transaction usable.
  async function rejects(sql, params, pattern) {
    await db.query('SAVEPOINT expect_error');
    try {
      await db.query(sql, params);
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT expect_error');
      assert.match(err.message, pattern);
      return;
    }
    await db.query('ROLLBACK TO SAVEPOINT expect_error');
    assert.fail(`Expected the statement to be rejected: ${sql}`);
  }

  before(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await db.query('BEGIN');
    hash = await hashSecret('correct horse battery staple');

    userId = (await one(
      "INSERT INTO users (name, email, role) VALUES ('Test Reader', 'credential-test@example.test', 'national') RETURNING id",
    )).id;
    freeInstallationId = (await one(
      "INSERT INTO solar_installations (substation_id, meter_id, capacity_kw) SELECT id, 'CRED-TEST-01', 5 FROM grid_substations LIMIT 1 RETURNING id",
    )).id;
    const seeded = await one(
      'SELECT installation_id AS id FROM generation_readings LIMIT 1',
    );
    assert.ok(seeded, 'the reading seed must be loaded');
    seededInstallationId = seeded.id;
  });

  after(async () => {
    await db.query('ROLLBACK');
    await db.end();
  });

  beforeEach(() => db.query('SAVEPOINT test_case'));
  afterEach(() => db.query('ROLLBACK TO SAVEPOINT test_case'));

  test('the tables have hash columns and no plaintext secret columns', async () => {
    const { rows } = await db.query(`
      SELECT table_name, column_name, domain_name
      FROM information_schema.columns
      WHERE table_name IN ('user_credentials', 'device_credentials', 'provisioners')
      ORDER BY table_name, ordinal_position`);
    const columns = rows.map((r) => `${r.table_name}.${r.column_name}`);
    assert.deepEqual(columns, [
      'device_credentials.installation_id',
      'device_credentials.secret_hash',
      'device_credentials.changed_at',
      'device_credentials.credential_version',
      'provisioners.id',
      'provisioners.username',
      'provisioners.password_hash',
      'provisioners.changed_at',
      'provisioners.credential_version',
      'user_credentials.user_id',
      'user_credentials.password_hash',
      'user_credentials.changed_at',
      'user_credentials.credential_version',
    ]);
    for (const r of rows.filter((row) => row.column_name.endsWith('_hash'))) {
      assert.equal(r.domain_name, 'scrypt_hash', `${r.table_name}.${r.column_name}`);
    }
  });

  test('a scrypt hash is stored in each table and verifies after reading it back', async () => {
    await db.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [userId, hash]);
    await db.query('INSERT INTO device_credentials (installation_id, secret_hash) VALUES ($1, $2)', [freeInstallationId, hash]);
    await db.query("INSERT INTO provisioners (username, password_hash) VALUES ('provisioner', $1)", [hash]);

    const stored = await one('SELECT password_hash FROM user_credentials WHERE user_id = $1', [userId]);
    assert.equal(await verifySecret('correct horse battery staple', stored.password_hash), true);
    assert.equal(await verifySecret('wrong password value', stored.password_hash), false);
  });

  for (const [label, value] of [
    ['a plaintext password', 'correct horse battery staple'],
    ['an empty string', ''],
    ['a hash with a short salt and key', '$scrypt$ln=15,r=8,p=3$c2FsdA$aGFzaA'],
    ['another algorithm', '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'],
    ['a hash with trailing text', `${'$scrypt$ln=15,r=8,p=3$'}${'A'.repeat(22)}$${'B'.repeat(43)} plaintext`],
  ]) {
    test(`${label} is rejected in every hash column`, async () => {
      await rejects('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [userId, value], /scrypt_hash_format/);
      await rejects('INSERT INTO device_credentials (installation_id, secret_hash) VALUES ($1, $2)', [freeInstallationId, value], /scrypt_hash_format/);
      await rejects("INSERT INTO provisioners (username, password_hash) VALUES ('provisioner', $1)", [value], /scrypt_hash_format/);
    });
  }

  test('a hash cannot be replaced by plaintext', async () => {
    await db.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [userId, hash]);
    await rejects("UPDATE user_credentials SET password_hash = 'new plaintext password' WHERE user_id = $1", [userId], /scrypt_hash_format/);
  });

  test('null hashes are rejected', async () => {
    await rejects('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, NULL)', [userId], /null value/);
    await rejects('INSERT INTO device_credentials (installation_id, secret_hash) VALUES ($1, NULL)', [freeInstallationId], /null value/);
    await rejects("INSERT INTO provisioners (username, password_hash) VALUES ('provisioner', NULL)", [], /null value/);
  });

  test('credentials must belong to an existing user or installation', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    await rejects('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [missing, hash], /foreign key/);
    await rejects('INSERT INTO device_credentials (installation_id, secret_hash) VALUES ($1, $2)', [missing, hash], /foreign key/);
  });

  test('each user and installation has at most one credential', async () => {
    await db.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [userId, hash]);
    await db.query('INSERT INTO device_credentials (installation_id, secret_hash) VALUES ($1, $2)', [freeInstallationId, hash]);
    await rejects('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [userId, hash], /user_credentials_pkey/);
    await rejects('INSERT INTO device_credentials (installation_id, secret_hash) VALUES ($1, $2)', [freeInstallationId, hash], /device_credentials_pkey/);
  });

  test('provisioner usernames are required and unique ignoring case and spaces', async () => {
    await db.query("INSERT INTO provisioners (username, password_hash) VALUES ('Admin', $1)", [hash]);
    await rejects("INSERT INTO provisioners (username, password_hash) VALUES ('admin', $1)", [hash], /provisioners_username_normalized_key/);
    await rejects("INSERT INTO provisioners (username, password_hash) VALUES ('  ADMIN ', $1)", [hash], /provisioners_username_normalized_key/);
    await rejects("INSERT INTO provisioners (username, password_hash) VALUES ('   ', $1)", [hash], /provisioners_username_not_blank/);
    await rejects('INSERT INTO provisioners (username, password_hash) VALUES (NULL, $1)', [hash], /null value/);
  });

  test('changed_at is set by the database on insert', async () => {
    const row = await one(
      "INSERT INTO provisioners (username, password_hash, changed_at) VALUES ('provisioner', $1, '2000-01-01Z') RETURNING changed_at",
      [hash],
    );
    assert.ok(row.changed_at > new Date('2026-01-01Z'), `changed_at was ${row.changed_at.toISOString()}`);
  });

  test('changed_at moves forward when the hash changes and only then', async () => {
    const created = await one(
      "INSERT INTO provisioners (username, password_hash) VALUES ('provisioner', $1) RETURNING id, changed_at",
      [hash],
    );

    const renamed = await one(
      "UPDATE provisioners SET username = 'renamed' WHERE id = $1 RETURNING changed_at",
      [created.id],
    );
    assert.equal(renamed.changed_at.getTime(), created.changed_at.getTime(), 'a username change keeps changed_at');

    const forced = await one(
      "UPDATE provisioners SET changed_at = '2000-01-01Z' WHERE id = $1 RETURNING changed_at",
      [created.id],
    );
    assert.equal(forced.changed_at.getTime(), created.changed_at.getTime(), 'changed_at cannot be written directly');

    const rehashed = await one(
      'UPDATE provisioners SET password_hash = $2 WHERE id = $1 RETURNING changed_at',
      [created.id, await hashSecret('a new provisioner password')],
    );
    assert.ok(rehashed.changed_at > created.changed_at, 'a new hash advances changed_at');
  });

  test('changed_at also tracks user and device hash changes', async () => {
    const user = await one('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2) RETURNING changed_at', [userId, hash]);
    const device = await one('INSERT INTO device_credentials (installation_id, secret_hash) VALUES ($1, $2) RETURNING changed_at', [freeInstallationId, hash]);
    const newHash = await hashSecret('rotated secret value');
    const user2 = await one('UPDATE user_credentials SET password_hash = $2 WHERE user_id = $1 RETURNING changed_at', [userId, newHash]);
    const device2 = await one('UPDATE device_credentials SET secret_hash = $2 WHERE installation_id = $1 RETURNING changed_at', [freeInstallationId, newHash]);
    assert.ok(user2.changed_at > user.changed_at);
    assert.ok(device2.changed_at > device.changed_at);
  });

  test('credential versions change on rotation and cannot be set directly', async () => {
    const created = await one(
      "INSERT INTO provisioners (username, password_hash) VALUES ('version-test', $1) RETURNING id, credential_version",
      [hash],
    );
    const unchanged = await one(
      'UPDATE provisioners SET username = $2, credential_version = gen_random_uuid() WHERE id = $1 RETURNING credential_version',
      [created.id, 'version-test-renamed'],
    );
    assert.equal(unchanged.credential_version, created.credential_version);

    const rotated = await one(
      'UPDATE provisioners SET password_hash = $2 WHERE id = $1 RETURNING credential_version',
      [created.id, await hashSecret('another long provisioner password')],
    );
    assert.notEqual(rotated.credential_version, created.credential_version);

    const rotatedAgain = await one(
      'UPDATE provisioners SET password_hash = $2 WHERE id = $1 RETURNING credential_version',
      [created.id, await hashSecret('yet another long password')],
    );
    assert.notEqual(rotatedAgain.credential_version, rotated.credential_version);
  });

  test('deleting a user or an installation without readings deletes its credential', async () => {
    await db.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [userId, hash]);
    await db.query('INSERT INTO device_credentials (installation_id, secret_hash) VALUES ($1, $2)', [freeInstallationId, hash]);
    await db.query('DELETE FROM users WHERE id = $1', [userId]);
    await db.query('DELETE FROM solar_installations WHERE id = $1', [freeInstallationId]);
    const left = await one(
      'SELECT (SELECT count(*) FROM user_credentials WHERE user_id = $1)::int AS users, (SELECT count(*) FROM device_credentials WHERE installation_id = $2)::int AS devices',
      [userId, freeInstallationId],
    );
    assert.deepEqual(left, { users: 0, devices: 0 });
  });

  test('an installation with readings cannot be deleted, so its credential stays', async () => {
    await db.query('INSERT INTO device_credentials (installation_id, secret_hash) VALUES ($1, $2)', [seededInstallationId, hash]);
    await rejects('DELETE FROM solar_installations WHERE id = $1', [seededInstallationId], /generation_readings_installation_id_fkey/);
    const left = await one('SELECT count(*)::int AS n FROM device_credentials WHERE installation_id = $1', [seededInstallationId]);
    assert.equal(left.n, 1);
  });
});
