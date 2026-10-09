// Price lock: a locked quote's item prices and totals never move when the engine or the
// Settings change; its hours do (hours.current), flagged by hours.changed / hoursCheck.
// Run: `npm test`. The saved-quotes half needs QUOTES_SNAPSHOT=<saved GET /api/quotes JSON>
// (client data — never committed):
//
//   QUOTES_SNAPSHOT=/path/quotes.json node --test test/price-lock.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SRC = path.join(__dirname, '..', 'public', 'pricing.js');
const P = require(SRC);
const { analyseQuote, inferSettings } = require(path.join(__dirname, '..', 'scripts', 'lock-quotes.js'));

// "Next engine": this pricing.js with real code changes and new default rates, loaded as
// a separate module — what a future deploy looks like to an already-locked quote.
const NEXT_EDITS = [
  ['labourRate: 30,', 'labourRate: 40,'],                                    // Settings: labour rate
  ['margin: 2.0,', 'margin: 2.4,'],                                          // Settings: margin
  ['vat: 0.20,', 'vat: 0.25,'],                                              // Settings: VAT
  ['topCoatSprayHrsPerM2:   0.21', 'topCoatSprayHrsPerM2:   0.30'],          // finishing rate → hours move
  ['const cornerHrs = 4 * 0.10;', 'const cornerHrs = 4 * 0.25;'],            // engine code: face-frame labour
  ['const labourHrs  = 0.5 + (exposedEdgeCount', 'const labourHrs  = 0.9 + (exposedEdgeCount'], // engine code: end panels
];
let nextSrc = fs.readFileSync(SRC, 'utf8');
for (const [from, to] of NEXT_EDITS) {
  assert.equal(nextSrc.split(from).length, 2, `simulated change anchor not found once: ${from}`);
  nextSrc = nextSrc.replace(from, to);
}
const nextFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sab-next-')), 'pricing.js');
fs.writeFileSync(nextFile, nextSrc);
const NEXT = require(nextFile);

const json = v => JSON.stringify(v);
const priced = it => Number.isFinite(it && it.pricing && it.pricing.totalCost);

// Lock with today's engine, then read it back the way the server (GET) and browser
// (ensurePricing) do after the next engine is deployed. Returns differences + hours moved.
function lockThenNextEngine(quote) {
  const locked = P.lockQuote(quote);
  const read = NEXT.withPricingStatus(NEXT.recomputeQuotePricing(locked));
  const diffs = [];
  let frozen = 0, hoursMoved = 0;
  for (const [room, r] of Object.entries(locked.rooms || {})) {
    (r.items || []).forEach((it, i) => {
      const after = read.rooms[room].items[i];
      if (priced(it)) frozen++;
      if (json(after.pricing) !== json(it.pricing)) diffs.push(`${room}[${i}] pricing`); // unpriced items stay unpriced too
      if (after.hours && after.hours.changed) hoursMoved++;
    });
  }
  if (json(NEXT.quoteTotals(read)) !== json(P.quoteTotals(locked))) diffs.push('quoteTotals');
  if (json(NEXT.quoteGrandTotal(read)) !== json(P.quoteGrandTotal(locked))) diffs.push('grandTotal');
  return { diffs, frozen, hoursMoved, read, locked };
}

// A painted kitchen with every money path: cabinets, doors, end panel, frame, custom, WRP,
// project costs and design time.
const sampleQuote = () => {
  const items = [
    { type: 'cabinet', qty: 2, params: { widthMm: 600, heightMm: 770, depthMm: 560, doorCount: 2, doorType: 'SHAKER_PNT', carcassMaterialKey: 'MAT_MDF_FH_18', carcassFinish: 'paint', frameKey: 'FRAME_MDF_PNT' } },
    { type: 'cabinet', qty: 1, params: { widthMm: 950, heightMm: 770, depthMm: 560, doorCount: 0, drawerCount: 3, doorType: 'SHAKER_PNT', carcassMaterialKey: 'MAT_BIRCH_UNF_18' } },
    { type: 'door', qty: 2, params: { doorType: 'SHAKER_PNT', widthMm: 598, heightMm: 764 } },
    { type: 'endpanel', qty: 1, params: { materialKey: 'MAT_MDF_FH_18', widthMm: 560, heightMm: 900, finishType: 'paint' } },
    { type: 'custom', qty: 1, params: { unitCostExVAT: 300 } },
    { type: 'wrp_moulding', qty: 1, params: { wrp_price_per_metre: 10, linear_metres: 5, markup_pct: 35, dimensions: '55mm x 52mm', finishType: 'paint' } },
  ].map(it => ({ ...it, pricing: P.priceItem(it) }));
  return { id: 'QTEST', rooms: { Kitchen: { items, includeDesignTime: true } }, projectCosts: P.getDefaultProjectCosts() };
};

