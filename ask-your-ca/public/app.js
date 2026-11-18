(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  let me = null;                 // { name, team, isOwner, owner, aiConfigured, services }
  let conversations = [];
  let clientList = [];
  let section = 'discussions';   // sidebar section
  let current = null;            // open discussion
  let pendingClientId = '';      // client chosen for a new question
  let currentClient = null;      // open client file
  let mode = 'ask';
  let busy = false;

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtTime = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const clientName = (id) => (clientList.find((c) => c.id === id) || {}).name || '';

  async function api(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (r.status === 401) { location.href = '/login'; throw new Error('Logged out'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  }

  function toast(msg) {
    document.querySelectorAll('.toast').forEach((old) => old.remove());
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
  }

  // ---------- small, safe Markdown renderer (input escaped first) ----------
  const BULLET = /^\s*[-*•]\s+/;
  const NUMBER = /^\s*\d+[.)]\s+/;
  const TABLE_ROW = /^\s*\|.*\|\s*$/;
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,;:])/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  function markdown(md) {
    const lines = esc(md).split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push(`<pre><code>${code.join('\n')}</code></pre>`);
        continue;
      }
      if (TABLE_ROW.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(cells(lines[i++]));
        out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { const l = h[1].length <= 2 ? 3 : 4; out.push(`<h${l}>${inline(h[2])}</h${l}>`); i++; continue; }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (BULLET.test(line) || NUMBER.test(line)) {
        const marker = NUMBER.test(line) ? NUMBER : BULLET;
        const items = [];
        while (i < lines.length && marker.test(lines[i])) {
          items.push(inline(lines[i].replace(marker, '')));
          i++;
          while (i < lines.length && /^\s{2,}[-*•]\s+/.test(lines[i])) {
            items[items.length - 1] += '<br>– ' + inline(lines[i].replace(/^\s+[-*•]\s+/, ''));
            i++;
          }
        }
        const tag = marker === NUMBER ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map((t) => `<li>${t}</li>`).join('')}</${tag}>`);
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const para = [inline(line)];
      i++;
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```)/.test(lines[i]) && !BULLET.test(lines[i]) && !NUMBER.test(lines[i]) && !TABLE_ROW.test(lines[i])) para.push(inline(lines[i++]));
      out.push(`<p>${para.join('<br>')}</p>`);
    }
    return out.join('');
  }

  function refsHtml(sources) {
    const web = (sources || []).filter((s) => s.url);
    const team = (sources || []).filter((s) => s.type === 'team');
    let html = '';
    if (team.length) {
      html += `<details class="refs" open><summary>Past team discussions checked (${team.length})</summary><ul>${team
        .map((t) => `<li><button class="link-btn" data-open-conv="${esc(t.conversationId)}">${esc(t.title)}</button> <span class="muted">· ${fmtDate(t.date)}</span></li>`)
        .join('')}</ul></details>`;
    }
    if (web.length) {
      html += `<details class="refs"><summary>Web sources (${web.length})</summary><ol>${web
        .map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a></li>`)
        .join('')}</ol></details>`;
    }
    return html;
  }

  // ---------- header ----------
  function setHead(title, meta, actions = []) {
    $('#head-title').textContent = title;
    $('#head-meta').innerHTML = meta;
    const box = $('#head-actions');
    box.innerHTML = '';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = a.primary ? 'btn-plain' : `btn-text ${a.danger ? 'danger' : ''}`;
      b.textContent = a.label;
      b.addEventListener('click', a.onClick);
      box.appendChild(b);
    }
  }

  function showView(name) {
    $('#view-chat').style.display = name === 'chat' ? '' : 'none';
    $('#view-client').style.display = name === 'client' ? '' : 'none';
    $('#sidebar').classList.remove('open');
  }

  // ---------- sidebar ----------
  function setSection(s) {
    section = s;
    $$('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.section === s));
    $('#side-discussions').style.display = s === 'discussions' ? '' : 'none';
    $('#side-clients').style.display = s === 'clients' ? '' : 'none';
    renderSide();
  }
  $$('.seg button').forEach((b) => b.addEventListener('click', () => setSection(b.dataset.section)));

  let searchResults = null;
  function renderSide() {
    const list = $('#side-list');
    if (section === 'discussions') {
      if (searchResults) {
        list.innerHTML = `<h3>Search results (${searchResults.length})</h3>` + (searchResults.length ? searchResults.map((r) => `
          <button class="conv-item" data-open-conv="${esc(r.conversationId)}">
            <div class="conv-title">${esc(r.title)}</div>
            <div class="conv-snippet"><span class="tag ${r.kind === 'note' ? 'note' : ''}">${r.kind === 'note' ? 'note' : 'Q'}</span>${esc(r.snippet)}</div>
            <div class="conv-meta">${esc(r.who)} · ${fmtDate(r.date)}</div>
          </button>`).join('') : '<p class="muted pad">Nothing found. Try other words, a section number or a form name.</p>');
      } else {
        list.innerHTML = `<h3>Team discussions (${conversations.length})</h3>` + (conversations.length ? conversations.map((c) => `
          <button class="conv-item ${current && current.id === c.id ? 'active' : ''}" data-open-conv="${esc(c.id)}">
            <div class="conv-title">${esc(c.title)}</div>
            <div class="conv-meta">${c.clientId && clientName(c.clientId) ? `<span class="tag client">${esc(clientName(c.clientId))}</span>` : ''}${esc(c.createdBy)} · ${fmtDate(c.updatedAt)} · ${c.questions} Q${c.notes ? ` · ${c.notes} note${c.notes > 1 ? 's' : ''}` : ''}</div>
          </button>`).join('') : '<p class="muted pad">No discussions yet. Ask the first question.</p>');
      }
    } else {
      const f = $('#client-filter').value.trim().toLowerCase();
      const mine = $('#only-mine').checked;
      const rows = clientList.filter((c) => {
        if (mine && c.assignedTo.toLowerCase() !== me.name.toLowerCase()) return false;
        if (!f) return true;
        return [c.name, c.pan, c.gstin, c.assignedTo, c.entityType].join(' ').toLowerCase().includes(f);
      });
      list.innerHTML = `<h3>Clients (${rows.length}${rows.length !== clientList.length ? ` of ${clientList.length}` : ''})</h3>` + (rows.length ? rows.map((c) => `
        <button class="conv-item ${currentClient && currentClient.id === c.id ? 'active' : ''}" data-open-client="${esc(c.id)}">
          <div class="conv-title">${esc(c.name)}</div>
          <div class="conv-meta">${esc([c.entityType, c.assignedTo && `handled by ${c.assignedTo}`].filter(Boolean).join(' · ') || '—')}</div>
        </button>`).join('') : `<p class="muted pad">${clientList.length ? 'No client matches.' : 'No clients yet. Add your first client.'}</p>`);
    }
  }

  async function loadLists() {
    [conversations, clientList] = await Promise.all([api('/api/conversations'), api('/api/clients')]);
    fillClientSelect();
    renderSide();
  }

  let searchTimer;
  $('#search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = $('#search').value.trim();
      searchResults = q ? await api('/api/search?q=' + encodeURIComponent(q)) : null;
      renderSide();
    }, 250);
  });
  $('#client-filter').addEventListener('input', renderSide);
  $('#only-mine').addEventListener('change', renderSide);

  // Any element with data-open-conv / data-open-client opens it.
  document.addEventListener('click', (e) => {
    const conv = e.target.closest('[data-open-conv]');
    if (conv) { openConversation(conv.dataset.openConv); return; }
    const cl = e.target.closest('[data-open-client]');
    if (cl) openClient(cl.dataset.openClient);
  });

  // ================= DISCUSSIONS =================
  function itemEl(it) {
    const div = document.createElement('div');
    div.className = `msg ${it.kind}`;
    const who = it.kind === 'answer' ? 'Ask your CA' : it.kind === 'note' ? `Team note · ${it.author}` : it.author;
    const body = it.kind === 'answer' ? markdown(it.text) + refsHtml(it.sources) : esc(it.text);
    div.innerHTML = `<div class="msg-who">${esc(who)}<time>${it.createdAt ? fmtTime(it.createdAt) : ''}</time></div><div class="msg-body">${body}</div>`;
    return div;
  }

  const SUGGESTIONS = [
    'Which GST, TDS and ROC due dates fall this month?',
    'Can we claim ITC on a car purchased for business? Explain section 17(5).',
    'Client got a DRC-01A intimation. What should we do and by when?',
    'Old vs new tax regime for a salaried person earning ₹18 lakh — which is better?',
    'Annual ROC filings for a small private limited company — forms and due dates?',
    'Explain Ind AS 115 five-step model with a journal-entry example.'
  ];

  function renderThread() {
    const thread = $('#thread');
    thread.innerHTML = '';
    if (!me.aiConfigured) thread.insertAdjacentHTML('beforeend', '<div class="notice">The advisor is not switched on yet (no ANTHROPIC_API_KEY on the server), so new questions cannot be answered. Client files, past discussions and notes all work.</div>');
    if (!current) {
      thread.insertAdjacentHTML('beforeend', `<div class="welcome"><h2>What do you want to know today?</h2>
        <p>Accounting, income tax, GST, TDS, ROC/MCA compliance, audit, costing, FEMA and finance — textbook and practical.
        The advisor checks the latest notifications, the team's past discussions and your client files.</p>
        <div class="chips">${SUGGESTIONS.map((s) => `<button class="chip">${esc(s)}</button>`).join('')}</div></div>`);
      thread.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => ask(c.textContent)));
    } else {
      current.items.forEach((it) => thread.appendChild(itemEl(it)));
    }
    thread.scrollTop = thread.scrollHeight;
  }

  function renderChatHead() {
    if (!current) {
      setHead('New question', 'Ask anything — the whole team will see it, and it becomes part of the shared knowledge base.');
    } else {
      const cl = current.clientId && clientName(current.clientId);
      const actions = [{ label: 'Rename', onClick: renameConversation }];
      if (current.createdBy === me.name || me.isOwner) actions.push({ label: 'Delete', danger: true, onClick: deleteConversation });
      setHead(current.title,
        `Started by ${esc(current.createdBy)} · ${fmtDate(current.createdAt)}${cl ? ` · client <button class="link-btn" data-open-client="${esc(current.clientId)}">${esc(cl)}</button>` : ''}`,
        actions);
    }
    $('#note-mode-btn').disabled = !current;
    if (!current && mode === 'note') setMode('ask');
    $('#client-select').value = current ? current.clientId || '' : pendingClientId;
  }

  function fillClientSelect() {
    const sel = $('#client-select');
    const value = current ? current.clientId || '' : pendingClientId;
    sel.innerHTML = '<option value="">— none —</option>' + clientList.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    sel.value = value;
  }
  $('#client-select').addEventListener('change', async (e) => {
    const id = e.target.value;
    if (!current) { pendingClientId = id; return; }
    try {
      await api('/api/conversations/' + encodeURIComponent(current.id), { method: 'PATCH', body: JSON.stringify({ clientId: id || null }) });
      current.clientId = id || null;
      renderChatHead();
      await loadLists();
      toast(id ? `Linked to ${clientName(id)}` : 'Client link removed');
    } catch (err) { alert(err.message); }
  });

  function setMode(m) {
    mode = m;
    $$('#mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    $('#send').textContent = m === 'ask' ? 'Ask' : 'Add note';
    $('#input').placeholder = m === 'ask'
      ? 'Ask anything — e.g. TDS on rent paid to a partner, 43B(h) MSME payments, tax audit limit…'
      : 'Record what the team did or decided — e.g. "Filed reply on 12 Nov; officer accepted the 17(5) position after we showed the logbook."';
  }
  $$('#mode button').forEach((b) => b.addEventListener('click', () => !b.disabled && setMode(b.dataset.mode)));

  async function openConversation(id, { clientId = '' } = {}) {
    if (busy) return;
    current = id ? await api('/api/conversations/' + encodeURIComponent(id)) : null;
    currentClient = null;
    pendingClientId = id ? '' : clientId;
    location.hash = id ? 'd/' + id : '';
    if (section !== 'discussions') setSection('discussions');
    showView('chat');
    renderChatHead();
    renderThread();
    renderSide();
  }

  async function renameConversation() {
    const t = prompt('Rename this discussion', current.title);
    if (!t || !t.trim()) return;
    await api('/api/conversations/' + encodeURIComponent(current.id), { method: 'PATCH', body: JSON.stringify({ title: t }) });
    current.title = t.trim();
    renderChatHead();
    await loadLists();
  }

  async function deleteConversation() {
    if (!confirm('Delete this discussion for the whole team? Its questions, answers and notes will be removed from the knowledge base.')) return;
    try {
      await api('/api/conversations/' + encodeURIComponent(current.id), { method: 'DELETE' });
      await openConversation(null);
      await loadLists();
    } catch (err) { alert(err.message); }
  }

  const STATUS = {
    thinking: 'Thinking it through…',
    searching_kb: "Looking through the team's past discussions…",
    searching_web: 'Checking the latest notifications and sources…',
    client_file: 'Opening the client file…',
    writing: ''
  };

  async function ask(question) {
    question = (question || '').trim();
    if (busy || !question) return;
    busy = true;
    $('#send').disabled = true;
    $('#input').value = '';

    const thread = $('#thread');
    if (!current) thread.innerHTML = '';
    thread.appendChild(itemEl({ kind: 'question', author: me.name, text: question, createdAt: new Date().toISOString() }));
    const ansEl = itemEl({ kind: 'answer', text: '' });
    const body = ansEl.querySelector('.msg-body');
    body.innerHTML = `<div class="status">${STATUS.thinking}</div>`;
    thread.appendChild(ansEl);
    thread.scrollTop = thread.scrollHeight;

    let text = '';
    let status = STATUS.thinking;
    const kbChecked = [];
    const saved = [];
    let convId = current ? current.id : null;
    let finished = false;
    let errorMsg = '';

    const paint = () => {
      const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 90;
      body.innerHTML = markdown(text) + (status ? `<div class="status">${esc(status)}</div>` : '')
        + saved.map((s) => `<div class="saved-badge">✓ Saved to <button class="link-btn" data-open-client="${esc(s.client.id)}">${esc(s.client.name)}</button>'s file</div>`).join('')
        + refsHtml(kbChecked);
      if (nearBottom) thread.scrollTop = thread.scrollHeight;
    };

    try {
      const r = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: convId, clientId: convId ? undefined : pendingClientId || undefined, question })
      });
      if (r.status === 401) { location.href = '/login'; return; }
      if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({}))).error || `Request failed (${r.status})`);
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.type === 'conversation') {
            convId = ev.id;
            if (!current) setHead(ev.title, `Started by ${esc(me.name)} · just now`);
          } else if (ev.type === 'status') { status = STATUS[ev.status] ?? ''; paint(); }
          else if (ev.type === 'text') { text += ev.text; paint(); }
          else if (ev.type === 'reset_step') { text = text.slice(0, Math.max(0, text.length - ev.length)); paint(); }
          else if (ev.type === 'kb') {
            for (const h of ev.hits) if (!kbChecked.some((k) => k.conversationId === h.conversationId)) kbChecked.push(h);
            paint();
          } else if (ev.type === 'client_saved') { saved.push(ev); paint(); }
          else if (ev.type === 'error') { errorMsg = ev.error; }
          else if (ev.type === 'done') { finished = true; }
        }
      }
    } catch (err) {
      errorMsg = err.message || 'Could not reach the server.';
    }

    busy = false;
    $('#send').disabled = false;
    if (finished && convId) {
      await loadLists();
      await openConversation(convId);
      if (saved.length) toast(`Saved to ${saved.map((s) => s.client.name).join(', ')}'s file`);
    } else {
      status = '';
      if (text) text += '\n\n_(answer interrupted — it was not saved; please ask again)_';
      paint();
      if (!text && !saved.length) ansEl.remove();
      const e = document.createElement('div');
      e.className = 'msg error';
      e.textContent = errorMsg || 'The answer did not finish. Please ask again.';
      thread.appendChild(e);
      thread.scrollTop = thread.scrollHeight;
      $('#input').value = question;
      await loadLists();
    }
    $('#input').focus();
  }

  async function addNote(text) {
    text = (text || '').trim();
    if (!text || !current || busy) return;
    $('#send').disabled = true;
    try {
      const note = await api(`/api/conversations/${encodeURIComponent(current.id)}/notes`, { method: 'POST', body: JSON.stringify({ text }) });
      current.items.push(note);
      $('#input').value = '';
      renderThread();
      await loadLists();
      setMode('ask');
    } catch (err) {
      alert(err.message);
    } finally {
      $('#send').disabled = false;
    }
  }

  $('#compose').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#input').value;
    if (mode === 'ask') ask(v); else addNote(v);
  });
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); $('#compose').requestSubmit(); }
  });
  $('#new-conv').addEventListener('click', () => {
    $('#search').value = '';
    searchResults = null;
    openConversation(null);
    setMode('ask');
    $('#input').focus();
  });

  // ================= CLIENTS =================
  const KIND_LABEL = { note: 'Note', preference: 'Preference', compliance: 'Compliance / filing', call: 'Call / meeting', change: 'Record updated' };
  const FIELD_ROWS = [
    ['entityType', 'Entity type'], ['pan', 'PAN'], ['gstin', 'GSTIN'], ['tan', 'TAN'], ['cin', 'CIN / LLPIN'],
    ['state', 'State'], ['address', 'Address'], ['since', 'Client since'], ['assignedTo', 'Handled by']
  ];

  function phoneLinks(phone) {
    const tel = phone.replace(/[^\d+]/g, '');
    if (!tel) return esc(phone);
    // WhatsApp only for Indian mobile numbers (10 digits starting 6–9, optionally with 91/0 prefix).
    const d = phone.replace(/\D/g, '').replace(/^(0|91)(?=[6-9]\d{9}$)/, '');
    const wa = /^[6-9]\d{9}$/.test(d) ? '91' + d : null;
    return `<a href="tel:${esc(tel)}">${esc(phone)}</a>
      <a class="pill" href="tel:${esc(tel)}">Call</a>
      ${wa ? `<a class="pill wa" href="https://wa.me/${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ''}`;
  }

  async function openClient(id) {
    if (busy) return;
    currentClient = await api('/api/clients/' + encodeURIComponent(id));
    current = null;
    location.hash = 'c/' + id;
    if (section !== 'clients') setSection('clients');
    renderClient();
    renderSide();
  }

  function canRemove(item) {
    return item.kind !== 'change' && (me.isOwner || item.author === me.name || item.author === `${me.name} (via Ask your CA)`);
  }

  function renderClient() {
    const c = currentClient;
    const p = c.profile || {};
    showView('client');
    const actions = [
      { label: 'Ask about this client', primary: true, onClick: () => openConversation(null, { clientId: c.id }).then(() => { fillClientSelect(); $('#input').focus(); }) },
      { label: 'Edit', onClick: () => renderClientForm(c) }
    ];
    if (me.isOwner) actions.push({ label: 'Delete', danger: true, onClick: deleteClient });
    setHead(c.name, `${esc(p.entityType || 'Client')}${p.assignedTo ? ` · handled by <strong>${esc(p.assignedTo)}</strong>` : ''} · updated ${fmtDate(c.updatedAt)} by ${esc(c.updatedBy)}`, actions);

    const kv = FIELD_ROWS.filter(([k]) => p[k]).map(([k, label]) => `<dt>${label}</dt><dd>${esc(p[k])}</dd>`).join('');
    const contacts = (p.contacts || []).map((ct) => `
      <div class="contact">
        <div class="contact-name">${esc(ct.name || '—')}${ct.role ? ` <span class="muted">· ${esc(ct.role)}</span>` : ''}</div>
        ${ct.phone ? `<div class="contact-line">${phoneLinks(ct.phone)}</div>` : ''}
        ${ct.email ? `<div class="contact-line"><a href="mailto:${esc(ct.email)}">${esc(ct.email)}</a></div>` : ''}
      </div>`).join('');
    const block = (title, text, cls = '') => (text ? `<section class="cblock ${cls}"><h3>${title}</h3><div class="ctext">${esc(text)}</div></section>` : '');

    $('#view-client').innerHTML = `
      <div class="client-grid">
        <div class="client-col">
          ${block('⚠ Always remember', p.important, 'important')}
          <section class="cblock"><h3>Contacts</h3>${contacts || '<p class="muted">No contacts yet — click Edit to add.</p>'}</section>
          <section class="cblock"><h3>Key details</h3>${kv ? `<dl class="kv">${kv}</dl>` : '<p class="muted">No details yet — click Edit to add.</p>'}</section>
          ${p.services && p.services.length ? `<section class="cblock"><h3>Services we handle</h3><div class="svc">${p.services.map((s) => `<span class="tag client">${esc(s)}</span>`).join('')}</div></section>` : ''}
          ${block('Preferences', p.preferences)}
          ${block('Fees & billing', p.billing)}
          ${block('Portal user IDs', p.portalIds)}
        </div>
        <div class="client-col">
          <section class="cblock">
            <h3>History &amp; notes</h3>
            <form id="item-form" class="item-form">
              <select id="item-kind">
                <option value="note">Note</option><option value="preference">Preference</option>
                <option value="compliance">Compliance / filing</option><option value="call">Call / meeting</option>
              </select>
              <textarea id="item-text" rows="2" placeholder="e.g. Called Mr Sharma — GSTR-9 data to come by 15 Dec. Prefers WhatsApp after 7 pm."></textarea>
              <button class="btn-primary" type="submit">Add</button>
            </form>
            <div class="timeline">${(c.items || []).map((it) => `
              <div class="tl-item kind-${esc(it.kind)}">
                <div class="tl-meta"><span class="tag ${it.kind === 'preference' ? 'note' : it.kind === 'compliance' ? 'client' : ''}">${KIND_LABEL[it.kind] || it.kind}</span>${esc(it.author)} · ${fmtTime(it.createdAt)}
                  ${canRemove(it) ? `<button class="btn-text danger tl-del" data-del-item="${esc(it.id)}" title="Remove">✕</button>` : ''}</div>
                <div class="tl-text">${esc(it.text)}</div>
              </div>`).join('')}</div>
          </section>
          <section class="cblock">
            <h3>Discussions about this client (${c.conversations.length})</h3>
            ${c.conversations.length ? `<ul class="plain">${c.conversations.map((d) => `<li><button class="link-btn" data-open-conv="${esc(d.id)}">${esc(d.title)}</button> <span class="muted">· ${esc(d.createdBy)} · ${fmtDate(d.updatedAt)}</span></li>`).join('')}</ul>` : '<p class="muted">None yet. Use “Ask about this client”.</p>'}
          </section>
        </div>
      </div>`;

    $('#item-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('#item-text').value.trim();
      if (!text) return;
      try {
        await api(`/api/clients/${encodeURIComponent(c.id)}/items`, { method: 'POST', body: JSON.stringify({ kind: $('#item-kind').value, text }) });
        await openClient(c.id);
        toast('Added to the client file');
      } catch (err) { alert(err.message); }
    });
    $('#view-client').querySelectorAll('[data-del-item]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Remove this entry from the client file?')) return;
      try {
        await api(`/api/clients/${encodeURIComponent(c.id)}/items/${encodeURIComponent(b.dataset.delItem)}`, { method: 'DELETE' });
        await openClient(c.id);
      } catch (err) { alert(err.message); }
    }));
    $('#view-client').scrollTop = 0;
  }

  function contactRow(ct = {}) {
    return `<div class="contact-row">
      <input placeholder="Name" data-f="name" value="${esc(ct.name || '')}" />
      <input placeholder="Role (Director, Accountant…)" data-f="role" value="${esc(ct.role || '')}" />
      <input placeholder="Phone" data-f="phone" inputmode="tel" value="${esc(ct.phone || '')}" />
      <input placeholder="Email" data-f="email" inputmode="email" value="${esc(ct.email || '')}" />
      <button type="button" class="btn-text danger rm-contact" title="Remove">✕</button>
    </div>`;
  }

  function renderClientForm(c) {
    const p = (c && c.profile) || {};
    showView('client');
    setHead(c ? `Edit: ${c.name}` : 'Add client', 'Everything here is shared with the whole team, so anyone can take over this client.');
    const input = (key, label, ph = '', extra = '') => `<label class="f"><span>${label}</span><input data-k="${key}" value="${esc(p[key] || '')}" placeholder="${esc(ph)}" ${extra} /></label>`;
    const area = (key, label, ph) => `<label class="f wide"><span>${label}</span><textarea data-k="${key}" rows="3" placeholder="${esc(ph)}">${esc(p[key] || '')}</textarea></label>`;
    const teamOpts = ['', ...me.team].map((n) => `<option value="${esc(n)}" ${n === (p.assignedTo || (c ? '' : me.name)) ? 'selected' : ''}>${n ? esc(n) : '— not assigned —'}</option>`).join('');

    $('#view-client').innerHTML = `
      <form id="client-form" class="client-form">
        <section class="cblock"><h3>Basic details</h3>
          <div class="fgrid">
            <label class="f wide"><span>Client name *</span><input id="cf-name" required value="${esc(c ? c.name : '')}" placeholder="e.g. Sharma Travels Pvt Ltd" /></label>
            <label class="f"><span>Entity type</span><input data-k="entityType" list="entity-types" value="${esc(p.entityType || '')}" placeholder="Private Ltd, LLP, Proprietor…" /></label>
            <label class="f"><span>Handled by</span><select data-k="assignedTo">${teamOpts}</select></label>
            ${input('pan', 'PAN', 'ABCDE1234F', 'maxlength="10" autocapitalize="characters"')}
            ${input('gstin', 'GSTIN', '27ABCDE1234F1Z5', 'autocapitalize="characters"')}
            ${input('tan', 'TAN', '', 'autocapitalize="characters"')}
            ${input('cin', 'CIN / LLPIN')}
            ${input('state', 'State', 'Maharashtra')}
            ${input('since', 'Client since', 'Apr 2021')}
            <label class="f wide"><span>Address</span><textarea data-k="address" rows="2">${esc(p.address || '')}</textarea></label>
          </div>
          <datalist id="entity-types"><option>Individual</option><option>Proprietorship</option><option>Partnership firm</option><option>LLP</option><option>Private Limited</option><option>Public Limited</option><option>HUF</option><option>Trust / Society</option><option>OPC</option></datalist>
        </section>
        <section class="cblock"><h3>Contact people</h3>
          <div id="contacts">${(p.contacts && p.contacts.length ? p.contacts : [{}]).map(contactRow).join('')}</div>
          <button type="button" id="add-contact" class="btn-plain">+ Add contact</button>
        </section>
        <section class="cblock"><h3>Services we handle</h3>
          <div class="svc-checks">${me.services.map((s) => `<label class="check-line"><input type="checkbox" data-svc value="${esc(s)}" ${(p.services || []).includes(s) ? 'checked' : ''} /> ${esc(s)}</label>`).join('')}</div>
        </section>
        <section class="cblock"><h3>For whoever handles this client</h3>
          <div class="fgrid">
            ${area('important', '⚠ Always remember', 'e.g. Never file GSTR-3B before partner approves. Old tax demand of ₹4.2L under appeal (CIT(A)).')}
            ${area('preferences', 'Preferences', 'e.g. WhatsApp only, after 7 pm. Speaks Hindi. Wants a call before any payment.')}
            ${area('billing', 'Fees & billing', 'e.g. ₹8,000/month retainer; tax audit ₹35,000 billed in Sept.')}
            ${area('portalIds', 'Portal user IDs (no passwords)', 'e.g. GST portal user ID: sharmatravels27. Passwords stay in your password manager.')}
          </div>
        </section>
        <div class="form-actions">
          <button type="submit" class="btn-primary">${c ? 'Save changes' : 'Add client'}</button>
          <button type="button" id="cf-cancel" class="btn-plain">Cancel</button>
        </div>
      </form>`;

    const contactsBox = $('#contacts');
    const wireRemove = () => contactsBox.querySelectorAll('.rm-contact').forEach((b) => { b.onclick = () => b.closest('.contact-row').remove(); });
    wireRemove();
    $('#add-contact').addEventListener('click', () => { contactsBox.insertAdjacentHTML('beforeend', contactRow()); wireRemove(); });
    $('#cf-cancel').addEventListener('click', () => (c ? openClient(c.id) : backToHome()));

    $('#client-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const profile = {};
      $('#client-form').querySelectorAll('[data-k]').forEach((el) => { profile[el.dataset.k] = el.value; });
      profile.services = [...$('#client-form').querySelectorAll('[data-svc]:checked')].map((el) => el.value);
      profile.contacts = [...contactsBox.querySelectorAll('.contact-row')].map((row) => {
        const ct = {};
        row.querySelectorAll('[data-f]').forEach((el) => { ct[el.dataset.f] = el.value; });
        return ct;
      });
      const name = $('#cf-name').value.trim();
      try {
        const saved = c
          ? await api('/api/clients/' + encodeURIComponent(c.id), { method: 'PUT', body: JSON.stringify({ name, profile }) })
          : await api('/api/clients', { method: 'POST', body: JSON.stringify({ name, profile }) });
        await loadLists();
        await openClient(saved.id);
        toast(c ? 'Client file saved' : 'Client added');
      } catch (err) { alert(err.message); }
    });
    $('#cf-name').focus();
  }

  async function deleteClient() {
    if (!confirm(`Delete the client file for ${currentClient.name}? Its profile and history will be removed for everyone. Discussions stay, unlinked.`)) return;
    try {
      await api('/api/clients/' + encodeURIComponent(currentClient.id), { method: 'DELETE' });
      currentClient = null;
      await loadLists();
      backToHome();
    } catch (err) { alert(err.message); }
  }

  function backToHome() {
    currentClient = null;
    if (section === 'clients') {
      showView('client');
      setHead('Clients', `${clientList.length} client file${clientList.length === 1 ? '' : 's'} — shared with the whole team.`, [{ label: '+ Add client', primary: true, onClick: () => renderClientForm(null) }]);
      $('#view-client').innerHTML = `<div class="welcome"><h2>Client files</h2><p>One complete file per client — contacts, registrations, services, preferences and a dated history — so anyone on the team can take over a client instantly.</p></div>`;
      location.hash = 'clients';
      renderSide();
    } else {
      openConversation(null);
    }
  }

  $('#new-client').addEventListener('click', () => { currentClient = null; renderSide(); renderClientForm(null); });
  $$('.seg button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.section === 'clients' && !currentClient) backToHome();
    if (b.dataset.section === 'discussions' && $('#view-chat').style.display === 'none') openConversation(null);
  }));

  // ---------- general ----------
  $('#menu').addEventListener('click', (e) => { e.stopPropagation(); $('#sidebar').classList.toggle('open'); });
  document.querySelector('.main').addEventListener('click', () => $('#sidebar').classList.remove('open'));
  $('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.href = '/login'; });

  // ---------- install as a phone/desktop app ----------
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    $('#install').style.display = '';
  });
  $('#install').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    $('#install').style.display = 'none';
  });
  window.addEventListener('appinstalled', () => { $('#install').style.display = 'none'; });
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIos && !standalone) $('#install-hint').style.display = '';

  // ---------- start ----------
  (async () => {
    me = await api('/api/me');
    $('#me').textContent = me.name + (me.isOwner ? ' (owner)' : '');
    await loadLists();
    const [kind, id] = location.hash.slice(1).split('/');
    if (kind === 'c' && clientList.some((c) => c.id === id)) await openClient(id);
    else if (kind === 'clients') { setSection('clients'); backToHome(); }
    else await openConversation(kind === 'd' && conversations.some((c) => c.id === id) ? id : null);
  })();
})();
