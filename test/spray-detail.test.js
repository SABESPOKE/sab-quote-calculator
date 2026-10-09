// sprayDetail (primer / top-coat / caulk / lacquer split) on every finished item.
// Run: `npm test`. The regression half needs git (baseline engine) and, for real
// quotes, QUOTES_SNAPSHOT=<path to a saved GET /api/quotes JSON> — never committed.
//
//   QUOTES_SNAPSHOT=/path/quotes.json node --test test/spray-detail.test.js
//
// BASE_REF (default: master before this change) is the engine every price is compared to.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const NEW = require(path.join(__dirname, '..', 'public', 'pricing.js'));
const STEPS = ['caulkHrs', 'stainHrs', 'primerHrs', 'topCoatHrs', 'lacquerHrs', 'edgePolishHrs', 'handlingHrs'];
const sumSteps = sd => STEPS.reduce((s, k) => s + (sd[k] || 0), 0);
const near = (a, b) => Math.abs(a - b) < 1e-9;

// Every item type that carries finishHrs, across every finish the engine knows.
const FINISHES = ['none', 'edge_polish', 'primed', 'paint', 'lacquer', 'stain_lacquer'];
const matrix = () => {
  const items = [];
  for (const f of FINISHES) {
    items.push({ type: 'endpanel', qty: 1, params: { materialKey: 'MAT_MDF_FH_18', widthMm: 560, heightMm: 900, finishType: f } });
    items.push({ type: 'shelf', qty: 2, params: { materialKey: 'TIM_OAK', lengthMm: 1200, depthMm: 250, visibleThicknessMm: 50, finishType: f } });
    items.push({ type: 'wrp_moulding', qty: 1, params: { wrp_price_per_metre: 10, linear_metres: 5.5, markup_pct: 35, dimensions: '55mm x 52mm', finishType: f } });
    items.push({ type: 'cabinet', qty: 1, params: { widthMm: 950, heightMm: 770, depthMm: 560, doorCount: 0, drawerCount: 3, doorType: 'SHAKER_PNT', carcassMaterialKey: 'MAT_MDF_FH_18', carcassFinish: f } });
  }
  for (const o of ['', 'primed', 'edge_polish', 'none']) {
    items.push({ type: 'door', qty: 2, params: { doorType: 'SHAKER_PNT', widthMm: 598, heightMm: 764, sprayFinishOverride: o } });
    items.push({ type: 'cabinet', qty: 1, params: { widthMm: 800, heightMm: 770, depthMm: 560, doorCount: 2, drawerCount: 1, doorType: 'SHAKER_PNT', carcassMaterialKey: 'MAT_OAK_MDF_UNF_19', carcassFinish: 'lacquer', sprayFinishOverride: o } });
  }
  for (const doorType of ['SLAB_VEN', 'SHAKER_VEN', 'SHAKER_TIM_OIL', 'SLAB_PNT'])
    items.push({ type: 'cabinet', qty: 3, params: { widthMm: 600, heightMm: 720, depthMm: 560, doorCount: 1, doorType, hasStain: doorType === 'SHAKER_VEN', timberSpeciesKey: 'TIM_OAK', carcassMaterialKey: 'MAT_BIRCH_UNF_18' } });
  items.push({ type: 'filler', qty: 1, params: { doorType: 'SHAKER_PNT', widthMm: 50, heightMm: 720 } });
  return items;
};

// ─── invariants (always run) ─────────────────────────────────────────────────
test('every finished item: sprayDetail steps add up exactly to finishHrs', () => {
  for (const item of matrix()) {
    const bd = NEW.priceItem(item).breakdown;
    if (!('finishHrs' in bd)) continue; // fillers carry no hours at all (unchanged)
    const sd = bd.sprayDetail;
    if (bd.finishHrs === 0 && !sd) continue;
    assert.ok(sd, `${item.type} ${JSON.stringify(item.params)} has finishHrs but no sprayDetail`);
    assert.ok(near(sd.totalHrs, bd.finishHrs), `${item.type}: sprayDetail.totalHrs ${sd.totalHrs} != finishHrs ${bd.finishHrs}`);
    assert.ok(near(sumSteps(sd), bd.finishHrs), `${item.type}: steps sum ${sumSteps(sd)} != finishHrs ${bd.finishHrs}`);
    assert.ok(sd.handlingHrs >= 0, `${item.type}: negative handlingHrs ${sd.handlingHrs}`);
  }
});