// ─── the simulated change bites ──────────────────────────────────────────────
test('control: the simulated next engine moves an UNLOCKED quote\'s price', () => {
  const q = sampleQuote();
  assert.notEqual(NEXT.quoteGrandTotal(NEXT.recomputeQuotePricing(q)).totalSellExVAT, P.quoteGrandTotal(q).totalSellExVAT);
});

test('locked quote: prices + totals identical under the next engine, hours.current moves', () => {
  const { diffs, frozen, hoursMoved, read } = lockThenNextEngine(sampleQuote());
  assert.deepEqual(diffs, []);
  assert.equal(frozen, 6);
  assert.ok(hoursMoved > 0, 'no item hours moved under the next engine');
  assert.ok(read.hoursCheck.deltaHrs > 0, 'hoursCheck should show more work than priced');
  assert.equal(read.pricingMixed, false);
  const door = read.rooms.Kitchen.items[2].hours;
  assert.ok(door.current.finishHrs > door.priced.finishHrs && door.changed === true);
});

test('editing one item on a locked quote prices it at current rates and flags the quote mixed', () => {
  const locked = P.lockQuote(sampleQuote());
  const items = locked.rooms.Kitchen.items.slice();
  const edited = { ...items[2], params: { ...items[2].params, widthMm: 498 } };
  items[2] = { ...edited, pricing: NEXT.priceItem(edited) };   // the UI reprices the edited item
  const q = NEXT.withPricingStatus({ ...locked, rooms: { Kitchen: { ...locked.rooms.Kitchen, items } } });
  assert.equal(q.pricingMixed, true);
  assert.equal(json(q.rooms.Kitchen.items[0].pricing), json(locked.rooms.Kitchen.items[0].pricing)); // untouched item frozen
});

test('margin change on a locked quote rescales frozen costs (WRP / fixed-price untouched)', () => {
  const locked = P.lockQuote(sampleQuote());
  const r = NEXT.rescaleMargin(locked, 1.6);
  r.rooms.Kitchen.items.forEach((it, i) => {
    const was = locked.rooms.Kitchen.items[i].pricing;
    assert.equal(it.pricing.totalCost, was.totalCost);
    if (it.type === 'wrp_moulding') assert.equal(json(it.pricing), json(was));
    else assert.ok(Math.abs(it.pricing.totalSellExVAT - was.totalCost * 1.6) < 1e-9);
  });
});

test('locked quote: an unpriced item is never priced on read; locking fills it once', () => {
  const q = sampleQuote();
  q.rooms.Kitchen.items.push({ type: 'door', qty: 1, params: { doorType: 'SHAKER_PNT', widthMm: 400, heightMm: 700 } });
  assert.equal(NEXT.recomputeQuotePricing(P.lockQuote(q)).rooms.Kitchen.items[6].pricing, undefined);
  const filled = P.recomputeQuotePricing(q, { onlyUnpriced: true });
  assert.ok(priced(filled.rooms.Kitchen.items[6]));
  assert.equal(json(filled.rooms.Kitchen.items[0].pricing), json(q.rooms.Kitchen.items[0].pricing));
});

// ─── shared settings ─────────────────────────────────────────────────────────
test('settings are a diff from the defaults: a new engine default still applies where not overridden', () => {
  try {
    NEXT.applySettings({ settings: { surveyFee: 300 } });
    assert.equal(NEXT.DB.settings.surveyFee, 300);
    assert.equal(NEXT.DB.settings.labourRate, 40); // the next engine's own default, not a frozen copy of today's
    assert.deepEqual(NEXT.settingsDiff(), { settings: { surveyFee: 300 } });
  } finally { NEXT.applySettings({}); }
  assert.deepEqual(NEXT.settingsDiff(), {});
});

test('settings diffs are validated: known keys, same type as the default, finite numbers', () => {
  assert.deepEqual(P.validateSettings({ settings: { labourRate: 35, sprayFinish: { techLabourRate: 26 } }, materials: { MAT_MDF_FH_18: { costPerM2: 18 } } }), []);
  for (const bad of [{ settings: { labourRate: '30' } }, { settings: { labourRate: NaN } }, { doorTypes: null },
    { settings: { sprayFinish: null } }, { settings: { nope: 1 } }, { materials: { MAT_NOPE: { costPerM2: 1 } } }, [], null]) {
    assert.ok(P.validateSettings(bad).length > 0, `should reject ${json(bad)}`);
  }
});

