const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pool, initDB } = require('./db');

// Single source of truth for pricing — the same engine the browser loads from
// public/pricing.js. Used to recompute each item's pricing on read (GET /api/quotes)
// so figures added after a quote was saved (e.g. labour hours) appear without
// anyone re-opening and re-saving the quote.
let priceItem = null;
try { ({ priceItem } = require('./public/pricing.js')); }
catch (err) { console.error('pricing engine load failed (GET /api/quotes will return stored pricing as-is):', err.message); }

// Recompute every item's `pricing` from its stored params using the canonical engine.
// Purely additive/non-destructive: structure is preserved, and if the engine is
// unavailable or an item throws/returns null, that item's stored pricing is kept.
function recomputeQuotePricing(quote) {
  if (!priceItem || !quote || !quote.rooms) return quote;
  const rooms = {};
  for (const [roomName, room] of Object.entries(quote.rooms)) {
    rooms[roomName] = {
      ...room,
      items: (room.items || []).map(item => {
        try { const pricing = priceItem(item); return pricing ? { ...item, pricing } : item; }
        catch { return item; }
      }),
    };
  }
  return { ...quote, rooms };
}

const app = express();
const PORT = process.env.PORT || 3000;

// Required so req.secure works behind Railway's HTTPS proxy.
app.set('trust proxy', 1);

app.use(express.json({ limit: '10mb' }));

// ─── AUTH ──────────────────────────────────────────────────────────────────
// Single shared-password gate. Set APP_PASSWORD in Railway env to enable;
// SESSION_SECRET signs the cookie so it can't be forged. If APP_PASSWORD is
// unset (local dev), auth is bypassed entirely.
const APP_PASSWORD   = process.env.APP_PASSWORD   || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
// Long random token for service-to-service auth (e.g. the SAB Business API
// MCP server). Set on both this service and the MCP service. When unset, the
// Bearer-token path is inactive and only cookie auth works.
const API_TOKEN      = process.env.API_TOKEN      || '';
const SESSION_DAYS   = 30;
const COOKIE_NAME    = 'sab_session';
const PUBLIC_PATHS   = new Set(['/login', '/api/login', '/api/logout', '/api/health']);

