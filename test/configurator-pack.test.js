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
  // A cabinet with drawers and no drawerType was the birch ply box; since the internal-drawers change it is the sheet
  // box in the carcass board (test/internal-drawers.test.js). The old default is said out loud here, so that this
  // still compares everything else.
  const cab = (params, qty = 1) => items.push({ type: 'cabinet', qty, params: params.drawerCount && !params.drawerType ? { ...params, drawerType: 'DRW_BIRCH_PLY' } : params });
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

// ─── 2. Handleless channel rail per metre (channelRails) ─────────────────────
// The configurator's handleless designs (Stop 55 specs): primed MDF fronts, rails in the 22 door board, primed.
const RAILS = (rails, o = {}) => ({ materialKey: 'MAT_MDF_FH_22', finishType: 'primed', rails, ...o });
const HL = {
  drw600:   { cab: { ...DRAWER3_600, doorType: 'SLAB_PNT', sprayFinishOverride: 'primed' }, rails: [{ profile: 'L', lengthMm: 600 }, { profile: 'C', lengthMm: 600 }, { profile: 'C', lengthMm: 600 }] },
  dbl1000:  { cab: { widthMm: 1000, doorCount: 2, sprayFinishOverride: 'primed' }, rails: [{ profile: 'L', lengthMm: 1000 }] },
  tall2100: { cab: { widthMm: 600, heightMm: 2100, doorCount: 1, shelfCount: 4, sprayFinishOverride: 'primed' }, rails: [{ profile: 'TALL_C', lengthMm: 600 }] },
};
// Today: each channel piece is one end panel (the configurator's route): length × piece width, one face, the door board.
const PIECES = { L: [42, 50], C: [42, 50, 42], TALL_C: [42, 70, 42] };   // T = 22: floor/flange 20 + T, upright 50 (70)
const perPiece = rails => rails.reduce((s, r) => s + PIECES[r.profile].reduce((a, w) => a + P.priceItem({ type: 'endpanel', qty: 1,
  params: { materialKey: 'MAT_MDF_FH_22', widthMm: r.lengthMm, heightMm: w, thicknessMm: 22, faces: 1, finishType: 'primed' } }).totalCost, 0), 0);

test('channel rail: board + spray per strip, bench labour per metre, ONE setup per cabinet, on its own line', () => {
  const mat = P.DB.materials.MAT_MDF_FH_22;
  for (const { cab, rails } of Object.values(HL)) {
    const without = cabinet(cab), withRail = cabinet({ ...cab, channelRails: RAILS(rails) });
    let expected = 0, metres = 0;
    for (const r of rails) {
      const girth = { L: 92, C: 134, TALL_C: 154 }[r.profile];
      metres += r.lengthMm / 1000;
      expected += (girth / 1000) * (r.lengthMm / 1000) * mat.costPerM2 * mat.wasteFactor
        + P.calcSprayFinishCost({ widthMm: girth, heightMm: r.lengthMm, finishType: 'primed', surfaceType: 'panel' }).costPerDoor;
    }
    expected += (metres * 15 + 10) / 60 * ER;
    assert.ok(near(withRail.breakdown.channelRail, expected), `${withRail.breakdown.channelRail} vs ${expected}`);
    assert.ok(near(withRail.totalCost - without.totalCost, expected));
    assert.ok(near(withRail.totalSellExVAT, withRail.totalCost * P.DB.settings.margin));
    assert.ok(near(withRail.breakdown.channelRailHrs, (metres * 15 + 10) / 60, 1e-3));
    // Doors and drawer lines unchanged (the configurator's split-tall sub-lines read only those).
    for (const k of ['doors', 'drawers', 'drawerFronts']) assert.equal(withRail.breakdown[k], without.breakdown[k]);
    // Spray hours join finishHrs as their own part; the split still adds up.
    const sd = withRail.breakdown.sprayDetail;
    assert.ok(sd.parts.channelRail.totalHrs > 0);
    assert.ok(near(sd.totalHrs, withRail.breakdown.finishHrs));
    assert.ok(near(withRail.breakdown.totalHrs, without.breakdown.totalHrs + withRail.breakdown.channelRailHrs + sd.parts.channelRail.totalHrs, 2e-3));
    // Cheaper than pricing the same pieces as end panels.
    assert.ok(withRail.breakdown.channelRail < perPiece(rails), `rail ${withRail.breakdown.channelRail} vs pieces ${perPiece(rails)}`);
  }
});

