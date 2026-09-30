const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// An idle client can lose its connection (for example when Neon suspends); log it instead of
// letting the unhandled 'error' event stop the process. The pool replaces the client.
pool.on('error', (err) => {
  console.error(`PostgreSQL pool error: ${err.message}`);
});

module.exports = pool;
