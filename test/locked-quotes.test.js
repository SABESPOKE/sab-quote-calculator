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
const os = require('node:os');
const { spawn } = require('node:child_process');

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

// ─── 2. server guard: nothing on it may change but its status ───────────────
const STORED = { ...ORDER, ...STAMPED }; // as the server stores it
const EDITS = {
  'item price': q => { q.rooms.Utility.items[0].pricing.totalSellExVAT = 1; },
  'item qty': q => { q.rooms.Utility.items[0].qty = 3; },
  'item added': q => { q.rooms.Utility.items.push({ type: 'custom', description: 'Extra', qty: 1, params: {} }); },
  'item deleted': q => { q.rooms.Utility.items.pop(); },
  'margin': q => { q.marginOverride = 3; },
  'room field': q => { q.rooms.Utility.includeDesignTime = true; },
  'room added': q => { q.rooms.Kitchen = { items: [] }; },
  'paid figures': q => { q.paid.exVat = 1000; },
  'project costs': q => { q.projectCosts = P.getDefaultProjectCosts(); },
  'unlocked': q => { delete q.locked; },
};
const edited = name => { const q = clone(STORED); EDITS[name](q); return q; };
const LOCKED_409 = /paid website order and is locked — only its status can change/;

test('PUT refuses any change to a website order\'s prices, items, margin, rooms or paid figures (409), even from lock-aware code', () => withServer({ [ORDER.id]: STORED }, async (s, pool) => {
  for (const name of Object.keys(EDITS)) for (const headers of [{}, { 'X-Pricing-Engine': P.ENGINE_VERSION }]) {
    const r = await s.call('PUT', `/api/quotes/${ORDER.id}`, edited(name), headers);
    assert.equal(r.status, 409, name);
    assert.match(r.body.error, LOCKED_409, name);
  }
  assert.deepEqual(pool.rows.get(ORDER.id).data, STORED);
}));

test('PATCH refuses the same changes (409); sync keeps the server copy', () => withServer({ [ORDER.id]: STORED }, async (s, pool) => {
  for (const patch of [{ marginOverride: 3 }, { paid: { ...ORDER.paid, exVat: 1000 } }, { rooms: {} }, { locked: false }, { status: 'archive', projectCosts: {} }]) {
    const r = await s.call('PATCH', `/api/quotes/${ORDER.id}`, patch);
    assert.equal(r.status, 409, JSON.stringify(patch));
    assert.match(r.body.error, LOCKED_409);
  }
  const newer = { ...edited('item price'), updated_at: '2030-01-01T00:00:00.000Z' };
  const r = await s.call('POST', '/api/quotes/sync', { quotes: { [ORDER.id]: newer } }, { 'X-Pricing-Engine': P.ENGINE_VERSION });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.quotes[ORDER.id], STORED);
  assert.deepEqual(pool.rows.get(ORDER.id).data, STORED);
}));

test('the status (and the Deleted folder) still changes by PUT, PATCH and sync — and nothing else moves', () => withServer({ [ORDER.id]: STORED }, async (s, pool) => {
  // What the browser sends: its copy from GET (with _serverUpdatedAt), newly timestamped.
  const copy = { ...clone(STORED), _serverUpdatedAt: '2026-10-27T09:00:00.000Z', updated_at: '2026-10-27T10:00:00.000Z' };
  const engine = { 'X-Pricing-Engine': P.ENGINE_VERSION };
  assert.equal((await s.call('PUT', `/api/quotes/${ORDER.id}`, { ...copy, status: 'archive' }, engine)).status, 200);
  assert.equal(pool.rows.get(ORDER.id).data.status, 'archive');
  assert.equal((await s.call('PATCH', `/api/quotes/${ORDER.id}`, { status: 'lost' })).status, 200);
  assert.equal(pool.rows.get(ORDER.id).data.status, 'lost');
  const deletedAt = '2026-10-27T11:00:00.000Z';
  assert.equal((await s.call('PUT', `/api/quotes/${ORDER.id}`, { ...copy, status: 'lost', deleted: true, deletedAt })).status, 200);
  const synced = await s.call('POST', '/api/quotes/sync', { quotes: { [ORDER.id]: { ...copy, status: 'sold', deleted: true, deletedAt, updated_at: '2030-01-01T00:00:00.000Z' } } }, engine);
  assert.equal(synced.body.quotes[ORDER.id].status, 'sold');
  const { status, deleted, deletedAt: at, updated_at, _serverUpdatedAt, ...rest } = pool.rows.get(ORDER.id).data;
  assert.deepEqual([status, deleted, at], ['sold', true, deletedAt]);
  const { status: s0, updated_at: u0, ...unchanged } = STORED;
  assert.deepEqual(rest, unchanged);
}));

