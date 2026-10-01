require('dotenv').config({ quiet: true });

const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const app = require('../../src/app');
const pool = require('../../src/config/db');
const { hashSecret, generateDeviceSecret } = require('../../src/auth/credentialHash');
const { issueToken } = require('../../src/auth/tokens');

const PASSWORD = 'a sufficiently long test password';
const TEST_JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-random-looking-bytes';

async function startApiFixture() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for API integration tests.');

  const oldJwtSecret = process.env.JWT_SECRET;
  const originalPoolQuery = pool.query;
  const originalPoolConnect = pool.connect;
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  let server;

  process.env.JWT_SECRET = TEST_JWT_SECRET;
  try {
    await db.connect();
    await db.query('BEGIN');

    const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
    const western = await one("SELECT id FROM provinces WHERE name = 'Western'");
    const southern = await one("SELECT id FROM provinces WHERE name = 'Southern'");
    const colombo = await one("SELECT id FROM districts WHERE name = 'Colombo' AND province_id = $1", [western?.id]);
    const substation = await one('SELECT id FROM grid_substations WHERE district_id = $1 LIMIT 1', [colombo?.id]);
    if (!western || !southern || !colombo || !substation) {
      throw new Error('Run npm run db:migrate and npm run db:seed before API integration tests.');
    }

    const suffix = randomUUID().slice(0, 8);
    const passwordHash = await hashSecret(PASSWORD);
    const staff = {};
    for (const [role, provinceId, districtId] of [
      ['national', null, null],
      ['provincial', western.id, null],
      ['district', null, colombo.id],
    ]) {
      const email = `${role}-${suffix}@example.test`;
      const user = await one(
        'INSERT INTO users (name, email, role, province_id, district_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [`Test ${role}`, email, role, provinceId, districtId],
      );
      const credential = await one(
        'INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2) RETURNING credential_version',
        [user.id, passwordHash],
      );
      staff[role] = { id: user.id, email, credentialVersion: credential.credential_version };
    }

    const meterId = `TEST-${suffix}`;
    const installation = await one(
      'INSERT INTO solar_installations (substation_id, meter_id, capacity_kw) VALUES ($1, $2, 5) RETURNING id',
      [substation.id, meterId],
    );
    const deviceSecret = generateDeviceSecret();
    const deviceCredential = await one(
      'INSERT INTO device_credentials (installation_id, secret_hash) VALUES ($1, $2) RETURNING credential_version',
      [installation.id, await hashSecret(deviceSecret)],
    );
    const device = { id: installation.id, meterId, deviceSecret, credentialVersion: deviceCredential.credential_version };

    const username = `provisioner-${suffix}`;
    const provisionerRow = await one(
      'INSERT INTO provisioners (username, password_hash) VALUES ($1, $2) RETURNING id, credential_version',
      [username, passwordHash],
    );
    const provisioner = { id: provisionerRow.id, username, credentialVersion: provisionerRow.credential_version };

    // The app and these fixtures share one transaction. Every HTTP write remains invisible to
    // other connections and is rolled back when the test file finishes. A transaction the app
    // opens with pool.connect() (src/db/transaction.js) becomes a savepoint inside it.
    pool.query = db.query.bind(db);
    const asSavepoint = { BEGIN: 'SAVEPOINT app_transaction', COMMIT: 'RELEASE SAVEPOINT app_transaction', ROLLBACK: 'ROLLBACK TO SAVEPOINT app_transaction' };
    pool.connect = async () => ({
      query: (text, params) => db.query(asSavepoint[text] ?? text, params),
      release() {},
    });
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });

    const url = `http://127.0.0.1:${server.address().port}`;
    const token = (type, principal) => issueToken({
      type,
      id: principal.id,
      credentialVersion: principal.credentialVersion,
    }).accessToken;
    return {
      db,
      url,
      staff,
      device,
      provisioner,
      westernId: western.id,
      southernId: southern.id,
      password: PASSWORD,
      jwtSecret: TEST_JWT_SECRET,
      token,
      async close() {
        await new Promise((resolve) => server.close(resolve));
        pool.query = originalPoolQuery;
        pool.connect = originalPoolConnect;
        try {
          await db.query('ROLLBACK');
        } finally {
          await db.end();
          if (oldJwtSecret === undefined) delete process.env.JWT_SECRET;
          else process.env.JWT_SECRET = oldJwtSecret;
        }
      },
    };
  } catch (err) {
    pool.query = originalPoolQuery;
    pool.connect = originalPoolConnect;
    if (server) await new Promise((resolve) => server.close(resolve));
    try {
      await db.query('ROLLBACK');
    } catch {
      // No transaction was open if connection or setup failed.
    }
    await db.end().catch(() => {});
    if (oldJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldJwtSecret;
    throw err;
  }
}

module.exports = { startApiFixture, PASSWORD };
