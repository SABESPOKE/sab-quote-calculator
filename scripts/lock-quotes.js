// ───────────────────────────────────────────────────────────────────────────────
// lock-quotes.js — one-off: price-lock every existing quote at its LAST-SAVED figures.
//
// After this, no engine or Settings change can move an existing quote's price (see
// pricing.js → PRICE LOCK). The dry run (the default) writes nothing and reports:
//   • per quote: saved total (stored item prices) vs served total (what GET /api/quotes
//     serves today — the current engine recomputing every item);
//   • every SOLD / accepted quote where they differ — or where the total it would lock
//     at differs from the total stamped at its last save — to check against the PDF /
//     invoice the client received. Those are skipped by --apply unless listed in
//     --confirm (lock at saved) or --use-served (lock at today's served figures);
//   • the Settings each lock captures (the shared Settings row; --apply refuses to run
//     without one unless --defaults is given);
//   • the Settings drift: the rates/margins implied by each quote's saved breakdowns,
//     against the engine defaults, over time (when Settings were changed, and to what).
//
// Usage:
//   node scripts/lock-quotes.js                         # dry run, writes nothing
//   node scripts/lock-quotes.js --json report.json      # dry run + full report file
//   node scripts/lock-quotes.js --apply --confirm Q1,Q2 [--use-served Q3] [--defaults]
//
// Requires DATABASE_URL. Never touches updated_at, and a row saved during the run is
// left for a re-run (the write checks updated_at). After locking, the server refuses
// writes that would drop the lock or come from old code. Idempotent: already-locked
// quotes are skipped.
// ───────────────────────────────────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const P = require(path.join(__dirname, '..', 'public', 'pricing.js'));

