(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  let me = null;
  let conversations = [];
  let current = null;   // { id, title, createdBy, createdAt, items }
  let mode = 'ask';
  let busy = false;

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtTime = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  async function api(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (r.status === 401) { location.href = '/login'; throw new Error('Logged out'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
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
        .map((t) => `<li><button class="team-link" data-open="${esc(t.conversationId)}">${esc(t.title)}</button> <span class="muted">· ${fmtDate(t.date)}</span></li>`)
        .join('')}</ul></details>`;
    }
    if (web.length) {
      html += `<details class="refs"><summary>Web sources (${web.length})</summary><ol>${web
        .map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a></li>`)
        .join('')}</ol></details>`;
    }
    return html;
  }

  // ---------- sidebar ----------
  function renderList(results) {
    const list = $('#conv-list');
    if (results) {
      list.innerHTML = `<h3>Search results (${results.length})</h3>` + (results.length ? results.map((r) => `
        <button class="conv-item" data-id="${esc(r.conversationId)}">
          <div class="conv-title">${esc(r.title)}</div>
          <div class="conv-snippet"><span class="tag ${r.kind === 'note' ? 'note' : ''}">${r.kind === 'note' ? 'note' : 'Q'}</span>${esc(r.snippet)}</div>
          <div class="conv-meta">${esc(r.who)} · ${fmtDate(r.date)}</div>
        </button>`).join('') : '<p class="muted" style="padding:0 10px">Nothing found. Try other words, a section number or a form name.</p>');
    } else {
      list.innerHTML = `<h3>Team discussions (${conversations.length})</h3>` + (conversations.length ? conversations.map((c) => `
        <button class="conv-item ${current && current.id === c.id ? 'active' : ''}" data-id="${esc(c.id)}">
          <div class="conv-title">${esc(c.title)}</div>
          <div class="conv-meta">${esc(c.createdBy)} · ${fmtDate(c.updatedAt)} · ${c.questions} Q${c.notes ? ` · ${c.notes} note${c.notes > 1 ? 's' : ''}` : ''}</div>
        </button>`).join('') : '<p class="muted" style="padding:0 10px">No discussions yet. Ask the first question.</p>');
    }
    list.querySelectorAll('.conv-item').forEach((b) => b.addEventListener('click', () => openConversation(b.dataset.id)));
  }

  async function loadList() {
    conversations = await api('/api/conversations');
    if (!$('#search').value.trim()) renderList();
  }

  let searchTimer;
  $('#search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = $('#search').value.trim();
      if (!q) return renderList();
      renderList(await api('/api/search?q=' + encodeURIComponent(q)));
    }, 250);
  });

  // ---------- thread ----------
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
    if (!me.aiConfigured) thread.insertAdjacentHTML('beforeend', '<div class="notice">The server has no ANTHROPIC_API_KEY set, so new questions cannot be answered yet. Past discussions and notes still work.</div>');
    if (!current) {
      thread.insertAdjacentHTML('beforeend', `<div class="welcome"><h2>What do you want to know today?</h2>
        <p>Accounting, income tax, GST, TDS, ROC/MCA compliance, audit, costing, FEMA and finance — textbook and practical.
        The advisor checks the latest notifications on the web and looks through the team's past discussions when they help.</p>
        <div class="chips">${SUGGESTIONS.map((s) => `<button class="chip">${esc(s)}</button>`).join('')}</div></div>`);
      thread.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => ask(c.textContent)));
    } else {
      current.items.forEach((it) => thread.appendChild(itemEl(it)));
    }
    thread.scrollTop = thread.scrollHeight;
  }

  function renderHead() {
    if (!current) {
      $('#conv-title').textContent = 'New question';
      $('#conv-meta').textContent = 'Ask anything — the whole team will see it, and it becomes part of the shared knowledge base.';
      $('#head-actions').style.display = 'none';
    } else {
      $('#conv-title').textContent = current.title;
      $('#conv-meta').textContent = `Started by ${current.createdBy} · ${fmtDate(current.createdAt)} · visible to the whole team`;
      $('#head-actions').style.display = 'flex';
      $('#delete').style.display = current.createdBy === me.name ? '' : 'none';
    }
    $('#note-mode-btn').disabled = !current;
    if (!current && mode === 'note') setMode('ask');
  }

  function setMode(m) {
    mode = m;
    $$('#mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    $('#send').textContent = m === 'ask' ? 'Ask' : 'Add note';
    $('#input').placeholder = m === 'ask'
      ? 'Ask anything — e.g. TDS on rent paid to a partner, 43B(h) MSME payments, tax audit limit…'
      : 'Record what the team did or decided — e.g. "Filed reply on 12 Nov; officer accepted the 17(5) position after we showed the logbook."';
  }
  $$('#mode button').forEach((b) => b.addEventListener('click', () => !b.disabled && setMode(b.dataset.mode)));

  async function openConversation(id) {
    if (busy) return;
    current = id ? await api('/api/conversations/' + encodeURIComponent(id)) : null;
    location.hash = id ? id : '';
    $('#sidebar').classList.remove('open');
    renderHead();
    renderThread();
    if (!$('#search').value.trim()) renderList();
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-open]');
    if (t) openConversation(t.dataset.open);
  });

  // ---------- asking ----------
  const STATUS = {
    thinking: 'Thinking it through…',
    searching_kb: "Looking through the team's past discussions…",
    searching_web: 'Checking the latest notifications and sources…',
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
    let kbChecked = [];
    let convId = current ? current.id : null;
    let doneItems = null;
    let errorMsg = '';

    const paint = () => {
      const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 90;
      body.innerHTML = markdown(text) + (status ? `<div class="status">${esc(status)}</div>` : '') + refsHtml(kbChecked);
      if (nearBottom) thread.scrollTop = thread.scrollHeight;
    };

    try {
      const r = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: convId, question })
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
            if (!current) {
              $('#conv-title').textContent = ev.title;
              $('#conv-meta').textContent = `Started by ${me.name} · just now · visible to the whole team`;
            }
          } else if (ev.type === 'status') { status = STATUS[ev.status] ?? ''; paint(); }
          else if (ev.type === 'text') { text += ev.text; paint(); }
          else if (ev.type === 'reset_step') { text = text.slice(0, Math.max(0, text.length - ev.length)); paint(); }
          else if (ev.type === 'kb') {
            for (const h of ev.hits) if (!kbChecked.some((k) => k.conversationId === h.conversationId)) kbChecked.push(h);
            paint();
          } else if (ev.type === 'error') { errorMsg = ev.error; }
          else if (ev.type === 'done') { doneItems = ev.items; }
        }
      }
    } catch (err) {
      errorMsg = err.message || 'Could not reach the server.';
    }

    busy = false;
    $('#send').disabled = false;
    if (doneItems && convId) {
      await openConversation(convId);
      await loadList();
    } else {
      status = '';
      if (text) text += '\n\n_(answer interrupted — it was not saved; please ask again)_';
      paint();
      if (!text) ansEl.remove();
      const e = document.createElement('div');
      e.className = 'msg error';
      e.textContent = errorMsg || 'The answer did not finish. Please ask again.';
      thread.appendChild(e);
      thread.scrollTop = thread.scrollHeight;
      $('#input').value = question;
      await loadList();
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
      await loadList();
      setMode('ask');
    } catch (err) {
      alert(err.message);
    } finally {
      $('#send').disabled = false;
    }
  }

  // ---------- events ----------
  $('#compose').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#input').value;
    if (mode === 'ask') ask(v); else addNote(v);
  });
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#compose').requestSubmit(); }
  });
  $('#new-conv').addEventListener('click', () => { $('#search').value = ''; openConversation(null); setMode('ask'); $('#input').focus(); });
  $('#menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.href = '/login'; });
  $('#rename').addEventListener('click', async () => {
    const t = prompt('Rename this discussion', current.title);
    if (!t || !t.trim()) return;
    await api('/api/conversations/' + encodeURIComponent(current.id), { method: 'PATCH', body: JSON.stringify({ title: t }) });
    current.title = t.trim();
    renderHead();
    await loadList();
  });
  $('#delete').addEventListener('click', async () => {
    if (!confirm('Delete this discussion for the whole team? Its questions, answers and notes will be removed from the knowledge base.')) return;
    try {
      await api('/api/conversations/' + encodeURIComponent(current.id), { method: 'DELETE' });
      await openConversation(null);
      await loadList();
    } catch (err) { alert(err.message); }
  });

  // ---------- start ----------
  (async () => {
    me = await api('/api/me');
    $('#me').textContent = me.name;
    await loadList();
    const id = location.hash.slice(1);
    await openConversation(id && conversations.some((c) => c.id === id) ? id : null);
  })();
})();
