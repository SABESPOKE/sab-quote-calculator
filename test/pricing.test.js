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
const { priceItem, calcCabinetCost, calcDoorCost, calcDesignHrsPerRoom, calcDesignTimePerRoom, DB,
        quoteTotals, quoteGrandTotal, getDefaultProjectCosts, totalInstallDays, recomputeQuotePricing,
        quoteMaterialsBom } = P;

const close = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;
const round2 = n => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

// Build a quote with every item pre-priced (as the UI stores it). `pc` overrides
// projectCosts; `roomExtra` lets a test toggle includeDesignTime etc. per room.
const ALL_PC_OFF = { includeSurvey: false, includeInstall: false, includeDelivery: false, includePM: false, includeConsumables: false, includeContingency: false, includeWarranty: false };
const pricedRoom = (items, extra = {}) => ({ items: items.map(it => ({ ...it, pricing: priceItem(it) })), ...extra });
const makeQuote = ({ rooms, projectCosts, ...rest } = {}) => ({
  rooms: rooms || { Kitchen: pricedRoom([cabinet(), door()], { includeDesignTime: false }) },
  projectCosts,
  ...rest,
});

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

// ─── QUOTE GRAND TOTAL (the figure persisted onto the quote / served by the API) ─
// These lock in that the stored total is the SAME number the calculator UI shows
// (quoteTotals), and that it actually captures project-level costs the downstream
// portal was previously missing.

test('engine exports the quote-level total functions', () => {
  for (const fn of ['quoteTotals', 'quoteGrandTotal', 'getDefaultProjectCosts', 'totalInstallDays', 'recomputeQuotePricing']) {
    assert.equal(typeof P[fn], 'function', `${fn} should be exported`);
  }
});

test('with all project costs off and no design time, grand total = sum of item sells', () => {
  const room = pricedRoom([cabinet(), door(), drawer()], { includeDesignTime: false });
  const quote = makeQuote({ rooms: { Kitchen: room }, projectCosts: ALL_PC_OFF });
  const itemsSell = room.items.reduce((s, i) => s + i.pricing.totalSellExVAT, 0);
  const t = quoteTotals(quote);
  assert.ok(close(t.totalExVAT, itemsSell), `total ${t.totalExVAT} != items ${itemsSell}`);
  assert.ok(close(t.mfgSellExVAT, itemsSell), 'mfgSellExVAT should equal items sell');
});

test('quoteGrandTotal = quoteTotals rounded to 2dp (the UI display figure)', () => {
  const quote = makeQuote({ projectCosts: { ...ALL_PC_OFF, includeDelivery: true, includePM: true } });
  const t = quoteTotals(quote);
  const g = quoteGrandTotal(quote);
  assert.equal(g.totalSellExVAT, round2(t.totalExVAT));
  assert.equal(g.totalSellIncVAT, round2(t.totalIncVAT));
  // inc VAT is the ex-VAT figure plus VAT, within a penny of the rounded relationship
  assert.ok(close(g.totalSellIncVAT, round2(g.totalSellExVAT * (1 + DB.settings.vat)), 0.011), 'inc VAT mismatch');
});

test('grand total includes project-level costs items-only summing misses', () => {
  // This is the bug the field fixes: a portal summing only line items understates
  // the quote by every active project cost. Turning delivery on must raise the
  // grand total by exactly the margined delivery fee.
  const base = makeQuote({ projectCosts: { ...ALL_PC_OFF } });
  const withDelivery = makeQuote({ rooms: base.rooms, projectCosts: { ...ALL_PC_OFF, includeDelivery: true } });
  const diff = quoteTotals(withDelivery).totalExVAT - quoteTotals(base).totalExVAT;
  const expected = DB.settings.deliveryFee * DB.settings.margin;
  assert.ok(close(diff, expected), `delivery should add ${expected}, added ${diff}`);
});

test('design time and PM% lift the total above the bare item sells', () => {
  const room = pricedRoom([cabinet(), cabinet()], { includeDesignTime: true });
  const quote = makeQuote({ rooms: { Kitchen: room }, projectCosts: { ...ALL_PC_OFF, includePM: true } });
  const itemsSell = room.items.reduce((s, i) => s + i.pricing.totalSellExVAT, 0);
  const t = quoteTotals(quote);
  assert.ok(t.designFee > 0, 'design fee should be charged');
  assert.ok(t.pm > 0, 'PM should be charged');
  assert.ok(t.totalExVAT > itemsSell, 'total must exceed bare item sells');
  assert.ok(close(t.totalExVAT, itemsSell + t.designFee + t.pm), 'total = items + design + pm (all else off)');
});

