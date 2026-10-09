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
let calcDesignHrsPerRoom = null;
let recomputeQuotePricing = null;
let quoteGrandTotal = null;
let quoteMaterialsBom = null;
let withPricingStatus = null, lockQuote = null, quoteSettings = null, applySettings = null, ENGINE_VERSION = null;
let PRICING_DB = null, FRAME_MATERIALS = null, EDGEBAND_TYPES = null; // lookup tables for /api/cabinet-cost
let pricingEngineError = null;
try {
  // Explicit absolute path so it resolves regardless of CWD on the deploy host.
  ({ priceItem, calcDesignHrsPerRoom, recomputeQuotePricing, quoteGrandTotal, quoteMaterialsBom, DB: PRICING_DB, FRAME_MATERIALS, EDGEBAND_TYPES,
     withPricingStatus, lockQuote, quoteSettings, applySettings, ENGINE_VERSION } = require(path.join(__dirname, 'public', 'pricing.js')));
  console.log('[pricing] engine loaded:', typeof priceItem === 'function' ? 'ok' : 'MISSING priceItem export');
} catch (err) {
  pricingEngineError = err.message;
  console.error('[pricing] engine load FAILED — GET /api/quotes will return STORED pricing as-is:\n', err.stack || err.message);
}

// Stamp the quote's grand total (totalSellExVAT / totalSellIncVAT) onto the
// record using the canonical UI total function (pricing.js → quoteGrandTotal),
// so the downstream client portal can read a final figure that already includes
// design + all project-level costs. Purely additive: the field is layered on
// top of the existing data; on any failure the quote is returned unchanged.
function withGrandTotal(quote) {
  if (!quoteGrandTotal || !quote || !quote.rooms) return quote;
  try {
    return { ...quote, ...quoteGrandTotal(quote) };
  } catch (err) {
    console.error('[pricing] grand-total stamp failed:', err.message);
    return quote;
  }
}

// Read/serialize-time ONLY (applied in GET /api/quotes, not in the persist path):
// annotate each room that has design time with its effective design labour, resolving
// blank inputs against the quote's settings (locked or live) — the same figure the UI shows. Adds
// room.designHrs and resolves room.techDays in the RESPONSE only; stored data untouched.
// Deliberately not folded into recomputeQuotePricing so no persist path can bake
// a resolved techDays into the DB (which would break "blank = follow the default").
// Read/serialize-time ONLY (GET /api/quotes, never persisted): attach a per-quote
// materials bill-of-materials (material QUANTITIES, not costs) derived from the same
// engine geometry that prices each item — so downstream consumers can pull exact order
// quantities that never drift from the price. Purely additive; quote returned unchanged
// on any failure or when the quote has no material lines.
function withMaterialsBom(quote) {
  if (!quoteMaterialsBom || !quote || !quote.rooms) return quote;
  try {
    const bom = quoteMaterialsBom(quote);
    return bom ? { ...quote, materialsBom: bom } : quote;
  } catch (err) {
    console.error('[pricing] materialsBom build failed:', err.message);
    return quote;
  }
}

function withDesignHrs(quote) {
  if (!calcDesignHrsPerRoom || !quote || !quote.rooms) return quote;
  const rooms = {};
  for (const [roomName, room] of Object.entries(quote.rooms)) {
    if (room && room.includeDesignTime !== false) {
      const d = calcDesignHrsPerRoom(room, quoteSettings(quote));
      rooms[roomName] = { ...room, designHrs: +d.designHrs.toFixed(3), techDays: d.techDays };
    } else {
      rooms[roomName] = room;
    }
  }
  return { ...quote, rooms };
}

// Read-time ONLY: live hours next to priced hours + the mixed-pricing flag (pricing.js
// → withPricingStatus). Never changes a price; quote returned unchanged on failure.
function withHours(quote) {
  if (!withPricingStatus) return quote;
  try { return withPricingStatus(quote); }
  catch (err) { console.error('[pricing] hours annotation failed:', err.message); return quote; }
}

// A quote the server has never stored is new: price anything unpriced and lock it.
// An existing quote keeps its stored lock even if a stale client sends it without one.
function lockOnWrite(quote, storedLock) {
  if (!quote || !lockQuote) return quote;
  if (quote.pricingLock) return quote;
  if (storedLock !== undefined) return storedLock ? { ...quote, pricingLock: storedLock } : quote;
  return lockQuote(recomputeQuotePricing(quote));
}