test('channel rail: the setup is per cabinet, not per strip', () => {
  const one = P.calcChannelRailCost(RAILS([{ profile: 'C', lengthMm: 600 }]));
  const two = P.calcChannelRailCost(RAILS([{ profile: 'C', lengthMm: 600 }, { profile: 'C', lengthMm: 600 }]));
  assert.ok(near(two.cost, 2 * one.cost - (10 / 60) * ER));
});

test('channel rail: girth from the profile and T (default: the board\'s own thickness)', () => {
  const girthM2 = (o) => P.calcChannelRailCost(RAILS([{ profile: o.profile, lengthMm: 1000 }], { materialKey: o.mat, finishType: 'none', thicknessMm: o.T })).material / (P.DB.materials[o.mat].costPerM2 * P.DB.materials[o.mat].wasteFactor);
  assert.ok(near(girthM2({ profile: 'L', mat: 'MAT_MDF_FH_22' }), 0.092));
  assert.ok(near(girthM2({ profile: 'C', mat: 'MAT_MDF_FH_22' }), 0.134));
  assert.ok(near(girthM2({ profile: 'TALL_C', mat: 'MAT_MDF_FH_22' }), 0.154));
  assert.ok(near(girthM2({ profile: 'C', mat: 'MAT_SHINNOKI_19' }), 0.128));            // T 19 from the board
  assert.ok(near(girthM2({ profile: 'C', mat: 'MAT_MDF_FH_18', T: 22 }), 0.134));       // T given
});

test('channel rail: finish defaults to the board\'s natural finish (painted MDF sprayed, Shinnoki not)', () => {
  const r = [{ profile: 'C', lengthMm: 600 }];
  const mdf = P.calcChannelRailCost({ materialKey: 'MAT_MDF_FH_22', rails: r });
  assert.ok(near(mdf.spray, P.calcChannelRailCost(RAILS(r, { finishType: 'paint' })).spray));
  const shin = P.calcChannelRailCost({ materialKey: 'MAT_SHINNOKI_19', rails: r });
  assert.equal(shin.spray, 0);
  assert.equal(shin.finishHrs, 0);
  const oak = P.calcChannelRailCost({ materialKey: 'MAT_OAK_MDF_UNF_19', rails: r });   // raw veneer → lacquer
  assert.ok(near(oak.spray, P.calcChannelRailCost({ materialKey: 'MAT_OAK_MDF_UNF_19', finishType: 'lacquer', rails: r }).spray));
});

test('API: /api/cabinet-cost takes channelRails and refuses a bad one', async () => {
  const body = { ...CAB, ...HL.drw600.cab, channelRails: RAILS(HL.drw600.rails), qty: 1 };
  await parity('/api/cabinet-cost', 'cabinet', body);
  await refused('/api/cabinet-cost', { ...body, channelRails: RAILS([{ profile: 'U', lengthMm: 600 }]) }, 'profile');
  await refused('/api/cabinet-cost', { ...body, channelRails: RAILS([{ profile: 'C', lengthMm: 0 }]) }, 'lengthMm');
  await refused('/api/cabinet-cost', { ...body, channelRails: RAILS([]) }, 'non-empty');
  await refused('/api/cabinet-cost', { ...body, channelRails: RAILS(HL.drw600.rails, { materialKey: 'MAT_NOPE' }) }, 'materialKey');
  await refused('/api/cabinet-cost', { ...body, channelRails: RAILS(HL.drw600.rails, { finishType: 'gloss' }) }, 'finishType');
  await refused('/api/cabinet-cost', { ...body, channelRails: RAILS(HL.drw600.rails, { colour: 'red' }) }, 'unknown channelRails');
  const keys = await (await fetch(`${base}/api/cabinet-cost/keys`, { headers: { authorization: `Bearer ${process.env.API_TOKEN}` } })).json();
  assert.deepEqual(Object.keys(keys.channelRails.profiles), ['L', 'C', 'TALL_C']);
  assert.ok(keys.fields.includes('channelRails'));
});

