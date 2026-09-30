require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const SEEDS_DIR = path.join(__dirname, 'seeds');
const SEED_FILE = /^(\d+)_[\w-]+\.sql$/;
// Different from the migration lock so seeding and migrating do not share a key.
const LOCK_KEY = 6008;

// Seed files are written to be repeatable, so every file runs on every call and
// nothing is recorded. Each file runs in its own transaction.
async function seed() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Add it to .env or the environment before seeding.');
  }

  const files = fs
    .readdirSync(SEEDS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => {
      const match = SEED_FILE.exec(file);
      if (!match) throw new Error(`Invalid seed file name "${file}". Use NNN_description.sql.`);
      return { name: file, number: Number(match[1]) };
    })
    .sort((a, b) => a.number - b.number);

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(SEEDS_DIR, file.name), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
        await client.query(sql);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Seed ${file.name} failed: ${err.message}`);
      }
      console.log(`Ran ${file.name}`);
    }
    console.log(`Ran ${files.length} seed file(s).`);
  } finally {
    await client.end();
  }
}

seed().catch((err) => {
  console.error(`Seed error: ${err.message}`);
  process.exitCode = 1;
});