// Shared pricing settings (the Settings page's DB JSON), stored once in Postgres and
// applied to this process's engine, so the API prices exactly as the browser does.
// ponytail: applied in-process; with several server instances each must reload on change.
async function loadSharedSettings() {
  if (!pool || !applySettings) return;
  try {
    const { rows } = await pool.query("SELECT data FROM settings WHERE id = 'pricing'");
    if (rows.length) { applySettings(rows[0].data); console.log('[pricing] shared settings applied'); }
  } catch (err) { console.error('[pricing] shared settings load failed:', err.message); }
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

// Public health check — minimal, no internals. `pricingEngine` is a plain boolean
// (whether the engine module loaded); the raw error and pricing details are exposed
// only on the auth-gated diagnostic route below.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: !!pool, pricingEngine: !!priceItem });
});

// Auth-gated engine diagnostic (NOT in PUBLIC_PATHS, so authMiddleware protects it).
// Runs a canonical open-lacquered carcass through the live engine so the deploy owner
// can confirm it's loaded AND current — carcassFinishHrs ≈ 3.06 and present means the
// latest pricing.js is live. The raw load error is only returned here, never publicly.
app.get('/api/health/engine', (req, res) => {
  let engineCheck = null;
  if (priceItem) {
    try {
      const r = priceItem({ type: 'cabinet', qty: 1, params: { widthMm: 600, heightMm: 2400, depthMm: 560, doorCount: 0, shelfCount: 5, carcassFinish: 'lacquer', carcassMaterialKey: 'MAT_BIRCH_UNF_18' } });
      const bd = (r && r.breakdown) || {};
      engineCheck = { finishHrs: bd.finishHrs, carcassFinishHrs: bd.carcassFinishHrs, hasCarcassFinishHrs: ('carcassFinishHrs' in bd) };
    } catch (e) { engineCheck = { error: e.message }; }
  }
  res.json({ pricingEngine: !!priceItem, engineVersion: ENGINE_VERSION, pricingEngineError, engineCheck });
});

// ─── CABINET COST API (for the cabinet configurator) ─────────────────────────
// Thin wrapper over the SAME engine call the UI makes: the request body is the
// engine's native cabinet params (the `params` object the UI stores on a cabinet
// item) and it is priced via priceItem({ type:'cabinet', qty, params }). No remapping,
// no defaults beyond the engine's own. Auth-gated by authMiddleware (not in
// PUBLIC_PATHS): Bearer API_TOKEN for service callers, or the cookie session.
//
// Validation is strict on purpose ("never a guess"): the engine silently ignores
// unknown fields and falls back to defaults for unknown hardware keys, so a typo
// would price a different cabinet. Unknown fields and unknown keys are 400s.
const CABINET_FIELDS = new Set([
  'widthMm', 'heightMm', 'depthMm', 'carcassMaterialKey', 'carcassFinish', 'backMaterialKey',
  'doorCount', 'doorType', 'drawerCount', 'drawerType', 'runnerKey', 'hingeKey', 'handleKey',
  'shelfCount', 'frameKey', 'frameThicknessMm', 'frameMemberWidthMm', 'frameCustomSpeciesName',
  'frameCustomPricePerM3', 'timberSpeciesKey', 'timberCustomSpeciesName', 'timberCustomPricePerM3',
  'panelMaterialKey', 'frameStileWidthMm', 'doorFrameThicknessMm', 'edgebandKey', 'hasStain',
  'sprayFinishOverride', 'qty',
  'cabinetTypeKey', // informational — the engine prices from dims/counts, not the type
]);
const CARCASS_FINISHES = ['none', 'edge_polish', 'primed', 'paint', 'lacquer', 'stain_lacquer'];
const SPRAY_OVERRIDES  = ['', 'primed', 'edge_polish', 'none'];