// ─── 3. Bin frame (binFrameKey) ──────────────────────────────────────────────
const BIN_600 = { doorCount: 0, drawerCount: 1, shelfCount: 0 };   // the bin pull-out: one pull-out front on runners
test('bin frame: £200 frame + 30 min fitting at the bench rate, one per cabinet, its own line', () => {
  const plain = cabinet(BIN_600), framed = cabinet({ ...BIN_600, binFrameKey: 'HW_BIN_ECOTOP' });
  const frame = 200 + 0.5 * ER;
  assert.ok(near(framed.breakdown.binFrame, frame));
  assert.ok(near(framed.totalCost - plain.totalCost, frame));
  assert.ok(near(framed.totalSellExVAT, framed.totalCost * P.DB.settings.margin));
  assert.ok(near(framed.breakdown.hardwareFitHrs, 0.5));
  assert.ok(near(framed.breakdown.totalHrs, plain.breakdown.totalHrs + 0.5, 2e-3));
  assert.equal(plain.breakdown.binFrame, undefined);
  const two = cabinet({ ...BIN_600, binFrameKey: 'HW_BIN_ECOTOP' }, 2);
  assert.ok(near(two.totalCost, 2 * framed.totalCost, 1e-6));
  assert.deepEqual(two.breakdown.bom.hardware.find(h => h.key === 'HW_BIN_ECOTOP'), { key: 'HW_BIN_ECOTOP', count: 2 });
});

test('API: /api/cabinet-cost takes binFrameKey and refuses an unknown one', async () => {
  await parity('/api/cabinet-cost', 'cabinet', { ...CAB, ...BIN_600, binFrameKey: 'HW_BIN_ECOTOP', qty: 1 });
  await refused('/api/cabinet-cost', { ...CAB, ...BIN_600, binFrameKey: 'HW_BIN_X' }, 'binFrameKey');
});

// ─── 4. Freestanding legs (legKey, legCount) ─────────────────────────────────
test('legs: per leg cost + 10 min fitting each, on their own line; a plinth is never charged', () => {
  const plinth = cabinet(SINGLE_600);   // "on a plinth": the engine prices no plinth, so this is the cabinet alone
  for (const [legKey, each] of [['HW_LEG_OAK_150', 18], ['HW_LEG_WAL_150', 24]]) {
    const onLegs = cabinet({ ...SINGLE_600, legKey, legCount: 4 });
    const legs = 4 * each + 4 * (10 / 60) * ER;
    assert.ok(near(onLegs.breakdown.legs, legs));
    assert.ok(near(onLegs.totalCost - plinth.totalCost, legs));
    assert.ok(near(onLegs.totalSellExVAT, onLegs.totalCost * P.DB.settings.margin));
    assert.ok(near(onLegs.breakdown.hardwareFitHrs, 4 / 6, 1e-3));
    assert.deepEqual(onLegs.breakdown.bom.hardware.find(h => h.key === legKey), { key: legKey, count: 4 });
  }
  assert.ok(!Object.keys(plinth.breakdown).some(k => /plinth/i.test(k)));
});

test('legs: the count the configurator sends wins; without one, 4 (6 over 1200 wide)', () => {
  const each = 18 + (10 / 60) * ER;
  assert.ok(near(cabinet({ ...SINGLE_600, legKey: 'HW_LEG_OAK_150', legCount: 6 }).breakdown.legs, 6 * each));
  assert.ok(near(cabinet({ ...SINGLE_600, legKey: 'HW_LEG_OAK_150' }).breakdown.legs, 4 * each));
  assert.ok(near(cabinet({ widthMm: 1400, doorCount: 2, legKey: 'HW_LEG_OAK_150' }).breakdown.legs, 6 * each));
});

