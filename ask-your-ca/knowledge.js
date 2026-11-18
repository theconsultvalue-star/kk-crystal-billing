// Search over the team's past discussions.
//
// Each searchable entry is one exchange (a question with its answer) or one
// team note. Scoring is BM25 over words, with section references such as
// "17(5)" or "43B(h)" kept as single tokens so they match exactly.
// The team is small, so the index is rebuilt from the store on each search.

const store = require('./store');

const STOP = new Set(('a an and are as at be by can do does for from has have how i if in is it its me my of on or our '
  + 'should so that the their this to was we what when where which who why will with you your shall may any all '
  + 'there then than also about into under per please tell explain kya hai ka ki ke').split(' '));

function tokenize(text) {
  const lower = String(text || '').toLowerCase();
  const tokens = [];
  // Section-style references: 17(5), 43b(h), 194-ia, 80ccd(1b)
  for (const m of lower.matchAll(/\b\d+[a-z]{0,3}(?:\(\w{1,4}\))+/g)) tokens.push(m[0]);
  for (const w of lower.split(/[^a-z0-9]+/)) {
    if (!w || STOP.has(w)) continue;
    if (w.length < 2 && !/\d/.test(w)) continue;
    tokens.push(w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  }
  return tokens;
}

function buildEntries(items, { excludeConversationId } = {}) {
  const entries = [];
  let pending = null;
  for (const it of items) {
    if (it.conversationId === excludeConversationId) continue;
    const base = { conversationId: it.conversationId, title: it.title };
    if (it.kind === 'question') {
      pending = { ...base, kind: 'exchange', question: it.text, askedBy: it.author, date: it.createdAt, answer: '' };
      entries.push(pending);
    } else if (it.kind === 'answer' && pending && pending.conversationId === it.conversationId) {
      pending.answer = it.text;
      pending = null;
    } else if (it.kind === 'note') {
      entries.push({ ...base, kind: 'note', note: it.text, author: it.author, date: it.createdAt });
    }
  }
  return entries;
}

function entryText(e) {
  // Title and question count double: they say what the entry is about.
  return e.kind === 'note'
    ? `${e.title} ${e.note}`
    : `${e.title} ${e.title} ${e.question} ${e.question} ${e.answer}`;
}

async function search(query, { limit = 5, excludeConversationId } = {}) {
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length) return [];
  const entries = buildEntries(await store.allItems(), { excludeConversationId });
  if (!entries.length) return [];

  const docs = entries.map((e) => {
    const tf = new Map();
    const toks = tokenize(entryText(e));
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return { e, tf, len: toks.length };
  });
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / docs.length || 1;
  const N = docs.length;
  const k1 = 1.2, b = 0.75;

  const scored = [];
  for (const d of docs) {
    let score = 0;
    let matched = 0;
    for (const t of qTokens) {
      const f = d.tf.get(t);
      if (!f) continue;
      matched++;
      const df = docs.reduce((n, x) => n + (x.tf.has(t) ? 1 : 0), 0);
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgLen)));
    }
    if (score > 0 && (qTokens.length <= 2 || matched >= 2)) scored.push({ ...d.e, score });
  }
  scored.sort((a, b2) => b2.score - a.score);
  return scored.slice(0, limit);
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + ' …[truncated]' : s);

// Text handed to Claude as the result of its knowledge-base search.
function formatForModel(results) {
  if (!results.length) return 'No earlier team discussion matches this query.';
  return results.map((r, i) => {
    const date = r.date.slice(0, 10);
    if (r.kind === 'note') {
      return `[${i + 1}] Team note by ${r.author} on ${date} in discussion "${r.title}":\n${clip(r.note, 2000)}`;
    }
    return `[${i + 1}] Discussion "${r.title}" — asked by ${r.askedBy} on ${date}\nQ: ${clip(r.question, 1500)}\nA: ${clip(r.answer || '(no answer saved)', 3500)}`;
  }).join('\n\n---\n\n');
}

module.exports = { search, formatForModel, tokenize };