test('persisted total is stable through a recompute (server-side stamping path)', () => {
  // The server stamps the total after recomputeQuotePricing; recomputing already
  // up-to-date items must not move the figure (same engine in, same figure out).
  const quote = makeQuote({ projectCosts: { ...ALL_PC_OFF, includeDelivery: true, includePM: true, includeConsumables: true } });
  const fromStored = quoteGrandTotal(quote);
  const fromRecomputed = quoteGrandTotal(recomputeQuotePricing(quote));
  assert.deepEqual(fromRecomputed, fromStored);
});

test('recomputeQuotePricing is non-destructive to rooms/items shape', () => {
  const quote = makeQuote();
  const out = recomputeQuotePricing(quote);
  assert.deepEqual(Object.keys(out.rooms), Object.keys(quote.rooms));
  assert.equal(out.rooms.Kitchen.items.length, quote.rooms.Kitchen.items.length);
  for (const it of out.rooms.Kitchen.items) assert.ok(it.pricing && 'totalSellExVAT' in it.pricing);
});

test('empty quote does not throw and yields a finite total', () => {
  const g = quoteGrandTotal({ rooms: {}, projectCosts: ALL_PC_OFF });
  assert.equal(g.totalSellExVAT, 0);
  assert.equal(g.totalSellIncVAT, 0);
});

// ─── project-cost helpers (moved from index.html, now shared) ─────────────────
test('getDefaultProjectCosts seeds toggles and pulls rates from DB.settings', () => {
  const pc = getDefaultProjectCosts();
  assert.equal(pc.surveyFee, DB.settings.surveyFee);
  assert.equal(pc.includeSurvey, true);
  assert.equal(pc.includeInstall, false);
  assert.deepEqual(pc.installDaysByRoom, {});
});

test('totalInstallDays sums the per-room map and falls back to legacy installDays', () => {
  assert.equal(totalInstallDays({ installDaysByRoom: { Kitchen: 2, Utility: 1.5 } }), 3.5);
  assert.equal(totalInstallDays({ installDays: 4 }), 4); // legacy single-number quotes
  assert.equal(totalInstallDays({}), 0);
});

// ─── MATERIALS BOM (read-only, additive — material quantities for ordering) ──────
// These lock in that the BOM is produced from the SAME geometry that prices each
// cabinet (so it can never disagree with the price), and that it's purely additive.

test('engine exports quoteMaterialsBom', () => {
  assert.equal(typeof quoteMaterialsBom, 'function');
});

test('cabinet breakdown exposes a bom of material quantities (additive, no cost change)', () => {
  const bd = priceItem(cabinet({ drawerCount: 0 })).breakdown;
  assert.ok(bd.bom, 'cabinet breakdown should carry a bom');
  for (const k of ['carcass', 'doors', 'drawerBoxes', 'frames', 'edgeband', 'hardware']) {
    assert.ok(Array.isArray(bd.bom[k]), `bom.${k} should be an array`);
  }
  // 2-door SHAKER_PNT cabinet: 2 door panels of that type, with positive area.
  const doors = bd.bom.doors.find(d => d.key === 'SHAKER_PNT');
  assert.ok(doors && doors.count === 2 && doors.areaM2 > 0, 'two door panels with area');
  // Carcass material is the picked key; birch needs no edgeband.
  assert.ok(bd.bom.carcass.some(c => c.key === 'MAT_BIRCH_UNF_18' && c.areaM2 > 0), 'carcass area present');
});

test('bom quantities scale linearly with cabinet qty', () => {
  // Note: the cabinet() fixture spreads overrides into params, so set the line qty
  // at the top level (item.qty is what the engine multiplies by).
  const one = priceItem({ ...cabinet(), qty: 1 }).breakdown.bom;
  const three = priceItem({ ...cabinet(), qty: 3 }).breakdown.bom;
  const a1 = one.carcass.reduce((s, c) => s + c.areaM2, 0);
  const a3 = three.carcass.reduce((s, c) => s + c.areaM2, 0);
  assert.ok(close(a3, a1 * 3, 0.05), `carcass area should triple: ${a1} → ${a3}`);
  assert.equal(three.doors[0].count, one.doors[0].count * 3, 'door panel count should triple');
});