// Returns a list of problems (empty = OK). Only checks what the engine would otherwise guess at.
function cabinetSpecErrors(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['body must be a JSON object of cabinet params'];
  const errs = [];
  const unknown = Object.keys(spec).filter(k => !CABINET_FIELDS.has(k));
  if (unknown.length) errs.push(`unknown field(s): ${unknown.join(', ')}`);
  for (const f of ['widthMm', 'heightMm', 'depthMm']) {
    if (typeof spec[f] !== 'number' || !Number.isFinite(spec[f]) || spec[f] <= 0) errs.push(`${f} must be a positive number`);
  }
  for (const f of ['doorCount', 'drawerCount', 'shelfCount']) {
    if (spec[f] !== undefined && (!Number.isInteger(spec[f]) || spec[f] < 0)) errs.push(`${f} must be a non-negative integer`);
  }
  if (spec.qty !== undefined && (!Number.isInteger(spec.qty) || spec.qty < 1)) errs.push('qty must be a positive integer');
  if (spec.carcassMaterialKey === undefined) errs.push('carcassMaterialKey is required');
  const keyIn = (f, table, group) => { const v = spec[f]; if (v !== undefined && !(table && Object.prototype.hasOwnProperty.call(table, v))) errs.push(`unknown ${f} "${v}" — see GET /api/cabinet-cost/keys (${group})`); };
  keyIn('carcassMaterialKey', PRICING_DB.materials, 'materials');
  keyIn('backMaterialKey',    PRICING_DB.materials, 'materials');
  keyIn('panelMaterialKey',   PRICING_DB.materials, 'materials');
  keyIn('doorType',           PRICING_DB.doorTypes, 'doorTypes');
  keyIn('drawerType',         PRICING_DB.drawerTypes, 'drawerTypes');
  keyIn('runnerKey',          PRICING_DB.hardware.runners, 'hardware.runners');
  keyIn('hingeKey',           PRICING_DB.hardware.hinges,  'hardware.hinges');
  keyIn('handleKey',          PRICING_DB.hardware.handles, 'hardware.handles');
  keyIn('timberSpeciesKey',   PRICING_DB.solidTimber, 'solidTimber');
  keyIn('cabinetTypeKey',     PRICING_DB.cabinetTypes, 'cabinetTypes');
  keyIn('frameKey',           FRAME_MATERIALS, 'frames');
  keyIn('edgebandKey',        EDGEBAND_TYPES, 'edgebands');
  if (spec.carcassFinish !== undefined && !CARCASS_FINISHES.includes(spec.carcassFinish)) errs.push(`carcassFinish must be one of ${CARCASS_FINISHES.join('|')}`);
  if (spec.sprayFinishOverride !== undefined && !SPRAY_OVERRIDES.includes(spec.sprayFinishOverride)) errs.push(`sprayFinishOverride must be one of ""|${SPRAY_OVERRIDES.slice(1).join('|')}`);
  if (spec.hasStain !== undefined && typeof spec.hasStain !== 'boolean') errs.push('hasStain must be a boolean');
  return errs;
}

// POST /api/cabinet-cost — body: engine-native cabinet params → priceItem result
// ({ costPerUnit, sellPerUnit, totalCost, totalSellExVAT, totalSellIncVAT, breakdown }).
app.post('/api/cabinet-cost', (req, res) => {
  if (!priceItem || !PRICING_DB) return res.status(503).json({ error: 'Pricing engine not loaded' });
  const errors = cabinetSpecErrors(req.body);
  if (errors.length) return res.status(400).json({ error: 'Cannot price cabinet', errors });
  const { qty = 1, ...params } = req.body;
  let result;
  try { result = priceItem({ type: 'cabinet', qty, params }); }
  catch (err) {
    console.error('POST /api/cabinet-cost error:', err.message);
    return res.status(422).json({ error: 'Pricing engine failed: ' + err.message });
  }
  if (!result || !Number.isFinite(result.totalCost)) return res.status(422).json({ error: 'Pricing engine returned no cost for this spec' });
  res.json(result);
});

// GET /api/cabinet-cost/keys — valid keys (and display names) for every keyed field, so
// the configurator can build/check its mapping without reading pricing.js.
app.get('/api/cabinet-cost/keys', (req, res) => {
  if (!PRICING_DB) return res.status(503).json({ error: 'Pricing engine not loaded' });
  const namesOf = obj => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, (v && v.name) || k]));
  res.json({
    materials:    namesOf(PRICING_DB.materials),
    doorTypes:    namesOf(PRICING_DB.doorTypes),
    drawerTypes:  namesOf(PRICING_DB.drawerTypes),
    hardware:     { runners: namesOf(PRICING_DB.hardware.runners), hinges: namesOf(PRICING_DB.hardware.hinges), handles: namesOf(PRICING_DB.hardware.handles) },
    frames:       namesOf(FRAME_MATERIALS),
    edgebands:    namesOf(EDGEBAND_TYPES),
    solidTimber:  namesOf(PRICING_DB.solidTimber),
    cabinetTypes: namesOf(PRICING_DB.cabinetTypes),
    carcassFinishes: CARCASS_FINISHES,
    sprayFinishOverrides: SPRAY_OVERRIDES,
    fields: [...CABINET_FIELDS],
    settings: { margin: PRICING_DB.settings.margin, vat: PRICING_DB.settings.vat },
  });
});

