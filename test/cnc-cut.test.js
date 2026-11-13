// The Cutlist cut (Steve, 12 Nov 2026). All sheet cutting is outsourced: Cutlist delivers every part cut, edged,
// drilled and jointed, and charges about the sheet price again. So:
//   • every board Cutlist supplies carries a cut = its sheet cost (board + waste) × DB.settings.cutlistCut (1), on its
//     own line (breakdown.cnc) — NOT doors or external drawer fronts (made in-house), solid timber or face frames;
//   • edging is inside the cut: no edging tape or labour anywhere;
//   • end-panel / sheet-shelf / filler bench time is sand, fit and finish prep only.
// Run: `npm test`. (That nothing else moved is in the other files' regression tests, run through test/as-before.js.)
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.APP_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-secret';
process.env.API_TOKEN = 'test-bearer-token';
delete process.env.DATABASE_URL; // never touch a real DB from tests

const P = require(path.join(__dirname, '..', 'public', 'pricing.js'));
const app = require(path.join(__dirname, '..', 'server.js'));

let server, base;
before(async () => { await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${server.address().port}`; });
after(() => new Promise(resolve => server.close(resolve)));
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const price = (type, params, qty = 1) => P.priceItem({ type, qty, params });
const withCut = (m, fn) => { const was = P.DB.settings.cutlistCut; P.DB.settings.cutlistCut = m; try { return fn(); } finally { P.DB.settings.cutlistCut = was; } };
const RATE = P.DB.settings.labourRate + P.DB.settings.overheadRate;   // £/h bench

// The plain hanging bay and the internal-drawer bay of the evidence quote (melamine, painted shaker doors, no handles).
const BAY = { widthMm: 950, heightMm: 1950, depthMm: 650, carcassMaterialKey: 'MAT_MEL_EGGER_18', doorCount: 2, doorType: 'SHAKER_PNT',
  drawerCount: 0, hingeKey: 'HW_HINGE_SM', handleKey: 'HW_HDL_NONE', shelfCount: 1 };
const DRAWERS = { drawerCount: 3, drawerType: 'DRW_SHEET', runnerKey: 'HW_RUN_BLUM_SM', drawerPosition: 'internal' };
const MEL = P.DB.materials.MAT_MEL_EGGER_18;
const boxM2 = (2 * 0.6 * 0.18 + 2 * 0.924 * 0.18 + 0.924 * 0.6);    // a sheet box: 2 sides + front + back + base
const frontM2 = 0.910 * 0.18;                                       // a plain internal front

test('the cut is 1 × the sheet by default: the carcass, drawer boxes and internal fronts carry their sheet again, on one cnc line', () => {
  assert.equal(P.DB.settings.cutlistCut, 1);
  assert.equal(P.DB.settings.cncPerSheetCost, undefined, 'the old internal-front double charge is gone');
  const bay = price('cabinet', BAY), b = bay.breakdown;
  // Plain bay: the carcass sheet (board + waste) again. Its doors are made in-house: no cut.
  assert.ok(near(b.cnc, b.carcassMaterial));
  assert.ok(near(bay.totalCost, b.carcassMaterial + b.carcassLabour + b.carcassHardware + b.doors + b.cnc));
  // Internal-drawer bay: + three sheet boxes and three plain fronts, in melamine, with their waste.
  const drw = price('cabinet', { ...BAY, ...DRAWERS }), d = drw.breakdown;
  assert.ok(near(d.cnc - b.cnc, 3 * (boxM2 + frontM2) * MEL.costPerM2 * MEL.wasteFactor));
  assert.ok(near(drw.totalCost, d.carcassMaterial + d.carcassLabour + d.carcassHardware + d.doors + d.drawers + d.drawerFronts + d.cnc));
  assert.ok(near(drw.totalSellExVAT, drw.totalCost * P.DB.settings.margin) && near(drw.totalSellIncVAT, drw.totalSellExVAT * (1 + P.DB.settings.vat)));
});

test('the cut is its own line: no other line, and no hour, moves with the Settings figure', () => {
  for (const params of [BAY, { ...BAY, ...DRAWERS }, { ...BAY, drawerCount: 2, drawerType: 'DRW_BIRCH_PLY', doorType: 'SLAB_VEN', frameKey: 'FRAME_MDF_22' }]) {
    const off = withCut(0, () => price('cabinet', params)), on = price('cabinet', params), twice = withCut(2, () => price('cabinet', params));
    assert.equal(off.breakdown.cnc, undefined, 'cut 0: no cut, no line');
    const { cnc, ...rest } = on.breakdown;
    assert.deepStrictEqual(rest, off.breakdown);
    assert.ok(near(on.totalCost - off.totalCost, cnc));
    assert.ok(near(twice.breakdown.cnc, 2 * cnc), 'cut 2: twice the sheet');
  }
});

test("only Cutlist's board carries the cut: never doors, external fronts, face frames or solid timber", () => {
  // Doors and external drawer fronts are made in-house — every door type, sheet or timber.
  for (const doorType of Object.keys(P.DB.doorTypes))
    assert.equal(price('door', { doorType, widthMm: 600, heightMm: 2000, timberSpeciesKey: 'TIM_TUL', frameThicknessMm: 28 }).breakdown.cnc, undefined, doorType);
  const ext = price('cabinet', { ...BAY, doorCount: 0, drawerCount: 3, drawerType: 'DRW_SHEET', runnerKey: 'HW_RUN_BLUM_SM' }).breakdown;
  const int = price('cabinet', { ...BAY, ...DRAWERS }).breakdown;
  assert.ok(near(int.cnc - ext.cnc, int.drawerFronts), 'external fronts add no cut; plain internal fronts add theirs');
  // Face frames: none, MDF or timber.
  assert.equal(P.calcCabinetFaceFrameCost({ frameKey: 'FRAME_MDF_22', widthMm: 600, heightMm: 770 }).cnc, undefined);
  assert.equal(P.calcCabinetFaceFrameCost({ frameKey: 'FRAME_TIM_TUL', widthMm: 600, heightMm: 770, frameThicknessMm: 28 }).cnc, undefined);
  const framed = price('cabinet', { ...BAY, frameKey: 'FRAME_MDF_22' }).breakdown;
  assert.ok(near(framed.cnc, framed.carcassMaterial));
  // Drawer boxes: the sheet box and the ply box are Cutlist's; a solid box is timber.
  const box = t => price('drawer', { drawerType: t, widthMm: 500, heightMm: 180, depthMm: 500, carcassMaterialKey: 'MAT_MEL_EGGER_18' }).breakdown;
  assert.ok(near(box('DRW_SHEET').cnc, box('DRW_SHEET').materialCost) && near(box('DRW_BIRCH_PLY').cnc, box('DRW_BIRCH_PLY').materialCost));
  assert.equal(box('DRW_SOLID_OAK').cnc, undefined);
  // End panels, sheet shelves and fillers are Cutlist's; a solid oak shelf is not.
  const panel = price('endpanel', { materialKey: 'MAT_MDF_FH_18', widthMm: 560, heightMm: 900 }).breakdown;
  assert.ok(near(panel.cnc, panel.material));
  const sheetShelf = price('shelf', { materialKey: 'MAT_MDF_FH_18', lengthMm: 600, depthMm: 200, finishType: 'paint' }).breakdown;
  assert.ok(near(sheetShelf.cnc, sheetShelf.material));
  assert.equal(price('shelf', { materialKey: 'TIM_OAK', lengthMm: 1240, depthMm: 250, thicknessMm: 40 }).breakdown.cnc, undefined);
  const filler = price('filler', { doorType: 'SHAKER_PNT', widthMm: 50, heightMm: 720 }).breakdown;
  assert.equal(filler.cnc, filler.material);
  // Bought-in and non-sheet lines carry none.
  assert.equal(price('moulding', { mouldingKey: 'MLD_SKR_MDF_95', metres: 3 }).breakdown.cnc, undefined);
  assert.equal(price('custom', { unitCostExVAT: 100 }).breakdown.cnc, undefined);
});

test('edging is free: no tape, no labour — but the run stays for the materials list', () => {
  for (const [key, eb] of Object.entries(P.EDGEBAND_TYPES)) assert.ok(!eb.costPerM && !eb.labourHrsPerM, key);
  const run = P.calcCabinetEdgebandCost({ edgebandKey: 'EDGE_ABS_PAINT', widthMm: 600, heightMm: 720, shelfCount: 1 });
  assert.equal(run.total, 0);
  assert.equal(run.labourHrs, 0);
  assert.ok(near(run.totalM, 2 * 1.32 + 0.6));
  // Whatever edge is chosen, the cabinet costs the same.
  const cab = edgebandKey => price('cabinet', { ...BAY, edgebandKey });
  const none = cab('EDGE_NONE');
  for (const key of Object.keys(P.EDGEBAND_TYPES)) { const c = cab(key); assert.equal(c.breakdown.edgeband, 0, key); assert.equal(c.totalCost, none.totalCost, key); assert.equal(c.breakdown.totalHrs, none.breakdown.totalHrs, key); }
  // An end panel's exposed edges cost nothing more.
  const panel = n => price('endpanel', { materialKey: 'MAT_MDF_FH_18', widthMm: 560, heightMm: 900, exposedEdgeCount: n });
  assert.equal(panel(4).totalCost, panel(0).totalCost);
});

test('bench time on a part that arrives cut and edged: end panel 0.25 h, sheet shelf 0.25 h, filler 0.10 h; solid timber as before', () => {
  assert.deepEqual([P.DB.settings.endPanelBenchHrs, P.DB.settings.endPanelEdgeHrsPerM, P.DB.settings.shelfBenchHrs, P.DB.settings.fillerBenchHrs], [0.25, 0, 0.25, 0.10]);
  const panel = price('endpanel', { materialKey: 'MAT_MDF_FH_18', widthMm: 560, heightMm: 900 }).breakdown;
  assert.equal(panel.panelHrs, 0.25);
  assert.ok(near(panel.labour, 0.25 * RATE));
  const shelf = p => price('shelf', { lengthMm: 1200, depthMm: 250, ...p }).breakdown;
  assert.equal(shelf({ materialKey: 'MAT_MDF_FH_18' }).shelfHrs, 0.25);
  assert.equal(shelf({ materialKey: 'MAT_MDF_FH_18', visibleThicknessMm: 50 }).shelfHrs, 1, 'box shelf: + 0.75 h assembly, as before');
  assert.equal(shelf({ materialKey: 'TIM_OAK', thicknessMm: 40, visibleThicknessMm: 40 }).shelfHrs, 0.8, 'solid timber: cut in-house, as before');
  assert.equal(price('filler', { doorType: 'SHAKER_PNT', widthMm: 50, heightMm: 720 }).breakdown.labour, +(0.10 * RATE).toFixed(2));
  // Unchanged by ruling: carcass assembly 1 h, drawer prep 0.5 h, 12% waste on the carcass board.
  assert.deepEqual([P.DB.settings.carcassBaseHrs, P.DB.settings.carcassDrawerPrepHrs, MEL.wasteFactor], [1, 0.5, 1.12]);
});

test('a price-locked quote does not move: its stored prices and totals are final', () => {
  const items = [{ type: 'cabinet', qty: 2, params: BAY }, { type: 'endpanel', qty: 1, params: { materialKey: 'MAT_MDF_FH_18', widthMm: 560, heightMm: 900 } }];
  const locked = withCut(0, () => P.lockQuote({ id: 'Q1', rooms: { R: { includeDesignTime: false, items: items.map(it => ({ ...it, pricing: P.priceItem(it) })) } }, projectCosts: P.getDefaultProjectCosts() }));
  const totalBefore = withCut(0, () => P.quoteGrandTotal(locked));
  assert.strictEqual(P.recomputeQuotePricing(locked), locked, 'never repriced');
  assert.deepEqual(P.quoteGrandTotal(locked), totalBefore);
  // The same quote without its lock would move — by exactly the cut.
  const { pricingLock, ...open } = locked;
  const re = P.recomputeQuotePricing(open).rooms.R.items;
  assert.ok(near(re[0].pricing.totalCost - locked.rooms.R.items[0].pricing.totalCost, 2 * re[0].pricing.breakdown.cnc));
});

test('API: /api/cabinet-cost and /api/endpanel-cost return the cnc line exactly as priceItem does; drawerBoxMaterialKey is checked', async () => {
  const AUTH = { 'content-type': 'application/json', authorization: `Bearer ${process.env.API_TOKEN}` };
  const post = async (route, body) => { const r = await fetch(`${base}${route}`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const wire = o => JSON.parse(JSON.stringify(o));
  const cab = { ...BAY, ...DRAWERS, drawerBoxMaterialKey: 'MAT_MEL_EGGER_18' };
  const a = await post('/api/cabinet-cost', { ...cab, qty: 1 });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual(a.body, wire(price('cabinet', cab)));
  assert.ok(a.body.breakdown.cnc > 0);
  const p = await post('/api/endpanel-cost', { materialKey: 'MAT_MDF_FH_18', widthMm: 560, heightMm: 900 });
  assert.deepEqual(p.body, wire(price('endpanel', { materialKey: 'MAT_MDF_FH_18', widthMm: 560, heightMm: 900 })));
  const bad = await post('/api/cabinet-cost', { ...cab, drawerBoxMaterialKey: 'MAT_NOPE' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.some(e => e.includes('drawerBoxMaterialKey')));
});
