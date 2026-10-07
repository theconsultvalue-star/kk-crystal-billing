const path = require('path');
const crypto = require('crypto');
const express = require('express');
const store = require('./store');
const db = require('./db');
const { createInvoice } = require('./createInvoice');
const { parseShorthand } = require('./quickbill');
const { buildEwayBillJson } = require('./ewaybill');
const { buildTallyXml } = require('./tally');

const app = express();
const PORT = process.env.PORT || 4321;
const INVOICES_DIR = process.env.INVOICES_DIR || path.join(__dirname, 'invoices');

// ---- Login gate ----
// Credentials come from environment variables (set as host secrets in
// production) rather than a settings file, so they can be rotated without
// touching the app's data at all, and are never written to disk in plaintext.
const AUTH_USER = process.env.BILLING_USERNAME || 'admin';
const AUTH_PASS = process.env.BILLING_PASSWORD || 'changeme';
if (!process.env.BILLING_PASSWORD) {
  console.warn('WARNING: BILLING_PASSWORD is not set — using the insecure default "changeme". Set BILLING_USERNAME/BILLING_PASSWORD before deploying anywhere reachable off this machine.');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

app.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (safeEqual(user || '', AUTH_USER) && safeEqual(pass || '', AUTH_PASS)) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Billing"');
  res.status(401).send('Authentication required.');
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// PDFs come from Postgres when a database is configured (hosted deployment),
// otherwise from the local invoices/ folder (plain local usage).
app.get('/invoices-files/:filename', async (req, res) => {
  if (store.usingDatabase) {
    const data = await db.getPdf(req.params.filename);
    if (!data) return res.status(404).send('Not found');
    res.set('Content-Type', 'application/pdf');
    return res.send(data);
  }
  res.sendFile(path.join(INVOICES_DIR, req.params.filename), (err) => {
    if (err) res.status(404).send('Not found');
  });
});

app.get('/api/settings', async (req, res) => {
  res.json(await store.getSettings());
});

app.post('/api/settings', async (req, res) => {
  const saved = await store.saveSettings(req.body || {});
  res.json(saved);
});

app.get('/api/next-number', async (req, res) => {
  res.json({ number: await store.nextInvoiceNumber() });
});

app.get('/api/invoices', async (req, res) => {
  res.json(await store.getLedger());
});

app.get('/api/parties', async (req, res) => {
  res.json(await store.getParties());
});

app.post('/api/parties', async (req, res) => {
  const { name, gstin, address } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Party name is required.' });
  res.json(await store.addParty({ name, gstin, address }));
});

app.post('/api/parties/bulk', async (req, res) => {
  const { parties } = req.body || {};
  if (!Array.isArray(parties)) return res.status(400).json({ error: 'parties must be an array.' });
  const saved = [];
  for (const p of parties) {
    if (p && p.name && p.name.trim()) saved.push(await store.upsertPartyByName(p));
  }
  res.json(saved);
});

app.put('/api/parties/:id', async (req, res) => {
  const updated = await store.updateParty(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json(updated);
});

app.delete('/api/parties/:id', async (req, res) => {
  const ok = await store.deleteParty(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.get('/api/items', async (req, res) => {
  res.json(await store.getItems());
});

app.post('/api/items', async (req, res) => {
  const { description, hsn, gstRate } = req.body || {};
  if (!description || !description.trim()) return res.status(400).json({ error: 'Item description is required.' });
  res.json(await store.addItem({ description, hsn, gstRate }));
});

app.post('/api/items/bulk', async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array.' });
  const saved = [];
  for (const i of items) {
    if (i && i.description && i.description.trim()) saved.push(await store.upsertItemByDescription(i));
  }
  res.json(saved);
});

app.put('/api/items/:id', async (req, res) => {
  const updated = await store.updateItem(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json(updated);
});

app.delete('/api/items/:id', async (req, res) => {
  const ok = await store.deleteItem(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.post('/api/invoices', async (req, res) => {
  try {
    const invoice = await createInvoice(req.body || {});
    res.json(invoice);
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to generate invoice.' });
  }
});

app.post('/api/quick-bill/parse', async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Paste some text first.' });
  res.json(await parseShorthand(text));
});

app.post('/api/quick-bill/generate', async (req, res) => {
  const { rows } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'No rows to generate.' });
  }
  const results = [];
  for (const row of rows) {
    try {
      const invoice = await createInvoice({
        clientName: row.clientName,
        clientGSTIN: row.clientGSTIN,
        clientAddress: row.clientAddress,
        items: [{
          description: row.item.description,
          hsn: row.item.hsn,
          unit: row.item.unit,
          qty: row.qty,
          rate: row.rate
        }],
        taxPercent: row.taxPercent
      });
      results.push({ ok: true, invoice });
    } catch (err) {
      results.push({ ok: false, error: err.message, row });
    }
  }
  res.json(results);
});

app.get('/api/invoices/:id', async (req, res) => {
  const invoice = await store.getInvoice(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Not found' });
  res.json(invoice);
});

app.delete('/api/invoices/:id', async (req, res) => {
  const ok = await store.deleteInvoice(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Builds the E-way Bill JSON for one invoice so the user can upload it
// themselves at ewaybillgst.gov.in — this app never talks to that portal.
app.post('/api/invoices/:id/eway-bill', async (req, res) => {
  const invoice = await store.getInvoice(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Not found' });
  const settings = await store.getSettings();
  try {
    const json = buildEwayBillJson(invoice, settings, req.body || {});
    res.json(json);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build e-way bill JSON.' });
  }
});

// Tally import file (Sales vouchers) for a date range, e.g.
// /api/tally-export?from=2026-04-01&to=2026-04-30. Ledger names can be
// overridden with ?salesLedger=&cgstLedger=&sgstLedger=&igstLedger= using
// {rate} as the placeholder for the GST rate.
app.get('/api/tally-export', async (req, res) => {
  const { from = '', to = '' } = req.query;
  const [ledger, settings] = await Promise.all([store.getLedger(), store.getSettings()]);
  const invoices = ledger
    .filter((inv) => (!from || inv.date >= from) && (!to || inv.date <= to))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const xml = buildTallyXml(invoices, settings, {
    sales: req.query.salesLedger,
    cgst: req.query.cgstLedger,
    sgst: req.query.sgstLedger,
    igst: req.query.igstLedger
  });
  const name = `tally-sales${from ? '-' + from : ''}${to ? '-to-' + to : ''}.xml`;
  res.set('Content-Type', 'application/xml');
  res.set('Content-Disposition', `attachment; filename="${name}"`);
  res.send(xml);
});

(async () => {
  if (store.usingDatabase) {
    await db.ensureSchema();
    console.log('Connected to Postgres — data will persist there.');
  } else {
    console.log('No DATABASE_URL set — using local JSON files under ./data.');
  }
  app.listen(PORT, () => {
    console.log(`Billing app running at http://localhost:${PORT}`);
  });
})();
