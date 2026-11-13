// The Margin page's figures (pricing.js → quoteMargin). Display only. Steve, 13 Nov 2026: until real costs are recorded
// against the add-ons, every project line is assumed to cost 50% of its charge; an actual cost recorded on the quote
// (quote.actualCosts) replaces the assumption on its own line. Nothing here may move a price, a total or the quote.
// Run: `npm test`. (The page itself: the margin-page UI test in test/locked-quotes.test.js.)
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require(path.join(__dirname, '..', 'public', 'pricing.js'));
const near = (a, b) => Math.abs(a - b) < 1e-6;
const clone = o => JSON.parse(JSON.stringify(o));

const priced = (type, params, qty = 1) => { const it = { type, qty, description: type, params }; return { ...it, pricing: P.priceItem(it) }; };
const ITEMS = () => [
  priced('cabinet', { widthMm: 600, heightMm: 720, depthMm: 560, carcassMaterialKey: 'MAT_MEL_EGGER_18', doorCount: 1, doorType: 'SHAKER_PNT', shelfCount: 1, hingeKey: 'HW_HINGE_SM', handleKey: 'HW_HDL_NONE' }, 2),
  priced('endpanel', { materialKey: 'MAT_MDF_FH_18', widthMm: 560, heightMm: 900 }),
];
const QUOTE = () => P.lockQuote({ id: 'Q1', client: 'Test', ref: 'T-1', rooms: { Kitchen: { items: ITEMS() } },
  projectCosts: { ...P.getDefaultProjectCosts(), includeInstall: true, installDaysByRoom: { Kitchen: 3 }, includeContingency: true, includeWarranty: true } });
const KEYS = ['mfg', 'design', 'survey', 'install', 'delivery', 'pm', 'consumables', 'contingency', 'warranty'];
const line = (m, key) => m.lines.find(l => l.key === key);

test('every line of the total: manufacturing at its real cost, every add-on assumed at 50% of its charge', () => {
  const q = QUOTE(), t = P.quoteTotals(q), m = P.quoteMargin(q);
  assert.deepEqual(m.lines.map(l => l.key), KEYS);
  assert.ok(near(m.lines.reduce((s, l) => s + l.charged, 0), t.totalExVAT), 'the lines add up to the total ex VAT');
  assert.deepEqual([line(m, 'mfg').charged, line(m, 'mfg').cost, line(m, 'mfg').basis], [t.mfgSellExVAT, t.mfgCost, 'engine']);
  for (const key of KEYS.slice(1)) {
    const l = line(m, key);
    assert.ok(l.charged > 0, `${key} is charged on this quote`);
    assert.deepEqual([l.basis, l.actualCost], ['assumed', null], key);
    assert.ok(near(l.cost, l.charged / 2) && near(l.margin, l.charged / 2), key);
  }
  const addOns = t.totalExVAT - t.mfgSellExVAT;
  assert.ok(near(m.grossMargin.amount, t.totalExVAT - t.mfgCost - addOns / 2));
  assert.ok(near(m.grossMargin.pct, m.grossMargin.amount / t.totalExVAT));
  assert.ok(near(m.grossMargin.amount, m.lines.reduce((s, l) => s + l.margin, 0)), 'the headline is the sum of the lines\' margins');
  assert.equal(m.withActual, null, 'no actual costs, no second figure');
  assert.equal(m.mfgProfit, t.mfgSellExVAT - t.mfgCost, 'manufacturing profit is today\'s "Gross Profit"');
  // At ×2 with no own-markup lines, the assumption makes the headline exactly half the total.
  assert.ok(near(m.grossMargin.pct, 0.5));
  assert.deepEqual([m.totalExVAT, m.vat, m.totalIncVAT], [t.totalExVAT, t.vat, t.totalIncVAT]);
});

