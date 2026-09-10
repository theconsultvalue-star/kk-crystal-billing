// Optional Postgres-backed persistence. Only used when DATABASE_URL is set
// (i.e. the hosted deployment) — local usage keeps working off plain JSON
// files with no database involved at all.
const { Pool } = require('pg');

let pool = null;

function isEnabled() {
  return !!process.env.DATABASE_URL;
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
  }
  return pool;
}

async function ensureSchema() {
  if (!isEnabled()) return;
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS invoice_pdfs (
      filename TEXT PRIMARY KEY,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

async function getDoc(key, fallback) {
  const res = await getPool().query('SELECT value FROM kv_store WHERE key = $1', [key]);
  return res.rows.length ? res.rows[0].value : fallback;
}

async function setDoc(key, value) {
  await getPool().query(
    'INSERT INTO kv_store (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = $2::jsonb',
    [key, JSON.stringify(value)]
  );
}

async function savePdf(filename, buffer) {
  await getPool().query(
    'INSERT INTO invoice_pdfs (filename, data) VALUES ($1, $2) ON CONFLICT (filename) DO UPDATE SET data = $2',
    [filename, buffer]
  );
}

async function getPdf(filename) {
  const res = await getPool().query('SELECT data FROM invoice_pdfs WHERE filename = $1', [filename]);
  return res.rows.length ? res.rows[0].data : null;
}

async function deletePdf(filename) {
  await getPool().query('DELETE FROM invoice_pdfs WHERE filename = $1', [filename]);
}

module.exports = { isEnabled, ensureSchema, getDoc, setDoc, savePdf, getPdf, deletePdf };
