// Client records: one complete file per client that stays with the firm when
// people change. Each client has a profile (contacts, registrations, services,
// preferences…) and a dated history of notes added by the team or by the
// advisor on someone's request. Same storage as the rest of the app.

const store = require('./store');
const { tokenize } = require('./knowledge');

const { db, readFile, mutateFile, newId, now } = store._internal;
const USE_DB = store.usingDatabase;

const SERVICES = [
  'GST returns', 'Income tax return', 'Tax audit', 'Statutory audit', 'TDS / TCS returns',
  'Accounting / bookkeeping', 'ROC / MCA compliance', 'Payroll / PF / ESI', 'FEMA / RBI',
  'Project finance / CMA data', 'Advisory'
];
const ITEM_KINDS = ['note', 'preference', 'compliance', 'call', 'change'];

const TEXT_FIELDS = {
  entityType: 'Entity type', pan: 'PAN', gstin: 'GSTIN', tan: 'TAN', cin: 'CIN / LLPIN',
  address: 'Address', state: 'State', assignedTo: 'Handled by', since: 'Client since',
  preferences: 'Preferences', important: 'Always remember', billing: 'Fees & billing',
  portalIds: 'Portal user IDs (no passwords)'
};

const clip = (v, n) => String(v ?? '').trim().slice(0, n);

// Keeps only known fields, trimmed and size-limited.
function cleanProfile(p = {}) {
  const out = {};
  const LONG = ['address', 'preferences', 'important', 'billing', 'portalIds'];
  for (const key of Object.keys(TEXT_FIELDS)) out[key] = clip(p[key], LONG.includes(key) ? 4000 : 200);
  out.pan = out.pan.toUpperCase();
  out.gstin = out.gstin.toUpperCase();
  out.tan = out.tan.toUpperCase();
  out.services = Array.isArray(p.services) ? p.services.filter((s) => SERVICES.includes(s)) : [];
  out.contacts = (Array.isArray(p.contacts) ? p.contacts : []).slice(0, 20)
    .map((c) => ({ name: clip(c.name, 120), role: clip(c.role, 120), phone: clip(c.phone, 40), email: clip(c.email, 160) }))
    .filter((c) => c.name || c.phone || c.email);
  return out;
}

function describeChanges(before, after) {
  const changed = [];
  for (const [key, label] of Object.entries(TEXT_FIELDS)) if ((before[key] || '') !== (after[key] || '')) changed.push(label);
  if (JSON.stringify(before.services || []) !== JSON.stringify(after.services || [])) changed.push('Services');
  if (JSON.stringify(before.contacts || []) !== JSON.stringify(after.contacts || [])) changed.push('Contacts');
  return changed;
}

const rowToClient = (r) => ({
  id: r.id, name: r.name, profile: r.profile || {}, createdBy: r.created_by,
  createdAt: new Date(r.created_at).toISOString(), updatedBy: r.updated_by, updatedAt: new Date(r.updated_at).toISOString()
});
const rowToItem = (r) => ({ id: r.id, kind: r.kind, author: r.author, text: r.text, createdAt: new Date(r.created_at).toISOString() });
const copy = (x) => JSON.parse(JSON.stringify(x));

