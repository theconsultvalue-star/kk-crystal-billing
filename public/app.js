const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const fmt = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let currentSettings = {};
let currentParties = [];
let currentItems = [];
let qbRows = [];

// ---------- Tabs ----------
function switchTab(name) {
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'history') return loadHistory();
  if (name === 'parties') return loadParties();
  if (name === 'items') return loadItemsMaster();
}

$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ---------- Quick Bill (paste-and-parse) ----------
function qbRowTotal(row) {
  const subtotal = row.qty * row.rate;
  return subtotal + subtotal * (row.taxPercent / 100);
}

function qbTypedSummary(row) {
  const orderLine = row.qty > 1 ? `${row.qty}×${row.rate}` : row.amount;
  return `${row.partyRaw}\n${orderLine} plus ${row.taxPercent}`;
}

function renderQbPreview() {
  const body = $('#qb-preview-body');
  body.innerHTML = '';
  $('#qb-preview-card').style.display = qbRows.length ? 'block' : 'none';

  qbRows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    const hasWarning = row.warnings.length > 0;
    if (hasWarning) tr.classList.add('qb-row-warn');

    const warningsHtml = row.warnings.map((w) => `<span class="qb-warning">⚠ ${w}</span>`).join('');
    const dupHtml = row.duplicateOf ? `<span class="qb-duplicate">⚠ Possible duplicate of ${row.duplicateOf}</span>` : '';
    const ewbThreshold = Number(currentSettings.ewayBillThreshold ?? 50000);
    const ewbHtml = qbRowTotal(row) >= ewbThreshold
      ? `<span class="qb-duplicate ewb-indicator">⚠ Needs an E-way Bill (₹${ewbThreshold.toLocaleString('en-IN')}+)</span>`
      : `<span class="ewb-indicator"></span>`;

    tr.innerHTML = `
      <td class="qb-you-typed">${qbTypedSummary(row)}</td>
      <td>
        <input type="text" class="qb-party" list="party-names" value="${(row.clientName || '').replace(/"/g, '&quot;')}" autocomplete="off" />
        ${warningsHtml}
      </td>
      <td><input type="text" class="qb-item" list="item-names" value="${(row.item.description || '').replace(/"/g, '&quot;')}" autocomplete="off" /></td>
      <td><input type="number" class="qb-qty" min="0" step="1" value="${row.qty}" /></td>
      <td><input type="number" class="qb-rate" min="0" step="0.01" value="${row.rate}" /></td>
      <td><input type="number" class="qb-tax" min="0" step="0.01" value="${row.taxPercent}" /></td>
      <td class="num qb-total">${fmt(qbRowTotal(row))}${ewbHtml}</td>
      <td>
        ${dupHtml}
        <label style="font-size:11px; display:flex; align-items:center; gap:4px; margin-top:3px;">
          <input type="checkbox" class="qb-include" ${row.duplicateOf ? '' : 'checked'} /> include
        </label>
      </td>
    `;

    const recalc = () => {
      row.clientName = tr.querySelector('.qb-party').value;
      const partyMatch = currentParties.find((p) => p.name.toLowerCase() === row.clientName.trim().toLowerCase());
      row.clientGSTIN = partyMatch ? partyMatch.gstin : '';
      row.clientAddress = partyMatch ? partyMatch.address : '';

      const desc = tr.querySelector('.qb-item').value;
      row.item.description = desc;
      const itemMatch = currentItems.find((i) => i.description.toLowerCase() === desc.trim().toLowerCase());
      row.item.hsn = itemMatch ? itemMatch.hsn : row.item.hsn;
      row.item.unit = row.item.unit || 'PAC';

      row.qty = Number(tr.querySelector('.qb-qty').value) || 0;
      row.rate = Number(tr.querySelector('.qb-rate').value) || 0;
      row.taxPercent = Number(tr.querySelector('.qb-tax').value) || 0;
      tr.querySelector('.qb-total').firstChild.textContent = fmt(qbRowTotal(row));

      const ewbT = Number(currentSettings.ewayBillThreshold ?? 50000);
      const indicator = tr.querySelector('.ewb-indicator');
      indicator.textContent = qbRowTotal(row) >= ewbT ? `⚠ Needs an E-way Bill (₹${ewbT.toLocaleString('en-IN')}+)` : '';
      indicator.classList.toggle('qb-duplicate', qbRowTotal(row) >= ewbT);
    };

    tr.querySelectorAll('.qb-party, .qb-item, .qb-qty, .qb-rate, .qb-tax').forEach((inp) => {
      inp.addEventListener('input', recalc);
    });
    tr.querySelector('.qb-include').addEventListener('change', (e) => {
      row.include = e.target.checked;
      tr.classList.toggle('qb-row-skip', !e.target.checked);
    });
    row.include = !row.duplicateOf;
    tr.classList.toggle('qb-row-skip', !row.include);

    body.appendChild(tr);
  });
}