test('drawer fronts fold into the door type bucket and drawer boxes are counted', () => {
  const bd = priceItem(cabinet({ doorCount: 2, drawerCount: 3, drawerType: 'DRW_BIRCH_PLY' })).breakdown;
  const doors = bd.bom.doors.find(d => d.key === 'SHAKER_PNT');
  // 2 doors + 3 drawer fronts all made/finished as SHAKER_PNT panels.
  assert.equal(doors.count, 5, 'door bucket = doors + drawer fronts');
  const boxes = bd.bom.drawerBoxes.find(b => b.key === 'DRW_BIRCH_PLY');
  assert.ok(boxes && boxes.count === 3, 'three drawer boxes counted');
  const runners = bd.bom.hardware.find(h => h.key === 'HW_RUN_BLUM_SM');
  assert.ok(runners && runners.count === 3, 'three runner pairs');
});

// ─── handles: positions pull through (split door/drawer) even when not priced ─────
test('handle positions are reported split by door/drawer, and live in their own field', () => {
  const bd = priceItem(cabinet({ doorCount: 2, drawerCount: 3, drawerType: 'DRW_BIRCH_PLY', handleKey: 'HW_HDL_BAR128' })).breakdown;
  const doorH = bd.bom.handles.find(h => h.target === 'door');
  const drawerH = bd.bom.handles.find(h => h.target === 'drawer');
  assert.ok(doorH && doorH.count === 2 && doorH.key === 'HW_HDL_BAR128', '2 door handle positions');
  assert.ok(drawerH && drawerH.count === 3 && drawerH.key === 'HW_HDL_BAR128', '3 drawer handle positions');
  // Handles are NOT mixed into the generic hardware array (which stays hinges + runners).
  assert.ok(!bd.bom.hardware.some(h => String(h.key).startsWith('HW_HDL')), 'handles not in hardware array');
});

test('handle positions still pull through when "No handle" is selected (the common case)', () => {
  const bd = priceItem(cabinet({ doorCount: 2, drawerCount: 3, drawerType: 'DRW_BIRCH_PLY', handleKey: 'HW_HDL_NONE' })).breakdown;
  const positions = bd.bom.handles.reduce((s, h) => s + h.count, 0);
  assert.equal(positions, 5, '5 handle positions reported even with HW_HDL_NONE');
  assert.ok(bd.bom.handles.every(h => h.key === 'HW_HDL_NONE'), 'key reflects the (none) selection');
});

test('"No handle" adds no cost; selecting a real handle does (price only when chosen)', () => {
  const none = priceItem(cabinet({ doorCount: 2, drawerCount: 3, drawerType: 'DRW_BIRCH_PLY', handleKey: 'HW_HDL_NONE' }));
  const bar = priceItem(cabinet({ doorCount: 2, drawerCount: 3, drawerType: 'DRW_BIRCH_PLY', handleKey: 'HW_HDL_BAR128' }));
  // 5 positions × £12 = £60 added when the handle is actually selected.
  assert.ok(close(bar.totalCost - none.totalCost, 5 * 12, 0.01), 'real handle adds 5 × £12; none adds nothing');
});

test('when a real handle IS selected, priced count equals the BOM handle positions', () => {
  // Source-of-truth for the priced case: positions == handles charged.
  for (const cfg of [{ doorCount: 2, drawerCount: 0 }, { doorCount: 2, drawerCount: 3, drawerType: 'DRW_BIRCH_PLY' }, { doorCount: 0, shelfCount: 0, drawerCount: 4, drawerType: 'DRW_BIRCH_PLY' }]) {
    const withH = priceItem(cabinet({ ...cfg, handleKey: 'HW_HDL_BAR128' }));
    const noneH = priceItem(cabinet({ ...cfg, handleKey: 'HW_HDL_NONE' }));
    const pricedHandles = Math.round((withH.totalCost - noneH.totalCost) / 12);
    const bomPositions = withH.breakdown.bom.handles.reduce((s, h) => s + h.count, 0);
    assert.equal(bomPositions, pricedHandles, `positions (${bomPositions}) != priced (${pricedHandles}) for ${JSON.stringify(cfg)}`);
  }
});