// ─── 4. idempotent create, as docs/configurator-quotes.md specifies ──────────
test('PUT /api/quotes/cfg-<id> with the same body twice leaves one quote, both answered 200', () => withServer({}, async (s, pool) => {
  for (let i = 0; i < 2; i++) assert.deepEqual(await s.call('PUT', `/api/quotes/${ORDER.id}`, ORDER), { status: 200, body: { ok: true } }, `PUT #${i + 1}`);
  assert.deepEqual([...pool.rows.keys()], [ORDER.id]);
  assert.deepEqual(pool.rows.get(ORDER.id).data, STORED);
  const { body } = await s.call('GET', '/api/quotes');
  assert.deepEqual(Object.keys(body), [ORDER.id]);
  // A different body for the same order is refused, never merged.
  const r = await s.call('PUT', `/api/quotes/${ORDER.id}`, { ...clone(ORDER), paid: { ...ORDER.paid, exVat: 1000, gross: 1250, balance: 500 } });
  assert.equal(r.status, 409);
  assert.deepEqual(pool.rows.get(ORDER.id).data, STORED);
}));

test('a new website order is validated: 400 with every problem listed, nothing stored', () => withServer({}, async (s, pool) => {
  const bad = (name, edit, expect) => [name, q => { edit(q); return q; }, expect];
  const cases = [
    bad('id ≠ URL', q => { q.id = 'cfg-9'; }, /id must equal the id in the URL/),
    bad('no paid', q => { delete q.paid; }, /paid\.exVat, paid\.vat, paid\.gross, paid\.deposit, paid\.balance must be/),
    bad('string amount', q => { q.paid.vat = '250.00'; }, /paid\.vat must be/),
    bad('negative', q => { q.paid.deposit = -1; }, /paid\.deposit must be/),
    bad('3 decimals', q => { q.paid.exVat = 1250.001; }, /paid\.exVat must be/),
    bad('gross ≠ ex + VAT', q => { q.paid.gross = 1499.99; q.paid.balance = 749.99; }, /paid\.gross must equal paid\.exVat \+ paid\.vat/),
    bad('deposit + balance ≠ gross', q => { q.paid.balance = 700; }, /paid\.deposit \+ paid\.balance must equal paid\.gross/),
    bad('lines ≠ ex VAT', q => { q.rooms.Utility.items.pop(); }, /must add up to paid\.exVat/),
    bad('unpriced line', q => { delete q.rooms.Utility.items[1].pricing; }, /every item needs pricing\.totalSellExVAT/),
    bad('design time', q => { delete q.rooms.Utility.includeDesignTime; }, /includeDesignTime: false/),
    bad('no rooms', q => { q.rooms = {}; }, /rooms must be/),
  ];
  for (const [name, edit, expect] of cases) {
    const q = edit(clone(ORDER));
    const r = await s.call('PUT', `/api/quotes/${ORDER.id}`, q);
    assert.equal(r.status, 400, name);
    assert.ok(r.body.errors.some(e => expect.test(e)), `${name}: ${JSON.stringify(r.body.errors)}`);
  }
  // The same rules hold however it arrives (sync, PATCH).
  const q = { ...clone(ORDER), paid: undefined, updated_at: '2030-01-01T00:00:00.000Z' };
  assert.deepEqual((await s.call('POST', '/api/quotes/sync', { quotes: { [ORDER.id]: q } })).body.quotes, {});
  assert.equal(pool.rows.size, 0);
  // A discount line (negative) is fine as long as the lines add up.
  const discounted = clone(ORDER);
  discounted.rooms.Utility.items.push({ type: 'custom', description: 'Discount', qty: 1, params: {}, pricing: { totalSellExVAT: -50 } });
  discounted.paid = { exVat: 1200, vat: 240, gross: 1440, deposit: 720, balance: 720 };
  assert.equal((await s.call('PUT', `/api/quotes/${ORDER.id}`, discounted)).status, 200);
}));

