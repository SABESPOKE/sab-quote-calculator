// Internal vs external drawers (Steve, 12 Nov 2026): the cabinet param drawerPosition, the drawer box default, and a
// standalone drawer with no drawerType. Run: `npm test`. The regression half needs git (baseline = master before this).
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
const AUTH = { authorization: `Bearer ${process.env.API_TOKEN}` };
const post = async (body) => {
  const res = await fetch(`${base}/api/cabinet-cost`, { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const wire = o => JSON.parse(JSON.stringify(o));
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// A melamine wardrobe bay with painted shaker doors and three drawers behind them (the shape of the evidence quote).
const BAY = { widthMm: 950, heightMm: 1950, depthMm: 650, carcassMaterialKey: 'MAT_MEL_EGGER_18', doorCount: 2, doorType: 'SHAKER_PNT',
  drawerCount: 3, drawerType: 'DRW_SHEET', runnerKey: 'HW_RUN_BLUM_SM', hingeKey: 'HW_HINGE_SM', handleKey: 'HW_HDL_BAR128', shelfCount: 1 };
const cabinet = (o = {}, qty = 1) => P.priceItem({ type: 'cabinet', qty, params: { ...BAY, ...o } });
const MEL = P.DB.materials.MAT_MEL_EGGER_18;

// ─── The baseline engine (master before this change) ─────────────────────────
const BASE_REF = process.env.BASE_REF || '7fc0ae8';
let OLD = null;
try {
  const src = execFileSync('git', ['show', `${BASE_REF}:public/pricing.js`], { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 1 << 24 });
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sab-drawers-base-')), 'pricing.js');
  fs.writeFileSync(tmp, src);
  OLD = require(tmp);
} catch { /* no git / unknown ref → the regression tests skip */ }
const priced = (E, item) => { const { pricedWith, ...p } = E.priceItem(item) || {}; return p; };   // (the engine stamp moves by design)

// The Cutlist change moved the cut, edging and three bench times by design (test/as-before.js). Put back as they
// were, the engine must still price exactly as the baseline: nothing else moved.
const noCnc = fn => require('./as-before.js')(P, OLD, fn);

test('regression: external is the default — every cabinet that names its drawer box prices exactly as before', { skip: !OLD && 'baseline engine unavailable (git)' }, () => noCnc(() => {
  let n = 0;
  for (const drawerType of Object.keys(OLD.DB.drawerTypes)) for (const doorType of Object.keys(OLD.DB.doorTypes)) for (const carcassMaterialKey of ['MAT_MEL_EGGER_18', 'MAT_BIRCH_UNF_18', 'MAT_MDF_FH_18'])
    for (const [doorCount, drawerCount] of [[2, 3], [0, 3], [1, 1], [2, 0]]) for (const extra of [{}, { drawerPosition: 'external' }]) {
      const item = { type: 'cabinet', qty: 2, params: { ...BAY, drawerType, doorType, carcassMaterialKey, doorCount, drawerCount, timberSpeciesKey: 'TIM_OAK' } };
      assert.deepStrictEqual(priced(P, { ...item, params: { ...item.params, ...extra } }), priced(OLD, item), JSON.stringify(item.params));
      n++;
    }
  // A standalone drawer that names its box: as before. So is every other item type.
  for (const drawerType of Object.keys(OLD.DB.drawerTypes)) for (const carcassMaterialKey of [undefined, 'MAT_MEL_EGGER_18']) {
    const item = { type: 'drawer', qty: 1, params: { drawerType, carcassMaterialKey, widthMm: 700, heightMm: 100, depthMm: 450 } };
    assert.deepStrictEqual(priced(P, item), priced(OLD, item));
  }
  assert.ok(n > 500);
}));

// ─── Internal drawers ────────────────────────────────────────────────────────
test('internal: the same boxes, and a plain front in the carcass board — its sheet and the CNC cut only', () => {
  const ext = cabinet(), int = cabinet({ drawerPosition: 'internal' }), e = ext.breakdown, i = int.breakdown;
  // The boxes, runners, carcass, doors and edgebanding are untouched.
  for (const k of ['drawers', 'drawerHrs', 'carcassMaterial', 'carcassLabour', 'carcassHardware', 'doors', 'doorHrs', 'edgeband', 'assemblyHrs']) assert.equal(i[k], e[k], k);
  // The front: opening wide (950 − 2 × 18 − 4) × the box's height, in the carcass board with its waste — the sheet
  // only on this line; its CNC cut is on the cabinet's cnc line with every other sheet part's (test/cnc-cut.test.js).
  const sheetM2 = 3 * 0.910 * 0.180 * MEL.wasteFactor;
  assert.ok(near(i.drawerFronts, sheetM2 * MEL.costPerM2));
  // No making labour, no spray and no handle on it.
  assert.equal(i.drawerFrontHrs, 0);
  assert.equal(i.finishHrs, i.sprayDetail.parts.door.totalHrs);
  assert.equal(i.sprayDetail.parts.drawerFront, undefined);
  assert.deepEqual(i.bom.handles, [{ key: 'HW_HDL_BAR128', target: 'door', count: 2 }]);
  // The total is its lines, and the saving is exactly the door-finish fronts less the plain ones.
  assert.ok(near(int.totalCost, i.carcassMaterial + i.carcassLabour + i.carcassHardware + i.doors + i.drawers + i.drawerFronts + i.edgeband + i.cnc));
  assert.ok(near(ext.totalCost - int.totalCost, (e.drawerFronts - i.drawerFronts) + (e.cnc - i.cnc)));
  assert.ok(i.drawerFronts < 15 && e.drawerFronts > 500, `plain ${i.drawerFronts} vs door-finish ${e.drawerFronts}`);
  assert.ok(near(int.totalSellExVAT, int.totalCost * P.DB.settings.margin) && near(int.totalSellIncVAT, int.totalSellExVAT * (1 + P.DB.settings.vat)));
  // The materials list: the plain fronts are carcass board to order; only the doors are door-finish panels.
  assert.deepEqual(i.bom.doors.map(d => d.count), [2]);
  assert.ok(near(i.bom.carcass[0].areaM2 - e.bom.carcass[0].areaM2, sheetM2, 1e-3));
});

test('internal: a front takes its own height when sent, the board is the cabinet\'s own (or the box board named), qty scales', () => {
  const a = cabinet({ drawerPosition: 'internal' }), b = cabinet({ drawerPosition: 'internal', drawerFrontHeightsMm: [150, 200, 250] });
  assert.ok(near(b.breakdown.drawerFronts / a.breakdown.drawerFronts, 600 / 540));
  const birch = cabinet({ drawerPosition: 'internal', carcassMaterialKey: 'MAT_BIRCH_UNF_18' }), B = P.DB.materials.MAT_BIRCH_UNF_18;
  assert.ok(near(birch.breakdown.drawerFronts, 3 * 0.910 * 0.180 * B.wasteFactor * B.costPerM2));
  // drawerBoxMaterialKey: the boxes and the plain fronts in a board of their own (melamine boxes in a birch carcass).
  const mel = cabinet({ drawerPosition: 'internal', carcassMaterialKey: 'MAT_BIRCH_UNF_18', drawerBoxMaterialKey: 'MAT_MEL_EGGER_18' });
  assert.ok(near(mel.breakdown.drawerFronts, a.breakdown.drawerFronts) && near(mel.breakdown.drawers, a.breakdown.drawers));
  assert.equal(mel.breakdown.carcassMaterial, birch.breakdown.carcassMaterial);
  assert.deepEqual(mel.breakdown.bom.carcass.map(c => c.key), ['MAT_BIRCH_UNF_18', 'MAT_MEL_EGGER_18']);
  assert.ok(near(cabinet({ drawerPosition: 'internal' }, 4).totalCost, 4 * a.totalCost));
  // No drawers: the field changes nothing.
  assert.equal(cabinet({ drawerCount: 0, drawerPosition: 'internal' }).totalCost, cabinet({ drawerCount: 0 }).totalCost);
});

// ─── The drawer box ──────────────────────────────────────────────────────────
test('a cabinet\'s drawer box with no drawerType is the sheet box in ITS carcass board (it was the birch ply box)', () => {
  const { drawerType, ...unset } = BAY;
  const got = P.priceItem({ type: 'cabinet', qty: 1, params: unset });
  assert.deepStrictEqual(got.breakdown, cabinet({ drawerType: 'DRW_SHEET' }).breakdown);
  assert.equal(got.breakdown.bom.drawerBoxes[0].key, 'DRW_SHEET');
  // The sheet box: 2 sides + front + back + base in melamine, 0.3 h, a pair of runners — per drawer.
  const w = 0.924, h = 0.18, d = 0.6, box = (2 * d * h + 2 * w * h + w * d) * MEL.costPerM2 * MEL.wasteFactor + 0.3 * P.er() + 40;
  assert.ok(near(got.breakdown.drawers, 3 * box));
  assert.deepStrictEqual(P.priceItem({ type: 'cabinet', qty: 1, params: { ...unset, drawerType: null } }).breakdown.drawers, got.breakdown.drawers);
  if (OLD) assert.ok(near(OLD.priceItem({ type: 'cabinet', qty: 1, params: unset }).breakdown.drawers, 3 * (25 * 924 / 500 + 0.5 * P.er() + 40)), 'before: the birch ply box');
});

test('a standalone drawer with no drawerType now has a price: the sheet box, in the board it names', () => {
  const slim = { widthMm: 700, heightMm: 100, depthMm: 450, runnerKey: 'HW_RUN_BLUM_SM', doorType: 'SHAKER_PNT' };   // (the evidence quote's unpriced line)
  const got = P.priceItem({ type: 'drawer', qty: 1, params: slim });
  assert.ok(got && got.totalCost > 0);
  assert.equal(got.totalCost, P.priceItem({ type: 'drawer', qty: 1, params: { ...slim, drawerType: 'DRW_SHEET' } }).totalCost);
  assert.ok(P.priceItem({ type: 'drawer', qty: 1, params: { ...slim, carcassMaterialKey: 'MAT_MEL_EGGER_18' } }).totalCost < got.totalCost, 'melamine, when named, not birch');
  if (OLD) assert.equal(OLD.priceItem({ type: 'drawer', qty: 1, params: slim }), null, 'before: no price at all');
  assert.equal(P.priceItem({ type: 'drawer', qty: 1, params: { ...slim, drawerType: 'DRW_NOPE' } }), null, 'an unknown box is still no price');
});

// ─── The API ─────────────────────────────────────────────────────────────────
test('API: /api/cabinet-cost takes drawerPosition, prices it as priceItem does, and refuses anything else', async () => {
  for (const drawerPosition of ['external', 'internal']) {
    const { status, body } = await post({ ...BAY, drawerPosition, qty: 1 });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body, wire(P.priceItem({ type: 'cabinet', qty: 1, params: { ...BAY, drawerPosition } })));
  }
  const bad = await post({ ...BAY, drawerPosition: 'inside' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.some(e => e.includes('drawerPosition')));
  const k = await (await fetch(`${base}/api/cabinet-cost/keys`, { headers: AUTH })).json();
  assert.ok(k.fields.includes('drawerPosition'));
  assert.deepEqual(k.drawerPositions, ['external', 'internal']);
});
