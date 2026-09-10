const store = require('./store');

// ---------- string similarity (no deps) ----------
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// Rewards abbreviations ("emb" for "embroidery", "app" for "apparels") —
// plain Levenshtein ratio badly under-scores a short prefix against a full
// word even though that's exactly how people shorten names when texting.
function wordSimilarity(a, b) {
  if (a === b) return 1;
  if (a.length >= 2 && b.length >= 2 && (b.startsWith(a) || a.startsWith(b))) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    return 0.7 + 0.3 * (shorter / longer);
  }
  return similarity(a, b);
}

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Best-effort fuzzy match of a shorthand name (e.g. "cue app") against the
// saved parties list. Returns { party, score } or { party: null, score: 0 }.
function matchParty(rawName, parties) {
  const query = normalize(rawName);
  if (!query) return { party: null, score: 0 };

  let best = null;
  let bestScore = 0;

  for (const p of parties) {
    const name = normalize(p.name);
    let score;
    if (name === query) {
      score = 1;
    } else if (name.includes(query) || query.includes(name)) {
      score = 0.9;
    } else {
      const qWords = query.split(' ');
      const nWords = name.split(' ');
      const perWord = qWords.map((qw) => Math.max(...nWords.map((nw) => wordSimilarity(qw, nw))));
      score = perWord.reduce((a, b) => a + b, 0) / perWord.length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return bestScore >= 0.6 ? { party: best, score: bestScore } : { party: null, score: bestScore };
}

// Finds a default line item for a party from their invoice history. A party
// that sells more than one product at different GST rates (seen in practice)
// needs the item whose own rate matches the CURRENT bill's tax%, not just
// whatever they most recently ordered — so that's tried first, falling back
// to the single most recent item if nothing at that rate has been billed yet.
// `ledger` is passed in (already fetched once by the caller) rather than
// re-queried per row.
function lastItemForParty(ledger, partyName, taxPercent) {
  const norm = normalize(partyName);
  const partyInvoices = ledger.filter((inv) => normalize(inv.clientName) === norm);
  if (partyInvoices.length === 0) return null;

  if (taxPercent != null) {
    const rateMatch = partyInvoices.find((inv) => Number(inv.taxPercent) === Number(taxPercent));
    if (rateMatch) {
      const item = rateMatch.items[0];
      return { description: item.description, hsn: item.hsn, unit: item.unit || 'PAC' };
    }
  }

  const match = partyInvoices[0];
  if (!match.items || match.items.length === 0) return null;
  const item = match.items[0];
  return { description: item.description, hsn: item.hsn, unit: item.unit || 'PAC' };
}

function findDuplicate(ledger, partyName, amount, taxPercent) {
  const norm = normalize(partyName);
  return ledger.find((inv) =>
    normalize(inv.clientName) === norm &&
    Math.abs(inv.subtotal - amount) < 0.005 &&
    Number(inv.taxPercent) === Number(taxPercent)
  ) || null;
}

const QTY_RATE_RE = /^(\d+(?:\.\d+)?)\s*\*\s*(\d+(?:\.\d+)?)$/;
const QTY_RATE_PLUS_RE = /^(\d+(?:\.\d+)?)\s*\*\s*(\d+(?:\.\d+)?)\s*plus\s*(\d+(?:\.\d+)?)\.?$/i;
const AMOUNT_PLUS_RE = /^(\d+(?:\.\d+)?)\s*plus\s*(\d+(?:\.\d+)?)\.?$/i;
const AMOUNT_ONLY_RE = /^(\d+(?:\.\d+)?)$/;
const PLUS_ONLY_RE = /^plus\s*(\d+(?:\.\d+)?)\.?$/i;

// Parses the client's shorthand:
//   Party Name
//   30*180          (qty*rate)
//   Plus 5          (tax % on its own line)
//   2500plus 18     (amount+tax combined)
// One party name line can be followed by several order lines (several bills).
async function parseShorthand(text) {
  const lines = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const [parties, ledger] = await Promise.all([store.getParties(), store.getLedger()]);

  const rows = [];
  let currentPartyRaw = null;
  let pending = null; // { qty, rate } | { amount }

  function flush(qty, rate, amount, taxPercent) {
    if (!currentPartyRaw) return;
    const { party, score } = matchParty(currentPartyRaw, parties);
    const finalQty = qty != null ? qty : 1;
    const finalRate = rate != null ? rate : amount;
    const computedAmount = finalQty * finalRate;

    const partyName = party ? party.name : currentPartyRaw;
    const lastItem = lastItemForParty(ledger, partyName, taxPercent);
    const duplicate = party ? findDuplicate(ledger, partyName, computedAmount, taxPercent) : null;

    rows.push({
      partyRaw: currentPartyRaw,
      matchedParty: party,
      matchScore: score,
      clientName: partyName,
      clientGSTIN: party ? party.gstin : '',
      clientAddress: party ? party.address : '',
      item: lastItem || { description: '', hsn: '', unit: 'PAC' },
      qty: finalQty,
      rate: finalRate,
      amount: computedAmount,
      taxPercent: taxPercent,
      duplicateOf: duplicate ? duplicate.number : null,
      warnings: [
        !party ? 'No confident match in Sale Parties — please pick one manually.' : null,
        !lastItem ? 'No order history for this party — please choose an item.' : null
      ].filter(Boolean)
    });
  }

  for (const line of lines) {
    let m;
    if ((m = line.match(QTY_RATE_PLUS_RE))) {
      flush(Number(m[1]), Number(m[2]), null, Number(m[3]));
      pending = null;
    } else if ((m = line.match(QTY_RATE_RE))) {
      pending = { qty: Number(m[1]), rate: Number(m[2]) };
    } else if ((m = line.match(AMOUNT_PLUS_RE))) {
      flush(null, null, Number(m[1]), Number(m[2]));
      pending = null;
    } else if ((m = line.match(PLUS_ONLY_RE))) {
      if (pending) {
        if (pending.qty != null) flush(pending.qty, pending.rate, null, Number(m[1]));
        else flush(null, null, pending.amount, Number(m[1]));
      }
      pending = null;
    } else if ((m = line.match(AMOUNT_ONLY_RE))) {
      pending = { amount: Number(m[1]) };
    } else {
      // Doesn't look like a number line — treat as a new party name.
      currentPartyRaw = line;
      pending = null;
    }
  }

  return rows;
}

module.exports = { parseShorthand, matchParty, lastItemForParty, findDuplicate, normalize };
