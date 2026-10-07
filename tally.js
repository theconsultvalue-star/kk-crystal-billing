// Builds a Tally Prime / Tally.ERP 9 import file (XML) of Sales vouchers from
// the invoice ledger, so bills made here can be pulled into Tally via
// Gateway of Tally > Import > Vouchers instead of being re-keyed by hand.
//
// Vouchers are written in Accounting Voucher View (no stock items), which
// imports cleanly without the items/units having to exist in Tally first.
// The ledgers named below DO have to exist in the Tally company (or be
// created once by hand) — Tally rejects a voucher that names a missing ledger.

const { stateCode } = require('./gst');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const amt = (n) => r2(n).toFixed(2);
// Trims a trailing ".0"/".00" so "9%" and "2.5%" read naturally in ledger names.
const pct = (n) => String(r2(n));

// Ledger names used for each voucher. Override any of them from the caller
// (e.g. ?salesLedger=Local Sales) to match the names in the Tally company.
const DEFAULT_LEDGERS = {
  sales: 'Sales @{rate}%',
  cgst: 'CGST Output @{rate}%',
  sgst: 'SGST Output @{rate}%',
  igst: 'IGST Output @{rate}%'
};

function ledgerName(template, rate) {
  return template.replace('{rate}', pct(rate));
}

// Same intra/inter-state decision the PDF uses (pdf.js computeTaxBreakup),
// with each tax rounded to paise so the voucher balances exactly in Tally.
function voucherLines(invoice, settings, ledgers) {
  const rate = Number(invoice.taxPercent) || 0;
  const taxable = r2((invoice.subtotal || 0) - (invoice.discount || 0));
  const sellerState = stateCode(settings.businessGSTIN);
  const buyerState = stateCode(invoice.clientGSTIN);
  const interState = sellerState && buyerState && sellerState !== buyerState;

  const credits = [{ ledger: ledgerName(ledgers.sales, rate), amount: taxable }];
  if (rate > 0) {
    if (interState) {
      credits.push({ ledger: ledgerName(ledgers.igst, rate), amount: r2(taxable * rate / 100) });
    } else {
      const half = rate / 2;
      const each = r2(taxable * half / 100);
      credits.push({ ledger: ledgerName(ledgers.cgst, half), amount: each });
      credits.push({ ledger: ledgerName(ledgers.sgst, half), amount: each });
    }
  }
  const total = r2(credits.reduce((s, c) => s + c.amount, 0));
  return { credits, total };
}

function voucherXml(invoice, settings, ledgers) {
  const { credits, total } = voucherLines(invoice, settings, ledgers);
  const party = invoice.clientName || 'Cash';
  const date = (invoice.date || '').replace(/-/g, '');
  const narration = [
    invoice.notes,
    invoice.clientGSTIN ? `GSTIN: ${invoice.clientGSTIN}` : ''
  ].filter(Boolean).join(' | ');

  // Tally sign convention: debits are negative with ISDEEMEDPOSITIVE=Yes,
  // credits positive with ISDEEMEDPOSITIVE=No.
  const entry = (ledger, amount, debit) => `
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${esc(ledger)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
        <ISPARTYLEDGER>${debit ? 'Yes' : 'No'}</ISPARTYLEDGER>
        <AMOUNT>${debit ? '-' : ''}${amt(amount)}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>`;

  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Accounting Voucher View">
      <DATE>${esc(date)}</DATE>
      <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
      <VOUCHERNUMBER>${esc(invoice.number)}</VOUCHERNUMBER>
      <REFERENCE>${esc(invoice.number)}</REFERENCE>
      <PARTYLEDGERNAME>${esc(party)}</PARTYLEDGERNAME>
      <PARTYNAME>${esc(party)}</PARTYNAME>
      <PARTYGSTIN>${esc(invoice.clientGSTIN || '')}</PARTYGSTIN>
      <NARRATION>${esc(narration)}</NARRATION>
      <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
      <ISINVOICE>No</ISINVOICE>${entry(party, total, true)}${credits.map((c) => entry(c.ledger, c.amount, false)).join('')}
      </VOUCHER>
    </TALLYMESSAGE>`;
}

// `invoices` should already be filtered to the period being exported.
function buildTallyXml(invoices, settings, ledgerOverrides = {}) {
  const ledgers = { ...DEFAULT_LEDGERS };
  for (const k of Object.keys(DEFAULT_LEDGERS)) {
    if (ledgerOverrides[k]) ledgers[k] = ledgerOverrides[k];
  }
  const company = settings.tallyCompanyName || settings.businessName || '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>${invoices.map((inv) => voucherXml(inv, settings, ledgers)).join('')}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>
`;
}

module.exports = { buildTallyXml, voucherLines, DEFAULT_LEDGERS };
