// One-time migration: pushes the local data/*.json files and invoices/*.pdf
// into Postgres. Run this once, locally, with DATABASE_URL pointed at the
// Supabase project, after the hosted app is set up. Safe to re-run — it
// overwrites the same keys/filenames rather than duplicating anything.
//
//   DATABASE_URL="postgres://..." node migrate-to-db.js

const fs = require('fs');
const path = require('path');
const db = require('./db');

const DATA_DIR = path.join(__dirname, 'data');
const INVOICES_DIR = path.join(__dirname, 'invoices');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Set DATABASE_URL first, e.g.:\n  DATABASE_URL="postgres://..." node migrate-to-db.js');
    process.exit(1);
  }

  await db.ensureSchema();

  const settings = readJson(path.join(DATA_DIR, 'settings.json'), {});
  const ledger = readJson(path.join(DATA_DIR, 'ledger.json'), []);
  const parties = readJson(path.join(DATA_DIR, 'parties.json'), []);
  const items = readJson(path.join(DATA_DIR, 'items.json'), []);

  await db.setDoc('settings', settings);
  console.log('Migrated settings.');
  await db.setDoc('ledger', ledger);
  console.log(`Migrated ${ledger.length} ledger invoices.`);
  await db.setDoc('parties', parties);
  console.log(`Migrated ${parties.length} parties.`);
  await db.setDoc('items', items);
  console.log(`Migrated ${items.length} items.`);

  if (fs.existsSync(INVOICES_DIR)) {
    const files = fs.readdirSync(INVOICES_DIR).filter((f) => f.toLowerCase().endsWith('.pdf'));
    for (const file of files) {
      const buffer = fs.readFileSync(path.join(INVOICES_DIR, file));
      await db.savePdf(file, buffer);
    }
    console.log(`Migrated ${files.length} invoice PDFs.`);
  }

  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