function signCookie(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyCookie(token) {
  if (!token || !SESSION_SECRET) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig  = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
function parseCookies(req) {
  const h = req.headers.cookie || '';
  const out = {};
  h.split(';').forEach(c => { const [k, ...rest] = c.trim().split('='); if (k && rest.length) out[k] = rest.join('='); });
  return out;
}
function isSecure(req) { return req.secure || req.headers['x-forwarded-proto'] === 'https'; }
function cookieFlags(req) {
  return `HttpOnly; SameSite=Strict; Path=/${isSecure(req) ? '; Secure' : ''}`;
}
// Constant-time compare for two strings via HMAC fingerprint. Returns false
// when either is empty so the empty/unset state doesn't accidentally validate.
function tokenMatches(presented, expected) {
  if (!presented || !expected) return false;
  const key = SESSION_SECRET || expected; // any non-empty key — only the digest matters
  const a = crypto.createHmac('sha256', key).update(presented).digest();
  const b = crypto.createHmac('sha256', key).update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function authMiddleware(req, res, next) {
  if (!APP_PASSWORD) return next();         // Auth disabled when no password configured
  if (PUBLIC_PATHS.has(req.path)) return next();
  // Bearer token path — for service-to-service callers like the MCP server.
  // Checked before cookies so a valid token works even without a session.
  if (API_TOKEN) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ') && tokenMatches(h.slice(7).trim(), API_TOKEN)) return next();
  }
  // Cookie session path — for the browser/PWA user.
  const cookies = parseCookies(req);
  if (verifyCookie(cookies[COOKIE_NAME])) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  // For HTML navigations send the user to /login
  return res.redirect('/login');
}
app.use(authMiddleware);

// Login page (served before the static middleware so it doesn't get gated)
app.get('/login', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(LOGIN_HTML);
});

app.post('/api/login', (req, res) => {
  const pw = (req.body && req.body.password) || '';
  if (!APP_PASSWORD || !SESSION_SECRET) {
    return res.status(500).json({ error: 'auth not configured' });
  }
  // Constant-time compare via HMAC fingerprints to avoid leaking password length.
  const target = crypto.createHmac('sha256', SESSION_SECRET).update(APP_PASSWORD).digest();
  const candidate = crypto.createHmac('sha256', SESSION_SECRET).update(String(pw)).digest();
  if (!crypto.timingSafeEqual(target, candidate)) {
    return res.status(401).json({ error: 'invalid' });
  }
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const token = signCookie({ exp });
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; ${cookieFlags(req)}; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${cookieFlags(req)}; Max-Age=0`);
  res.json({ ok: true });
});

const LOGIN_HTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SAB Quote Studio</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Raleway:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  body { margin:0; font-family:'Raleway',sans-serif; background:#1a1a1a; color:#1a1a1a; display:flex; align-items:center; justify-content:center; min-height:100vh; }
  .box { background:#f5f5f5; padding:36px 34px; border-radius:8px; width:320px; max-width:calc(100vw - 30px); box-shadow:0 8px 30px rgba(0,0,0,0.3); box-sizing:border-box; }
  .brand { font-size:10px; letter-spacing:0.2em; color:#c8a96e; text-transform:uppercase; margin-bottom:6px; }
  h1 { font-size:22px; font-weight:400; margin:0 0 24px; color:#1a1a1a; }
  label { display:block; font-size:10px; letter-spacing:0.12em; color:#777; text-transform:uppercase; margin-bottom:6px; }
  input[type="password"] { width:100%; padding:11px 12px; border:1px solid #d8d3cc; border-radius:4px; font-size:16px; font-family:inherit; box-sizing:border-box; background:#fff; }
  input[type="password"]:focus { outline:none; border-color:#c8a96e; }
  button { width:100%; margin-top:16px; padding:13px; background:#c8a96e; color:#1a1a1a; border:none; border-radius:4px; font-size:11px; letter-spacing:0.1em; text-transform:uppercase; font-weight:600; cursor:pointer; font-family:inherit; }
  button:disabled { background:#c8c3bc; cursor:not-allowed; }
  .err { color:#b86a3e; font-size:11px; margin-top:10px; min-height:14px; }
</style></head><body>
<form class="box" onsubmit="event.preventDefault(); login();">
  <div class="brand">Steven Andrews Bespoke</div>
  <h1>Sign In</h1>
  <label for="pw">Password</label>
  <input type="password" id="pw" autocomplete="current-password" autofocus required />
  <button type="submit" id="btn">Sign In</button>
  <div class="err" id="err"></div>
</form>
<script>
async function login() {
  const pw = document.getElementById('pw').value;
  const err = document.getElementById('err');
  const btn = document.getElementById('btn');
  err.textContent = '';
  btn.disabled = true;
  try {
    const r = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ password: pw }) });
    if (r.ok) { window.location.href = '/'; }
    else { err.textContent = r.status === 500 ? 'Server not configured.' : 'Incorrect password.'; btn.disabled = false; }
  } catch (e) { err.textContent = 'Network error.'; btn.disabled = false; }
}
</script></body></html>`;

// ─── WRP CATALOGUE ──────────────────────────────────────────────────────────
const WRP_CATALOGUE_PATH = path.join(__dirname, 'data', 'wrp_catalogue.json');
let wrpCatalogue = null;
try {
  wrpCatalogue = JSON.parse(fs.readFileSync(WRP_CATALOGUE_PATH, 'utf8'));
} catch (err) {
  console.warn('WRP catalogue not found at', WRP_CATALOGUE_PATH);
}

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// ─── API ROUTES ──────────────────────────────────────────────────────────────

// Health check (also tells the client if DB is available)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: !!pool });
});

// Get all quotes
app.get('/api/quotes', async (req, res) => {
  if (!pool) return res.json({});
  try {
    const { rows } = await pool.query('SELECT id, data, updated_at FROM quotes ORDER BY updated_at DESC');
    const quotes = {};
    for (const row of rows) {
      quotes[row.id] = recomputeQuotePricing({ ...row.data, _serverUpdatedAt: row.updated_at });
    }
    res.json(quotes);
  } catch (err) {
    console.error('GET /api/quotes error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Upsert a single quote
app.put('/api/quotes/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { id } = req.params;
  const data = req.body;
  try {
    await pool.query(
      `INSERT INTO quotes (id, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [id, JSON.stringify(data)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/quotes error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Patch a quote (e.g. update status)
app.patch('/api/quotes/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { id } = req.params;
  const patch = req.body;
  try {
    // Read current data, merge patch fields into it, write back
    const { rows } = await pool.query('SELECT data FROM quotes WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const updated = { ...rows[0].data, ...patch };
    await pool.query(
      'UPDATE quotes SET data = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(updated), id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/quotes error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Delete a quote
app.delete('/api/quotes/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    await pool.query('DELETE FROM quotes WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/quotes error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Bulk sync — client sends all its quotes, server merges and returns result
app.post('/api/quotes/sync', async (req, res) => {
  if (!pool) return res.json({ quotes: req.body.quotes || {} });
  const clientQuotes = req.body.quotes || {};
  try {
    // Get all server quotes
    const { rows } = await pool.query('SELECT id, data, updated_at FROM quotes');
    const serverMap = {};
    for (const row of rows) {
      serverMap[row.id] = { data: row.data, updated_at: row.updated_at };
    }

    const merged = {};

    // Process client quotes — upsert if newer or missing on server
    for (const [id, quote] of Object.entries(clientQuotes)) {
      const clientTime = quote.updated_at ? new Date(quote.updated_at) : new Date(0);
      const serverEntry = serverMap[id];

      if (!serverEntry || clientTime > new Date(serverEntry.updated_at)) {
        // Client is newer — upsert to server
        await pool.query(
          `INSERT INTO quotes (id, data, updated_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = $3`,
          [id, JSON.stringify(quote), quote.updated_at || new Date().toISOString()]
        );
        merged[id] = quote;
      } else {
        // Server is newer — use server version
        merged[id] = serverEntry.data;
      }
      delete serverMap[id];
    }

    // Add quotes that only exist on server
    for (const [id, entry] of Object.entries(serverMap)) {
      merged[id] = entry.data;
    }

    res.json({ quotes: merged });
  } catch (err) {
    console.error('POST /api/quotes/sync error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── WRP CATALOGUE ROUTES ───────────────────────────────────────────────────

// Get full WRP catalogue
app.get('/api/wrp-catalogue', (req, res) => {
  if (!wrpCatalogue) return res.status(404).json({ error: 'WRP catalogue not loaded' });
  res.json(wrpCatalogue);
});

// Update a single profile's price (learn-as-you-go)
app.put('/api/wrp-catalogue/price/:id', (req, res) => {
  if (!wrpCatalogue) return res.status(404).json({ error: 'WRP catalogue not loaded' });
  const profileId = parseInt(req.params.id, 10);
  const { price_per_metre_gbp } = req.body;

  const profile = wrpCatalogue.profiles.find(p => p.id === profileId);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  profile.price_per_metre_gbp = typeof price_per_metre_gbp === 'number' ? price_per_metre_gbp : null;
  profile.price_last_updated = new Date().toISOString().split('T')[0];

  // Persist to disk
  try {
    fs.writeFileSync(WRP_CATALOGUE_PATH, JSON.stringify(wrpCatalogue, null, 2), 'utf8');
    res.json({ ok: true, profile });
  } catch (err) {
    console.error('Failed to save WRP catalogue:', err.message);
    res.status(500).json({ error: 'Failed to save catalogue' });
  }
});

// Proxy WRP images to avoid browser referrer/CORS issues
app.get('/api/wrp-image/:hash', async (req, res) => {
  const url = `https://www.wrp-timber-mouldings.co.uk/uploads/${req.params.hash}`;
  try {
    const https = require('https');
    https.get(url, upstream => {
      if (upstream.statusCode !== 200) return res.status(upstream.statusCode).end();
      res.set('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=604800');
      upstream.pipe(res);
    }).on('error', () => res.status(502).end());
  } catch { res.status(500).end(); }
});

// ─── CATCH-ALL ───────────────────────────────────────────────────────────────

// Serve index.html for any non-API route (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START ───────────────────────────────────────────────────────────────────

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`SAB Quote Calculator running on port ${PORT}`);
  });
});
