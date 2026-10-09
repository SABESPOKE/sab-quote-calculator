// ───────────────────────────────────────────────────────────────────────────────
// lock-quotes.js — one-off: price-lock every existing quote at its LAST-SAVED figures.
//
// After this, no engine or Settings change can move an existing quote's price (see
// pricing.js → PRICE LOCK). The dry run (the default) writes nothing and reports:
//   • per quote: saved total (stored item prices) vs served total (what GET /api/quotes
//     serves today — the current engine recomputing every item);
//   • every SOLD / accepted quote where they differ, with both totals, to check against
//     the PDF / invoice the client received. Those are skipped by --apply unless listed
//     in --confirm (lock at saved) or --use-served (lock at today's served figures);
//   • the Settings drift: the rates/margins implied by each quote's saved breakdowns,
//     against the engine defaults, over time (when Settings were changed, and to what).
//
// Usage:
//   node scripts/lock-quotes.js                         # dry run, writes nothing
//   node scripts/lock-quotes.js --json report.json      # dry run + full report file
//   node scripts/lock-quotes.js --apply --confirm Q1,Q2 [--use-served Q3]
//
// Requires DATABASE_URL. Never touches updated_at (sync conflict resolution is
// undisturbed; the server keeps a stored lock even if a stale client re-saves the
// quote without one). Idempotent: already-locked quotes are skipped.
// ───────────────────────────────────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const P = require(path.join(__dirname, '..', 'public', 'pricing.js'));