$('#qb-parse-btn').addEventListener('click', async () => {
  const status = $('#qb-parse-status');
  const text = $('#qb-input').value;
  if (!text.trim()) {
    status.textContent = 'Paste something first.';
    status.className = 'error';
    return;
  }
  status.textContent = 'Parsing...';
  status.className = '';
  $('#qb-results-card').style.display = 'none';

  try {
    const res = await fetch('/api/quick-bill/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not parse that.');
    qbRows = data;
    renderQbPreview();
    status.textContent = `Found ${qbRows.length} bill${qbRows.length === 1 ? '' : 's'}. Review below before generating.`;
    status.className = 'success';
  } catch (err) {
    status.textContent = err.message;
    status.className = 'error';
  }
});

$('#qb-generate-btn').addEventListener('click', async () => {
  const status = $('#qb-generate-status');
  const toGenerate = qbRows.filter((r) => r.include);
  if (toGenerate.length === 0) {
    status.textContent = 'Nothing checked to generate.';
    status.className = 'error';
    return;
  }
  status.textContent = 'Generating...';
  status.className = '';

  try {
    const res = await fetch('/api/quick-bill/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: toGenerate })
    });
    const results = await res.json();

    const ewbThreshold = Number(currentSettings.ewayBillThreshold ?? 50000);
    const list = $('#qb-results-list');
    list.innerHTML = '';
    results.forEach((r) => {
      const li = document.createElement('li');
      if (r.ok) {
        const needsEwb = r.invoice.total >= ewbThreshold;
        li.innerHTML = `<span class="qb-ok">✓ ${r.invoice.number} — ${r.invoice.clientName} — ${fmt(r.invoice.total)}</span>
          <a class="pdf-link" href="${r.invoice.pdfUrl}" target="_blank">Open PDF</a>
          ${needsEwb ? '<button type="button" class="link-btn ewb-prompt-btn" style="color: var(--accent)">E-way Bill</button>' : ''}`;
        if (needsEwb) {
          li.querySelector('.ewb-prompt-btn').addEventListener('click', () => openEwayBillForm(r.invoice));
        }
      } else {
        li.innerHTML = `<span class="qb-fail">✗ ${r.row.clientName}: ${r.error}</span>`;
      }
      list.appendChild(li);
    });
    $('#qb-results-card').style.display = 'block';

    status.textContent = `Done — ${results.filter((r) => r.ok).length} of ${results.length} generated.`;
    status.className = 'success';

    // Reset for the next paste
    qbRows = [];
    $('#qb-preview-card').style.display = 'none';
    $('#qb-input').value = '';
    await refreshPartyDatalist();
    await refreshItemDatalist();
    const { number } = await fetch('/api/next-number').then((r) => r.json());
    $('#invoice-number').value = number;
  } catch (err) {
    status.textContent = err.message;
    status.className = 'error';
  }
});

// ---------- Line items ----------
const itemsBody = $('#items-body');

function findItemByDescription(desc) {
  const n = (desc || '').trim().toLowerCase();
  if (!n) return null;
  return currentItems.find((i) => i.description.toLowerCase() === n) || null;
}

