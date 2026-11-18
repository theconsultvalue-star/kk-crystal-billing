// ---------- Ask your CA ----------
// The conversation lives in the browser (and localStorage, so a reload keeps
// it). Assistant turns are stored exactly as the server returned them and sent
// back unchanged with the next question.
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const STORE_KEY = 'askca.conversation.v1';
  let apiMessages = []; // API-shaped turns sent to the server
  let view = [];        // what's shown: {role, text, sources}
  let busy = false;

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Small, safe Markdown renderer (input is escaped first) covering what the
  // answers use: headings, bold/italic, code, lists, tables, links, rules.
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,;:])/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  const BULLET = /^\s*[-*•]\s+/;
  const NUMBER = /^\s*\d+[.)]\s+/;
  const TABLE_ROW = /^\s*\|.*\|\s*$/;

  function markdown(md) {
    const lines = escapeHtml(md).split('\n');
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
        out.push(
          `<div class="ca-table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows
            .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
            .join('')}</tbody></table></div>`
        );
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const lvl = h[1].length <= 2 ? 3 : 4;
        out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
        i++;
        continue;
      }
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
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```)/.test(lines[i]) && !BULLET.test(lines[i]) && !NUMBER.test(lines[i]) && !TABLE_ROW.test(lines[i])) {
        para.push(inline(lines[i++]));
      }
      out.push(`<p>${para.join('<br>')}</p>`);
    }
    return out.join('');
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ apiMessages, view })); } catch (e) { /* storage unavailable */ }
  }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (saved && Array.isArray(saved.apiMessages) && Array.isArray(saved.view)) {
        apiMessages = saved.apiMessages;
        view = saved.view;
      }
    } catch (e) { /* ignore */ }
  }

  function fillBot(div, text, sources) {
    let html = markdown(text || '');
    if (sources && sources.length) {
      html += `<details class="ca-sources"><summary>Sources (${sources.length})</summary><ol>${sources
        .map((s) => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title)}</a></li>`)
        .join('')}</ol></details>`;
    }
    div.innerHTML = html;
  }

  function bubble(entry) {
    const div = document.createElement('div');
    div.className = `ca-msg ${entry.role === 'user' ? 'user' : 'bot'}`;
    if (entry.role === 'user') div.textContent = entry.text;
    else fillBot(div, entry.text, entry.sources);
    return div;
  }

  function render() {
    const thread = $('#ca-thread');
    thread.querySelectorAll('.ca-msg').forEach((n) => thread.removeChild(n));
    $('#ca-empty').style.display = view.length ? 'none' : 'block';
    view.forEach((entry) => thread.appendChild(bubble(entry)));
    thread.scrollTop = thread.scrollHeight;
  }

  const STATUS_TEXT = {
    thinking: 'Thinking it through…',
    searching: 'Checking the latest notifications and sources…',
    writing: ''
  };

  async function ask(question) {
    question = (question || '').trim();
    if (busy || !question) return;
    busy = true;
    $('#ca-send').disabled = true;
    $('#ca-input').value = '';

    const outgoing = [...apiMessages, { role: 'user', content: question }];
    view.push({ role: 'user', text: question });
    render();

    const thread = $('#ca-thread');
    const bot = document.createElement('div');
    bot.className = 'ca-msg bot';
    bot.innerHTML = `<span class="ca-status">${STATUS_TEXT.thinking}</span>`;
    thread.appendChild(bot);
    thread.scrollTop = thread.scrollHeight;

    let text = '';
    let finished = false;
    let errorMsg = '';
    try {
      const resp = await fetch('/api/ask-ca', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: outgoing })
      });
      if (!resp.ok || !resp.body) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${resp.status}).`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let status = '';
      const paint = () => {
        const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
        fillBot(bot, text);
        if (status) bot.insertAdjacentHTML('beforeend', `<div class="ca-status">${escapeHtml(status)}</div>`);
        if (nearBottom) thread.scrollTop = thread.scrollHeight;
      };
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
          if (ev.type === 'status') { status = STATUS_TEXT[ev.status] || ''; paint(); }
          else if (ev.type === 'text') { text += ev.text; paint(); }
          else if (ev.type === 'error') { errorMsg = ev.error; }
          else if (ev.type === 'done') {
            finished = true;
            apiMessages = [...outgoing, ev.message];
            view.push({ role: 'assistant', text, sources: ev.sources || [] });
          }
        }
      }
    } catch (err) {
      errorMsg = err.message || 'Could not reach the server.';
    }

    // An unfinished answer stays visible but is not added to the API history,
    // so the next question starts from the last complete exchange.
    if (!finished && text) view.push({ role: 'assistant', text: text + '\n\n_(answer interrupted — please ask again)_' });
    save();
    render();
    if (errorMsg) {
      const e = document.createElement('div');
      e.className = 'ca-msg error';
      e.textContent = errorMsg;
      thread.appendChild(e);
      thread.scrollTop = thread.scrollHeight;
    }
    busy = false;
    $('#ca-send').disabled = false;
    $('#ca-input').focus();
  }

  $('#ca-form').addEventListener('submit', (e) => {
    e.preventDefault();
    ask($('#ca-input').value);
  });
  $('#ca-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask($('#ca-input').value);
    }
  });
  $$('.ca-chip').forEach((chip) => chip.addEventListener('click', () => ask(chip.textContent)));
  $('#ca-new').addEventListener('click', () => {
    if (busy) return;
    apiMessages = [];
    view = [];
    save();
    render();
  });

  load();
  render();
  fetch('/api/ask-ca/status')
    .then((r) => r.json())
    .then(({ configured }) => {
      if (!configured) {
        const n = $('#ca-notice');
        n.textContent = 'Ask your CA is not switched on yet: set the ANTHROPIC_API_KEY environment variable on the server and restart it.';
        n.style.display = 'block';
      }
    })
    .catch(() => {});
})();
