// In-frame pricing from the existing rates (Steve, 13 Nov 2026): the optional cabinet param inframeFront.
// Run: `npm test`. The regression half needs git (baseline engine = master before this change).
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

// What the configurator sends for a 600 base today (its house choices), and the four in-frame builds.
const CAB = { widthMm: 600, heightMm: 770, depthMm: 560, carcassMaterialKey: 'MAT_BIRCH_PREF_18', carcassFinish: 'none', doorCount: 2, doorType: 'SHAKER_PNT',
  drawerCount: 0, drawerType: 'DRW_SHEET', runnerKey: 'HW_RUN_BLUM_SM', hingeKey: 'HW_HINGE_SM', handleKey: 'HW_HDL_NONE', frameKey: 'FRAME_NONE', edgebandKey: 'EDGE_ABS_PAINT', hasStain: false, shelfCount: 1 };
const TULIP  = { timber: 'tulipwood', thicknessMm: 28, frameMm: 28, hinges: 'butt' };
const OAK    = { timber: 'oak',       thicknessMm: 28, frameMm: 28, hinges: 'butt' };
const OAK_SL = { timber: 'oak',       thicknessMm: 19, frameMm: 20, hinges: 'butt' };
const MDF    = { timber: 'mdf',       thicknessMm: 22, frameMm: 22, hinges: 'blum' };
const cabinet = (o = {}, qty = 1) => P.priceItem({ type: 'cabinet', qty, params: { ...CAB, ...o } });
const bomKeys = r => ({ door: r.breakdown.bom.doors[0].key, frame: r.breakdown.bom.frames[0] && r.breakdown.bom.frames[0].key, hinge: r.breakdown.bom.hardware[0].key });

// ─── Without inframeFront nothing may change (lay-on, and a frame picked in the calculator) ───
const BASE_REF = process.env.BASE_REF || 'f46b99d';
let OLD = null;
try {
  const src = execFileSync('git', ['show', `${BASE_REF}:public/pricing.js`], { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 1 << 24 });
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sab-inframe-base-')), 'pricing.js');
  fs.writeFileSync(tmp, src);
  OLD = require(tmp);
} catch { /* no git / unknown ref → the regression test skips */ }

test('regression: every cabinet without inframeFront prices exactly as the baseline engine', { skip: !OLD && 'baseline engine unavailable (git)' }, () => {
  const items = [];
  const cab = (params, qty = 1) => items.push({ type: 'cabinet', qty, params });
  for (const doorType of Object.keys(OLD.DB.doorTypes)) for (const frameKey of Object.keys(OLD.FRAME_MATERIALS)) for (const hingeKey of Object.keys(OLD.DB.hardware.hinges))
    cab({ ...CAB, doorType, frameKey, hingeKey, drawerCount: 1, timberSpeciesKey: 'TIM_TUL', frameThicknessMm: 28, frameMemberWidthMm: 32, frameCustomPricePerM3: 3000 });
  for (const sprayFinishOverride of ['', 'primed', 'edge_polish', 'none']) for (const carcassFinish of ['none', 'paint', 'lacquer'])
    cab({ ...CAB, widthMm: 1000, heightMm: 2100, drawerCount: 2, shelfCount: 4, sprayFinishOverride, carcassFinish, frameKey: 'FRAME_TIM_TUL' }, 2);
  for (const [k, t] of Object.entries(OLD.DB.cabinetTypes))   // every catalogue cabinet at its defaults
    cab({ widthMm: t.w, heightMm: t.h, depthMm: t.d, doorCount: t.doors, drawerCount: t.drawers, shelfCount: t.shelves, carcassMaterialKey: 'MAT_BIRCH_UNF_18', cabinetTypeKey: k });
  cab({ widthMm: 600, heightMm: 770, depthMm: 560 });         // engine defaults throughout
  // priceItem without its pricedWith stamp (the engine version moves by design).
  const priced = (E, item) => { const { pricedWith, ...p } = E.priceItem(item); return p; };
  for (const item of items) assert.deepStrictEqual(priced(P, item), priced(OLD, item), JSON.stringify(item.params));
  assert.ok(items.length > 500);
});

