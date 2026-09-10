const PDFDocument = require('pdfkit');

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigitWords(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
}

function threeDigitWords(n) {
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  let out = '';
  if (hundred) out += ONES[hundred] + ' Hundred';
  if (rest) out += (out ? ' ' : '') + twoDigitWords(rest);
  return out;
}

// Indian numbering: crore / lakh / thousand / hundred
function numberToWordsIndian(num) {
  num = Math.floor(num);
  if (num === 0) return 'Zero';
  const crore = Math.floor(num / 10000000);
  num %= 10000000;
  const lakh = Math.floor(num / 100000);
  num %= 100000;
  const thousand = Math.floor(num / 1000);
  num %= 1000;
  const hundred = num;

  const parts = [];
  if (crore) parts.push(threeDigitWords(crore) + ' Crore');
  if (lakh) parts.push(threeDigitWords(lakh) + ' Lakh');
  if (thousand) parts.push(threeDigitWords(thousand) + ' Thousand');
  if (hundred) parts.push(threeDigitWords(hundred));
  return parts.join(' ');
}

function amountInWords(amount) {
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  let words = 'INR ' + numberToWordsIndian(rupees);
  if (paise) words += ' and ' + numberToWordsIndian(paise) + ' Paise';
  return words + ' Only';
}

const CURRENCY = 'Rs. ';

function money(n) {
  return CURRENCY + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function stateCode(gstin) {
  const m = (gstin || '').match(/^(\d{2})/);
  return m ? m[1] : null;
}

const GST_STATE_NAMES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '28': 'Andhra Pradesh (Old)',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh', '97': 'Other Territory'
};

function stateNameFromAddress(address) {
  if (!address) return '';
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!/^\d+$/.test(parts[i])) return parts[i];
  }
  return '';
}

function stateName(gstin, address) {
  const code = stateCode(gstin);
  if (code && GST_STATE_NAMES[code]) return GST_STATE_NAMES[code];
  return stateNameFromAddress(address);
}

function computeTaxBreakup(invoice, settings) {
  const sellerState = stateCode(settings.businessGSTIN);
  const buyerState = stateCode(invoice.clientGSTIN);
  const interState = sellerState && buyerState && sellerState !== buyerState;
  const rate = invoice.taxPercent || 0;
  const taxableValue = invoice.subtotal - (invoice.discount || 0);

  if (interState) {
    return { type: 'igst', igstRate: rate, igstAmount: taxableValue * (rate / 100), taxableValue };
  }
  const half = rate / 2;
  return {
    type: 'cgst_sgst',
    cgstRate: half,
    sgstRate: half,
    cgstAmount: taxableValue * (half / 100),
    sgstAmount: taxableValue * (half / 100),
    taxableValue
  };
}

// Layout constants, measured from the client's actual Tally-exported invoice
// (KK CRYSTAL ELEMENTS template) so the output matches it as closely as
// PDFKit allows: same margins, same column boundaries, same grid look.
const LEFT = 35;
const RIGHT = 490;
const WIDTH = RIGHT - LEFT;
const MID = 263; // divider between party-details column and the reference-fields grid
const GRID_COL2 = 374; // second sub-column inside the reference-fields grid
const ITEM_COLS = { sl: 35, desc: 47, hsn: 239, qty: 290, rate: 341, per: 392, amt: 413, end: 489 };
const ITEM_BOX_MIN_HEIGHT = 214; // reserves the same amount of table space Tally's print form does