async function listClients() {
  let rows;
  if (USE_DB) rows = (await db().query('SELECT * FROM askca_clients ORDER BY lower(name)')).rows.map(rowToClient);
  else rows = copy(readFile().clients).map(({ items, ...c }) => c).sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

async function getClient(id) {
  let client;
  if (USE_DB) {
    const r = await db().query('SELECT * FROM askca_clients WHERE id = $1', [id]);
    if (!r.rows.length) return null;
    client = rowToClient(r.rows[0]);
    client.items = (await db().query('SELECT * FROM askca_client_items WHERE client_id = $1 ORDER BY created_at DESC, id', [id])).rows.map(rowToItem);
  } else {
    const c = readFile().clients.find((x) => x.id === id);
    if (!c) return null;
    client = copy(c);
    client.items = [...client.items].reverse();
  }
  client.conversations = (await store.listConversations()).filter((c) => c.clientId === id);
  return client;
}

async function findByName(name, excludeId) {
  const n = String(name).trim().toLowerCase();
  return (await listClients()).find((c) => c.name.toLowerCase() === n && c.id !== excludeId) || null;
}

async function createClient({ name, profile, by }) {
  const t = now();
  const client = { id: newId(), name: clip(name, 150), profile: cleanProfile(profile), createdBy: by, createdAt: t, updatedBy: by, updatedAt: t };
  const first = { id: newId(), kind: 'change', author: by, text: 'Client file created.', createdAt: t };
  if (USE_DB) {
    await db().query(
      'INSERT INTO askca_clients (id, name, profile, created_by, created_at, updated_by, updated_at) VALUES ($1,$2,$3::jsonb,$4,$5,$4,$5)',
      [client.id, client.name, JSON.stringify(client.profile), by, t]
    );
    await db().query('INSERT INTO askca_client_items (id, client_id, kind, author, text, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [first.id, client.id, first.kind, first.author, first.text, first.createdAt]);
  } else {
    await mutateFile((data) => data.clients.push({ ...client, items: [first] }));
  }
  return client;
}

// Saves the profile and records which fields changed in the client's history.
async function updateClient(id, { name, profile, by }) {
  const existing = await getClient(id);
  if (!existing) return null;
  const newName = clip(name, 150) || existing.name;
  const newProfile = cleanProfile(profile);
  const changed = describeChanges(existing.profile, newProfile);
  if (newName !== existing.name) changed.unshift('Name');
  if (!changed.length) return existing;
  const t = now();
  const item = { id: newId(), kind: 'change', author: by, text: `Updated: ${changed.join(', ')}.`, createdAt: t };
  if (USE_DB) {
    await db().query('UPDATE askca_clients SET name = $2, profile = $3::jsonb, updated_by = $4, updated_at = $5 WHERE id = $1',
      [id, newName, JSON.stringify(newProfile), by, t]);
    await db().query('INSERT INTO askca_client_items (id, client_id, kind, author, text, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [item.id, id, item.kind, item.author, item.text, item.createdAt]);
  } else {
    await mutateFile((data) => {
      const c = data.clients.find((x) => x.id === id);
      Object.assign(c, { name: newName, profile: newProfile, updatedBy: by, updatedAt: t });
      c.items.push(item);
    });
  }
  return getClient(id);
}

async function addItem(id, { kind, author, text }) {
  const item = { id: newId(), kind: ITEM_KINDS.includes(kind) && kind !== 'change' ? kind : 'note', author, text: clip(text, 20000), createdAt: now() };
  if (USE_DB) {
    const r = await db().query('UPDATE askca_clients SET updated_at = $2, updated_by = $3 WHERE id = $1', [id, item.createdAt, author]);
    if (!r.rowCount) return null;
    await db().query('INSERT INTO askca_client_items (id, client_id, kind, author, text, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [item.id, id, item.kind, item.author, item.text, item.createdAt]);
    return item;
  }
  return mutateFile((data) => {
    const c = data.clients.find((x) => x.id === id);
    if (!c) return null;
    c.items.push(item);
    c.updatedAt = item.createdAt;
    c.updatedBy = author;
    return item;
  });
}

async function getItem(clientId, itemId) {
  const c = await getClient(clientId);
  return c ? c.items.find((i) => i.id === itemId) || null : null;
}

async function deleteItem(clientId, itemId) {
  if (USE_DB) {
    const r = await db().query('DELETE FROM askca_client_items WHERE id = $1 AND client_id = $2', [itemId, clientId]);
    return r.rowCount > 0;
  }
  return mutateFile((data) => {
    const c = data.clients.find((x) => x.id === clientId);
    if (!c) return false;
    const before = c.items.length;
    c.items = c.items.filter((i) => i.id !== itemId);
    return c.items.length < before;
  });
}

async function deleteClient(id) {
  if (USE_DB) {
    const r = await db().query('DELETE FROM askca_clients WHERE id = $1', [id]);
    return r.rowCount > 0;
  }
  return mutateFile((data) => {
    const before = data.clients.length;
    data.clients = data.clients.filter((x) => x.id !== id);
    for (const conv of data.conversations) if (conv.clientId === id) conv.clientId = null;
    return data.clients.length < before;
  });
}

// Finds clients by name (or PAN/GSTIN/contact person) for the advisor.
async function search(query, limit = 3) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const qTokens = tokenize(q);
  const scored = [];
  for (const c of await listClients()) {
    const name = c.name.toLowerCase();
    const p = c.profile || {};
    const ids = [p.pan, p.gstin, p.tan, p.cin].filter(Boolean).map((x) => x.toLowerCase());
    let score = 0;
    if (name === q) score += 100;
    else if (name.includes(q) || (q.length > 3 && q.includes(name))) score += 40;
    if (ids.some((x) => q.includes(x))) score += 100;
    const nameTokens = new Set(tokenize(name));
    const other = new Set(tokenize([p.assignedTo, ...(p.contacts || []).map((x) => x.name)].join(' ')));
    for (const t of qTokens) {
      if (nameTokens.has(t)) score += 10;
      else if (other.has(t)) score += 2;
    }
    if (score > 0) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.c);
}

// Full client file as text for the advisor.
function formatForModel(client) {
  const p = client.profile || {};
  const lines = [`CLIENT: ${client.name}  (client file id ${client.id})`];
  for (const [key, label] of Object.entries(TEXT_FIELDS)) if (p[key]) lines.push(`${label}: ${p[key]}`);
  if (p.services && p.services.length) lines.push(`Services we handle: ${p.services.join(', ')}`);
  if (p.contacts && p.contacts.length) {
    lines.push('Contacts:');
    for (const c of p.contacts) lines.push(`  - ${[c.name, c.role && `(${c.role})`, c.phone, c.email].filter(Boolean).join(' ')}`);
  }
  const items = (client.items || []).filter((i) => i.kind !== 'change').slice(0, 40);
  if (items.length) {
    lines.push('History (newest first):');
    for (const i of items) lines.push(`  - ${i.createdAt.slice(0, 10)} [${i.kind}] ${i.author}: ${i.text.replace(/\s+/g, ' ').slice(0, 600)}`);
  }
  if (client.conversations && client.conversations.length) {
    lines.push('Earlier team discussions about this client: ' + client.conversations.slice(0, 15).map((c) => `"${c.title}" (${c.updatedAt.slice(0, 10)})`).join('; '));
  }
  lines.push(`Last updated ${client.updatedAt.slice(0, 10)} by ${client.updatedBy}.`);
  return lines.join('\n');
}

module.exports = {
  SERVICES, ITEM_KINDS, listClients, getClient, findByName, createClient, updateClient,
  addItem, getItem, deleteItem, deleteClient, search, formatForModel
};
