const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const db = require('./db');
const { generateInvoicePdf } = require('./pdf');

const INVOICES_DIR = process.env.INVOICES_DIR || path.join(__dirname, 'invoices');
if (!store.usingDatabase) {
  fs.mkdirSync(INVOICES_DIR, { recursive: true });
}

async function createInvoice(body) {
  const settings = await store.getSettings();

  const items = (body.items || []).map((item) => {
    const qty = Number(item.qty) || 0;
    const rate = Number(item.rate) || 0;
    return {
      description: item.description || '',
      hsn: item.hsn || '',
      unit: item.unit || '',
      qty,
      rate,
      amount: qty * rate
    };
  });

  if (items.length === 0) {
    throw Object.assign(new Error('At least one line item is required.'), { status: 400 });
  }

  const subtotal = items.reduce((sum, i) => sum + i.amount, 0);
  const taxPercent = Number(body.taxPercent) || 0;
  const discount = Number(body.discount) || 0;
  const taxAmount = (subtotal - discount) * (taxPercent / 100);
  const total = subtotal - discount + taxAmount;

  const invoice = {
    id: crypto.randomUUID(),
    number: await store.nextInvoiceNumber(),
    date: body.date || new Date().toISOString().slice(0, 10),
    dueDate: body.dueDate || '',
    clientName: body.clientName || '',
    clientAddress: body.clientAddress || '',
    clientGSTIN: body.clientGSTIN || '',
    items,
    subtotal,
    discount,
    taxPercent,
    taxAmount,
    total,
    notes: body.notes || '',
    terms: body.terms || settings.defaultTerms || '',
    createdAt: new Date().toISOString()
  };

  const { fileName, buffer } = await generateInvoicePdf(invoice, settings);
  invoice.pdfFile = fileName;

  if (store.usingDatabase) {
    await db.savePdf(fileName, buffer);
  } else {
    fs.writeFileSync(path.join(INVOICES_DIR, fileName), buffer);
  }

  await store.addInvoice(invoice);

  if (invoice.clientName.trim()) {
    await store.upsertPartyByName({
      name: invoice.clientName,
      gstin: invoice.clientGSTIN,
      address: invoice.clientAddress
    });
  }

  for (const item of invoice.items) {
    if (item.description.trim()) {
      await store.upsertItemByDescription({
        description: item.description,
        hsn: item.hsn,
        gstRate: invoice.taxPercent
      });
    }
  }

  return { ...invoice, pdfUrl: `/invoices-files/${fileName}` };
}

module.exports = { createInvoice };
