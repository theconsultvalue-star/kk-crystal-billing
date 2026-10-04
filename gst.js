// Shared GST helpers used by both the PDF template and the e-way bill
// JSON builder, so the state-code table only lives in one place.

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

// Best-effort pincode extraction from a free-text address (our data model
// doesn't store structured address fields) — looks for a standalone 6-digit
// number, which is how Indian PINs appear in practice.
function pincodeFromAddress(address) {
  const m = (address || '').match(/\b(\d{6})\b/);
  return m ? m[1] : '';
}

// Best-effort "place" (city/town) extraction: the last comma-separated
// segment that isn't a pincode or the state name itself.
function placeFromAddress(address, stateN) {
  if (!address) return '';
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (/^\d+$/.test(p)) continue;
    if (stateN && p.toLowerCase() === stateN.toLowerCase()) continue;
    return p;
  }
  return '';
}

module.exports = { stateCode, GST_STATE_NAMES, stateName, stateNameFromAddress, pincodeFromAddress, placeFromAddress };