// Renders the PDF into memory and hands back { fileName, buffer } — the
// caller decides where that buffer actually gets persisted (local disk vs.
// a database blob), so this module has no filesystem opinion of its own.
function generateInvoicePdf(invoice, settings) {
  const fileName = `${invoice.number.replace(/[^a-zA-Z0-9-]/g, '_')}.pdf`;
  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  const breakup = computeTaxBreakup(invoice, settings);
  const buyerStateN = stateName(invoice.clientGSTIN, invoice.clientAddress) ||
    (invoice.clientGSTIN ? '' : stateName(settings.businessGSTIN, settings.businessAddress));
  const buyerStateC = stateCode(invoice.clientGSTIN) || (invoice.clientGSTIN ? '' : stateCode(settings.businessGSTIN));

  doc.font('Helvetica-Bold').fontSize(11).fillColor('#000')
    .text('Tax Invoice', 0, 16, { width: doc.page.width, align: 'center' });

  // ================= Party details + reference-fields grid =================
  const boxTop = 31;
  const partyBoxW = MID - LEFT - 4;

  function partyBlock(startY, label, name, address, gstin, stateN, stateC) {
    let py = startY + 3;
    if (label) {
      doc.font('Helvetica').fontSize(8.5).fillColor('#333').text(label, LEFT + 2, py, { width: partyBoxW });
      py += 12;
    }
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000').text(name || '', LEFT + 2, py, { width: partyBoxW });
    py += 12;
    doc.font('Helvetica').fontSize(9.5);
    if (address) {
      doc.text(address, LEFT + 2, py, { width: partyBoxW });
      py += doc.heightOfString(address, { width: partyBoxW });
    }
    if (gstin) {
      doc.text(`GSTIN/UIN : ${gstin}`, LEFT + 2, py, { width: partyBoxW });
      py += 12;
    }
    doc.text(`State Name : ${stateN || ''}, Code : ${stateC || ''}`, LEFT + 2, py, { width: partyBoxW });
    py += 12;
    return py + 4;
  }

  // Seller block prints "GSTIN/UIN: X" (no space before colon) plus an email
  // line, which differs slightly from the buyer block's label style, so it's
  // rendered directly here rather than through the shared partyBlock() helper.
  let sellerY = boxTop + 2;
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000').text(settings.businessName || '', LEFT + 2, sellerY, { width: partyBoxW });
  sellerY += 12;
  doc.font('Helvetica').fontSize(9.5);
  if (settings.businessAddress) {
    doc.text(settings.businessAddress, LEFT + 2, sellerY, { width: partyBoxW });
    sellerY += doc.heightOfString(settings.businessAddress, { width: partyBoxW });
  }
  if (settings.businessGSTIN) {
    doc.text(`GSTIN/UIN: ${settings.businessGSTIN}`, LEFT + 2, sellerY, { width: partyBoxW });
    sellerY += 12;
  }
  doc.text(`State Name : ${stateName(settings.businessGSTIN, settings.businessAddress)}, Code : ${stateCode(settings.businessGSTIN) || ''}`, LEFT + 2, sellerY, { width: partyBoxW });
  sellerY += 12;
  if (settings.businessEmail) {
    doc.text(`E-Mail : ${settings.businessEmail}`, LEFT + 2, sellerY, { width: partyBoxW });
    sellerY += 12;
  }
  const sellerBoxBottom = sellerY + 3;

  const consBottom = partyBlock(
    sellerBoxBottom, 'Consignee (Ship to)', invoice.clientName, invoice.clientAddress,
    invoice.clientGSTIN, buyerStateN, buyerStateC
  );
  const buyerBottom = partyBlock(
    consBottom, 'Buyer (Bill to)', invoice.clientName, invoice.clientAddress,
    invoice.clientGSTIN, buyerStateN, buyerStateC
  );

  // ---- Reference-fields grid (right column) ----
  const gridRowH = 24;
  const fields = [
    ['Invoice No.', invoice.number, 'Dated', invoice.date],
    ['Delivery Note', '', 'Mode/Terms of Payment', ''],
    ['Reference No. & Date.', '', 'Other References', ''],
    ["Buyer's Order No.", '', 'Dated', ''],
    ['Dispatch Doc No.', '', 'Delivery Note Date', ''],
    ['Dispatched through', '', 'Destination', '']
  ];
  let gy = boxTop + 2;
  fields.forEach(([l1, v1, l2, v2]) => {
    doc.font('Helvetica').fontSize(8.5).fillColor('#333').text(l1, GRID_COL2 - 108, gy, { width: 106 });
    doc.text(l2, GRID_COL2 + 2, gy, { width: 106 });
    if (v1) doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000').text(v1, GRID_COL2 - 108, gy + 11, { width: 106 });
    if (v2) doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000').text(v2, GRID_COL2 + 2, gy + 11, { width: 106 });
    gy += gridRowH;
  });
  doc.font('Helvetica').fontSize(8.5).fillColor('#333').text('Terms of Delivery', GRID_COL2 - 108, gy + 3);

  const sectionBottom = Math.max(buyerBottom, gy + 26);

  // ---- Borders for the whole top section ----
  doc.strokeColor('#000').lineWidth(0.75);
  doc.rect(LEFT, boxTop, WIDTH, sectionBottom - boxTop).stroke();
  doc.moveTo(MID, boxTop).lineTo(MID, sectionBottom).stroke();
  doc.moveTo(LEFT, sellerBoxBottom).lineTo(MID, sellerBoxBottom).stroke();
  doc.moveTo(LEFT, consBottom).lineTo(MID, consBottom).stroke();
  doc.moveTo(GRID_COL2, boxTop).lineTo(GRID_COL2, gy).stroke();
  fields.forEach((_, i) => {
    const ly = boxTop + gridRowH * (i + 1);
    doc.moveTo(MID, ly).lineTo(RIGHT, ly).stroke();
  });

  let y = sectionBottom;

  // ================= Line items table =================
  const c = ITEM_COLS;
  const headerH = 26;

  doc.font('Helvetica').fontSize(8).fillColor('#000');
  doc.text('Sl', c.sl + 2, y + 4, { width: 20, lineBreak: false });
  doc.text('No.', c.sl + 2, y + 15, { width: 20, lineBreak: false });
  doc.text('Description of Goods', c.desc + 2, y + 9, { width: c.hsn - c.desc - 4 });
  doc.text('HSN/SAC', c.hsn + 2, y + 9, { width: c.qty - c.hsn - 4 });
  doc.text('Quantity', c.qty + 2, y + 9, { width: c.rate - c.qty - 4 });
  doc.text('Rate', c.rate + 2, y + 9, { width: c.per - c.rate - 4 });
  doc.text('per', c.per + 2, y + 9, { width: c.amt - c.per - 4 });
  doc.text('Amount', c.amt + 2, y + 9, { width: c.end - c.amt - 4, align: 'right' });

  const tableTop = y;
  y += headerH;
  const itemsTop = y;

  invoice.items.forEach((item, i) => {
    const rowH = Math.max(20, doc.heightOfString(item.description || '', { width: c.hsn - c.desc - 4 }) + 8);
    doc.font('Helvetica').fontSize(9.5).fillColor('#000');
    doc.text(String(i + 1), c.sl + 2, y + 5, { width: c.desc - c.sl - 2, lineBreak: false });
    doc.font('Helvetica-Bold').text(item.description || '', c.desc + 2, y + 4, { width: c.hsn - c.desc - 4 });
    doc.font('Helvetica').fontSize(8.7).text(item.hsn || '', c.hsn + 2, y + 5, { width: c.qty - c.hsn - 4, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(8.8).text(`${item.qty}${item.unit ? ' ' + item.unit : ''}`, c.qty + 2, y + 4, { width: c.rate - c.qty - 4, lineBreak: false });
    doc.font('Helvetica').fontSize(8.7).text(money(item.rate).replace(CURRENCY, ''), c.rate + 2, y + 5, { width: c.per - c.rate - 4, align: 'right', lineBreak: false });
    doc.text(item.unit || '', c.per + 2, y + 5, { width: c.amt - c.per - 4, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(9.5).text(money(item.amount), c.amt + 2, y + 4, { width: c.end - c.amt - 4, align: 'right' });
    y += rowH;
  });

  y += 6;
  if (breakup.type === 'igst') {
    doc.font('Helvetica-BoldOblique').fontSize(9).text(`OUTPUT IGST@${breakup.igstRate}%`, c.desc + 2, y, { width: c.hsn - c.desc - 4 });
    doc.font('Helvetica-Bold').fontSize(9.5).text(money(breakup.igstAmount), c.amt + 2, y, { width: c.end - c.amt - 4, align: 'right' });
    y += 16;
  } else {
    doc.font('Helvetica-BoldOblique').fontSize(9).text(`OUTPUT CGST@${breakup.cgstRate}%`, c.desc + 2, y, { width: c.hsn - c.desc - 4 });
    doc.font('Helvetica-Bold').fontSize(9.5).text(money(breakup.cgstAmount), c.amt + 2, y, { width: c.end - c.amt - 4, align: 'right' });
    y += 16;
    doc.font('Helvetica-BoldOblique').fontSize(9).text(`OUTPUT SGST@${breakup.sgstRate}%`, c.desc + 2, y, { width: c.hsn - c.desc - 4 });
    doc.font('Helvetica-Bold').fontSize(9.5).text(money(breakup.sgstAmount), c.amt + 2, y, { width: c.end - c.amt - 4, align: 'right' });
    y += 16;
  }
  if (invoice.discount) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#000').text('Less: Discount', c.desc + 2, y, { width: c.hsn - c.desc - 4 });
    doc.font('Helvetica-Bold').text('-' + money(invoice.discount), c.amt + 2, y, { width: c.end - c.amt - 4, align: 'right' });
    y += 16;
  }

  // Pad the item box out to Tally's usual fixed table height, then close it off
  const itemsBoxBottom = Math.max(y + 8, itemsTop + ITEM_BOX_MIN_HEIGHT);

  doc.lineWidth(0.75).strokeColor('#000');
  doc.rect(LEFT, tableTop, WIDTH, headerH).stroke();
  doc.rect(LEFT, itemsTop, WIDTH, itemsBoxBottom - itemsTop).stroke();
  [c.sl, c.desc, c.hsn, c.qty, c.rate, c.per, c.amt].forEach((x) => {
    doc.moveTo(x, tableTop).lineTo(x, itemsBoxBottom).stroke();
  });
  doc.moveTo(RIGHT, tableTop).lineTo(RIGHT, itemsBoxBottom).stroke();

  y = itemsBoxBottom;

  // ---- Total row ----
  const totalRowH = 16;
  doc.font('Helvetica').fontSize(8.5).fillColor('#000').text('Total', c.desc + 2, y + 4, { width: c.hsn - c.desc - 4 });
  const totalQty = invoice.items.reduce((s, i) => s + Number(i.qty || 0), 0);
  const firstUnit = invoice.items[0] && invoice.items[0].unit ? invoice.items[0].unit : '';
  doc.font('Helvetica-Bold').fontSize(8.5).text(`${totalQty}${firstUnit ? ' ' + firstUnit : ''}`, c.qty + 2, y + 3, { width: c.rate - c.qty - 4 });
  doc.font('Helvetica-Bold').fontSize(10).text(money(invoice.total), c.amt + 2, y + 2, { width: c.end - c.amt - 4, align: 'right' });
  doc.rect(LEFT, y, WIDTH, totalRowH).stroke();
  y += totalRowH;

  // ---- Amount Chargeable (in words) ----
  const amtWordsH = 30;
  doc.font('Helvetica').fontSize(8).fillColor('#000').text('Amount Chargeable (in words)', LEFT + 2, y + 4);
  doc.font('Helvetica-Oblique').fontSize(8.2).text('E. & O.E', LEFT + 2, y + 4, { width: WIDTH - 4, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(9.5).text(amountInWords(invoice.total), LEFT + 2, y + 16);
  doc.rect(LEFT, y, WIDTH, amtWordsH).stroke();
  y += amtWordsH;

  // ================= HSN/SAC tax summary table =================
  const hsnGroups = {};
  invoice.items.forEach((item) => {
    const key = item.hsn || '-';
    if (!hsnGroups[key]) hsnGroups[key] = 0;
    hsnGroups[key] += item.amount;
  });

  const isIgst = breakup.type === 'igst';
  // Generous, non-overlapping column widths: HSN gets a wide but mostly-empty
  // header cell (matching the source template), the rest split evenly enough
  // for "CGST Rate"/"CGST Amt"/"SGST Rate"/"SGST Amt" to each fit on one line.
  const sc = isIgst
    ? { hsn: LEFT, taxable: LEFT + 110, r1: LEFT + 180, a1: LEFT + 240, total: LEFT + 330 }
    : { hsn: LEFT, taxable: LEFT + 110, r1: LEFT + 180, a1: LEFT + 225, r2: LEFT + 285, a2: LEFT + 330, total: LEFT + 390 };

  const hsnHeaderH = 26;
  doc.font('Helvetica').fontSize(8.2).fillColor('#000');
  doc.text('HSN/SAC', sc.hsn + 2, y + 8, { width: sc.taxable - sc.hsn - 4 });
  doc.text('Taxable', sc.taxable + 2, y + 3, { width: sc.r1 - sc.taxable - 4, align: 'center' });
  doc.text('Value', sc.taxable + 2, y + 14, { width: sc.r1 - sc.taxable - 4, align: 'center' });
  if (isIgst) {
    doc.text('IGST', sc.r1 + 2, y + 3, { width: sc.total - sc.r1 - 4, align: 'center' });
    doc.fontSize(7.8);
    doc.text('Rate', sc.r1 + 2, y + 15, { width: sc.a1 - sc.r1 - 4, align: 'center' });
    doc.text('Amount', sc.a1 + 2, y + 15, { width: sc.total - sc.a1 - 4, align: 'center' });
  } else {
    doc.text('CGST', sc.r1 + 2, y + 3, { width: sc.r2 - sc.r1 - 4, align: 'center' });
    doc.text('SGST', sc.r2 + 2, y + 3, { width: sc.total - sc.r2 - 4, align: 'center' });
    doc.fontSize(7.8);
    doc.text('Rate', sc.r1 + 1, y + 15, { width: sc.a1 - sc.r1 - 2, align: 'center' });
    doc.text('Amt', sc.a1 + 1, y + 15, { width: sc.r2 - sc.a1 - 2, align: 'center' });
    doc.text('Rate', sc.r2 + 1, y + 15, { width: sc.a2 - sc.r2 - 2, align: 'center' });
    doc.text('Amt', sc.a2 + 1, y + 15, { width: sc.total - sc.a2 - 2, align: 'center' });
  }
  doc.fontSize(7.8);
  doc.text('Total', sc.total + 2, y + 3, { width: RIGHT - sc.total - 4, align: 'right' });
  doc.text('Tax Amount', sc.total + 2, y + 15, { width: RIGHT - sc.total - 4, align: 'right' });

  const hsnTableTop = y;
  y += hsnHeaderH;

  doc.font('Helvetica').fontSize(8.2);
  let totalTax = 0;
  const hsnRowH = 13;
  Object.entries(hsnGroups).forEach(([hsn, taxable]) => {
    doc.text(hsn, sc.hsn + 2, y + 3, { width: sc.taxable - sc.hsn - 4 });
    doc.text(money(taxable).replace(CURRENCY, ''), sc.taxable + 2, y + 3, { width: sc.r1 - sc.taxable - 4, align: 'right' });
    if (isIgst) {
      const amt = taxable * (breakup.igstRate / 100);
      totalTax += amt;
      doc.text(`${breakup.igstRate}%`, sc.r1 + 2, y + 3, { width: sc.a1 - sc.r1 - 4, align: 'right' });
      doc.text(money(amt).replace(CURRENCY, ''), sc.a1 + 2, y + 3, { width: sc.total - sc.a1 - 4, align: 'right' });
    } else {
      const cAmt = taxable * (breakup.cgstRate / 100);
      const sAmt = taxable * (breakup.sgstRate / 100);
      totalTax += cAmt + sAmt;
      doc.text(`${breakup.cgstRate}%`, sc.r1 + 1, y + 3, { width: sc.a1 - sc.r1 - 2, align: 'right' });
      doc.text(money(cAmt).replace(CURRENCY, ''), sc.a1 + 1, y + 3, { width: sc.r2 - sc.a1 - 2, align: 'right' });
      doc.text(`${breakup.sgstRate}%`, sc.r2 + 1, y + 3, { width: sc.a2 - sc.r2 - 2, align: 'right' });
      doc.text(money(sAmt).replace(CURRENCY, ''), sc.a2 + 1, y + 3, { width: sc.total - sc.a2 - 2, align: 'right' });
    }
    const rowTax = isIgst ? taxable * (breakup.igstRate / 100) : taxable * (breakup.cgstRate / 100) + taxable * (breakup.sgstRate / 100);
    doc.text(money(rowTax).replace(CURRENCY, ''), sc.total + 2, y + 3, { width: RIGHT - sc.total - 4, align: 'right' });
    y += hsnRowH;
  });

  const hsnDataBottom = y;
  doc.font('Helvetica-Bold').fontSize(7.8);
  doc.text('Total', sc.taxable - 30, y + 3, { width: 26, align: 'right' });
  doc.text(money(breakup.taxableValue).replace(CURRENCY, ''), sc.taxable + 2, y + 3, { width: sc.r1 - sc.taxable - 4, align: 'right' });
  if (isIgst) {
    doc.text(money(breakup.igstAmount).replace(CURRENCY, ''), sc.a1 + 2, y + 3, { width: sc.total - sc.a1 - 4, align: 'right' });
  } else {
    doc.text(money(breakup.cgstAmount).replace(CURRENCY, ''), sc.a1 + 1, y + 3, { width: sc.r2 - sc.a1 - 2, align: 'right' });
    doc.text(money(breakup.sgstAmount).replace(CURRENCY, ''), sc.a2 + 1, y + 3, { width: sc.total - sc.a2 - 2, align: 'right' });
  }
  doc.text(money(totalTax).replace(CURRENCY, ''), sc.total + 2, y + 3, { width: RIGHT - sc.total - 4, align: 'right' });
  y += hsnRowH + 1;

  doc.lineWidth(0.75).strokeColor('#000');
  doc.rect(LEFT, hsnTableTop, WIDTH, y - hsnTableTop).stroke();
  doc.moveTo(LEFT, hsnTableTop + hsnHeaderH).lineTo(RIGHT, hsnTableTop + hsnHeaderH).stroke();
  doc.moveTo(LEFT, hsnDataBottom).lineTo(RIGHT, hsnDataBottom).stroke();
  const hsnCols = isIgst ? [sc.taxable, sc.r1, sc.a1] : [sc.taxable, sc.r1, sc.a1, sc.r2, sc.a2];
  hsnCols.concat([sc.total]).forEach((x) => doc.moveTo(x, hsnTableTop).lineTo(x, y).stroke());

  // ---- Tax Amount (in words) ----
  const taxWordsH = 17;
  doc.font('Helvetica').fontSize(8).fillColor('#000').text('Tax Amount (in words)  :', LEFT + 2, y + 4, { continued: true });
  doc.font('Helvetica-Bold').fontSize(9.5).text(' ' + amountInWords(totalTax));
  doc.rect(LEFT, y, WIDTH, taxWordsH).stroke();
  y += taxWordsH;

  // ================= Declaration + Bank details + signature =================
  const footerTop = y;
  const bankLines = [
    settings.bankAccountName ? ["A/c Holder's Name", settings.bankAccountName] : null,
    settings.bankName ? ['Bank Name', settings.bankName] : null,
    settings.bankAccountNumber ? ['A/c No.', settings.bankAccountNumber] : null,
    settings.bankIFSC ? ['Branch & IFS Code', settings.bankIFSC] : null
  ].filter(Boolean);

  let by = footerTop + 5;
  doc.font('Helvetica').fontSize(8.2).fillColor('#000').text("Company's Bank Details", MID + 1, by);
  by += 11;
  bankLines.forEach(([label, value]) => {
    doc.font('Helvetica').fontSize(8).text(label, MID + 1, by, { width: 72 });
    doc.text(':', MID + 74, by);
    doc.font('Helvetica-Bold').text(' ' + value, MID + 78, by, { width: RIGHT - (MID + 78) - 2 });
    by += 11;
  });
  by += 20;
  doc.font('Helvetica-Bold').fontSize(8).text(`for ${settings.businessName || ''}`, MID + 1, by, { width: RIGHT - MID - 2, align: 'right' });
  by += 28;
  doc.moveTo(RIGHT - 130, by).lineTo(RIGHT - 2, by).lineWidth(0.5).stroke();
  by += 4;
  doc.font('Helvetica').fontSize(8).text('Authorised Signatory', MID + 1, by, { width: RIGHT - MID - 2, align: 'right' });
  by += 12;

  let dy = footerTop + 5;
  doc.font('Helvetica').fontSize(7.5).fillColor('#000');
  const declLabel = 'Declaration';
  doc.text(declLabel, LEFT + 2, dy);
  doc.moveTo(LEFT + 2, dy + 9).lineTo(LEFT + 2 + doc.widthOfString(declLabel), dy + 9).lineWidth(0.5).stroke();
  dy += 11;
  doc.font('Helvetica').fontSize(7.8).text(
    'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.',
    LEFT + 2, dy, { width: MID - LEFT - 6 }
  );
  dy += doc.heightOfString('We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.', { width: MID - LEFT - 6 }) + 8;

  const footerBottom = Math.max(by + 4, dy + 4);
  doc.lineWidth(0.75).strokeColor('#000');
  doc.rect(LEFT, footerTop, WIDTH, footerBottom - footerTop).stroke();
  doc.moveTo(MID, footerTop).lineTo(MID, footerBottom).stroke();

  y = footerBottom;

  if (invoice.notes) {
    y += 8;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#555').text('NOTES', LEFT, y);
    y += 11;
    doc.font('Helvetica').fontSize(8).fillColor('#333').text(invoice.notes, LEFT, y, { width: WIDTH });
    y += doc.heightOfString(invoice.notes, { width: WIDTH }) + 4;
  }
  if (invoice.terms) {
    y += 8;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#555').text('TERMS', LEFT, y);
    y += 11;
    doc.font('Helvetica').fontSize(8).fillColor('#333').text(invoice.terms, LEFT, y, { width: WIDTH });
  }

  const footerNoteY = doc.page.height - doc.page.margins.bottom - 14;
  doc.fontSize(7).fillColor('#888').text('This is a Computer Generated Invoice', LEFT, Math.max(footerNoteY, y + 20), { width: WIDTH, align: 'center' });

  doc.end();

  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve({ fileName, buffer: Buffer.concat(chunks) }));
    doc.on('error', reject);
  });
}

module.exports = { generateInvoicePdf };