test('API: /api/cabinet-cost takes legKey + legCount and refuses bad ones', async () => {
  await parity('/api/cabinet-cost', 'cabinet', { ...CAB, ...SINGLE_600, legKey: 'HW_LEG_WAL_150', legCount: 4, qty: 1 });
  await refused('/api/cabinet-cost', { ...CAB, ...SINGLE_600, legKey: 'HW_LEG_PINE' }, 'legKey');
  await refused('/api/cabinet-cost', { ...CAB, ...SINGLE_600, legKey: 'HW_LEG_OAK_150', legCount: 0 }, 'legCount');
  await refused('/api/cabinet-cost', { ...CAB, ...SINGLE_600, legCount: 4 }, 'legCount needs a legKey');
});

// ─── 5. Painted MDF carcass (carcassMaterialKey MAT_MDF_FH_18 + carcassFinish paint; carcassFinishOutside) ──
const OPEN_600 = { doorCount: 0, drawerCount: 0, shelfCount: 2, carcassMaterialKey: 'MAT_MDF_FH_18', carcassFinish: 'paint' };
test('painted carcass: inside is priceable today; carcassFinishOutside adds the outer sides, top and bottom', () => {
  const inside = cabinet(OPEN_600), both = cabinet({ ...OPEN_600, carcassFinishOutside: true });
  const W = 0.6, H = 0.77, D = 0.56, innerW = 0.564, shelfD = 0.51;
  const shell = 2 * D * H + 2 * W * D + W * H + 2 * 2 * innerW * shelfD;   // the inside, as today
  const perim = 2 * (W + H) + 2 * innerW;                                   // open: shelf front edges too
  const spray = area => P.calcSprayFinishCost({ widthMm: 600, heightMm: 770, finishType: 'paint', surfaceType: 'panel', sprayAreaM2Override: area, perimMOverride: perim, doorType: 'SLAB_PNT' });
  assert.ok(near(both.totalCost - inside.totalCost, spray(shell + 2 * D * H + 2 * W * D).costPerDoor - spray(shell).costPerDoor, 1e-6));
  assert.equal(both.breakdown.carcassMaterial, inside.breakdown.carcassMaterial);
  assert.ok(both.breakdown.carcassFinishHrs > inside.breakdown.carcassFinishHrs);
  assert.ok(near(both.totalSellExVAT, both.totalCost * P.DB.settings.margin));
  // Nothing to finish → nothing added.
  assert.equal(cabinet({ ...OPEN_600, carcassFinish: 'none', carcassFinishOutside: true }).totalCost, cabinet({ ...OPEN_600, carcassFinish: 'none' }).totalCost);
});

test('API: /api/cabinet-cost takes carcassFinishOutside (boolean only)', async () => {
  await parity('/api/cabinet-cost', 'cabinet', { ...CAB, ...OPEN_600, carcassFinishOutside: true, qty: 1 });
  await refused('/api/cabinet-cost', { ...CAB, ...OPEN_600, carcassFinishOutside: 'yes' }, 'carcassFinishOutside');
});

// ─── 6. Actual front heights (doorHeightsMm, drawerFrontHeightsMm) ───────────
const DBL_1000 = { widthMm: 1000, doorCount: 2 };
// A leaf as the cabinet prices it: soft-close hinges by its height, no handle (CAB's HW_HDL_NONE).
const leaf = (w, h, n = 1) => P.calcDoorCost({ doorType: 'SLAB_PNT', widthMm: w, heightMm: h, qty: n, hingeCost: P.hingeCount(h) * 9.5, handleCost: 0 }).totalCost;
test('front heights: a handleless base double prices its leaves at their true height', () => {
  const carcass = cabinet(DBL_1000), actual = cabinet({ ...DBL_1000, doorHeightsMm: [736, 736] });
  assert.ok(near(carcass.breakdown.doors, leaf(498, 764, 2)));   // today: carcass height − 6
  assert.ok(near(actual.breakdown.doors, leaf(498, 736, 2)));
  assert.ok(near(actual.totalCost - carcass.totalCost, actual.breakdown.doors - carcass.breakdown.doors));
  assert.ok(actual.totalCost < carcass.totalCost);
  assert.deepEqual(actual.breakdown.bom.hardware, carcass.breakdown.bom.hardware);   // same leaves, same hinges
  assert.equal(actual.breakdown.bom.doors[0].count, 2);
});