const AGREED = new Set(['sold', 'accepted']); // statuses where the client agreed a price
const gbp = n => `£${(Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sell = it => (it && it.pricing && it.pricing.totalSellExVAT) || 0;

// Saved = the stored item prices, locked (items with no valid stored price are priced
// now, once). Served = today's GET /api/quotes: every item recomputed by the current engine.
function analyseQuote(data) {
  const unlocked = { ...data, pricingLock: undefined };
  const saved = P.lockQuote(P.recomputeQuotePricing(unlocked, { onlyUnpriced: true }));
  const served = P.recomputeQuotePricing(unlocked);
  let itemsDiffer = 0, itemsFilled = 0;
  for (const [room, r] of Object.entries(data.rooms || {})) {
    (r.items || []).forEach((it, i) => {
      if (!Number.isFinite(it.pricing && it.pricing.totalCost)) itemsFilled++;
      if (Math.abs(sell(saved.rooms[room].items[i]) - sell(served.rooms[room].items[i])) >= 0.005) itemsDiffer++;
    });
  }
  const savedTotal = P.quoteGrandTotal(saved), servedTotal = P.quoteGrandTotal(served);
  const storedStamp = data.totalSellExVAT ?? null;
  return {
    id: data.id, ref: data.ref || data.id, client: data.client || '', status: data.status || 'active',
    alreadyLocked: P.isPricingLock(data.pricingLock), savedTotal, servedTotal, storedStamp, itemsDiffer, itemsFilled,
    differs: itemsDiffer > 0 || savedTotal.totalSellExVAT !== servedTotal.totalSellExVAT,
    // The total it would lock at ≠ the total stamped at its last save: catches Settings
    // drift on project-level costs (survey, design rate…) that item prices can't show.
    stampDiffers: storedStamp != null && Math.abs(savedTotal.totalSellExVAT - storedStamp) >= 0.01,
    saved, served,
  };
}

// ─── Settings drift ─────────────────────────────────────────────────────────────
// Each saved item's breakdown shows the rates it was priced with. Per quote, take the
// median implied value of each setting; then group quotes by value over save time.
const median = xs => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const r2 = n => Math.round(n * 100) / 100;
const r1 = n => Math.round(n * 10) / 10; // spray £/hr come from 2dp costs ÷ 3dp hours

function impliedSettings(data) {
  const v = { margin: [], vat: [], labourPlusOverhead: [], sprayTechRate: [], boothRate: [] };
  for (const r of Object.values(data.rooms || {})) for (const it of (r && r.items) || []) {
    const p = it && it.pricing, b = p && p.breakdown;
    if (!p || !b || it.fixedPrice) continue;
    if (data.marginOverride == null && it.type !== 'wrp_moulding' && p.costPerUnit > 0) v.margin.push(p.sellPerUnit / p.costPerUnit);
    if (p.totalSellExVAT > 0) v.vat.push(p.totalSellIncVAT / p.totalSellExVAT - 1);
    // doors + cabinets only: their hours are unrounded, so cost ÷ hours is the exact rate
    const lab = [[b.labourCost, b.labourHours], [b.carcassLabour, b.assemblyHrs]];
    for (const [cost, hrs] of lab) if (cost > 0 && hrs > 0) { v.labourPlusOverhead.push(cost / hrs); break; }
    const sd = b.sprayDetail;
    if (sd && sd.totalHrs > 0) {
      if (sd.labourCost > 0) v.sprayTechRate.push(sd.labourCost / sd.totalHrs);
      if (sd.boothCost > 0) v.boothRate.push(sd.boothCost / sd.totalHrs); // edge polish has no booth time
    }
  }
  const out = {};
  for (const [k, xs] of Object.entries(v)) if (xs.length) out[k] = (k === 'sprayTechRate' || k === 'boothRate' ? r1 : r2)(median(xs));
  return out;
}

function inferSettings(rows, defaults = P.DB.settings) {
  const def = {
    margin: defaults.margin, vat: defaults.vat, labourPlusOverhead: defaults.labourRate + defaults.overheadRate,
    sprayTechRate: defaults.sprayFinish.techLabourRate, boothRate: defaults.sprayFinish.boothCostPerHr,
  };
  const perQuote = rows
    .map(({ data, updated_at }) => ({ ref: (data && (data.ref || data.id)) || '', savedAt: new Date(updated_at).toISOString(), implied: impliedSettings(data || {}) }))
    .sort((a, b) => a.savedAt.localeCompare(b.savedAt)); // full timestamp, so "latest" is truly the last save
  const settings = {};
  for (const key of Object.keys(def)) {
    const groups = new Map(); // implied value → { from, to, quotes }
    for (const q of perQuote) {
      const val = q.implied[key];
      if (val == null) continue;
      const day = q.savedAt.slice(0, 10);
      const g = groups.get(val) || { value: val, from: day, to: day, quotes: 0 };
      g.to = day; g.quotes++;
      groups.set(val, g);
    }
    const values = [...groups.values()].sort((a, b) => a.from.localeCompare(b.from));
    const latest = perQuote.filter(q => q.implied[key] != null).pop();
    const dflt = (key === 'sprayTechRate' || key === 'boothRate' ? r1 : r2)(def[key]);
    settings[key] = {
      default: dflt, values,
      latestSaved: latest ? latest.implied[key] : null,              // ≈ what the browser prices with now
      differsFromDefault: values.some(g => g.value !== dflt),
    };
  }
  return { settings, perQuote };
}

// ─── main ───────────────────────────────────────────────────────────────────────
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const idList = name => new Set((arg(name) || '').split(',').map(s => s.trim()).filter(Boolean));

async function main() {
  const APPLY = process.argv.includes('--apply');
  const confirm = idList('--confirm'), useServed = idList('--use-served');
  const { pool } = require(path.join(__dirname, '..', 'db'));
  if (!pool) { console.error('No DATABASE_URL set — nothing to lock.'); process.exit(1); }

  // Price exactly as the deployed server does: shared Settings (if saved yet) over the
  // defaults. These are also the settings each lock captures for its totals.
  let shared = false;
  try {
    const { rows } = await pool.query("SELECT data FROM settings WHERE id = 'pricing'");
    if (rows.length) {
      const errs = P.validateSettings(rows[0].data);
      if (errs.length) { console.error(`[lock] the shared Settings row is invalid: ${errs.join('; ')}`); process.exit(1); }
      P.applySettings(rows[0].data);
      shared = true;
    }
  } catch { /* settings table not created yet */ }
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k} = ${v}`]);
  const changes = flat(P.settingsDiff());
  console.log(`[lock] Settings used (they become each lock's settings): ${shared ? 'the SHARED Settings saved in the database' : 'the engine DEFAULTS (no shared Settings saved yet)'}`);
  console.log(`[lock]   changed from the defaults: ${changes.length ? '\n         ' + changes.join('\n         ') : 'none'}`);
  if (APPLY && !shared && !process.argv.includes('--defaults')) {
    console.error('\n[lock] Refusing --apply: no shared Settings yet. Open the calculator on the device with the correct Settings first (it uploads them), or pass --defaults to lock with the engine defaults.');
    process.exit(1);
  }

  console.log(`\n[lock] ${APPLY ? 'APPLYING' : 'DRY RUN — no writes'} · engine ${P.ENGINE_VERSION}\n`);
  // updated_at as text: the write below only lands if the row hasn't been saved meanwhile.
  const { rows } = await pool.query('SELECT id, data, updated_at, updated_at::text AS ts FROM quotes ORDER BY updated_at DESC');
  const report = [];
  let locked = 0, skipped = 0, needConfirm = 0, failed = 0, raced = 0;

  for (const row of rows) {
    const data = { id: row.id, ...(row.data || {}) };
    let a;
    try { a = analyseQuote(data); } catch (err) { failed++; console.error(`  ✗ ${data.ref || row.id}: ${err.message}`); continue; }
    const label = `${a.ref}${a.client ? ` (${a.client})` : ''} [${a.status}]`;
    const totals = `saved ${gbp(a.savedTotal.totalSellExVAT)} · served ${gbp(a.servedTotal.totalSellExVAT)} ex VAT`;
    const entry = { id: row.id, ref: a.ref, client: a.client, status: a.status, savedAt: row.updated_at,
      saved: a.savedTotal, served: a.servedTotal, storedStamp: a.storedStamp, itemsDiffer: a.itemsDiffer, itemsFilled: a.itemsFilled };
    report.push(entry);

    if (a.alreadyLocked) { skipped++; entry.action = 'already locked'; console.log(`  = ${label}: already locked`); continue; }
    let lockAt = 'saved';
    if (useServed.has(row.id)) lockAt = 'served';
    else if (AGREED.has(a.status) && (a.differs || a.stampDiffers) && !confirm.has(row.id)) lockAt = null;
    entry.action = lockAt ? `lock at ${lockAt}` : 'NEEDS CONFIRM';
    if (!lockAt) {
      needConfirm++;
      const stamp = a.storedStamp != null ? ` · last stamped ${gbp(a.storedStamp)}` : '';
      console.log(`  ! ${label}: ${totals}${stamp} (inc VAT ${gbp(a.savedTotal.totalSellIncVAT)} vs ${gbp(a.servedTotal.totalSellIncVAT)}) — ${a.itemsDiffer} item(s) differ. Check the client's PDF/invoice, then --confirm ${row.id} (saved) or --use-served ${row.id}`);
      continue;
    }
    const mark = APPLY ? '✓' : '·';
    console.log(`  ${mark} ${label}: ${a.differs ? totals + ` (${a.itemsDiffer} item(s) differ)` : `${gbp(a.savedTotal.totalSellExVAT)} ex VAT, saved = served`} → lock at ${lockAt}${a.itemsFilled ? ` · ${a.itemsFilled} unpriced item(s) priced now` : ''}`);
    if (APPLY) {
      const base = lockAt === 'served' ? P.lockQuote(a.served) : a.saved;
      const stored = { ...base, ...P.quoteGrandTotal(base) };
      try {
        const r = await pool.query('UPDATE quotes SET data = $1 WHERE id = $2 AND updated_at::text = $3', [JSON.stringify(stored), row.id, row.ts]);
        if (r.rowCount === 0) { raced++; entry.action = 'changed during run — not locked'; console.log(`  ~ ${label}: saved by someone during this run — skipped, re-run to lock it`); continue; }
      } catch (err) { failed++; console.error(`  ✗ ${label}: ${err.message}`); continue; }
    }
    locked++;
  }

  let drift = null;
  try {
    drift = inferSettings(rows.map(r => ({ data: r.data || {}, updated_at: r.updated_at })));
    console.log('\n[lock] Settings drift — rates implied by the saved prices (value: first → last save, quotes):');
    for (const [key, s] of Object.entries(drift.settings)) {
      const vals = s.values.map(g => `${g.value} (${g.from} → ${g.to}, ${g.quotes})`).join('; ') || 'no data';
      console.log(`  ${s.differsFromDefault ? '≠' : '='} ${key}: default ${s.default} · saved ${vals} · latest save ${s.latestSaved ?? '—'}`);
    }
  } catch (err) { console.error(`\n[lock] settings-drift report failed: ${err.message}`); }

  const json = arg('--json');
  if (json) { fs.writeFileSync(json, JSON.stringify({ quotes: report, drift }, null, 2)); console.log(`\n[lock] full report → ${json}`); }
  console.log(`\n[lock] ${rows.length} quote(s): ${locked} ${APPLY ? 'locked' : 'would be locked'}, ${skipped} already locked, ${needConfirm} sold/accepted need your confirm, ${raced} changed during the run, ${failed} failed.\n`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

module.exports = { analyseQuote, impliedSettings, inferSettings };
if (require.main === module) main().catch(err => { console.error('[lock] fatal:', err.stack || err.message); process.exit(1); });