test('an actual cost replaces the assumption on its own line, and a second figure appears', () => {
  const q = QUOTE(), before = P.quoteMargin(q);
  q.actualCosts = { install: 500, pm: 0 };
  const m = P.quoteMargin(q);
  assert.deepEqual([line(m, 'install').basis, line(m, 'install').cost, line(m, 'install').assumedCost], ['actual', 500, line(before, 'install').assumedCost]);
  assert.deepEqual([line(m, 'pm').basis, line(m, 'pm').cost], ['actual', 0], 'a recorded £0 is a cost, not a blank');
  for (const key of KEYS.filter(k => !['install', 'pm'].includes(k))) assert.deepEqual(line(m, key), line(before, key), key);
  assert.deepEqual(m.grossMargin, before.grossMargin, 'the assumed figure never uses actual costs');
  assert.ok(near(m.withActual.amount, m.totalExVAT - m.lines.reduce((s, l) => s + l.cost, 0)));
  assert.ok(near(m.withActual.amount - before.grossMargin.amount, (line(before, 'install').assumedCost - 500) + line(before, 'pm').assumedCost));
});

test('a blank, negative or non-number actual cost is ignored; manufacturing has no actual cost', () => {
  const q = QUOTE(), before = P.quoteMargin(q);
  q.actualCosts = { install: -5, survey: '100', delivery: NaN, design: null, mfg: 1 };
  const m = P.quoteMargin(q);
  assert.deepEqual(m, before);
});

test('display only: no price, total, hour or lock moves, and the quote is not changed', () => {
  const q = QUOTE(), withCosts = { ...clone(q), actualCosts: { install: 500, warranty: 10 } };
  const snapshot = clone(withCosts);
  P.quoteMargin(withCosts);
  assert.deepEqual(withCosts, snapshot, 'quoteMargin does not change the quote');
  assert.deepEqual(P.quoteTotals(withCosts), P.quoteTotals(q));
  assert.deepEqual(P.quoteGrandTotal(withCosts), P.quoteGrandTotal(q));
  assert.strictEqual(P.recomputeQuotePricing(withCosts), withCosts, 'a locked quote is never repriced');
  const { pricingLock, ...open } = withCosts, { pricingLock: _, ...openQ } = q;
  assert.deepEqual(P.recomputeQuotePricing(open).rooms, P.recomputeQuotePricing(openQ).rooms, 'an unlocked one prices the same');
  assert.deepEqual(P.withPricingStatus(withCosts).hoursCheck, P.withPricingStatus(q).hoursCheck);
});

test('a price-locked quote is read with its own settings, not the current ones', () => {
  const was = P.DB.settings.margin;
  let q;
  try { P.DB.settings.margin = 2.4; q = P.lockQuote({ id: 'Q2', rooms: { Kitchen: { items: ITEMS() } }, projectCosts: { ...P.getDefaultProjectCosts(), includeInstall: true, installDaysByRoom: { Kitchen: 1 } } }); }
  finally { P.DB.settings.margin = was; }
  const m = P.quoteMargin(q), mfg = line(m, 'mfg');
  assert.ok(near(mfg.charged, mfg.cost * 2.4), 'manufacturing at the locked ×2.4');
  assert.ok(near(line(m, 'install').charged, 1 * P.DB.settings.installDayRate * 2.4), 'installation doubled at the locked ×2.4 too');
  assert.ok(m.grossMargin.pct > 0.5);
});

test('a website order: its paid total, its items\' cost; no add-ons', () => {
  const order = P.onOrderCreate(clone(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'website-order.json'), 'utf8'))));
  const m = P.quoteMargin(order), cost = Object.values(order.rooms).flatMap(r => r.items).reduce((s, i) => s + i.pricing.totalCost, 0);
  assert.deepEqual([m.totalExVAT, line(m, 'mfg').charged], [order.paid.exVat, order.paid.exVat]);
  assert.ok(KEYS.slice(1).every(k => line(m, k).charged === 0));
  assert.ok(near(m.grossMargin.amount, order.paid.exVat - cost));
});