function addItemRow(values = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="item-desc" list="item-names" placeholder="Description" value="${values.description || ''}" autocomplete="off" /></td>
    <td><input type="text" class="item-hsn" placeholder="HSN" value="${values.hsn || ''}" /></td>
    <td><input type="number" class="item-qty" min="0" step="1" value="${values.qty ?? 1}" /></td>
    <td><input type="text" class="item-unit" placeholder="pkt" value="${values.unit || ''}" /></td>
    <td><input type="number" class="item-rate" min="0" step="0.01" value="${values.rate ?? ''}" /></td>
    <td class="row-amount">₹0.00</td>
    <td><button type="button" class="remove-row" title="Remove">×</button></td>
  `;
  tr.querySelector('.remove-row').addEventListener('click', () => {
    tr.remove();
    recalc();
  });
  tr.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', recalc));
  tr.querySelector('.item-desc').addEventListener('input', (e) => {
    const match = findItemByDescription(e.target.value);
    if (match) {
      if (match.gstRate != null) {
        $('#taxPercent').value = match.gstRate;
      }
      tr.querySelector('.item-hsn').value = match.hsn || '';
      recalc();
    }
  });
  itemsBody.appendChild(tr);
}

$('#add-item').addEventListener('click', () => addItemRow());

function recalc() {
  let subtotal = 0;
  itemsBody.querySelectorAll('tr').forEach((tr) => {
    const qty = Number(tr.querySelector('.item-qty').value) || 0;
    const rate = Number(tr.querySelector('.item-rate').value) || 0;
    const amount = qty * rate;
    tr.querySelector('.row-amount').textContent = fmt(amount);
    subtotal += amount;
  });
  const discount = Number($('#discount').value) || 0;
  const taxPercent = Number($('#taxPercent').value) || 0;
  const taxAmount = (subtotal - discount) * (taxPercent / 100);
  const total = subtotal - discount + taxAmount;

  $('#sum-subtotal').textContent = fmt(subtotal);
  $('#sum-discount').textContent = fmt(discount);
  $('#sum-tax').textContent = fmt(taxAmount);
  $('#sum-total').textContent = fmt(total);
}

['#discount', '#taxPercent'].forEach((sel) => $(sel).addEventListener('input', recalc));

// ---------- Sale Parties: autocomplete on invoice form ----------
async function refreshPartyDatalist() {
  currentParties = await fetch('/api/parties').then((r) => r.json());
  const datalist = $('#party-names');
  datalist.innerHTML = currentParties
    .map((p) => `<option value="${p.name.replace(/"/g, '&quot;')}"></option>`)
    .join('');
}

function findPartyByName(name) {
  const n = (name || '').trim().toLowerCase();
  if (!n) return null;
  return currentParties.find((p) => p.name.toLowerCase() === n) || null;
}

$('#clientName').addEventListener('input', () => {
  const match = findPartyByName($('#clientName').value);
  if (match) {
    $('#clientGSTIN').value = match.gstin || '';
    $('#clientAddress').value = match.address || '';
  }
});

// ---------- Items: autocomplete on invoice form ----------
async function refreshItemDatalist() {
  currentItems = await fetch('/api/items').then((r) => r.json());
  const datalist = $('#item-names');
  datalist.innerHTML = currentItems
    .map((i) => `<option value="${i.description.replace(/"/g, '&quot;')}"></option>`)
    .join('');
}

// ---------- Init form ----------
async function initForm() {
  const settings = await fetch('/api/settings').then((r) => r.json());
  currentSettings = settings;
  $('#taxPercent').value = settings.defaultTaxPercent ?? 0;
  $('#terms').value = settings.defaultTerms || '';
  $('#date').value = new Date().toISOString().slice(0, 10);

  const { number } = await fetch('/api/next-number').then((r) => r.json());
  $('#invoice-number').value = number;

  await refreshItemDatalist();

  await refreshPartyDatalist();

  addItemRow();
  recalc();
}

