require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATION_FILE = /^(\d+)_[\w-]+\.sql$/;
// Arbitrary constant so only one migration run can hold the lock at a time.
const LOCK_KEY = 6007;

function listMigrations() {
  let files;
  try {
    files = fs.readdirSync(MIGRATIONS_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const migrations = files
    .filter((file) => file.endsWith('.sql'))
    .map((file) => {
      const match = MIGRATION_FILE.exec(file);
      if (!match) {
        throw new Error(`Invalid migration file name "${file}". Use NNN_description.sql.`);
      }
      return { name: file, number: Number(match[1]) };
    })
    .sort((a, b) => a.number - b.number);

  for (let i = 1; i < migrations.length; i += 1) {
    if (migrations[i].number === migrations[i - 1].number) {
      throw new Error(
        `Duplicate migration number in "${migrations[i - 1].name}" and "${migrations[i].name}".`
      );
    }
  }

  return migrations;
}

// Runs work in a transaction holding a transaction-level advisory lock. The lock is
// released on COMMIT/ROLLBACK, so it is also safe through a transaction-mode pooler.
async function inLockedTransaction(client, work) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function migrate() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Add it to .env or the environment before running migrations.');
  }

  const migrations = listMigrations();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await inLockedTransaction(client, () =>
      client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `)
    );

    let appliedCount = 0;

    for (const migration of migrations) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, migration.name), 'utf8');

      // Each file and its record commit together, so a failed file leaves no partial changes.
      // The applied check runs under the lock so concurrent runs cannot apply a file twice.
      const applied = await inLockedTransaction(client, async () => {
        const { rowCount } = await client.query(
          'SELECT 1 FROM schema_migrations WHERE name = $1',
          [migration.name]
        );
        if (rowCount > 0) return false;

        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration.name]);
        return true;
      }).catch((err) => {
        throw new Error(`Migration ${migration.name} failed: ${err.message}`);
      });

      if (applied) {
        appliedCount += 1;
        console.log(`Applied ${migration.name}`);
      }
    }

    console.log(appliedCount === 0 ? 'No pending migrations.' : `Applied ${appliedCount} migration(s).`);
  } finally {
    await client.end();
  }
}

migrate().catch((err) => {
  console.error(`Migration error: ${err.message}`);
  process.exitCode = 1;
});
