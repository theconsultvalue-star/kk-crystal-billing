// Team logins. Users come from the ASKCA_USERS environment variable:
//   ASKCA_USERS="Ramesh:pass-one,Sita:pass-two,Arjun:pass-three"
// A signed, HTTP-only cookie keeps each person logged in for 30 days.

const crypto = require('crypto');

const COOKIE = 'askca_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function loadUsers() {
  const users = new Map();
  for (const pair of (process.env.ASKCA_USERS || '').split(',')) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const pass = pair.slice(idx + 1).trim();
    if (name && pass) users.set(name.toLowerCase(), { name, pass });
  }
  return users;
}

const USERS = loadUsers();
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set — everyone will be logged out whenever the server restarts.');
}
if (!USERS.size) {
  console.warn('ASKCA_USERS is not set — nobody can log in. Example: ASKCA_USERS="Ramesh:pass1,Sita:pass2"');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const sign = (value) => crypto.createHmac('sha256', SECRET).update(value).digest('base64url');

function makeToken(name) {
  const payload = Buffer.from(JSON.stringify({ u: name, exp: Date.now() + MAX_AGE_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (Date.now() > exp) return null;
    const user = USERS.get(String(u).toLowerCase());
    return user ? user.name : null; // removed users lose access at once
  } catch (e) {
    return null;
  }
}

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setSession(req, res, name) {
  const secure = req.secure ? '; Secure' : '';
  res.set('Set-Cookie', `${COOKIE}=${makeToken(name)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_MS / 1000}${secure}`);
}

function clearSession(res) {
  res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Simple brute-force brake: 10 failed logins per IP per 15 minutes.
const failures = new Map();
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > 15 * 60 * 1000) return false;
  return f.count >= 10;
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > 15 * 60 * 1000) failures.set(ip, { count: 1, since: Date.now() });
  else f.count++;
}

function login(req, res) {
  const { username, password } = req.body || {};
  if (tooManyFailures(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const user = USERS.get(String(username || '').trim().toLowerCase());
  if (!user || !safeEqual(password || '', user.pass)) {
    noteFailure(req.ip);
    return res.status(401).json({ error: 'Wrong name or password.' });
  }
  failures.delete(req.ip);
  setSession(req, res, user.name);
  res.json({ name: user.name });
}

function logout(req, res) {
  clearSession(res);
  res.json({ ok: true });
}

// Attaches req.user, or answers 401 for API calls / redirects pages to /login.
function requireUser(req, res, next) {
  const name = readToken(getCookie(req, COOKIE));
  if (name) {
    req.user = name;
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please log in again.' });
  res.redirect('/login');
}

module.exports = { login, logout, requireUser, teamNames: () => [...USERS.values()].map((u) => u.name) };
