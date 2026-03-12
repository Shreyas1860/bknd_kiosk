// Use CommonJS require to avoid needing @types/pg
const pg = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is not set');
}

const Pool = pg.Pool as any;

// Increased pool size to handle multiple simultaneous kiosks
// 7 kiosks × ~2 concurrent queries each = need headroom above 14
const pool = new Pool({
  connectionString,
  max: 20,                    // max concurrent DB connections
  idleTimeoutMillis: 30000,   // close idle connections after 30s
  connectionTimeoutMillis: 2000, // fail fast if no connection available in 2s
});

pool.on('error', (err: any) => {
  console.error('[db] Unexpected pool error:', err);
});

export { pool };