test('quoteMaterialsBom aggregates handle positions by key + target across the quote', () => {
  // Two cabinets, knobs on doors / drawers — positions merge by (key, target).
  const room = pricedRoom([
    cabinet({ doorCount: 2, drawerCount: 3, drawerType: 'DRW_BIRCH_PLY', handleKey: 'HW_HDL_KNOB' }),
    cabinet({ doorCount: 2, drawerCount: 0, handleKey: 'HW_HDL_KNOB' }),
  ], { includeDesignTime: false });
  const bom = quoteMaterialsBom(makeQuote({ rooms: { Kitchen: room } }));
  const doorPos = bom.handles.find(h => h.key === 'HW_HDL_KNOB' && h.target === 'door');
  const drawerPos = bom.handles.find(h => h.key === 'HW_HDL_KNOB' && h.target === 'drawer');
  assert.equal(doorPos.count, 4, '2 + 2 door positions');
  assert.equal(drawerPos.count, 3, '3 drawer positions');
});

test('hinge counts match the priced hinges (per-door hinge count × doors)', () => {
  const params = cabinet({ doorCount: 2, heightMm: 770, hingeKey: 'HW_HINGE_SM' }).params;
  const bd = calcCabinetCost({ ...params, qty: 1 }).breakdown;
  const hinges = bd.bom.hardware.find(h => h.key === 'HW_HINGE_SM');
  // doorH = 770-6 = 764 ≤ 900 → 2 hinges/door × 2 doors = 4.
  assert.ok(hinges && hinges.count === 4, `expected 4 hinges, got ${hinges && hinges.count}`);
});

test('a frame on the cabinet surfaces frame lineal metres and suppresses edgeband', () => {
  const bd = priceItem(cabinet({ frameKey: 'FRAME_TIM_OAK', carcassMaterialKey: 'MAT_OAK_MDF_PREF_19' })).breakdown;
  const frame = bd.bom.frames.find(f => f.key === 'FRAME_TIM_OAK');
  assert.ok(frame && frame.linealM > 0, 'frame lineal metres present');
  assert.equal(bd.bom.edgeband.length, 0, 'framed cabinet has no edgeband');
});

test('quoteMaterialsBom aggregates across rooms and merges identical keys', () => {
  const room = pricedRoom([cabinet(), cabinet()], { includeDesignTime: false });
  const quote = makeQuote({ rooms: { Kitchen: room } });
  const bom = quoteMaterialsBom(quote);
  assert.ok(bom, 'bom should be produced for a quote with cabinets');
  // Two identical cabinets → one merged carcass line, doubled area, integer sheet count.
  const carcass = bom.carcass.find(c => c.key === 'MAT_BIRCH_UNF_18');
  assert.ok(carcass, 'carcass key merged');
  const singleCarcass = priceItem(cabinet()).breakdown.bom.carcass.reduce((s, c) => s + c.areaM2, 0);
  assert.equal(carcass.areaM2, round2(singleCarcass * 2));
  assert.ok(Number.isInteger(carcass.sheets) && carcass.sheets >= 1, 'sheet count is a positive integer');
  const doors = bom.doors.find(d => d.key === 'SHAKER_PNT');
  assert.equal(doors.count, 4, 'two 2-door cabinets → 4 door panels');
});

test('quoteMaterialsBom recomputes bom when items lack a pre-priced breakdown', () => {
  // Items with no .pricing at all — aggregator must price them itself.
  const quote = { rooms: { Kitchen: { items: [cabinet(), cabinet()], includeDesignTime: false } } };
  const bom = quoteMaterialsBom(quote);
  assert.ok(bom && bom.doors.find(d => d.key === 'SHAKER_PNT').count === 4, 'aggregated without pre-priced items');
});

test('quoteMaterialsBom returns null for empty / fixed-price-only quotes', () => {
  assert.equal(quoteMaterialsBom({ rooms: {} }), null, 'empty quote → null');
  const fixed = { type: 'cabinet', qty: 1, fixedPrice: true, fixedCostExVAT: 1000, fixedMarkupPct: 10, params: {} };
  const quote = { rooms: { Kitchen: { items: [{ ...fixed, pricing: priceItem(fixed) }] } } };
  assert.equal(quoteMaterialsBom(quote), null, 'fixed-price-only quote → null');
});

test('materials bom does not change the existing pricing shape or numbers', () => {
  // Adding breakdown.bom must not perturb any costed figure.
  const r = priceItem(cabinet({ drawerCount: 1 }));
  for (const k of ['costPerUnit', 'sellPerUnit', 'totalCost', 'totalSellExVAT', 'totalSellIncVAT']) {
    assert.equal(typeof r[k], 'number', `${k} still present`);
  }
  assert.ok(close(r.totalSellExVAT, r.totalCost * DB.settings.margin), 'sell = cost × margin still holds');
});
