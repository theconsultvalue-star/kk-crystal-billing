// Builds the JSON for a single E-way Bill, matching the standard NIC/GSP
// e-way-bill-generation schema (the same field set used by the official
// "Bulk Generation" tool and by the e-way bill API). This is NOT submitted
// anywhere automatically — it's handed back to the user to upload themselves
// at ewaybillgst.gov.in, since logging into a government portal on someone
// else's behalf is out of scope here.
//
// IMPORTANT: verify field names/formats against the current official
// template (e-way bill portal → Help → Tools → Bulk Generation → download
// the JSON format) before relying on this for a real shipment — the schema
// has been stable for years but this hasn't been tested against the live
// portal.

const { stateCode, stateName, pincodeFromAddress, placeFromAddress } = require('./gst');

const SUPPLY_TYPES = { supply: '1', export: '3', jobwork: '4', ownuse: '5', others: '8' };
const DOC_TYPES = { INV: 'INV', BIL: 'BIL', CHL: 'CHL', OTH: 'OTH' };
const TRANS_MODES = { road: '1', rail: '2', air: '3', ship: '4' };

function toDDMMYYYY(isoDate) {
  const [y, m, d] = (isoDate || '').split('-');
  if (!y || !m || !d) return '';
  return `${d}/${m}/${y}`;
}

function splitAddressLines(address) {
  const parts = (address || '').split(',').map((s) => s.trim()).filter(Boolean);
  // Addr1/Addr2 are the building/street-level parts — drop the trailing
  // place/state/pincode segments the e-way bill schema already has its own
  // fields for.
  return { addr1: parts[0] || '', addr2: parts.slice(1, -2).join(', ') };
}

function buildEwayBillJson(invoice, settings, extra) {
  const sellerStateC = stateCode(settings.businessGSTIN);
  const buyerStateC = stateCode(invoice.clientGSTIN) || sellerStateC;
  const sellerState = stateName(settings.businessGSTIN, settings.businessAddress);
  const buyerState = stateName(invoice.clientGSTIN, invoice.clientAddress) || sellerState;

  const fromAddr = splitAddressLines(settings.businessAddress);
  const toAddr = splitAddressLines(invoice.clientAddress);

  // Tax breakup (CGST+SGST vs IGST) isn't stored on the invoice — it's
  // derived from seller/buyer state codes the same way the PDF does.
  const isIgst = !!(sellerStateC && buyerStateC && sellerStateC !== buyerStateC);
  const cgst = isIgst ? 0 : invoice.taxAmount / 2;
  const sgst = cgst;
  const igst = isIgst ? invoice.taxAmount : 0;

  return {
    supplyType: extra.supplyType === 'inward' ? 'I' : 'O',
    subSupplyType: SUPPLY_TYPES[extra.subSupplyType] || SUPPLY_TYPES.supply,
    subSupplyDesc: extra.subSupplyDesc || '',
    docType: DOC_TYPES[extra.docType] || DOC_TYPES.INV,
    docNo: invoice.number,
    docDate: toDDMMYYYY(invoice.date),

    fromGstin: settings.businessGSTIN || '',
    fromTrdName: settings.businessName || '',
    fromAddr1: fromAddr.addr1,
    fromAddr2: fromAddr.addr2,
    fromPlace: extra.fromPlace || placeFromAddress(settings.businessAddress, sellerState),
    fromPincode: Number(extra.fromPincode || pincodeFromAddress(settings.businessAddress)) || '',
    fromStateCode: Number(sellerStateC) || '',
    actFromStateCode: Number(sellerStateC) || '',

    toGstin: invoice.clientGSTIN || '',
    toTrdName: invoice.clientName || '',
    toAddr1: toAddr.addr1,
    toAddr2: toAddr.addr2,
    toPlace: extra.toPlace || placeFromAddress(invoice.clientAddress, buyerState),
    toPincode: Number(extra.toPincode || pincodeFromAddress(invoice.clientAddress)) || '',
    toStateCode: Number(buyerStateC) || '',
    actToStateCode: Number(buyerStateC) || '',

    transactionType: 1,
    totalValue: Number(invoice.subtotal.toFixed(2)),
    cgstValue: Number(cgst.toFixed(2)),
    sgstValue: Number(sgst.toFixed(2)),
    igstValue: Number(igst.toFixed(2)),
    cessValue: 0,
    cessNonAdvolValue: 0,
    totInvValue: Number(invoice.total.toFixed(2)),

    transporterId: extra.transporterId || '',
    transporterName: extra.transporterName || '',
    transDocNo: extra.transDocNo || '',
    transDocDate: extra.transDocDate ? toDDMMYYYY(extra.transDocDate) : '',
    transMode: TRANS_MODES[extra.transMode] || TRANS_MODES.road,
    transDistance: String(extra.transDistance || ''),
    vehicleNo: (extra.vehicleNo || '').toUpperCase().replace(/\s+/g, ''),
    vehicleType: extra.vehicleType === 'odc' ? 'O' : 'R',

    itemList: invoice.items.map((item) => ({
      productName: item.description,
      productDesc: item.description,
      hsnCode: Number((item.hsn || '').replace(/\D/g, '')) || '',
      quantity: item.qty,
      qtyUnit: (item.unit || 'OTH').toUpperCase(),
      taxableAmount: Number(item.amount.toFixed(2)),
      cgstRate: isIgst ? 0 : invoice.taxPercent / 2,
      sgstRate: isIgst ? 0 : invoice.taxPercent / 2,
      igstRate: isIgst ? invoice.taxPercent : 0,
      cessRate: 0,
      cessAdvol: 0,
      cessNonAdvol: 0
    }))
  };
}

module.exports = { buildEwayBillJson };