test('cabinet sprayDetail.parts match carcass / door / drawer-front finishing and sum to finishHrs', () => {
  const cab = NEW.priceItem({ type: 'cabinet', qty: 1, params: { widthMm: 800, heightMm: 770, depthMm: 560, doorCount: 2, drawerCount: 2, doorType: 'SHAKER_PNT', carcassMaterialKey: 'MAT_MDF_FH_18', carcassFinish: 'paint' } }).breakdown;
  const { parts } = cab.sprayDetail;
  assert.deepEqual(Object.keys(parts).sort(), ['carcass', 'door', 'drawerFront']);
  assert.equal(parts.carcass.totalHrs, cab.carcassFinishHrs);
  for (const p of Object.values(parts)) assert.ok(near(sumSteps(p), p.totalHrs));
  assert.ok(near(Object.values(parts).reduce((s, p) => s + p.totalHrs, 0), cab.finishHrs));
  for (const k of STEPS) assert.ok(near(cab.sprayDetail[k] || 0, Object.values(parts).reduce((s, p) => s + (p[k] || 0), 0)), `top-level ${k} != sum of parts`);
  // shaker painted: caulk once, primer, top coats; no lacquer
  assert.ok(parts.door.caulkHrs > 0 && parts.door.primerHrs > 0 && parts.door.topCoatHrs > 0 && !parts.door.lacquerHrs);
});

// ─── regression: additive only, no price / hours / total may change ──────────
const BASE_REF = process.env.BASE_REF || 'd7b9222';
let OLD = null;
try {
  const src = execFileSync('git', ['show', `${BASE_REF}:public/pricing.js`], { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 1 << 24 });
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sab-base-')), 'pricing.js');
  fs.writeFileSync(tmp, src);
  OLD = require(tmp);
} catch { /* no git / unknown ref → regression tests skip */ }

// Every leaf of the old value must exist, identical, in the new one (new may only ADD keys).
function changed(oldV, newV, at, out) {
  if (oldV !== null && typeof oldV === 'object') {
    if (newV === null || typeof newV !== 'object') { out.push(at); return out; }
    for (const k of Object.keys(oldV)) changed(oldV[k], newV[k], `${at}.${k}`, out);
  } else if (!Object.is(oldV, newV)) out.push(`${at}: ${oldV} → ${newV}`);
  return out;
}

function compareQuote(q) {
  const out = [];
  let items = 0;
  for (const [room, r] of Object.entries(q.rooms || {})) {
    (r.items || []).forEach((item, i) => {
      items++;
      let o, n;
      try { o = OLD.priceItem(item, q.marginOverride); } catch (e) { o = `threw ${e.message}`; }
      try { n = NEW.priceItem(item, q.marginOverride); } catch (e) { n = `threw ${e.message}`; }
      changed(o, n, `${room}[${i}]`, out);
    });
  }
  const ro = OLD.recomputeQuotePricing(q), rn = NEW.recomputeQuotePricing(q);
  changed(OLD.quoteTotals(ro), NEW.quoteTotals(rn), 'quoteTotals', out);
  changed(OLD.quoteGrandTotal(ro), NEW.quoteGrandTotal(rn), 'grandTotal', out);
  changed(OLD.quoteMaterialsBom(ro), NEW.quoteMaterialsBom(rn), 'materialsBom', out);
  return { items, out };
}

test('regression: synthetic matrix prices identically to the baseline engine', { skip: !OLD && `baseline ${BASE_REF} not loadable` }, () => {
  const { out } = compareQuote({ rooms: { All: { items: matrix() } } });
  assert.deepEqual(out, []);
});

const SNAP = process.env.QUOTES_SNAPSHOT;
test('regression: every saved quote prices identically to the baseline engine', { skip: (!OLD && `baseline ${BASE_REF} not loadable`) || (!SNAP && 'QUOTES_SNAPSHOT not set') }, () => {
  const quotes = Object.values(JSON.parse(fs.readFileSync(SNAP, 'utf8')));
  let items = 0;
  const diffs = [];
  for (const q of quotes) {
    const r = compareQuote(q);
    items += r.items;
    r.out.forEach(d => diffs.push(`${q.ref || q.id}: ${d}`));
  }
  console.log(`[spray-detail regression] ${quotes.length} quotes, ${items} items, ${diffs.length} differences (baseline ${BASE_REF})`);
  assert.deepEqual(diffs, []);
});