test('docs/configurator-quotes.md: its example body is exactly the order these tests use', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'configurator-quotes.md'), 'utf8');
  const example = doc.split('## Example')[1].match(/```json\r?\n([\s\S]*?)\r?\n```/)[1];
  assert.deepEqual(JSON.parse(example), ORDER);
});

// ─── 3. UI: headless Chrome over the DevTools protocol ───────────────────────
// Needs Chrome (CHROME_PATH), Node 22+ (global WebSocket) and the CDN (React / Babel).
// SCREENSHOT_DIR=<dir> also saves screenshots of each screen.
const CHROME = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => fs.existsSync(p));
async function browser() {
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--window-size=1440,1000', '--no-first-run',
    `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'sab-chrome-'))}`, 'about:blank']);
  const port = await new Promise((resolve, reject) => {
    let err = '';
    proc.stderr.on('data', d => { err += d; const m = err.match(/ws:\/\/127\.0\.0\.1:(\d+)\//); if (m) resolve(m[1]); });
    proc.on('exit', () => reject(new Error(`chrome exited: ${err}`)));
  });
  const [page] = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  let n = 0;
  const waiting = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); } });
  const send = (method, params = {}) => new Promise(resolve => { waiting.set(++n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  const js = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description || r.exceptionDetails.text} in: ${expr.slice(0, 200)}`);
    return r.result.value;
  };
  const until = async (expr, ms = 15000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise(r => setTimeout(r, 100))) if (await js(expr)) return;
    throw new Error(`timed out waiting for: ${expr}`);
  };
  // Click the LAST (deepest) element matching `sel` whose text contains every one of `texts`.
  const click = (sel, ...texts) => js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
    .filter(e => ${JSON.stringify(texts)}.every(t => e.textContent.includes(t))).pop();
    if (!el) throw new Error('nothing to click: ' + ${JSON.stringify(`${sel} ${texts.join(' + ')}`)}); el.click(); return true; })()`);
  const shot = async name => {
    if (!process.env.SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.SCREENSHOT_DIR, name), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  };
  return { js, until, click, shot, send, close: () => { ws.close(); proc.kill(); } };
}
const settle = ms => new Promise(r => setTimeout(r, ms));
const rootText = `document.getElementById('root').textContent`; // rendered text only (body also holds the JSX source)
const BUILD_STATE = `(() => {
  const panel = document.querySelector('.sab-items-panel'), text = ${rootText};
  const buttons = t => [...document.querySelectorAll('button')].filter(e => e.textContent.trim() === t);
  const off = e => e.matches(':disabled'); // also true inside a disabled <fieldset>, unlike e.disabled
  return {
    badges: text.split('From website — price locked').length - 1,
    addItem: buttons('+ Add Item').map(off),
    edit: buttons('Edit').map(off),
    enabledInItems: [...panel.querySelectorAll('input, select, textarea, button')].filter(e => !off(e)).length,
  };
})()`;

