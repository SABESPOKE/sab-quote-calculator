// Website orders (locked: true): quotes the configurator creates from PAID website orders.
// Never priced or repriced — their totals are the paid figures — and nothing on them may
// change but their status. Run: `npm test`.
//
// No live data: server.js runs against an in-memory stand-in for Postgres that stores each
// row as JSONB does (JSON round trip, object keys re-ordered).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

delete process.env.DATABASE_URL; // never touch a real DB from tests
delete process.env.APP_PASSWORD;  // auth off, as in local dev

const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'public', 'pricing.js'));
const clone = o => JSON.parse(JSON.stringify(o));
const ORDER = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'website-order.json'), 'utf8'));
const STAMPED = { totalSellExVAT: 1250, totalSellIncVAT: 1500 }; // the paid figures, as the server stamps them

// ─── in-memory Postgres (only the statements server.js runs) ─────────────────
// JSONB returns object keys shorter-first, then bytewise — never in the order sent.
const jsonb = v => Array.isArray(v) ? v.map(jsonb) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).map(k => [k, jsonb(v[k])]))
  : v;
function fakePool(seed = {}) {
  const rows = new Map();
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 27, 9, 0, tick++));
  const put = (id, data, at) => rows.set(id, { data: jsonb(clone(data)), updated_at: at ? new Date(at) : now() });
  for (const [id, data] of Object.entries(seed)) put(id, data);
  return {
    rows,
    async query(sql, p = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      const row = rows.get(p[0]);
      if (/ settings /.test(s)) return { rows: [], rowCount: 0 };
      if (s.startsWith('SELECT id, data, updated_at FROM quotes')) return { rows: [...rows].map(([id, r]) => ({ id, data: clone(r.data), updated_at: r.updated_at })) };
      if (s.startsWith("SELECT data->'pricingLock' AS lock FROM quotes WHERE id = $1")) return { rows: row ? [{ lock: row.data.pricingLock ?? null }] : [] };
      if (s.startsWith('SELECT data FROM quotes WHERE id = $1')) return { rows: row ? [{ data: clone(row.data) }] : [] };
      if (s.startsWith('INSERT INTO quotes')) { put(p[0], JSON.parse(p[1]), p[2]); return { rowCount: 1 }; }
      if (s.startsWith('UPDATE quotes SET data = $1, updated_at = NOW() WHERE id = $2')) { put(p[1], JSON.parse(p[0])); return { rowCount: 1 }; }
      if (s.startsWith('DELETE FROM quotes WHERE id = $1')) return { rowCount: rows.delete(p[0]) ? 1 : 0 };
      throw new Error(`fake pool: unexpected SQL: ${s}`);
    },
  };
}

// server.js with the stand-in pool as ./db. Run as a plain function so the same loader can
// run a baseline server.js taken from git.
function loadServer(pool, src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'), dir = ROOT) {
  const mod = { exports: {} };
  const req = id => id === './db' ? { pool, initDB: async () => true } : require(id);
  new Function('require', 'module', 'exports', '__dirname', '__filename', src)(req, mod, mod.exports, dir, path.join(dir, 'server.js'));
  return mod.exports;
}
async function start(pool, src, dir) {
  const server = await new Promise(resolve => { const s = loadServer(pool, src, dir).listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { base, call, close: () => new Promise(resolve => server.close(resolve)) };
}
async function withServer(seed, fn) {
  const pool = fakePool(seed);
  const s = await start(pool);
  try { await fn(s, pool); } finally { await s.close(); }
}

// ─── 1. read path: never priced, totals = the paid figures ──────────────────
test('engine: a website order is never repriced, and its totals are the paid figures exactly', () => {
  const q = clone(ORDER);
  const cab = q.rooms.Utility.items[0];
  assert.notEqual(P.priceItem(cab).totalSellExVAT, cab.pricing.totalSellExVAT, 'control: the engine prices this cabinet differently');
  assert.equal(P.recomputeQuotePricing(q), q);
  assert.equal(P.recomputeQuotePricing(q, { onlyUnpriced: true }), q);
  const t = P.quoteTotals(q);
  assert.deepEqual([t.totalExVAT, t.vat, t.totalIncVAT], [1250, 250, 1500]);
  assert.deepEqual(P.quoteGrandTotal(q), STAMPED);
  assert.notEqual(P.quoteGrandTotal({ ...q, locked: false }).totalSellExVAT, 1250, 'control: unlocked, project costs are added');
});

test('GET /api/quotes serves a website order exactly as stored: no reprice, no re-total, no annotations', () => withServer({ [ORDER.id]: ORDER }, async s => {
  const { status, body } = await s.call('GET', '/api/quotes');
  assert.equal(status, 200);
  const { _serverUpdatedAt, ...served } = body[ORDER.id];
  assert.ok(_serverUpdatedAt);
  assert.deepEqual(served, ORDER);
}));

test('PUT and sync store a new website order as sent, never priced or price-locked; totals = paid', () => withServer({}, async (s, pool) => {
  const other = { ...clone(ORDER), id: 'cfg-1043' };
  assert.equal((await s.call('PUT', `/api/quotes/${ORDER.id}`, ORDER)).status, 200);
  assert.equal((await s.call('POST', '/api/quotes/sync', { quotes: { [other.id]: other } })).status, 200);
  for (const q of [ORDER, other]) assert.deepEqual(pool.rows.get(q.id).data, { ...q, ...STAMPED });
}));

test('lock-quotes migration skips website orders', () => {
  const { analyseQuote } = require(path.join(ROOT, 'scripts', 'lock-quotes.js'));
  const a = analyseQuote(clone(ORDER));
  assert.equal(a.alreadyLocked, true);
  assert.deepEqual([a.savedTotal, a.servedTotal], [STAMPED, STAMPED], 'the dry-run report shows the paid figures');
});
