const { Pool } = require('pg');

// Railway provides DATABASE_URL automatically when PostgreSQL plugin is added
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

async function initDB() {
  if (!pool) {
    console.log('No DATABASE_URL set — running without database (localStorage only)');
    return false;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quotes (
        id          TEXT PRIMARY KEY,
        data        JSONB NOT NULL,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_quotes_updated ON quotes(updated_at)
    `);
    console.log('Database connected and quotes table ready');
    return true;
  } catch (err) {
    console.error('Database init failed:', err.message);
    return false;
  }
}

module.exports = { pool, initDB };