// ─── The four builds ─────────────────────────────────────────────────────────
test('painted shaker: solid tulipwood 28 doors in a tulipwood 28 frame on butt hinges, every part at its existing rate', () => {
  const r = cabinet({ inframeFront: TULIP, frameMemberWidthMm: 32 }), b = r.breakdown;
  assert.deepEqual(bomKeys(r), { door: 'SHAKER_TIM_PNT', frame: 'FRAME_TIM_TUL', hinge: 'HW_HINGE_BUTT' });
  // Doors: the engine's own solid-timber shaker door, sized to the opening (600 − 2 × 32 across two, 770 − 2 × 32 − 6).
  const butt = P.DB.hardware.hinges.HW_HINGE_BUTT.costEach;
  const door = P.calcDoorCost({ doorType: 'SHAKER_TIM_PNT', widthMm: 266, heightMm: 700, qty: 2, hingeCost: 2 * butt, handleCost: 0, timberSpeciesKey: 'TIM_TUL', frameThicknessMm: 28 });
  assert.ok(near(b.doors, door.totalCost));
  assert.ok(near(b.bom.doors[0].areaM2, +(0.266 * 0.7 * 2).toFixed(4)));
  // Frame: the engine's own face frame at the tulipwood rate, 28 thick, 32 face.
  assert.equal(b.frame, P.calcCabinetFaceFrameCost({ frameKey: 'FRAME_TIM_TUL', widthMm: 600, heightMm: 770, frameThicknessMm: 28, frameMemberWidthMm: 32 }).total);
  // Frame finish: painted as the doors — its face and reveal at the spray rates.
  const perimM = 2 * (600 + 770) / 1000;
  const spray = P.calcSprayFinishCost({ doorType: null, widthMm: 600, heightMm: 770, finishType: 'paint', surfaceType: 'panel', sprayAreaM2Override: perimM * 0.032, perimMOverride: perimM });
  assert.ok(near(b.frameFinish, spray.costPerDoor) && b.frameFinish > 0);
  assert.equal(b.edgeband, 0);
  // Hanging: 30 minutes a door on butt hinges at the bench rate (DB.settings.buttHingeHangMins), on its own line.
  assert.equal(P.DB.settings.buttHingeHangMins, 30);
  assert.equal(b.hangHrs, 1);
  assert.ok(near(b.hanging, 2 * 0.5 * P.er()));
  // The total is its lines; hours and the spray split include the frame.
  assert.ok(near(r.totalCost, b.carcassMaterial + b.carcassLabour + b.carcassHardware + b.doors + b.drawers + b.drawerFronts + b.frame + b.frameFinish + b.hanging));
  assert.equal(b.totalHrs, +(b.assemblyHrs + b.doorHrs + b.frameHrs + b.finishHrs + b.hangHrs).toFixed(3));
  assert.ok(near(b.finishHrs, b.sprayDetail.parts.door.totalHrs + b.sprayDetail.parts.frame.totalHrs, 1e-3));
  assert.equal(b.sprayDetail.parts.frame.totalHrs, b.frameFinishHrs);
  assert.ok(near(r.totalSellExVAT, r.totalCost * P.DB.settings.margin) && near(r.totalSellIncVAT, r.totalSellExVAT * (1 + P.DB.settings.vat)));
});

test('oak shaker: solid oak, lacquered — the door and the frame take the oak rate', () => {
  const r = cabinet({ doorType: 'SHAKER_VEN', inframeFront: OAK, frameMemberWidthMm: 32 });
  assert.deepEqual(bomKeys(r), { door: 'SHAKER_TIM_LAC', frame: 'FRAME_TIM_OAK', hinge: 'HW_HINGE_BUTT' });
  assert.ok(r.breakdown.sprayDetail.parts.frame.lacquerHrs > 0 && !r.breakdown.sprayDetail.parts.frame.primerHrs);
  assert.ok(r.totalCost > cabinet({ inframeFront: TULIP, frameMemberWidthMm: 32 }).breakdown.doors);
  // The same build spelt out in the engine's own fields, plus the frame's finish: nothing else is in the figure.
  const spelt = cabinet({ doorType: 'SHAKER_TIM_LAC', timberSpeciesKey: 'TIM_OAK', doorFrameThicknessMm: 28, frameKey: 'FRAME_TIM_OAK', frameThicknessMm: 28, frameMemberWidthMm: 32, hingeKey: 'HW_HINGE_BUTT' });
  assert.equal(r.breakdown.frame, spelt.breakdown.frame);
  assert.ok(r.breakdown.doors < spelt.breakdown.doors);   // (the spelt-out doors are lay-on size)
});

test('veneered slab: the 19 veneered door as sent, in a 20 frame of the species, on butt hinges', () => {
  const r = cabinet({ doorType: 'SLAB_VEN', inframeFront: OAK_SL, frameMemberWidthMm: 32 });
  assert.deepEqual(bomKeys(r), { door: 'SLAB_VEN', frame: 'FRAME_TIM_OAK', hinge: 'HW_HINGE_BUTT' });
  assert.equal(r.breakdown.frame, P.calcCabinetFaceFrameCost({ frameKey: 'FRAME_TIM_OAK', widthMm: 600, heightMm: 770, frameThicknessMm: 20, frameMemberWidthMm: 32 }).total);
});