test('front heights: a split tall prices its two leaves, one over the other, separately', () => {
  const split = cabinet({ widthMm: 600, heightMm: 2100, doorCount: 1, shelfCount: 4, doorHeightsMm: [1300, 742] });
  assert.ok(near(split.breakdown.doors, leaf(598, 1300) + leaf(598, 742)));   // full width each
  assert.equal(split.breakdown.bom.doors[0].count, 2);
  assert.deepEqual(split.breakdown.bom.hardware.find(h => h.key === 'HW_HINGE_SM'), { key: 'HW_HINGE_SM', count: 5 });   // 3 + 2
  assert.ok(near(split.breakdown.sprayDetail.parts.door.totalHrs, split.breakdown.sprayDetail.totalHrs - (split.breakdown.carcassFinishHrs || 0)));
  const push = cabinet({ widthMm: 600, heightMm: 2100, doorCount: 1, shelfCount: 4, doorHeightsMm: [1300, 742], handleKey: 'HW_HDL_PUSH' });
  assert.ok(near(push.breakdown.hardwareFitHrs, 2 / 6, 1e-3));   // one device per leaf
});

test('front heights: a wall leaf 20 longer costs more; drawer fronts at their own heights', () => {
  const wall = { widthMm: 600, heightMm: 720, depthMm: 300, doorCount: 2 };
  assert.ok(cabinet({ ...wall, doorHeightsMm: [734, 734] }).totalCost > cabinet(wall).totalCost);
  const fronts = cabinet({ ...DRAWER3_600, drawerFrontHeightsMm: [150, 226, 302] });
  const expected = [150, 226, 302].reduce((s, h) => s + P.calcDoorCost({ doorType: 'SLAB_PNT', widthMm: 596, heightMm: h, qty: 1, hingeCost: 0, handleCost: 0 }).totalCost, 0);
  assert.ok(near(fronts.breakdown.drawerFronts, expected));
});

test('API: /api/cabinet-cost takes doorHeightsMm / drawerFrontHeightsMm and refuses a mismatch', async () => {
  await parity('/api/cabinet-cost', 'cabinet', { ...CAB, ...DBL_1000, doorHeightsMm: [736, 736], qty: 1 });
  await parity('/api/cabinet-cost', 'cabinet', { ...CAB, widthMm: 600, heightMm: 2100, doorCount: 1, shelfCount: 4, doorHeightsMm: [1300, 742], qty: 1 });
  await parity('/api/cabinet-cost', 'cabinet', { ...CAB, ...DRAWER3_600, drawerFrontHeightsMm: [150, 226, 302], qty: 1 });
  await refused('/api/cabinet-cost', { ...CAB, ...DBL_1000, doorHeightsMm: [736] }, 'whole rows');
  await refused('/api/cabinet-cost', { ...CAB, ...DBL_1000, doorHeightsMm: [736, 0] }, 'positive');
  await refused('/api/cabinet-cost', { ...CAB, ...DRAWER3_600, drawerFrontHeightsMm: [150, 226] }, 'one height per drawer');
});

// ─── 7. Soffit LED channel (item type soffit_led, POST /api/soffit-led-cost) ──
const led = runs => P.priceItem({ type: 'soffit_led', qty: 1, params: { runs } });
test('soffit LED: one 2.4 m run — 2 extrusion lengths, 1 reel, 30 W driver, routing per metre', () => {
  const r = led([{ lengthMm: 2400, position: 'front' }]);
  assert.deepEqual(r.breakdown.led, { metres: 2.4, extrusions: 2, reels: 1, wattsNeeded: 28.8, driverKey: 'DRV_24V_30W', driverCount: 1 });
  assert.ok(near(r.totalCost, 2 * 18 + 35 + 18 + 2.4 * (10 / 60) * ER));
  assert.ok(near(r.totalSellExVAT, r.totalCost * P.DB.settings.margin));
  assert.ok(near(r.breakdown.totalHrs, 0.4));
  assert.equal(led([{ lengthMm: 2400, position: 'back' }]).totalCost, r.totalCost);   // position is not priced
});

