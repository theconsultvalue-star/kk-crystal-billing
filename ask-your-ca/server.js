// Ask your CA — a standalone team app. Everyone on the team logs in, asks
// questions, and every question, answer and team note goes into one shared
// knowledge base that the advisor searches for later questions.

const path = require('path');
const express = require('express');
const auth = require('./auth');
const store = require('./store');
const agent = require('./agent');
const knowledge = require('./knowledge');

const app = express();
const PORT = process.env.PORT || 4500;
app.set('trust proxy', 1); // behind a hosting proxy: honour X-Forwarded-Proto for Secure cookies
app.use(express.json({ limit: '1mb' }));

const PUBLIC = path.join(__dirname, 'public');

// ---- Public: login ----
app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC, 'login.html')));
app.get('/style.css', (req, res) => res.sendFile(path.join(PUBLIC, 'style.css')));
// Phone-app files must load before login (the browser fetches them on its own).
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').sendFile(path.join(PUBLIC, 'manifest.webmanifest'));
});
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache'); // so app updates reach phones promptly
  res.sendFile(path.join(PUBLIC, 'sw.js'));
});
app.use('/icons', express.static(path.join(PUBLIC, 'icons'), { maxAge: '7d' }));
app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);

// ---- Everything below needs a logged-in team member ----
app.use(auth.requireUser);
app.use(express.static(PUBLIC));

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Server error. Please try again.' });
});

app.get('/api/me', (req, res) => {
  res.json({ name: req.user, team: auth.teamNames(), aiConfigured: !!process.env.ANTHROPIC_API_KEY });
});

app.get('/api/conversations', wrap(async (req, res) => {
  res.json(await store.listConversations());
}));

app.get('/api/conversations/:id', wrap(async (req, res) => {
  const conv = await store.getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Discussion not found.' });
  const { api, ...rest } = conv; // the API transcript stays on the server
  res.json(rest);
}));

app.patch('/api/conversations/:id', wrap(async (req, res) => {
  const title = String((req.body || {}).title || '').trim().slice(0, 150);
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  if (!(await store.renameConversation(req.params.id, title))) return res.status(404).json({ error: 'Discussion not found.' });
  res.json({ ok: true });
}));

app.delete('/api/conversations/:id', wrap(async (req, res) => {
  const conv = await store.getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Discussion not found.' });
  if (conv.createdBy !== req.user) return res.status(403).json({ error: `Only ${conv.createdBy}, who started this discussion, can delete it.` });
  await store.deleteConversation(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/conversations/:id/notes', wrap(async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text || text.length > 20000) return res.status(400).json({ error: 'Write a note of up to 20,000 characters.' });
  const note = await store.addNote(req.params.id, { author: req.user, text });
  if (!note) return res.status(404).json({ error: 'Discussion not found.' });
  res.json(note);
}));

app.get('/api/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  const results = await knowledge.search(q, { limit: 20 });
  res.json(results.map((r) => ({
    conversationId: r.conversationId, title: r.title, kind: r.kind, date: r.date,
    who: r.kind === 'note' ? r.author : r.askedBy,
    snippet: (r.kind === 'note' ? r.note : r.question).slice(0, 220)
  })));
}));

// Ask a question — in an existing discussion (conversationId) or a new one.
// The answer streams back as newline-delimited JSON events.
const busy = new Set();
app.post('/api/ask', wrap(async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'The server has no ANTHROPIC_API_KEY set, so questions cannot be answered yet.' });
  }
  const question = String((req.body || {}).question || '').trim();
  if (!question || question.length > 20000) return res.status(400).json({ error: 'Write a question of up to 20,000 characters.' });

  let conv;
  if (req.body.conversationId) {
    conv = await store.getConversation(req.body.conversationId);
    if (!conv) return res.status(404).json({ error: 'Discussion not found.' });
  }
  if (conv && busy.has(conv.id)) {
    return res.status(409).json({ error: 'Someone is already asking in this discussion — wait for that answer, then ask.' });
  }
  if (!conv) {
    const title = question.replace(/\s+/g, ' ').slice(0, 90) + (question.length > 90 ? '…' : '');
    conv = await store.createConversation({ title, createdBy: req.user });
  }
  busy.add(conv.id);

  res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.set('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const emit = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };
  let aborted = false;
  res.on('close', () => { aborted = !res.writableFinished; });

  emit({ type: 'conversation', id: conv.id, title: conv.title });
  try {
    const result = await agent.answer({
      priorApi: conv.api, question, author: req.user, conversationId: conv.id, emit, isAborted: () => aborted
    });
    const items = await store.saveExchange(conv.id, {
      author: req.user, question, answer: result.answer, sources: result.sources, api: result.api
    });
    emit({ type: 'done', items });
  } catch (err) {
    if (err.message !== 'aborted') {
      console.error('Ask failed:', err);
      emit({ type: 'error', error: agent.friendlyError(err) });
    }
    // A brand-new discussion whose first answer failed holds nothing: remove it.
    if (!conv.items.length) await store.deleteConversation(conv.id).catch(() => {});
  } finally {
    busy.delete(conv.id);
    res.end();
  }
}));

(async () => {
  await store.ensureSchema();
  console.log(store.usingDatabase ? 'Using Postgres (DATABASE_URL).' : 'Using local file storage under ./data.');
  if (!process.env.ANTHROPIC_API_KEY) console.warn('ANTHROPIC_API_KEY is not set — questions cannot be answered until it is.');
  app.listen(PORT, () => console.log(`Ask your CA running at http://localhost:${PORT}`));
})();