test('painted slab: the 22 MDF door as sent, in the 22 MDF frame, on the Blum hinge sent', () => {
  const r = cabinet({ doorType: 'SLAB_PNT', inframeFront: MDF, frameMemberWidthMm: 32 });
  assert.deepEqual(bomKeys(r), { door: 'SLAB_PNT', frame: 'FRAME_MDF_22', hinge: 'HW_HINGE_SM' });
  assert.equal(r.breakdown.frame, P.calcCabinetFaceFrameCost({ frameKey: 'FRAME_MDF_22', widthMm: 600, heightMm: 770 }).total);
  assert.ok(r.breakdown.frameFinish > 0);
  assert.equal(r.breakdown.hanging, 0);   // Blum hinges: no butt-hinge hanging time
  // Primed only: the frame is primed as the doors are.
  const primed = cabinet({ doorType: 'SLAB_PNT', inframeFront: MDF, sprayFinishOverride: 'primed' }).breakdown.sprayDetail.parts.frame;
  assert.ok(primed.primerHrs > 0 && !primed.topCoatHrs);
});

test('drawer fronts sit in the opening too, the frame member defaults to 30, and qty scales', () => {
  const r = cabinet({ doorCount: 0, drawerCount: 3, shelfCount: 0, inframeFront: TULIP });
  assert.ok(near(r.breakdown.bom.doors[0].areaM2, +(0.536 * ((770 - 60 - 6) / 3 / 1000) * 3).toFixed(4), 1e-3));
  assert.equal(r.breakdown.bom.doors[0].key, 'SHAKER_TIM_PNT');
  assert.equal(r.breakdown.hanging, 0);   // drawers only: nothing hung
  // The calculator's defaults for each build (inframeDefaults) are the four builds above.
  assert.deepEqual([P.inframeDefaults(false, 'tulipwood'), P.inframeDefaults(false, 'oak'), P.inframeDefaults(true, 'oak'), P.inframeDefaults(true, 'mdf')], [TULIP, OAK, OAK_SL, MDF]);
  assert.ok(near(cabinet({ inframeFront: TULIP }, 3).totalCost, 3 * cabinet({ inframeFront: TULIP }).totalCost));
});

// ─── The API ─────────────────────────────────────────────────────────────────
test('API: /api/cabinet-cost prices inframeFront exactly as priceItem does', async () => {
  for (const [doorType, inframeFront] of [['SHAKER_PNT', TULIP], ['SHAKER_VEN', OAK], ['SLAB_VEN', OAK_SL], ['SLAB_PNT', MDF]]) {
    const params = { ...CAB, doorType, inframeFront, frameMemberWidthMm: 32 };
    const { status, body } = await post({ ...params, qty: 1 });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body, wire(P.priceItem({ type: 'cabinet', qty: 1, params })));
  }
});

test('API: a build that is not made in-frame is refused, never guessed', async () => {
  const refused = async (patch, needle) => {
    const { status, body } = await post({ ...CAB, ...patch });
    assert.equal(status, 400, JSON.stringify(body));
    assert.ok(body.errors.some(e => e.includes(needle)), `expected an error mentioning "${needle}", got ${JSON.stringify(body.errors)}`);
  };
  await refused({ inframeFront: { ...TULIP, timber: 'shinnoki' } }, 'inframeFront.timber');
  await refused({ inframeFront: { ...TULIP, hinges: 'concealed' } }, 'inframeFront.hinges');
  await refused({ inframeFront: { ...TULIP, frameMm: '28' } }, 'inframeFront.frameMm');
  await refused({ inframeFront: { timber: 'tulipwood', frameMm: 28, hinges: 'butt' } }, 'inframeFront.thicknessMm');
  await refused({ inframeFront: { ...MDF, frameMm: 28 } }, 'MDF frame');
  await refused({ inframeFront: { ...TULIP, species: 'oak' } }, 'unknown field');
  await refused({ inframeFront: 'tulipwood' }, 'inframeFront must be an object');
  await refused({ inframeFront: TULIP, frameMemberWidthMm: '32' }, 'frameMemberWidthMm');
});

test('API: /api/cabinet-cost/keys lists the field, its timbers and hinges', async () => {
  const k = await (await fetch(`${base}/api/cabinet-cost/keys`, { headers: AUTH })).json();
  assert.ok(k.fields.includes('inframeFront'));
  assert.deepEqual(k.inframeFront, { timbers: ['tulipwood', 'oak', 'walnut', 'maple', 'mdf'], hinges: ['butt', 'blum'] });
});
