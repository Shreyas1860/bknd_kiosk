// Use CommonJS require to avoid needing @types/pg
const pg = require('pg');
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is not set');
}

const Pool = pg.Pool as any;
const pool = new Pool({ connectionString });

export { pool };