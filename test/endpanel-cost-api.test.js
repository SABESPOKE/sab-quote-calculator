// Tests for POST /api/endpanel-cost (the configurator's end-panel endpoint — a fridge
// surround's two sides). Parity: the API's result must equal
// priceItem({ type:'endpanel', qty, params }) to the penny. Run: `npm test`.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Auth must be ON for these tests (the server bypasses auth when APP_PASSWORD is unset).
process.env.APP_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-secret';
process.env.API_TOKEN = 'test-bearer-token';
delete process.env.DATABASE_URL; // never touch a real DB from tests

const SERVER = path.join(__dirname, '..', 'server.js');
const app = require(SERVER);
const P = require(path.join(__dirname, '..', 'public', 'pricing.js'));

let server, base;
before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => server.close(resolve)));

const AUTH = { authorization: `Bearer ${process.env.API_TOKEN}` };
const post = async (body, headers = AUTH, at = base) => {
  const res = await fetch(`${at}/api/endpanel-cost`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
};
const wire = o => JSON.parse(JSON.stringify(o));

// What quoteCalcMapping.mapSpecToEngineItems emits for a 600 × 2100 × 560 fridge surround
// in the configurator's default carcass board (birch_prelac → MAT_BIRCH_PREF_18, finish 'none'):
// each side = depth × housing height, 18 mm, one face, qty 2.
const PANEL = { materialKey: 'MAT_BIRCH_PREF_18', widthMm: 560, heightMm: 2100, thicknessMm: 18, faces: 1, finishType: 'none', hasStain: false, qty: 2 };

// ─── Parity ──────────────────────────────────────────────────────────────────
test('parity: fridge-surround side panels, qty 2 — equals priceItem to the penny', async () => {
  const { qty, ...params } = PANEL;
  const expected = wire(P.priceItem({ type: 'endpanel', qty, params }));
  const { status, body: got } = await post(PANEL);
  assert.equal(status, 200, JSON.stringify(got));
  assert.ok(Number.isFinite(got.totalCost) && got.totalCost > 0, `totalCost ${got.totalCost}`);
  assert.equal(got.totalCost, expected.totalCost);
  assert.ok(Math.abs(got.totalCost - 2 * got.costPerUnit) < 1e-6, 'totalCost is pre-margin cost × qty');
  assert.ok(got.breakdown && got.breakdown.material > 0 && got.breakdown.labour > 0, 'breakdown included');
  assert.deepEqual(got, expected);
});
test('parity: a sprayed panel (primed MDF, paint, 2 faces) also matches priceItem', async () => {
  const spec = { ...PANEL, materialKey: 'MAT_MDF_FH_18', finishType: 'paint', faces: 2, exposedEdgeCount: 3, qty: 1 };
  const { qty, ...params } = spec;
  const { status, body: got } = await post(spec);
  assert.equal(status, 200, JSON.stringify(got));
  assert.deepEqual(got, wire(P.priceItem({ type: 'endpanel', qty, params })));
});

// ─── Auth (as /api/cabinet-cost) ─────────────────────────────────────────────
test('auth: no token → 401', async () => { assert.equal((await post(PANEL, {})).status, 401); });
test('auth: wrong token → 401', async () => { assert.equal((await post(PANEL, { authorization: 'Bearer nope' })).status, 401); });

// ─── 400: a clear error list, never a guess ──────────────────────────────────
const bad = async (patch, needle) => {
  const spec = { ...PANEL, ...patch };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete spec[k];
  const { status, body } = await post(spec);
  assert.equal(status, 400, JSON.stringify(body));
  assert.ok(Array.isArray(body.errors) && body.errors.some(e => e.includes(needle)), `expected an error mentioning "${needle}", got ${JSON.stringify(body.errors)}`);
};
test('400: unknown materialKey',          () => bad({ materialKey: 'MAT_NOPE' }, 'materialKey'));
test('400: materialKey is required',      () => bad({ materialKey: undefined }, 'materialKey is required'));
test('400: non-positive widthMm',         () => bad({ widthMm: 0 }, 'widthMm'));
test('400: non-positive heightMm',        () => bad({ heightMm: -5 }, 'heightMm'));
test('400: non-positive thicknessMm',     () => bad({ thicknessMm: 0 }, 'thicknessMm'));
test('400: dims as strings are rejected', () => bad({ widthMm: '560' }, 'widthMm'));
test('400: bad faces',                    () => bad({ faces: 'one' }, 'faces'));
test('400: faces out of range',           () => bad({ faces: 3 }, 'faces'));
test('400: bad finishType',               () => bad({ finishType: 'gloss' }, 'finishType'));
test('400: hasStain must be a boolean',   () => bad({ hasStain: 'no' }, 'hasStain'));
test('400: bad qty',                      () => bad({ qty: 0 }, 'qty'));
test('400: bad exposedEdgeCount',         () => bad({ exposedEdgeCount: 9 }, 'exposedEdgeCount'));
test('400: unknown field (engine would silently ignore it)', () => bad({ exposedEdges: 2 }, 'unknown field'));
test('400: non-object body', async () => { assert.equal((await post([1, 2, 3])).status, 400); });

// ─── 503 / 422: boot a second server whose pricing.js is swapped ─────────────
// `stub` is JS for a function (realExports) => replacement exports; it runs in the
// child before server.js loads, so the engine-missing / engine-failing paths are real.
async function withEngine(stub, fn) {
  const code = [
    "const Module = require('module'); const orig = Module.prototype.require;",
    "Module.prototype.require = function (id) { const exp = orig.apply(this, arguments); return String(id).endsWith('pricing.js') ? (" + stub + ")(exp) : exp; };",
    "const s = require(" + JSON.stringify(SERVER) + ").listen(0, '127.0.0.1', () => console.log(s.address().port));",
  ].join('\n');
  const child = spawn(process.execPath, ['-e', code], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', d => { err += d; });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', d => { out += d; const m = out.match(/^(\d+)$/m); if (m) resolve(+m[1]); });
      child.on('exit', c => reject(new Error(`child server exited ${c}: ${err}`)));
      setTimeout(() => reject(new Error('child server did not start: ' + err)), 15000).unref();
    });
    await fn(`http://127.0.0.1:${port}`);
  } finally { child.kill(); }
}
test('503: engine failed to load', () => withEngine('() => { throw new Error("engine broken"); }', async at => {
  const { status, body } = await post(PANEL, AUTH, at);
  assert.equal(status, 503, JSON.stringify(body));
  assert.match(body.error, /not loaded/);
}));
test('422: engine throws', () => withEngine('exp => ({ ...exp, priceItem: () => { throw new Error("boom"); } })', async at => {
  const { status, body } = await post(PANEL, AUTH, at);
  assert.equal(status, 422, JSON.stringify(body));
  assert.match(body.error, /boom/);
}));
test('422: engine returns no cost', () => withEngine('exp => ({ ...exp, priceItem: () => null })', async at => {
  const { status, body } = await post(PANEL, AUTH, at);
  assert.equal(status, 422, JSON.stringify(body));
  assert.match(body.error, /no cost/);
}));

// ─── Keys ────────────────────────────────────────────────────────────────────
test('keys: /api/cabinet-cost/keys still lists materials and now the end-panel fields + finish types', async () => {
  const k = await (await fetch(`${base}/api/cabinet-cost/keys`, { headers: AUTH })).json();
  assert.equal(k.materials.MAT_BIRCH_PREF_18, P.DB.materials.MAT_BIRCH_PREF_18.name); // unchanged
  assert.ok(k.fields.includes('carcassMaterialKey'));                                   // unchanged
  assert.deepEqual([...k.endPanel.fields].sort(), ['exposedEdgeCount', 'faces', 'finishType', 'hasStain', 'heightMm', 'materialKey', 'qty', 'thicknessMm', 'widthMm']);
  assert.ok(k.endPanel.finishTypes.includes('none') && k.endPanel.finishTypes.includes('lacquer'));
});
