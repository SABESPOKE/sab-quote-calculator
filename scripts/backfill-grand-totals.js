// ───────────────────────────────────────────────────────────────────────────────
// backfill-grand-totals.js — one-off backfill of the persisted quote grand total.
//
// Adds `totalSellExVAT` / `totalSellIncVAT` to every stored quote using the SAME
// canonical total function the calculator UI uses (pricing.js → quoteGrandTotal),
// so existing quotes — especially anything already marked "sold" — gain the field
// the downstream client portal reads.
//
// PURELY ADDITIVE & SAFE:
//   • Only the two total fields are written; stored rooms/items/projectCosts are
//     preserved byte-for-byte (the total is computed from a fresh in-memory
//     recompute, exactly matching what GET /api/quotes serves, but the recomputed
//     item pricing is NOT written back).
//   • `updated_at` is left untouched, so timestamp-based sync conflict resolution
//     is not disturbed and a backfilled quote can't "win" over a newer client edit.
//   • Idempotent: a quote whose stored totals already match is skipped.
//
// Usage:
//   node scripts/backfill-grand-totals.js --dry-run   # preview, write nothing
//   node scripts/backfill-grand-totals.js             # apply
//
// Requires DATABASE_URL in the environment (same var the server uses).
// ───────────────────────────────────────────────────────────────────────────────
const path = require('path');
const { pool } = require(path.join(__dirname, '..', 'db'));
const { recomputeQuotePricing, quoteGrandTotal } = require(path.join(__dirname, '..', 'public', 'pricing.js'));

const DRY_RUN = process.argv.includes('--dry-run');

const gbp = n => `£${(Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  if (!pool) {
    console.error('No DATABASE_URL set — nothing to backfill (the app runs on localStorage only without a database).');
    process.exit(1);
  }
  if (typeof quoteGrandTotal !== 'function') {
    console.error('pricing.js did not export quoteGrandTotal — aborting.');
    process.exit(1);
  }

  console.log(`\n[backfill] ${DRY_RUN ? 'DRY RUN — no writes' : 'APPLYING changes'}\n`);

  const { rows } = await pool.query('SELECT id, data FROM quotes ORDER BY updated_at DESC');
  let updated = 0, skipped = 0, failed = 0;

  for (const row of rows) {
    const data = row.data || {};
    const ref = data.ref || row.id;
    const client = data.client || '';
    try {
      // Compute the grand total from freshly-recomputed item pricing so it matches
      // what GET /api/quotes serves — but only persist the total fields.
      const recomputed = recomputeQuotePricing(data);
      const { totalSellExVAT, totalSellIncVAT } = quoteGrandTotal(recomputed);

      const unchanged =
        data.totalSellExVAT === totalSellExVAT &&
        data.totalSellIncVAT === totalSellIncVAT;
      if (unchanged) {
        skipped++;
        console.log(`  = ${ref}${client ? ` (${client})` : ''} — already ${gbp(totalSellExVAT)} ex VAT`);
        continue;
      }

      const before = data.totalSellExVAT != null ? gbp(data.totalSellExVAT) : '—';
      console.log(`  ${DRY_RUN ? '·' : '✓'} ${ref}${client ? ` (${client})` : ''}: ${before} → ${gbp(totalSellExVAT)} ex VAT  (${gbp(totalSellIncVAT)} inc VAT)`);

      if (!DRY_RUN) {
        // Layer the two fields on top of the existing data; leave updated_at alone.
        const newData = { ...data, totalSellExVAT, totalSellIncVAT };
        await pool.query('UPDATE quotes SET data = $1 WHERE id = $2', [JSON.stringify(newData), row.id]);
      }
      updated++;
    } catch (err) {
      failed++;
      console.error(`  ✗ ${ref}${client ? ` (${client})` : ''}: ${err.message}`);
    }
  }

  console.log(`\n[backfill] ${rows.length} quote(s): ${updated} ${DRY_RUN ? 'would be updated' : 'updated'}, ${skipped} already current, ${failed} failed.\n`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[backfill] fatal:', err.stack || err.message);
  process.exit(1);
});
