// Central repository for every discussion: questions, answers and team notes.
//
// Uses Postgres when DATABASE_URL is set (hosted deployment), otherwise a
// single JSON file under ./data (local use). Both keep the same shape:
//
//   conversation: { id, title, createdBy, createdAt, updatedAt, api, items }
//     api   - the exact Claude API transcript, sent back for follow-ups
//     items - what people see: { id, kind: question|answer|note, author, text, sources, createdAt }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USE_DB = !!process.env.DATABASE_URL;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'askca.json');

const newId = () => crypto.randomBytes(8).toString('hex');
const now = () => new Date().toISOString();

// ---------------- Postgres ----------------
let pool = null;
function db() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
    });
  }
  return pool;
}

async function ensureSchema() {
  if (!USE_DB) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    return;
  }
  await db().query(`
    CREATE TABLE IF NOT EXISTS askca_conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      api JSONB NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE TABLE IF NOT EXISTS askca_items (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES askca_conversations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      sources JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS askca_items_conv ON askca_items (conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS askca_clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      profile JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS askca_client_items (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES askca_clients(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS askca_client_items_client ON askca_client_items (client_id, created_at);
    ALTER TABLE askca_conversations ADD COLUMN IF NOT EXISTS client_id TEXT REFERENCES askca_clients(id) ON DELETE SET NULL;
  `);
}

const rowToItem = (r) => ({
  id: r.id, conversationId: r.conversation_id, kind: r.kind, author: r.author,
  text: r.text, sources: r.sources || [], createdAt: new Date(r.created_at).toISOString()
});
const rowToConv = (r) => ({
  id: r.id, title: r.title, createdBy: r.created_by, clientId: r.client_id || null,
  createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString()
});

// ---------------- JSON file ----------------
// One process serves the app, so a read-modify-write under a promise chain
// keeps writes ordered; the rename makes each write atomic on disk.
let fileCache = null;
let writeChain = Promise.resolve();

function readFile() {
  if (!fileCache) {
    try { fileCache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch (e) { fileCache = { conversations: [] }; }
    if (!Array.isArray(fileCache.clients)) fileCache.clients = [];
  }
  return fileCache;
}

function mutateFile(fn) {
  const run = writeChain.then(() => {
    const data = readFile();
    const result = fn(data);
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, DATA_FILE);
    return result;
  });
  writeChain = run.catch(() => {});
  return run;
}

const summarize = (c) => ({ id: c.id, title: c.title, createdBy: c.createdBy, clientId: c.clientId || null, createdAt: c.createdAt, updatedAt: c.updatedAt });

// ---------------- API ----------------

