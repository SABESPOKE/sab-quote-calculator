// Pricing-engine tests for public/pricing.js — the single source of truth shared by
// the browser (window globals) and the server (require). Run: `npm test` (node --test).
//
// These lock in the behaviours verified by hand across the labour-hours / recompute /
// carcass / design work. They prefer invariants (sell = cost × margin, override scales
// proportionally, finishHrs = sum of its parts) over magic numbers, so legitimate rate
// changes don't break them — only behavioural regressions do.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const P = require(path.join(__dirname, '..', 'public', 'pricing.js'));
const { priceItem, calcCabinetCost, calcDoorCost, calcDesignHrsPerRoom, calcDesignTimePerRoom, DB } = P;

const close = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

// ─── canonical item fixtures ───────────────────────────────────────────────
const cabinet = (over = {}) => ({ type: 'cabinet', qty: 1, params: { widthMm: 600, heightMm: 770, depthMm: 560, doorCount: 2, doorType: 'SHAKER_PNT', shelfCount: 1, carcassMaterialKey: 'MAT_BIRCH_UNF_18', ...over } });
const door = (over = {}) => ({ type: 'door', qty: 1, params: { doorType: 'SHAKER_PNT', widthMm: 500, heightMm: 720, ...over } });
const drawer = () => ({ type: 'drawer', qty: 1, params: { drawerType: 'DRW_BIRCH_PLY', widthMm: 500, heightMm: 180, depthMm: 500 } });
const moulding = () => ({ type: 'moulding', qty: 1, params: { mouldingKey: 'MLD_SKR_OAK_95', metres: 6 } });
const custom = () => ({ type: 'custom', qty: 2, params: { unitCostExVAT: 120 } });
const wrp = () => ({ type: 'wrp_moulding', qty: 1, params: { wrp_price_per_metre: 10, linear_metres: 5, markup_pct: 50, finishType: 'none' } });

// ─── exports / shape ────────────────────────────────────────────────────────
test('engine exports the expected functions', () => {
  for (const fn of ['priceItem', 'calcCabinetCost', 'calcDoorCost', 'calcDesignHrsPerRoom', 'calcDesignTimePerRoom']) {
    assert.equal(typeof P[fn], 'function', `${fn} should be exported`);
  }
  assert.equal(typeof DB.settings.margin, 'number');
});

test('priceItem returns the standard pricing shape for every item type', () => {
  for (const item of [cabinet(), door(), drawer(), moulding(), custom(), wrp()]) {
    const r = priceItem(item);
    assert.ok(r, `${item.type} should price`);
    for (const k of ['costPerUnit', 'sellPerUnit', 'totalCost', 'totalSellExVAT', 'totalSellIncVAT', 'breakdown']) {
      assert.ok(k in r, `${item.type} pricing missing ${k}`);
    }
  }
});

// ─── margin: sell = cost × margin, and inc-VAT relationship ──────────────────
test('sell ex-VAT = cost × margin; inc-VAT = ex-VAT × (1 + vat)', () => {
  const m = DB.settings.margin, vat = DB.settings.vat;
  for (const item of [cabinet(), door(), drawer(), moulding()]) {
    const r = priceItem(item);
    assert.ok(close(r.totalSellExVAT, r.totalCost * m), `${item.type}: sell ${r.totalSellExVAT} != cost ${r.totalCost} × ${m}`);
    assert.ok(close(r.totalSellIncVAT, r.totalSellExVAT * (1 + vat)), `${item.type}: incVAT mismatch`);
  }
});

// ─── per-quote margin override ───────────────────────────────────────────────
test('no margin override prices identically to the default (undefined / null / explicit default)', () => {
  for (const item of [cabinet(), door(), drawer(), moulding(), custom()]) {
    const base = JSON.stringify(priceItem(item));
    assert.equal(JSON.stringify(priceItem(item, undefined)), base, `${item.type}: undefined override differs`);
    assert.equal(JSON.stringify(priceItem(item, null)), base, `${item.type}: null override differs`);
    assert.equal(JSON.stringify(priceItem(item, DB.settings.margin)), base, `${item.type}: explicit default differs`);
  }
});

test('margin override scales sell to cost × override', () => {
  const item = cabinet();
  const cost = priceItem(item).totalCost;
  for (const m of [2.0, 2.5, 3.0]) {
    assert.ok(close(priceItem(item, m).totalSellExVAT, cost * m), `override ${m} did not apply`);
  }
});

test('WRP mouldings ignore the margin override (own markup_pct)', () => {
  const item = wrp();
  assert.equal(priceItem(item, 5).totalSellExVAT, priceItem(item).totalSellExVAT);
});

// ─── labour-hours fields (additive, for scheduling) ──────────────────────────
test('door breakdown exposes doorHrs / finishHrs / totalHrs and totalHrs = doorHrs + finishHrs', () => {
  const bd = priceItem(door()).breakdown;
  for (const k of ['doorHrs', 'finishHrs', 'totalHrs']) assert.ok(k in bd, `door missing ${k}`);
  assert.ok(close(bd.totalHrs, bd.doorHrs + bd.finishHrs), 'door totalHrs != doorHrs + finishHrs');
});

