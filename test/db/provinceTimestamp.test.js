require('dotenv').config({ quiet: true });

const { randomUUID } = require('node:crypto');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

describe('province modification time', { skip }, () => {
  test('every real change gets a later HTTP-date second; direct timestamp writes do not', async () => {
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      await db.query('BEGIN');
      const name = `Timestamp Test ${randomUUID()}`;
      const created = (await db.query(
        'INSERT INTO provinces (name) VALUES ($1) RETURNING id, updated_at', [name],
      )).rows[0];
      const renamed = (await db.query(
        'UPDATE provinces SET name = $2 WHERE id = $1 RETURNING updated_at', [created.id, `${name} A`],
      )).rows[0];
      const renamedAgain = (await db.query(
        'UPDATE provinces SET name = $2 WHERE id = $1 RETURNING updated_at', [created.id, `${name} B`],
      )).rows[0];
      assert.ok(Math.floor(renamed.updated_at.getTime() / 1000)
        > Math.floor(created.updated_at.getTime() / 1000));
      assert.ok(Math.floor(renamedAgain.updated_at.getTime() / 1000)
        > Math.floor(renamed.updated_at.getTime() / 1000));

      const forged = (await db.query(
        "UPDATE provinces SET updated_at = '2000-01-01Z' WHERE id = $1 RETURNING updated_at",
        [created.id],
      )).rows[0];
      assert.equal(forged.updated_at.getTime(), renamedAgain.updated_at.getTime());
    } finally {
      await db.query('ROLLBACK');
      await db.end();
    }
  });
});
