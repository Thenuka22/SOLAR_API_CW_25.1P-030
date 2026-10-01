const pool = require('../config/db');

// Runs work(client) in one transaction on one connection: committed when it resolves, rolled
// back when it throws. Use it when a check and the change it guards must see the same data,
// such as a write precondition and the update.
async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
