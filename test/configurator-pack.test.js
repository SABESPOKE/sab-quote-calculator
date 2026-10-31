// Configurator pricing pack (Steve, 31 Oct 2026): push to open, channel rail per metre, bin frame, legs,
// painted carcass outside, true door heights, soffit LED. Every new field is optional and off by default.
// Run: `npm test`. The regression half needs git (baseline engine = master before the pack).
//
//   QUOTES_SNAPSHOT=/path/quotes.json node --test test/configurator-pack.test.js   (real quotes, never committed)
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

process.env.APP_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-secret';
process.env.API_TOKEN = 'test-bearer-token';
delete process.env.DATABASE_URL; // never touch a real DB from tests

const P = require(path.join(__dirname, '..', 'public', 'pricing.js'));
const app = require(path.join(__dirname, '..', 'server.js'));

let server, base;
before(async () => { await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${server.address().port}`; });
after(() => new Promise(resolve => server.close(resolve)));
// POST to the configurator's endpoints → { status, body }.
const post = async (route, body) => {
  const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.API_TOKEN}` }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const wire = o => JSON.parse(JSON.stringify(o));
// The API answer for a body equals priceItem for the same item (the configurator's parity contract).
async function parity(route, type, body) {
  const { qty = 1, ...params } = body;
  const { status, body: got } = await post(route, body);
  assert.equal(status, 200, JSON.stringify(got));
  assert.deepEqual(got, wire(P.priceItem({ type, qty, params })));
  return got;
}
async function refused(route, body, needle) {
  const { status, body: got } = await post(route, body);
  assert.equal(status, 400, JSON.stringify(got));
  assert.ok(got.errors.some(e => e.includes(needle)), `expected an error mentioning "${needle}", got ${JSON.stringify(got.errors)}`);
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const ER = P.er();   // bench rate £/h (labour + overhead)
// Configurator-shaped cabinet params (quoteCalcMapping's house choices).
const CAB = { widthMm: 600, heightMm: 770, depthMm: 560, carcassMaterialKey: 'MAT_BIRCH_PREF_18', carcassFinish: 'none', doorType: 'SLAB_PNT',
  drawerType: 'DRW_SHEET', runnerKey: 'HW_RUN_BLUM_SM', hingeKey: 'HW_HINGE_SM', handleKey: 'HW_HDL_NONE', frameKey: 'FRAME_NONE', edgebandKey: 'EDGE_ABS_PAINT', hasStain: false, shelfCount: 1 };
const cabinet = (o = {}, qty = 1) => P.priceItem({ type: 'cabinet', qty, params: { ...CAB, ...o } });
const SINGLE_600  = { doorCount: 1, drawerCount: 0 };
const DRAWER3_600 = { doorCount: 0, drawerCount: 3, shelfCount: 0 };

// ─── Existing quotes: with every new field absent, nothing may change ────────
const BASE_REF = process.env.BASE_REF || 'f46b99d';
let OLD = null;
try {
  const src = execFileSync('git', ['show', `${BASE_REF}:public/pricing.js`], { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 1 << 24 });
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sab-pack-base-')), 'pricing.js');
  fs.writeFileSync(tmp, src);
  OLD = require(tmp);
} catch { /* no git / unknown ref → regression tests skip */ }

// Every item type, across the materials, fronts, finishes and hardware the BASELINE engine knows (its keys only:
// a key the pack adds, e.g. HW_HDL_PUSH, is a new field).
function corpus(P = OLD) {
  const items = [];
  const cab = (params, qty = 1) => items.push({ type: 'cabinet', qty, params });
  const FIN = ['none', 'edge_polish', 'primed', 'paint', 'lacquer', 'stain_lacquer'];
  for (const carcassMaterialKey of ['MAT_BIRCH_PREF_18', 'MAT_BIRCH_UNF_18', 'MAT_MDF_FH_18', 'MAT_OAK_MDF_UNF_19', 'MAT_SHINNOKI_19', 'MAT_MEL_EGGER_18'])
    for (const doorType of Object.keys(P.DB.doorTypes))
      cab({ widthMm: 600, heightMm: 770, depthMm: 560, carcassMaterialKey, doorCount: 2, drawerCount: 1, doorType, drawerType: 'DRW_SHEET', timberSpeciesKey: 'TIM_OAK' });
  for (const carcassFinish of FIN) for (const doorCount of [0, 1, 2])
    cab({ widthMm: 600, heightMm: 770, depthMm: 560, carcassMaterialKey: 'MAT_MDF_FH_18', carcassFinish, doorCount, shelfCount: 2, doorType: 'SLAB_PNT' });
  for (const handleKey of Object.keys(P.DB.hardware.handles)) for (const hingeKey of Object.keys(P.DB.hardware.hinges))
    cab({ widthMm: 600, heightMm: 770, depthMm: 560, carcassMaterialKey: 'MAT_BIRCH_PREF_18', doorCount: 1, drawerCount: 3, doorType: 'SLAB_PNT', handleKey, hingeKey });
  for (const sprayFinishOverride of ['', 'primed', 'edge_polish', 'none'])
    cab({ widthMm: 1000, heightMm: 2100, depthMm: 560, carcassMaterialKey: 'MAT_MDF_FH_18', doorCount: 2, drawerCount: 2, shelfCount: 4, doorType: 'SHAKER_PNT', sprayFinishOverride }, 2);
  for (const frameKey of Object.keys(P.FRAME_MATERIALS))
    cab({ widthMm: 800, heightMm: 900, depthMm: 350, carcassMaterialKey: 'MAT_OAK_MDF_PREF_19', doorCount: 2, doorType: 'FRAMED_INSET', frameKey, frameCustomPricePerM3: 3000 });
  for (const edgebandKey of Object.keys(P.EDGEBAND_TYPES))
    cab({ widthMm: 450, heightMm: 720, depthMm: 300, carcassMaterialKey: 'MAT_MEL_EGGER_18', doorCount: 1, doorType: 'SLAB_VEN', edgebandKey, hasStain: true });
  for (const [k, t] of Object.entries(P.DB.cabinetTypes))   // every catalogue cabinet at its defaults
    cab({ widthMm: t.w, heightMm: t.h, depthMm: t.d, doorCount: t.doors, drawerCount: t.drawers, shelfCount: t.shelves, carcassMaterialKey: 'MAT_BIRCH_UNF_18', cabinetTypeKey: k });
  cab({ widthMm: 600, heightMm: 770, depthMm: 560 });   // engine defaults throughout
  for (const f of FIN) {
    items.push({ type: 'endpanel', qty: 2, params: { materialKey: 'MAT_MDF_FH_18', widthMm: 560, heightMm: 900, finishType: f, faces: 2 } });
    items.push({ type: 'shelf', qty: 1, params: { materialKey: 'TIM_WAL', lengthMm: 1200, depthMm: 250, visibleThicknessMm: 50, finishType: f } });
    items.push({ type: 'wrp_moulding', qty: 1, params: { wrp_price_per_metre: 10, linear_metres: 5.5, markup_pct: 35, dimensions: '55mm x 52mm', finishType: f } });
  }
  items.push({ type: 'door', qty: 3, params: { doorType: 'SHAKER_TIM_LAC', widthMm: 497, heightMm: 1200, timberSpeciesKey: 'TIM_OAK', hingeCost: 19, handleCost: 12 } });
  items.push({ type: 'frame', qty: 1, params: { species: 'TIM_ASH', heightMm: 2000, widthMm: 900 } });
  items.push({ type: 'drawer', qty: 2, params: { drawerType: 'DRW_SOLID_WAL', widthMm: 574, heightMm: 180, depthMm: 510 } });
  items.push({ type: 'moulding', qty: 1, params: { mouldingKey: 'MLD_CORN_OAK_100', metres: 4.2 } });
  items.push({ type: 'filler', qty: 2, params: { doorType: 'SHAKER_PNT', widthMm: 50, heightMm: 720 } });
  items.push({ type: 'custom', qty: 2, params: { unitCostExVAT: 145 } });
  items.push({ type: 'cabinet', qty: 1, fixedPrice: true, fixedCostExVAT: 900, fixedMarkupPct: 15, params: {} });
  return items;
}

// priceItem without its pricedWith stamp (the engine version and settings fingerprint move by design).
const priced = (E, item, m) => { try { const { pricedWith, ...p } = E.priceItem(item, m) || {}; return p; } catch (e) { return `threw ${e.message}`; } };

function compareQuote(q) {
  const out = [];
  for (const [room, r] of Object.entries(q.rooms || {})) (r.items || []).forEach((item, i) => {
    try { assert.deepStrictEqual(priced(P, item, q.marginOverride), priced(OLD, item, q.marginOverride)); }
    catch { out.push(`${room}[${i}] ${item.type} ${JSON.stringify(item.params)}`); }
  });
  const ro = OLD.recomputeQuotePricing(q), rn = P.recomputeQuotePricing(q);
  for (const [name, fn] of [['quoteTotals', 'quoteTotals'], ['grandTotal', 'quoteGrandTotal'], ['materialsBom', 'quoteMaterialsBom']]) {
    try { assert.deepStrictEqual(P[fn](rn), OLD[fn](ro)); } catch { out.push(name); }
  }
  return out;
}

test('regression: with every new field absent, every item and quote prices exactly as master', { skip: !OLD && `baseline ${BASE_REF} not loadable` }, () => {
  const items = corpus();
  assert.ok(items.length > 200, `corpus too small (${items.length})`);
  assert.deepEqual(compareQuote({ rooms: { All: { items } } }), []);
  assert.deepEqual(compareQuote({ marginOverride: 1.6, rooms: { A: { items: items.slice(0, 40) }, B: { items: items.slice(40, 90) } } }), []);
});

const SNAP = process.env.QUOTES_SNAPSHOT;
test('regression: every saved quote prices exactly as master', { skip: (!OLD && `baseline ${BASE_REF} not loadable`) || (!SNAP && 'QUOTES_SNAPSHOT not set') }, () => {
  const quotes = Object.values(JSON.parse(fs.readFileSync(SNAP, 'utf8')));
  const diffs = quotes.flatMap(q => compareQuote(q).map(d => `${q.ref || q.id}: ${d}`));
  console.log(`[configurator-pack regression] ${quotes.length} quotes, ${diffs.length} differences (baseline ${BASE_REF})`);
  assert.deepEqual(diffs, []);
});

// ─── 1. Push to open (handleKey HW_HDL_PUSH) ─────────────────────────────────
test('push to open: per front one Tip-On (£10) + 10 min fitting at the bench rate, and no handle', () => {
  const tipOn = 10 + (10 / 60) * ER;
  for (const [cfg, fronts] of [[SINGLE_600, 1], [DRAWER3_600, 3]]) {
    const push = cabinet({ ...cfg, handleKey: 'HW_HDL_PUSH' });
    const bar = cabinet({ ...cfg, handleKey: 'HW_HDL_BAR128' });
    const none = cabinet({ ...cfg, handleKey: 'HW_HDL_NONE' });
    assert.ok(near(push.totalCost - none.totalCost, fronts * tipOn));
    assert.ok(near(push.totalCost - bar.totalCost, fronts * (tipOn - 12)));   // the £12 bar handle is not charged
    assert.ok(near(push.totalSellExVAT, push.totalCost * P.DB.settings.margin));
    assert.ok(near(push.breakdown.hardwareFitHrs, fronts / 6, 1e-3));
    assert.ok(near(push.breakdown.totalHrs, bar.breakdown.totalHrs + fronts / 6, 2e-3));
    assert.equal(bar.breakdown.hardwareFitHrs, undefined);
    // Hinges and runners as they are; one device per handle position.
    assert.deepEqual(push.breakdown.bom.hardware, bar.breakdown.bom.hardware);
    assert.deepEqual(push.breakdown.bom.handles, bar.breakdown.bom.handles.map(h => ({ ...h, key: 'HW_HDL_PUSH' })));
  }
});

test('push to open: a tall door gets one device (DECISION)', () => {
  const tall = cabinet({ widthMm: 600, heightMm: 2100, doorCount: 1, shelfCount: 4, handleKey: 'HW_HDL_PUSH' });
  assert.ok(near(tall.breakdown.hardwareFitHrs, 1 / 6, 1e-3));
});

test('API: /api/cabinet-cost takes handleKey HW_HDL_PUSH', async () => {
  await parity('/api/cabinet-cost', 'cabinet', { ...CAB, ...DRAWER3_600, handleKey: 'HW_HDL_PUSH', qty: 1 });
});