test('soffit LED: extrusion rounds up per run, tape reels per design, driver from total watts', () => {
  assert.equal(led([{ lengthMm: 2100 }, { lengthMm: 500 }]).breakdown.led.extrusions, 3);   // 2 + 1
  assert.equal(led([{ lengthMm: 2000 }, { lengthMm: 2000 }, { lengthMm: 2000 }]).breakdown.led.reels, 2);   // 6 m → 2 reels, not 3
  assert.equal(led([{ lengthMm: 2400 }, { lengthMm: 2600 }]).breakdown.led.reels, 1);   // exactly 5 m
  assert.equal(led([{ lengthMm: 4000 }]).breakdown.led.driverKey, 'DRV_24V_60W');      // 48 W
  assert.equal(led([{ lengthMm: 12000 }]).breakdown.led.driverKey, 'DRV_24V_150W');    // 144 W
  assert.deepEqual([led([{ lengthMm: 14000 }]).breakdown.led.driverKey, led([{ lengthMm: 14000 }]).breakdown.led.driverCount], ['DRV_24V_150W', 2]);   // 168 W
  assert.equal(led([]), null);
});

test('soffit LED: prices on a stored quote (GET /api/quotes recompute, the cfg- path) with its hours', () => {
  const q = P.withPricingStatus(P.recomputeQuotePricing({ rooms: { Kitchen: { items: [{ type: 'soffit_led', qty: 1, params: { runs: [{ lengthMm: 2400, position: 'front' }] } }] } } }));
  const it = q.rooms.Kitchen.items[0];
  assert.ok(near(it.pricing.totalCost, led([{ lengthMm: 2400 }]).totalCost));
  assert.ok(near(it.hours.current.totalHrs, 0.4));
});

test('quote path: a stored cabinet carrying every new field prices, gets its hours and materials list', () => {
  const params = { ...CAB, ...DRAWER3_600, handleKey: 'HW_HDL_PUSH', binFrameKey: 'HW_BIN_ECOTOP', legKey: 'HW_LEG_OAK_150', legCount: 4,
    channelRails: RAILS(HL.drw600.rails), drawerFrontHeightsMm: [150, 226, 302], carcassMaterialKey: 'MAT_MDF_FH_18', carcassFinish: 'paint', carcassFinishOutside: true };
  const q = P.withPricingStatus(P.recomputeQuotePricing({ rooms: { Kitchen: { items: [{ type: 'cabinet', qty: 2, params }] } } }));
  const it = q.rooms.Kitchen.items[0];
  const { pricedWith, ...direct } = P.priceItem({ type: 'cabinet', qty: 2, params });
  const { pricedWith: _, ...stored } = it.pricing;
  assert.deepEqual(stored, direct);
  assert.ok(near(it.hours.current.totalHrs, direct.breakdown.totalHrs));
  for (const k of ['hardwareFitHrs', 'channelRailHrs']) assert.ok(it.hours.current[k] > 0, k);
  const bom = P.quoteMaterialsBom(q);
  assert.deepEqual(bom.hardware.filter(h => /^HW_(BIN|LEG)/.test(h.key)), [{ key: 'HW_BIN_ECOTOP', count: 2 }, { key: 'HW_LEG_OAK_150', count: 8 }]);
  assert.deepEqual(bom.handles, [{ key: 'HW_HDL_PUSH', target: 'drawer', count: 6 }]);
});

test('API: /api/soffit-led-cost prices runs and refuses bad ones', async () => {
  await parity('/api/soffit-led-cost', 'soffit_led', { runs: [{ lengthMm: 2400, position: 'front' }] });
  await refused('/api/soffit-led-cost', { runs: [] }, 'non-empty');
  await refused('/api/soffit-led-cost', { runs: [{ lengthMm: 0 }] }, 'lengthMm');
  await refused('/api/soffit-led-cost', { runs: [{ lengthMm: 2400, position: 'side' }] }, 'position');
  await refused('/api/soffit-led-cost', { runs: [{ lengthMm: 2400 }], watts: 10 }, 'unknown field');
  const keys = await (await fetch(`${base}/api/cabinet-cost/keys`, { headers: { authorization: `Bearer ${process.env.API_TOKEN}` } })).json();
  assert.deepEqual(keys.soffitLed.positions, ['front', 'back']);
  assert.equal((await fetch(`${base}/api/soffit-led-cost`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"runs":[{"lengthMm":2400}]}' })).status, 401);
});