// ---------- Submit invoice ----------
$('#invoice-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('#form-status');
  status.textContent = '';
  status.className = '';

  const items = [...itemsBody.querySelectorAll('tr')].map((tr) => ({
    description: tr.querySelector('.item-desc').value,
    hsn: tr.querySelector('.item-hsn').value,
    unit: tr.querySelector('.item-unit').value,
    qty: Number(tr.querySelector('.item-qty').value) || 0,
    rate: Number(tr.querySelector('.item-rate').value) || 0
  })).filter((i) => i.description || i.qty || i.rate);

  if (items.length === 0) {
    status.textContent = 'Add at least one line item.';
    status.className = 'error';
    return;
  }
  if (!$('#clientName').value.trim()) {
    status.textContent = 'Client name is required.';
    status.className = 'error';
    return;
  }

  const payload = {
    date: $('#date').value,
    dueDate: $('#dueDate').value,
    clientName: $('#clientName').value,
    clientAddress: $('#clientAddress').value,
    clientGSTIN: $('#clientGSTIN').value,
    items,
    discount: Number($('#discount').value) || 0,
    taxPercent: Number($('#taxPercent').value) || 0,
    notes: $('#notes').value,
    terms: $('#terms').value
  };

  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  status.textContent = 'Generating...';

  try {
    const res = await fetch('/api/invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to generate invoice.');

    const threshold = Number(currentSettings.ewayBillThreshold ?? 50000);
    const ewbPrompt = data.total >= threshold
      ? ` — <span class="qb-duplicate">⚠ ₹${threshold.toLocaleString('en-IN')}+, needs an E-way Bill</span> <button type="button" class="link-btn ewb-prompt-btn" style="color: var(--accent)">Generate it</button>`
      : '';
    status.innerHTML = `Bill ${data.number} created — <a class="pdf-link" href="${data.pdfUrl}" target="_blank">Open PDF</a>${ewbPrompt}`;
    status.className = 'success';
    if (data.total >= threshold) {
      status.querySelector('.ewb-prompt-btn').addEventListener('click', () => openEwayBillForm(data));
    }

    // Reset form for next bill
    document.getElementById('invoice-form').reset();
    itemsBody.innerHTML = '';
    await initForm();
  } catch (err) {
    status.textContent = err.message;
    status.className = 'error';
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------- History ----------
async function loadHistory() {
  const ledger = await fetch('/api/invoices').then((r) => r.json());
  const body = $('#history-body');
  body.innerHTML = '';
  $('#history-empty').style.display = ledger.length ? 'none' : 'block';
  $('#ewb-card').style.display = 'none';

  const threshold = Number(currentSettings.ewayBillThreshold ?? 50000);

  ledger.forEach((inv) => {
    const tr = document.createElement('tr');
    const showEwb = inv.total >= threshold;
    tr.innerHTML = `
      <td>${inv.number}</td>
      <td>${inv.date}</td>
      <td>${inv.clientName}</td>
      <td class="num">${fmt(inv.total)}</td>
      <td>
        <a class="pdf-link" href="/invoices-files/${inv.pdfFile}" target="_blank">PDF</a>
        &nbsp;·&nbsp;
        ${showEwb ? '<button class="link-btn ewb-btn" style="color: var(--accent)">E-way Bill</button>&nbsp;·&nbsp;' : ''}
        <button class="link-btn delete-btn">Delete</button>
      </td>
    `;
    tr.querySelector('.delete-btn').addEventListener('click', async () => {
      if (!confirm(`Delete invoice ${inv.number}? This cannot be undone.`)) return;
      await fetch(`/api/invoices/${inv.id}`, { method: 'DELETE' });
      loadHistory();
    });
    if (showEwb) {
      tr.querySelector('.ewb-btn').addEventListener('click', () => openEwayBillForm(inv));
    }
    body.appendChild(tr);
  });
}

// ---------- E-way Bill ----------
function ewbGuessPincode(address) {
  const m = (address || '').match(/\b(\d{6})\b/);
  return m ? m[1] : '';
}

function ewbGuessPlace(address) {
  if (!address) return '';
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!/^\d+$/.test(parts[i])) return parts[i];
  }
  return '';
}