test('cabinet breakdown exposes all labour-hours fields and totalHrs is their sum', () => {
  const bd = priceItem(cabinet({ drawerCount: 1, drawerType: 'DRW_BIRCH_PLY' })).breakdown;
  const keys = ['assemblyHrs', 'doorHrs', 'drawerHrs', 'drawerFrontHrs', 'frameHrs', 'edgebandHrs', 'carcassFinishHrs', 'finishHrs', 'totalHrs'];
  for (const k of keys) assert.ok(k in bd, `cabinet missing ${k}`);
  const sum = bd.assemblyHrs + bd.doorHrs + bd.drawerHrs + bd.drawerFrontHrs + bd.frameHrs + bd.edgebandHrs + bd.finishHrs;
  assert.ok(close(bd.totalHrs, sum), `cabinet totalHrs ${bd.totalHrs} != sum ${sum}`);
});

// ─── carcass finishing hours (the fix that finishHrs now includes carcass spray) ─
test('carcassFinish "none" → carcassFinishHrs 0; finishHrs is doors+fronts only', () => {
  const bd = priceItem(cabinet({ carcassFinish: 'none' })).breakdown;
  assert.equal(bd.carcassFinishHrs, 0);
});

test('finished carcass adds carcass spray hours into finishHrs (open unit: no doors)', () => {
  const open = (cf) => priceItem(cabinet({ doorCount: 0, shelfCount: 5, heightMm: 2400, carcassFinish: cf })).breakdown;
  const none = open('none'), lac = open('lacquer');
  assert.equal(none.finishHrs, 0, 'open unit, no finish → finishHrs 0');
  assert.ok(lac.carcassFinishHrs > 0, 'lacquered carcass → carcassFinishHrs > 0');
  assert.ok(close(lac.finishHrs, lac.carcassFinishHrs), 'open unit finishHrs should equal carcassFinishHrs (no doors/fronts)');
});

// ─── No Hinge (£0 flows through) ─────────────────────────────────────────────
test('HW_HINGE_NONE exists at £0 and removes hinge cost from a door cabinet', () => {
  assert.equal(DB.hardware.hinges.HW_HINGE_NONE.costEach, 0);
  const sm = calcCabinetCost({ ...cabinet().params, hingeKey: 'HW_HINGE_SM', qty: 1 }).breakdown.doors;
  const none = calcCabinetCost({ ...cabinet().params, hingeKey: 'HW_HINGE_NONE', qty: 1 }).breakdown.doors;
  assert.ok(none < sm, 'No Hinge should cost less than soft-close (hinge £0)');
});

// ─── thin Finsa Hydro MDF materials ──────────────────────────────────────────
test('Finsa Hydrofuga thin MDF materials exist at the pro-rata prices', () => {
  const expect = { MAT_MDF_FH_6: 5.60, MAT_MDF_FH_9: 8.40, MAT_MDF_FH_12: 11.20, MAT_MDF_FH_15: 14.00 };
  for (const [k, v] of Object.entries(expect)) {
    assert.ok(DB.materials[k], `${k} missing`);
    assert.ok(close(DB.materials[k].costPerM2, v, 0.001), `${k} costPerM2 ${DB.materials[k].costPerM2} != ${v}`);
  }
});

// ─── design hours (per room; defaults resolved) ──────────────────────────────
test('calcDesignHrsPerRoom resolves blank inputs to the defaults', () => {
  const s = DB.settings;
  const expected = s.designRoundsPerRoom * s.designHoursPerRound + s.technicalDrawingDays * s.workingHoursPerDay;
  const d = calcDesignHrsPerRoom({}); // all blank
  assert.equal(d.designHrs, expected, 'defaulted designHrs');
  assert.equal(d.techDays, s.technicalDrawingDays, 'defaulted techDays resolved');
});

test('calcDesignHrsPerRoom honours entered values', () => {
  const s = DB.settings;
  const d = calcDesignHrsPerRoom({ designRounds: 1, designHrsPerRound: 8, techDays: 1 });
  assert.equal(d.designHrs, 1 * 8 + 1 * s.workingHoursPerDay);
  assert.equal(d.techDays, 1);
});

test('design fee = designHrs × rate (refactor kept the fee identical)', () => {
  const room = { designRounds: 3, designHrsPerRound: 8, techDays: 4, designRate: 50 };
  const { designHrs } = calcDesignHrsPerRoom(room);
  assert.equal(calcDesignTimePerRoom(room), designHrs * 50);
});

// ─── fixed-price pass-through unaffected by margin ───────────────────────────
test('fixed-price item uses its own markup, not the global margin', () => {
  const item = { type: 'cabinet', qty: 1, fixedPrice: true, fixedCostExVAT: 1000, fixedMarkupPct: 10, params: {} };
  const r = priceItem(item, 99); // huge margin override must be ignored
  assert.equal(r.totalSellExVAT, 1100);
  assert.equal(r.isFixedPrice, true);
});