// Get all quotes
app.get('/api/quotes', async (req, res) => {
  if (!pool) return res.json({});
  try {
    const { rows } = await pool.query('SELECT id, data, updated_at FROM quotes ORDER BY updated_at DESC');
    const quotes = {};
    for (const row of rows) {
      const base = { ...row.data, _serverUpdatedAt: row.updated_at };
      const recomputed = recomputeQuotePricing ? recomputeQuotePricing(base) : base;
      // Stamp the grand total from the freshly-recomputed items so the served
      // total always matches the served line items (and the calculator UI), and
      // attach the materials BOM aggregated from the same recomputed items.
      quotes[row.id] = withMaterialsBom(withHours(withGrandTotal(withDesignHrs(recomputed))));
    }
    res.json(quotes);
  } catch (err) {
    console.error('GET /api/quotes error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// (POST /api/quotes/reprice was removed: quotes are price-locked and only move to new
// pricing one at a time, through the calculator's "Reprice…" preview + confirm.)

// Shared pricing settings — see loadSharedSettings. GET returns null until first saved.
app.get('/api/settings', async (req, res) => {
  if (!pool) return res.json(null);
  try {
    const { rows } = await pool.query("SELECT data FROM settings WHERE id = 'pricing'");
    res.json(rows.length ? rows[0].data : null);
  } catch (err) {
    console.error('GET /api/settings error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/settings', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || !body.settings || typeof body.settings !== 'object') {
    return res.status(400).json({ error: 'expected the pricing DB object with a settings object' });
  }
  try {
    await pool.query(
      `INSERT INTO settings (id, data, updated_at) VALUES ('pricing', $1, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
      [JSON.stringify(body)]
    );
    if (applySettings) applySettings(body);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/settings error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Upsert a single quote
app.put('/api/quotes/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { id } = req.params;
  try {
    // New quote → priced + locked; existing → keeps its stored lock. Then stamp the grand
    // total from the client's own item pricing so it matches what the UI displayed.
    const { rows } = await pool.query("SELECT data->'pricingLock' AS lock FROM quotes WHERE id = $1", [id]);
    const data = withGrandTotal(lockOnWrite(req.body, rows.length ? rows[0].lock : undefined));
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
    // Re-stamp the grand total in case the patch touched pricing-affecting fields.
    const updated = withGrandTotal({ ...rows[0].data, ...patch });
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

// Bulk sync — client sends all its quotes, server merges and returns result.
// `deleted` is a list of tombstoned IDs (permanent deletes): the server purges
// them and refuses to re-introduce them, so they can't resurrect on any device.
app.post('/api/quotes/sync', async (req, res) => {
  if (!pool) return res.json({ quotes: req.body.quotes || {}, deleted: [] });
  const clientQuotes = req.body.quotes || {};
  const clientDeleted = Array.isArray(req.body.deleted) ? req.body.deleted : [];
  try {
    // Honour client tombstones first so the merge below can't re-introduce them.
    const confirmedDeleted = [];
    for (const id of clientDeleted) {
      try { await pool.query('DELETE FROM quotes WHERE id = $1', [id]); confirmedDeleted.push(id); }
      catch (e) { console.error('sync delete failed for', id, e.message); }
    }
    const deletedSet = new Set(clientDeleted);

    // Get all server quotes
    const { rows } = await pool.query('SELECT id, data, updated_at FROM quotes');
    const serverMap = {};
    for (const row of rows) {
      serverMap[row.id] = { data: row.data, updated_at: row.updated_at };
    }

    const merged = {};

    // Process client quotes — upsert if newer or missing on server
    for (const [id, quote] of Object.entries(clientQuotes)) {
      if (deletedSet.has(id)) continue; // tombstoned — never re-add
      const clientTime = quote.updated_at ? new Date(quote.updated_at) : new Date(0);
      const serverEntry = serverMap[id];

      if (!serverEntry || clientTime > new Date(serverEntry.updated_at)) {
        // Client is newer — upsert to server, stamping the grand total so the
        // stored record carries the same final figure the UI showed.
        const stamped = withGrandTotal(lockOnWrite(quote, serverEntry ? (serverEntry.data.pricingLock || null) : undefined));
        await pool.query(
          `INSERT INTO quotes (id, data, updated_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = $3`,
          [id, JSON.stringify(stamped), quote.updated_at || new Date().toISOString()]
        );
        merged[id] = stamped;
      } else {
        // Server is newer — use server version
        merged[id] = serverEntry.data;
      }
      delete serverMap[id];
    }

    // Add quotes that only exist on server (skip anything the client tombstoned)
    for (const [id, entry] of Object.entries(serverMap)) {
      if (deletedSet.has(id)) continue;
      merged[id] = entry.data;
    }

    res.json({ quotes: merged, deleted: confirmedDeleted });
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

// Exported for tests (which listen on their own port); started only when run directly.
module.exports = app;
if (require.main === module) {
  initDB().then(loadSharedSettings).then(() => {
    app.listen(PORT, () => {
      console.log(`SAB Quote Calculator running on port ${PORT}`);
    });
  });
}