async function openEwayBillForm(invoice) {
  // Callable from anywhere (New Invoice / Quick Bill success messages, not
  // just the Past Invoices row) — the form itself lives in that tab's panel.
  // Must wait for loadHistory() to finish before showing the card, since it
  // resets #ewb-card to hidden as part of its own render.
  await switchTab('history');
  $('#ewb-card').style.display = 'block';
  $('#ewb-invoice-label').textContent = `${invoice.number} — ${invoice.clientName} — ${fmt(invoice.total)}`;
  $('#ewb-fromPlace').value = ewbGuessPlace(currentSettings.businessAddress);
  $('#ewb-fromPincode').value = ewbGuessPincode(currentSettings.businessAddress);
  $('#ewb-toPlace').value = ewbGuessPlace(invoice.clientAddress);
  $('#ewb-toPincode').value = ewbGuessPincode(invoice.clientAddress);
  $('#ewb-transDistance').value = '';
  $('#ewb-vehicleNo').value = '';
  $('#ewb-transporterName').value = '';
  $('#ewb-transporterId').value = '';
  $('#ewb-status').textContent = '';
  $('#ewb-card').dataset.invoiceId = invoice.id;
  $('#ewb-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

$('#ewb-cancel-btn').addEventListener('click', () => {
  $('#ewb-card').style.display = 'none';
});

$('#ewb-generate-btn').addEventListener('click', async () => {
  const status = $('#ewb-status');
  const invoiceId = $('#ewb-card').dataset.invoiceId;
  const payload = {
    docType: $('#ewb-docType').value,
    subSupplyType: $('#ewb-subSupplyType').value,
    fromPlace: $('#ewb-fromPlace').value,
    fromPincode: $('#ewb-fromPincode').value,
    toPlace: $('#ewb-toPlace').value,
    toPincode: $('#ewb-toPincode').value,
    transMode: $('#ewb-transMode').value,
    transDistance: $('#ewb-transDistance').value,
    vehicleNo: $('#ewb-vehicleNo').value,
    vehicleType: $('#ewb-vehicleType').value,
    transporterName: $('#ewb-transporterName').value,
    transporterId: $('#ewb-transporterId').value
  };

  status.textContent = 'Building...';
  status.className = '';

  try {
    const res = await fetch(`/api/invoices/${invoiceId}/eway-bill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Could not build the e-way bill JSON.');

    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eway-bill-${json.docNo.replace(/[^a-zA-Z0-9-]/g, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    status.textContent = 'Downloaded. Upload this on the e-way bill portal yourself.';
    status.className = 'success';
  } catch (err) {
    status.textContent = err.message;
    status.className = 'error';
  }
});

// ---------- Sale Parties management tab ----------
let editingPartyId = null;

async function loadParties() {
  currentParties = await fetch('/api/parties').then((r) => r.json());
  const body = $('#parties-body');
  body.innerHTML = '';
  $('#parties-empty').style.display = currentParties.length ? 'none' : 'block';

  currentParties.forEach((p) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.name}</td>
      <td>${p.gstin || ''}</td>
      <td>${p.address || ''}</td>
      <td>
        <button type="button" class="link-btn edit-party" style="color: var(--accent)">Edit</button>
        &nbsp;·&nbsp;
        <button type="button" class="link-btn delete-party">Delete</button>
      </td>
    `;
    tr.querySelector('.edit-party').addEventListener('click', () => {
      editingPartyId = p.id;
      $('#p-name').value = p.name;
      $('#p-gstin').value = p.gstin || '';
      $('#p-address').value = p.address || '';
      $('#party-form-title').textContent = `Edit ${p.name}`;
      $('#party-submit-btn').textContent = 'Update Party';
      $('#party-cancel-edit').style.display = 'inline';
    });
    tr.querySelector('.delete-party').addEventListener('click', async () => {
      if (!confirm(`Delete party "${p.name}"?`)) return;
      await fetch(`/api/parties/${p.id}`, { method: 'DELETE' });
      loadParties();
      refreshPartyDatalist();
    });
    body.appendChild(tr);
  });
}

function resetPartyForm() {
  editingPartyId = null;
  $('#party-form').reset();
  $('#party-form-title').textContent = 'Add a Sale Party';
  $('#party-submit-btn').textContent = 'Add Party';
  $('#party-cancel-edit').style.display = 'none';
}

$('#party-cancel-edit').addEventListener('click', resetPartyForm);

$('#party-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('#party-status');
  const payload = {
    name: $('#p-name').value,
    gstin: $('#p-gstin').value,
    address: $('#p-address').value
  };
  if (!payload.name.trim()) {
    status.textContent = 'Name is required.';
    status.className = 'error';
    return;
  }

  if (editingPartyId) {
    await fetch(`/api/parties/${editingPartyId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } else {
    await fetch('/api/parties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  status.textContent = 'Saved.';
  status.className = 'success';
  setTimeout(() => { status.textContent = ''; }, 2000);
  resetPartyForm();
  loadParties();
  refreshPartyDatalist();
});

$('#bulk-import-btn').addEventListener('click', async () => {
  const status = $('#bulk-status');
  const raw = $('#bulk-import').value.trim();
  if (!raw) {
    status.textContent = 'Paste at least one line first.';
    status.className = 'error';
    return;
  }

  const parties = raw.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name, gstin, ...addressParts] = line.split(',').map((s) => s.trim());
    return { name, gstin: gstin || '', address: addressParts.join(', ') || '' };
  }).filter((p) => p.name);

  if (parties.length === 0) {
    status.textContent = 'Could not parse any parties from that text.';
    status.className = 'error';
    return;
  }

  const saved = await fetch('/api/parties/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parties })
  }).then((r) => r.json());

  status.textContent = `Imported ${saved.length} part${saved.length === 1 ? 'y' : 'ies'}.`;
  status.className = 'success';
  $('#bulk-import').value = '';
  loadParties();
  refreshPartyDatalist();
});

// ---------- Items management tab ----------
let editingItemId = null;

async function loadItemsMaster() {
  currentItems = await fetch('/api/items').then((r) => r.json());
  const body = $('#items-master-body');
  body.innerHTML = '';
  $('#items-master-empty').style.display = currentItems.length ? 'none' : 'block';

  currentItems.forEach((i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i.description}</td>
      <td>${i.hsn || ''}</td>
      <td class="num">${i.gstRate != null ? i.gstRate : ''}</td>
      <td>
        <button type="button" class="link-btn edit-item" style="color: var(--accent)">Edit</button>
        &nbsp;·&nbsp;
        <button type="button" class="link-btn delete-item">Delete</button>
      </td>
    `;
    tr.querySelector('.edit-item').addEventListener('click', () => {
      editingItemId = i.id;
      $('#i-description').value = i.description;
      $('#i-hsn').value = i.hsn || '';
      $('#i-gstRate').value = i.gstRate != null ? i.gstRate : '';
      $('#item-form-title').textContent = `Edit ${i.description}`;
      $('#item-submit-btn').textContent = 'Update Item';
      $('#item-cancel-edit').style.display = 'inline';
    });
    tr.querySelector('.delete-item').addEventListener('click', async () => {
      if (!confirm(`Delete item "${i.description}"?`)) return;
      await fetch(`/api/items/${i.id}`, { method: 'DELETE' });
      loadItemsMaster();
      refreshItemDatalist();
    });
    body.appendChild(tr);
  });
}

function resetItemForm() {
  editingItemId = null;
  $('#item-form').reset();
  $('#item-form-title').textContent = 'Add an Item';
  $('#item-submit-btn').textContent = 'Add Item';
  $('#item-cancel-edit').style.display = 'none';
}

$('#item-cancel-edit').addEventListener('click', resetItemForm);

$('#item-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('#item-status');
  const payload = {
    description: $('#i-description').value,
    hsn: $('#i-hsn').value,
    gstRate: $('#i-gstRate').value === '' ? null : Number($('#i-gstRate').value)
  };
  if (!payload.description.trim()) {
    status.textContent = 'Description is required.';
    status.className = 'error';
    return;
  }

  if (editingItemId) {
    await fetch(`/api/items/${editingItemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } else {
    await fetch('/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  status.textContent = 'Saved.';
  status.className = 'success';
  setTimeout(() => { status.textContent = ''; }, 2000);
  resetItemForm();
  loadItemsMaster();
  refreshItemDatalist();
});

$('#items-bulk-import-btn').addEventListener('click', async () => {
  const status = $('#items-bulk-status');
  const raw = $('#items-bulk-import').value.trim();
  if (!raw) {
    status.textContent = 'Paste at least one line first.';
    status.className = 'error';
    return;
  }

  const items = raw.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [description, hsn, gstRate] = line.split(',').map((s) => s.trim());
    return { description, hsn: hsn || '', gstRate: gstRate ? Number(gstRate) : null };
  }).filter((i) => i.description);

  if (items.length === 0) {
    status.textContent = 'Could not parse any items from that text.';
    status.className = 'error';
    return;
  }

  const saved = await fetch('/api/items/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items })
  }).then((r) => r.json());

  status.textContent = `Imported ${saved.length} item${saved.length === 1 ? '' : 's'}.`;
  status.className = 'success';
  $('#items-bulk-import').value = '';
  loadItemsMaster();
  refreshItemDatalist();
});

// ---------- Tally export ----------
// Defaults to the current month so the usual "send this month to Tally" is one click.
(function initTallyExport() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ym = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  $('#tally-from').value = `${ym}-01`;
  $('#tally-to').value = `${ym}-${pad(lastDay)}`;
})();

$('#tally-export-btn').addEventListener('click', () => {
  const from = $('#tally-from').value;
  const to = $('#tally-to').value;
  const status = $('#tally-status');
  if (from && to && from > to) {
    status.textContent = '"From" date is after "To" date.';
    status.className = 'error';
    return;
  }
  status.textContent = '';
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  // Navigating (rather than fetch) lets the browser save the attachment and
  // reuse the existing login.
  window.location.href = `/api/tally-export?${qs}`;
});

// ---------- Settings ----------
async function loadSettings() {
  const s = await fetch('/api/settings').then((r) => r.json());
  currentSettings = s;
  $('#s-businessName').value = s.businessName || '';
  $('#s-businessAddress').value = s.businessAddress || '';
  $('#s-businessGSTIN').value = s.businessGSTIN || '';
  $('#s-businessEmail').value = s.businessEmail || '';
  $('#s-businessPhone').value = s.businessPhone || '';
  $('#s-bankAccountName').value = s.bankAccountName || '';
  $('#s-bankName').value = s.bankName || '';
  $('#s-bankAccountNumber').value = s.bankAccountNumber || '';
  $('#s-bankIFSC').value = s.bankIFSC || '';
  $('#s-invoicePrefix').value = s.invoicePrefix || 'INV-';
  $('#s-nextNumber').value = s.nextNumber || 1;
  $('#s-defaultTaxPercent').value = s.defaultTaxPercent ?? 0;
  $('#s-defaultTerms').value = s.defaultTerms || '';
  $('#s-ewayBillThreshold').value = s.ewayBillThreshold ?? 50000;
  $('#s-tallyCompanyName').value = s.tallyCompanyName || '';
  $('#s-tallySalesLedger').value = s.tallySalesLedger || 'Sales @{rate}%';
  $('#s-tallyCgstLedger').value = s.tallyCgstLedger || 'CGST Output @{rate}%';
  $('#s-tallySgstLedger').value = s.tallySgstLedger || 'SGST Output @{rate}%';
  $('#s-tallyIgstLedger').value = s.tallyIgstLedger || 'IGST Output @{rate}%';
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('#settings-status');
  const payload = {
    businessName: $('#s-businessName').value,
    businessAddress: $('#s-businessAddress').value,
    businessGSTIN: $('#s-businessGSTIN').value,
    businessEmail: $('#s-businessEmail').value,
    businessPhone: $('#s-businessPhone').value,
    bankAccountName: $('#s-bankAccountName').value,
    bankName: $('#s-bankName').value,
    bankAccountNumber: $('#s-bankAccountNumber').value,
    bankIFSC: $('#s-bankIFSC').value,
    invoicePrefix: $('#s-invoicePrefix').value,
    nextNumber: Number($('#s-nextNumber').value) || 1,
    defaultTaxPercent: Number($('#s-defaultTaxPercent').value) || 0,
    defaultTerms: $('#s-defaultTerms').value,
    ewayBillThreshold: Number($('#s-ewayBillThreshold').value) || 0,
    tallyCompanyName: $('#s-tallyCompanyName').value.trim(),
    tallySalesLedger: $('#s-tallySalesLedger').value.trim() || 'Sales @{rate}%',
    tallyCgstLedger: $('#s-tallyCgstLedger').value.trim() || 'CGST Output @{rate}%',
    tallySgstLedger: $('#s-tallySgstLedger').value.trim() || 'SGST Output @{rate}%',
    tallyIgstLedger: $('#s-tallyIgstLedger').value.trim() || 'IGST Output @{rate}%'
  };
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  currentSettings = { ...currentSettings, ...payload };
  status.textContent = 'Saved.';
  status.className = 'success';
  setTimeout(() => { status.textContent = ''; }, 2000);
});

// ---------- Boot ----------
initForm();
loadSettings();