// ─── server write guard ──────────────────────────────────────────────────────
test('server: a locked row accepts only lock-aware writes that carry the lock', () => {
  const { guardWrite } = require(path.join(__dirname, '..', 'server.js'));
  const locked = P.lockQuote(sampleQuote()), lock = locked.pricingLock;
  const loadedBeforeLock = { ...locked, pricingLock: undefined };
  assert.ok(guardWrite(loadedBeforeLock, lock, true).reject, 'copy loaded before the lock is refused');
  assert.ok(guardWrite(locked, lock, false).reject, 'old code (no X-Pricing-Engine) is refused even with the lock attached');
  assert.ok(guardWrite({ ...locked, pricingLock: true }, lock, true).reject, 'a lock without settings is not a lock');
  assert.equal(guardWrite(locked, lock, true).data, locked);
  assert.equal(guardWrite(loadedBeforeLock, null, false).data, loadedBeforeLock, 'stored unlocked → written as sent');
  const created = guardWrite({ id: 'QNEW', rooms: { R: { items: [{ type: 'door', qty: 1, params: { doorType: 'SHAKER_PNT', widthMm: 500, heightMm: 720 } }] } } }, undefined, false).data;
  assert.ok(P.isPricingLock(created.pricingLock) && priced(created.rooms.R.items[0]), 'new quote → priced + locked');
});

// ─── migration dry-run helpers ───────────────────────────────────────────────
test('settings drift: inference recovers the rates a browser priced with, and when', () => {
  const at = it => ({ ...it, pricing: P.priceItem(it) });
  const mk = (ref, date) => ({ updated_at: date, data: { ref, rooms: { R: { items: [
    { type: 'door', qty: 1, params: { doorType: 'SHAKER_PNT', widthMm: 500, heightMm: 720 } },
    { type: 'cabinet', qty: 1, params: { widthMm: 600, heightMm: 770, depthMm: 560, doorCount: 2, doorType: 'SHAKER_PNT', carcassMaterialKey: 'MAT_BIRCH_UNF_18' } },
  ].map(it => at(it)) } } } });
  const rows = [mk('A', '2026-03-01'), mk('B', '2026-04-01')];
  const saved = JSON.parse(JSON.stringify(P.DB.settings));
  try {
    Object.assign(P.DB.settings, { margin: 2.25, labourRate: 50 });
    P.DB.settings.sprayFinish.techLabourRate = 28;
    rows.push(mk('C', '2026-05-01'), mk('D', '2026-06-01'));
  } finally { P.DB.settings = saved; }
  const { settings } = inferSettings(rows);
  assert.deepEqual(settings.margin.values.map(g => [g.value, g.from, g.to, g.quotes]), [[2, '2026-03-01', '2026-04-01', 2], [2.25, '2026-05-01', '2026-06-01', 2]]);
  assert.equal(settings.labourPlusOverhead.latestSaved, 87);
  assert.equal(settings.sprayTechRate.latestSaved, 28);
  assert.equal(settings.vat.differsFromDefault, false);
  assert.ok(settings.margin.differsFromDefault && settings.labourPlusOverhead.differsFromDefault);
});

// ─── every saved quote ───────────────────────────────────────────────────────
const SNAP = process.env.QUOTES_SNAPSHOT;
test('regression: every saved quote — prices + totals identical under the next engine, hours move', { skip: !SNAP && 'QUOTES_SNAPSHOT not set' }, () => {
  const quotes = Object.values(JSON.parse(fs.readFileSync(SNAP, 'utf8')));
  let items = 0, frozen = 0, hoursMoved = 0, quotesHoursMoved = 0, unlockedMoved = 0;
  const diffs = [];
  for (const q of quotes) {
    const r = lockThenNextEngine(q);
    items += Object.values(q.rooms || {}).reduce((n, room) => n + (room.items || []).length, 0);
    frozen += r.frozen; hoursMoved += r.hoursMoved;
    if (r.read.hoursCheck && r.read.hoursCheck.deltaHrs !== 0) quotesHoursMoved++;
    r.diffs.forEach(d => diffs.push(`${q.ref || q.id}: ${d}`));
    if (NEXT.quoteGrandTotal(NEXT.recomputeQuotePricing(q)).totalSellExVAT !== P.quoteGrandTotal(q).totalSellExVAT) unlockedMoved++;
  }
  console.log(`[price-lock regression] ${quotes.length} quotes, ${items} items (${frozen} with a stored price, frozen): ` +
    `${diffs.length} price/total differences; hours.current moved on ${hoursMoved} items in ${quotesHoursMoved} quotes; ` +
    `control: ${unlockedMoved} quotes would have changed price unlocked`);
  assert.deepEqual(diffs, []);
  assert.ok(hoursMoved > 0 && unlockedMoved > 0);
});

test('migration dry run on the snapshot: saved = served for every quote, and no false settings drift', { skip: !SNAP && 'QUOTES_SNAPSHOT not set' }, () => {
  const quotes = Object.values(JSON.parse(fs.readFileSync(SNAP, 'utf8')));
  const differ = quotes.map(analyseQuote).filter(a => a.differs).map(a => a.ref);
  assert.deepEqual(differ, []);
  // A served snapshot is priced entirely at the defaults, so nothing may read as drift
  // (guards against rounding noise and edge-polish items with no booth time).
  const { settings } = inferSettings(quotes.map(q => ({ data: q, updated_at: q.updated_at || q._serverUpdatedAt })));
  for (const [key, s] of Object.entries(settings)) assert.equal(s.differsFromDefault, false, `${key}: ${json(s.values)}`);
});
