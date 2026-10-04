const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const USE_DB = db.isEnabled();

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const LEDGER_FILE = path.join(DATA_DIR, 'ledger.json');
const PARTIES_FILE = path.join(DATA_DIR, 'parties.json');
const ITEMS_FILE = path.join(DATA_DIR, 'items.json');

if (!USE_DB) {
  // On a fresh volume (e.g. first boot on a new host) this directory won't
  // exist yet — create it rather than fail on the first write.
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DEFAULT_SETTINGS = {
  businessName: '',
  businessAddress: '',
  businessGSTIN: '',
  businessEmail: '',
  businessPhone: '',
  bankName: '',
  bankAccountName: '',
  bankAccountNumber: '',
  bankIFSC: '',
  invoicePrefix: 'INV-',
  nextNumber: 1,
  defaultTaxPercent: 18,
  defaultNotes: '',
  defaultTerms: 'Payment due within 15 days.',
  ewayBillThreshold: 50000
};

function readJsonSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJsonSync(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Every read/write goes through these two so the rest of this file doesn't
// need to know whether it's talking to Postgres or a local JSON file.
async function readDoc(key, file, fallback) {
  return USE_DB ? db.getDoc(key, fallback) : readJsonSync(file, fallback);
}

async function writeDoc(key, file, data) {
  return USE_DB ? db.setDoc(key, data) : writeJsonSync(file, data);
}

async function getSettings() {
  const s = await readDoc('settings', SETTINGS_FILE, {});
  return { ...DEFAULT_SETTINGS, ...s };
}

async function saveSettings(partial) {
  const current = await getSettings();
  const merged = { ...current, ...partial };
  await writeDoc('settings', SETTINGS_FILE, merged);
  return merged;
}

async function getLedger() {
  return readDoc('ledger', LEDGER_FILE, []);
}

async function saveLedger(ledger) {
  return writeDoc('ledger', LEDGER_FILE, ledger);
}

async function nextInvoiceNumber() {
  const settings = await getSettings();
  return `${settings.invoicePrefix}${String(settings.nextNumber).padStart(4, '0')}`;
}

async function addInvoice(invoice) {
  const ledger = await getLedger();
  ledger.unshift(invoice);
  await saveLedger(ledger);
  const settings = await getSettings();
  await saveSettings({ nextNumber: settings.nextNumber + 1 });
  return invoice;
}

async function getInvoice(id) {
  const ledger = await getLedger();
  return ledger.find((inv) => inv.id === id);
}

async function deleteInvoice(id) {
  const ledger = await getLedger();
  const idx = ledger.findIndex((inv) => inv.id === id);
  if (idx === -1) return false;
  const [removed] = ledger.splice(idx, 1);
  await saveLedger(ledger);
  if (removed && removed.pdfFile) {
    if (USE_DB) {
      await db.deletePdf(removed.pdfFile);
    } else {
      const invoicesDir = process.env.INVOICES_DIR || path.join(__dirname, 'invoices');
      const filePath = path.join(invoicesDir, removed.pdfFile);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  }
  return true;
}

async function getParties() {
  return readDoc('parties', PARTIES_FILE, []);
}

async function saveParties(parties) {
  return writeDoc('parties', PARTIES_FILE, parties);
}

async function addParty(party) {
  const parties = await getParties();
  const record = {
    id: crypto.randomUUID(),
    name: (party.name || '').trim(),
    gstin: (party.gstin || '').trim(),
    address: (party.address || '').trim()
  };
  parties.push(record);
  await saveParties(parties);
  return record;
}

async function updateParty(id, partial) {
  const parties = await getParties();
  const idx = parties.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  parties[idx] = { ...parties[idx], ...partial, id };
  await saveParties(parties);
  return parties[idx];
}

async function deleteParty(id) {
  const parties = await getParties();
  const idx = parties.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  parties.splice(idx, 1);
  await saveParties(parties);
  return true;
}

async function upsertPartyByName(party) {
  const parties = await getParties();
  const existing = parties.find((p) => p.name.toLowerCase() === (party.name || '').trim().toLowerCase());
  if (existing) {
    // Only overwrite fields that came with a real value, so a bill with a
    // blank GSTIN/address never erases what's already on file for the party.
    const patch = {};
    if (party.gstin && party.gstin.trim()) patch.gstin = party.gstin.trim();
    if (party.address && party.address.trim()) patch.address = party.address.trim();
    return Object.keys(patch).length ? updateParty(existing.id, patch) : existing;
  }
  return addParty(party);
}

async function getItems() {
  return readDoc('items', ITEMS_FILE, []);
}

async function saveItems(items) {
  return writeDoc('items', ITEMS_FILE, items);
}

async function addItem(item) {
  const items = await getItems();
  const record = {
    id: crypto.randomUUID(),
    description: (item.description || '').trim(),
    hsn: (item.hsn || '').trim(),
    gstRate: item.gstRate === '' || item.gstRate == null ? null : Number(item.gstRate)
  };
  items.push(record);
  await saveItems(items);
  return record;
}

async function updateItem(id, partial) {
  const items = await getItems();
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return null;
  items[idx] = { ...items[idx], ...partial, id };
  await saveItems(items);
  return items[idx];
}

async function deleteItem(id) {
  const items = await getItems();
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return false;
  items.splice(idx, 1);
  await saveItems(items);
  return true;
}

async function upsertItemByDescription(item) {
  const items = await getItems();
  const existing = items.find((i) => i.description.toLowerCase() === (item.description || '').trim().toLowerCase());
  if (existing) {
    const patch = {};
    if (item.hsn && item.hsn.trim()) patch.hsn = item.hsn.trim();
    if (item.gstRate !== '' && item.gstRate != null) patch.gstRate = Number(item.gstRate);
    return Object.keys(patch).length ? updateItem(existing.id, patch) : existing;
  }
  return addItem(item);
}

module.exports = {
  usingDatabase: USE_DB,
  getSettings,
  saveSettings,
  getLedger,
  nextInvoiceNumber,
  addInvoice,
  getInvoice,
  deleteInvoice,
  getParties,
  addParty,
  updateParty,
  deleteParty,
  upsertPartyByName,
  getItems,
  addItem,
  updateItem,
  deleteItem,
  upsertItemByDescription
};