const AGREED = new Set(['sold', 'accepted']); // statuses where the client agreed a price
const gbp = n => `£${(Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sell = it => (it && it.pricing && it.pricing.totalSellExVAT) || 0;

// Saved = the stored item prices, locked (items with no valid stored price get priced
// now). Served = today's GET /api/quotes: every item recomputed by the current engine.
function analyseQuote(data) {
  const unlocked = { ...data, pricingLock: undefined };
  const saved = P.recomputeQuotePricing(P.lockQuote(unlocked));
  const served = P.recomputeQuotePricing(unlocked);
  let itemsDiffer = 0, itemsFilled = 0;
  for (const [room, r] of Object.entries(data.rooms || {})) {
    (r.items || []).forEach((it, i) => {
      if (!Number.isFinite(it.pricing && it.pricing.totalCost)) itemsFilled++;
      if (Math.abs(sell(saved.rooms[room].items[i]) - sell(served.rooms[room].items[i])) >= 0.005) itemsDiffer++;
    });
  }
  const savedTotal = P.quoteGrandTotal(saved), servedTotal = P.quoteGrandTotal(served);
  return {
    id: data.id, ref: data.ref || data.id, client: data.client || '', status: data.status || 'active',
    alreadyLocked: !!data.pricingLock, savedTotal, servedTotal,
    storedStamp: data.totalSellExVAT ?? null, itemsDiffer, itemsFilled,
    differs: itemsDiffer > 0 || savedTotal.totalSellExVAT !== servedTotal.totalSellExVAT,
    saved, served,
  };
}

// ─── Settings drift ─────────────────────────────────────────────────────────────
// Each saved item's breakdown shows the rates it was priced with. Per quote, take the
// median implied value of each setting; then group quotes by value over save time.
const median = xs => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const r2 = n => Math.round(n * 100) / 100;

function impliedSettings(data) {
  const v = { margin: [], vat: [], labourPlusOverhead: [], sprayTechRate: [], boothRate: [] };
  for (const r of Object.values(data.rooms || {})) for (const it of r.items || []) {
    const p = it.pricing, b = p && p.breakdown;
    if (!p || !b || it.fixedPrice) continue;
    if (data.marginOverride == null && it.type !== 'wrp_moulding' && p.costPerUnit > 0) v.margin.push(p.sellPerUnit / p.costPerUnit);
    if (p.totalSellExVAT > 0) v.vat.push(p.totalSellIncVAT / p.totalSellExVAT - 1);
    // doors + cabinets only: their hours are unrounded, so cost ÷ hours is the exact rate
    const lab = [[b.labourCost, b.labourHours], [b.carcassLabour, b.assemblyHrs]];
    for (const [cost, hrs] of lab) if (cost > 0 && hrs > 0) { v.labourPlusOverhead.push(cost / hrs); break; }
    const sd = b.sprayDetail;
    if (sd && sd.totalHrs > 0) { if (sd.labourCost > 0) v.sprayTechRate.push(sd.labourCost / sd.totalHrs); v.boothRate.push(sd.boothCost / sd.totalHrs); }
  }
  const out = {};
  for (const [k, xs] of Object.entries(v)) if (xs.length) out[k] = r2(median(xs));
  return out;
}

function inferSettings(rows, defaults = P.DB.settings) {
  const def = {
    margin: defaults.margin, vat: defaults.vat, labourPlusOverhead: defaults.labourRate + defaults.overheadRate,
    sprayTechRate: defaults.sprayFinish.techLabourRate, boothRate: defaults.sprayFinish.boothCostPerHr,
  };
  const perQuote = rows
    .map(({ data, updated_at }) => ({ ref: data.ref || data.id, savedAt: new Date(updated_at).toISOString().slice(0, 10), implied: impliedSettings(data) }))
    .sort((a, b) => a.savedAt.localeCompare(b.savedAt));
  const settings = {};
  for (const key of Object.keys(def)) {
    const groups = new Map(); // implied value → { from, to, quotes }
    for (const q of perQuote) {
      const val = q.implied[key];
      if (val == null) continue;
      const g = groups.get(val) || { value: val, from: q.savedAt, to: q.savedAt, quotes: 0 };
      g.to = q.savedAt; g.quotes++;
      groups.set(val, g);
    }
    const values = [...groups.values()].sort((a, b) => a.from.localeCompare(b.from));
    const latest = perQuote.filter(q => q.implied[key] != null).pop();
    settings[key] = {
      default: r2(def[key]), values,
      latestSaved: latest ? latest.implied[key] : null,              // ≈ what the browser prices with now
      differsFromDefault: values.some(g => g.value !== r2(def[key])),
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

  // Price exactly as the deployed server does: shared Settings (if saved yet) over the defaults.
  try {
    const { rows } = await pool.query("SELECT data FROM settings WHERE id = 'pricing'");
    if (rows.length) { P.applySettings(rows[0].data); console.log('[lock] using the shared Settings saved in the database'); }
    else console.log('[lock] no shared Settings saved yet — using the engine defaults');
  } catch { console.log('[lock] settings table not created yet — using the engine defaults'); }

  console.log(`\n[lock] ${APPLY ? 'APPLYING' : 'DRY RUN — no writes'} · engine ${P.ENGINE_VERSION}\n`);
  const { rows } = await pool.query('SELECT id, data, updated_at FROM quotes ORDER BY updated_at DESC');
  const report = [];
  let locked = 0, skipped = 0, needConfirm = 0, failed = 0;

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
    else if (AGREED.has(a.status) && a.differs && !confirm.has(row.id)) lockAt = null;
    entry.action = lockAt ? `lock at ${lockAt}` : 'NEEDS CONFIRM';
    if (!lockAt) {
      needConfirm++;
      console.log(`  ! ${label}: ${totals} (inc VAT ${gbp(a.savedTotal.totalSellIncVAT)} vs ${gbp(a.servedTotal.totalSellIncVAT)}) — ${a.itemsDiffer} item(s) differ. Check the client's PDF/invoice, then --confirm ${row.id} (saved) or --use-served ${row.id}`);
      continue;
    }
    const mark = APPLY ? '✓' : '·';
    console.log(`  ${mark} ${label}: ${a.differs ? totals + ` (${a.itemsDiffer} item(s) differ)` : `${gbp(a.savedTotal.totalSellExVAT)} ex VAT, saved = served`} → lock at ${lockAt}${a.itemsFilled ? ` · ${a.itemsFilled} unpriced item(s) priced now` : ''}`);
    if (APPLY) {
      const base = lockAt === 'served' ? P.lockQuote(a.served) : a.saved;
      const stored = { ...base, ...P.quoteGrandTotal(base) };
      try { await pool.query('UPDATE quotes SET data = $1 WHERE id = $2', [JSON.stringify(stored), row.id]); }
      catch (err) { failed++; console.error(`  ✗ ${label}: ${err.message}`); continue; }
    }
    locked++;
  }

  const drift = inferSettings(rows.map(r => ({ data: r.data || {}, updated_at: r.updated_at })));
  console.log('\n[lock] Settings drift — rates implied by the saved prices (value: first → last save, quotes):');
  for (const [key, s] of Object.entries(drift.settings)) {
    const vals = s.values.map(g => `${g.value} (${g.from} → ${g.to}, ${g.quotes})`).join('; ') || 'no data';
    console.log(`  ${s.differsFromDefault ? '≠' : '='} ${key}: default ${s.default} · saved ${vals} · latest save ${s.latestSaved ?? '—'}`);
  }

  const json = arg('--json');
  if (json) { fs.writeFileSync(json, JSON.stringify({ quotes: report, drift }, null, 2)); console.log(`\n[lock] full report → ${json}`); }
  console.log(`\n[lock] ${rows.length} quote(s): ${locked} ${APPLY ? 'locked' : 'would be locked'}, ${skipped} already locked, ${needConfirm} sold/accepted need your confirm, ${failed} failed.\n`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

module.exports = { analyseQuote, impliedSettings, inferSettings };
if (require.main === module) main().catch(err => { console.error('[lock] fatal:', err.stack || err.message); process.exit(1); });