test('UI: a website order shows the badge and its paid figures, is read-only, and its status still changes', {
  skip: (!CHROME && 'Chrome not found (set CHROME_PATH)') || (typeof WebSocket === 'undefined' && 'needs Node 22+ (global WebSocket)'),
  timeout: 180000,
}, () => {
  const CONTROL = P.lockQuote({ id: 'Q1790000000000', client: 'Jane Example', project: 'Kitchen', ref: 'SAB-2026-101', created: '01/10/2026', status: 'sold',
    rooms: { Kitchen: { includeDesignTime: false, items: [{ type: 'door', description: 'Shaker door', qty: 1, params: { doorType: 'SHAKER_PNT', widthMm: 500, heightMm: 720 } }].map(it => ({ ...it, pricing: P.priceItem(it) })) } },
    projectCosts: P.getDefaultProjectCosts() });
  return withServer({ [ORDER.id]: STORED, [CONTROL.id]: CONTROL }, async (s, pool) => {
    const b = await browser();
    try {
      await b.send('Page.navigate', { url: `${s.base}/` });
      await b.until(`!!document.getElementById('root') && ${rootText}.includes('Sold (2)')`, 90000).catch(e => { throw new Error(`${e.message} — the app never rendered (offline? it loads React/Babel from unpkg)`); });
      await b.js(`window.__alerts = []; window.alert = m => { window.__alerts.push(String(m)); }; true`);

      // The browser's load path leaves a website order exactly as paid — even one that would trip a migration.
      const odd = clone(STORED);
      odd.projectCosts = { includeSurvey: false };
      odd.rooms.Utility.items[0].params.fillerCount = 1;
      assert.equal(await b.js(`JSON.stringify(ensurePricing({ x: ${JSON.stringify(odd)} }).x) === ${JSON.stringify(JSON.stringify(odd))}`), true, 'ensurePricing changed a website order');

      // List: the badge on the website order's card.
      await b.click('button', 'Sold (');
      await b.click('div', 'Jane Example', '2 quotes');
      await b.until(`${rootText}.includes('WEB-1042')`);
      assert.equal(await b.js(`${rootText}.split('From website — price locked').length - 1`), 1, 'list badge');
      await b.shot('1-list-badge.png');

      // Build view: badge + the paid figures as entered; nothing to add, edit or delete.
      await b.click('div', 'WEB-1042');
      await b.until(`!!document.querySelector('.sab-items-panel')`);
      await settle(300);
      await b.shot('2-build-locked.png');
      const ui = await b.js(BUILD_STATE);
      assert.equal(ui.badges, 2, 'header badge + paid-figures panel');
      assert.deepEqual(ui.addItem, [true, true], '+ Add Item disabled');
      assert.deepEqual(ui.edit, [true, true], 'Edit disabled');
      assert.equal(ui.enabledInItems, 0, 'every price / item / margin control in the items panel is disabled');
      assert.equal(await b.js(`['£1,250.00', '£250.00', '£1,500.00', '£750.00'].every(v => ${rootText}.includes(v))`), true, 'paid figures');
      assert.equal(await b.js(`document.querySelector('.sab-rooms-panel fieldset').disabled && !document.querySelector('input[placeholder="Room name…"]')`), true, 'rooms panel read-only');
      assert.equal(await b.js(`[...document.querySelectorAll('button')].some(e => /^(Reprice…|⧉|⚙)$/.test(e.textContent.trim()))`), false, 'no reprice / duplicate-room / room-setup');
      assert.equal(await b.js(`document.querySelector('input[placeholder^="Describe items"]').matches(':disabled')`), true, 'AI chat disabled');
      // A toggle the fieldset can't disable is undone by saveQuotes and never sent.
      await b.click('div', 'Items are alternatives');
      await settle(900);
      assert.equal(await b.js(`${rootText}.includes('✓Items are alternatives')`), false, 'toggle undone');
      assert.deepEqual(pool.rows.get(ORDER.id).data, STORED);

      await b.click('button', 'Margin');
      await b.until(`${rootText}.includes('Cost & Margin Analysis')`);
      assert.equal(await b.js(`['£1,250.00', '£250.00', '£1,500.00'].every(v => ${rootText}.includes(v))`), true, 'margin view totals = paid');
      await b.shot('3-margin-locked.png');
      await b.click('button', 'Client View');
      await b.until(`${rootText}.includes('Total (inc VAT)')`);
      assert.equal(await b.js(`${rootText}.includes('£1,500.00')`), true, 'client view total = paid gross');
      await b.shot('4-client-view-locked.png');

      // Status still changes (⋮ → Archive): the PATCH and the whole-quote PUT are both accepted.
      await b.click('button', '← All');
      await b.until(`${rootText}.includes('WEB-1042')`);
      await b.js(`(() => { const card = e => { while (!e.textContent.includes('Jane Example')) e = e.parentElement; return e; };
        [...document.querySelectorAll('button')].find(e => e.textContent.trim() === '⋮' && card(e).textContent.includes('WEB-1042')).click(); return true; })()`);
      await b.click('div', 'Archive');
      for (const t0 = Date.now(); !pool.rows.get(ORDER.id).data._serverUpdatedAt && Date.now() - t0 < 10000;) await settle(100);
      const { status, updated_at, _serverUpdatedAt, ...rest } = pool.rows.get(ORDER.id).data;
      const { status: s0, updated_at: u0, ...unchanged } = STORED;
      assert.equal(status, 'archive');
      assert.ok(_serverUpdatedAt, 'the whole-quote PUT landed');
      assert.deepEqual(rest, unchanged);
      assert.deepEqual(await b.js('window.__alerts'), []);

      // ⋮ → Duplicate: the copy is an ordinary, editable quote at the order's item prices.
      await b.click('button', 'Archive (');
      await b.until(`${rootText}.includes('WEB-1042')`);
      await b.click('button', '⋮');
      await b.click('div', 'Duplicate quote');
      await b.until(`!!document.querySelector('.sab-rooms-panel')`);
      await b.click('div', 'Utility', '2 items');
      await b.until(`!!document.querySelector('.sab-items-table')`);
      const dup = await b.js(BUILD_STATE);
      assert.equal(dup.badges, 0);
      assert.deepEqual(dup.addItem, [false, false]);
      let copy;
      for (const t0 = Date.now(); !copy && Date.now() - t0 < 10000; await settle(100)) copy = [...pool.rows].find(([id]) => /^Q\d+$/.test(id) && id !== CONTROL.id);
      assert.ok(copy, 'the copy was saved');
      assert.deepEqual([copy[1].data.locked, copy[1].data.paid, copy[1].data.source, P.isPricingLock(copy[1].data.pricingLock)], [undefined, undefined, undefined, true]);
      assert.deepEqual(copy[1].data.rooms.Utility.items.map(i => i.pricing.totalSellExVAT), [1190, 60]);

      // Control: an ordinary quote is editable as before.
      await b.click('button', '← All');
      await b.click('button', 'Sold (');
      await b.click('div', 'SAB-2026-101');
      await b.until(`!!document.querySelector('.sab-items-panel')`);
      await settle(300);
      const ctl = await b.js(BUILD_STATE);
      assert.equal(ctl.badges, 0);
      assert.deepEqual(ctl.addItem, [false, false]);
      assert.ok(ctl.enabledInItems > 5);
      await b.shot('5-unlocked-control.png');
    } finally { b.close(); }
  });
});

test('lock-quotes migration skips website orders', () => {
  const { analyseQuote } = require(path.join(ROOT, 'scripts', 'lock-quotes.js'));
  const a = analyseQuote(clone(ORDER));
  assert.equal(a.alreadyLocked, true);
  assert.deepEqual([a.savedTotal, a.servedTotal], [STAMPED, STAMPED], 'the dry-run report shows the paid figures');
});