async function listConversations() {
  if (USE_DB) {
    const res = await db().query(`
      SELECT c.*, COUNT(i.id) FILTER (WHERE i.kind = 'question') AS questions,
             COUNT(i.id) FILTER (WHERE i.kind = 'note') AS notes
      FROM askca_conversations c LEFT JOIN askca_items i ON i.conversation_id = c.id
      GROUP BY c.id ORDER BY c.updated_at DESC`);
    return res.rows.map((r) => ({ ...rowToConv(r), questions: Number(r.questions), notes: Number(r.notes) }));
  }
  return readFile().conversations
    .map((c) => ({
      ...summarize(c),
      questions: c.items.filter((i) => i.kind === 'question').length,
      notes: c.items.filter((i) => i.kind === 'note').length
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

async function getConversation(id) {
  if (USE_DB) {
    const c = await db().query('SELECT * FROM askca_conversations WHERE id = $1', [id]);
    if (!c.rows.length) return null;
    const items = await db().query('SELECT * FROM askca_items WHERE conversation_id = $1 ORDER BY created_at, id', [id]);
    return { ...rowToConv(c.rows[0]), api: c.rows[0].api, items: items.rows.map(rowToItem) };
  }
  const c = readFile().conversations.find((x) => x.id === id);
  return c ? JSON.parse(JSON.stringify(c)) : null;
}

async function createConversation({ title, createdBy, clientId = null }) {
  const conv = { id: newId(), title, createdBy, clientId, createdAt: now(), updatedAt: now(), api: [], items: [] };
  if (USE_DB) {
    await db().query(
      'INSERT INTO askca_conversations (id, title, created_by, client_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)',
      [conv.id, title, createdBy, clientId, conv.createdAt]
    );
    return conv;
  }
  await mutateFile((data) => data.conversations.push(conv));
  return JSON.parse(JSON.stringify(conv));
}

// Saves one finished question + answer together with the updated transcript,
// so a failed answer never leaves half an exchange behind.
async function saveExchange(id, { author, question, answer, sources, api }) {
  const t1 = now();
  const t2 = new Date(Date.parse(t1) + 1).toISOString();
  const items = [
    { id: newId(), kind: 'question', author, text: question, sources: [], createdAt: t1 },
    { id: newId(), kind: 'answer', author: 'Ask your CA', text: answer, sources, createdAt: t2 }
  ];
  if (USE_DB) {
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      for (const it of items) {
        await client.query(
          'INSERT INTO askca_items (id, conversation_id, kind, author, text, sources, created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)',
          [it.id, id, it.kind, it.author, it.text, JSON.stringify(it.sources), it.createdAt]
        );
      }
      await client.query('UPDATE askca_conversations SET api = $2::jsonb, updated_at = $3 WHERE id = $1', [id, JSON.stringify(api), t2]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return items;
  }
  await mutateFile((data) => {
    const c = data.conversations.find((x) => x.id === id);
    if (!c) throw new Error('Conversation not found');
    c.items.push(...items);
    c.api = api;
    c.updatedAt = t2;
  });
  return items;
}

async function addNote(id, { author, text }) {
  const item = { id: newId(), kind: 'note', author, text, sources: [], createdAt: now() };
  if (USE_DB) {
    const r = await db().query('UPDATE askca_conversations SET updated_at = $2 WHERE id = $1', [id, item.createdAt]);
    if (!r.rowCount) return null;
    await db().query(
      'INSERT INTO askca_items (id, conversation_id, kind, author, text, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [item.id, id, 'note', author, text, item.createdAt]
    );
    return item;
  }
  return mutateFile((data) => {
    const c = data.conversations.find((x) => x.id === id);
    if (!c) return null;
    c.items.push(item);
    c.updatedAt = item.createdAt;
    return item;
  });
}

async function renameConversation(id, title) {
  if (USE_DB) {
    const r = await db().query('UPDATE askca_conversations SET title = $2 WHERE id = $1', [id, title]);
    return r.rowCount > 0;
  }
  return mutateFile((data) => {
    const c = data.conversations.find((x) => x.id === id);
    if (c) c.title = title;
    return !!c;
  });
}

async function setConversationClient(id, clientId) {
  if (USE_DB) {
    const r = await db().query('UPDATE askca_conversations SET client_id = $2 WHERE id = $1', [id, clientId]);
    return r.rowCount > 0;
  }
  return mutateFile((data) => {
    const c = data.conversations.find((x) => x.id === id);
    if (c) c.clientId = clientId;
    return !!c;
  });
}

async function deleteConversation(id) {
  if (USE_DB) {
    const r = await db().query('DELETE FROM askca_conversations WHERE id = $1', [id]);
    return r.rowCount > 0;
  }
  return mutateFile((data) => {
    const before = data.conversations.length;
    data.conversations = data.conversations.filter((x) => x.id !== id);
    return data.conversations.length < before;
  });
}

// Every item with its conversation title, for the knowledge-base search.
async function allItems() {
  if (USE_DB) {
    const res = await db().query(`
      SELECT i.*, c.title FROM askca_items i JOIN askca_conversations c ON c.id = i.conversation_id
      ORDER BY i.conversation_id, i.created_at, i.id`);
    return res.rows.map((r) => ({ ...rowToItem(r), title: r.title }));
  }
  const out = [];
  for (const c of readFile().conversations) {
    for (const i of c.items) out.push({ ...i, conversationId: c.id, title: c.title });
  }
  return out;
}

module.exports = {
  usingDatabase: USE_DB, ensureSchema, listConversations, getConversation, createConversation,
  saveExchange, addNote, renameConversation, setConversationClient, deleteConversation, allItems,
  // shared with clients.js
  _internal: { db, readFile, mutateFile, newId, now }
};
