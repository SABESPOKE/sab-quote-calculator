// Tests for POST /api/cabinet-cost + GET /api/cabinet-cost/keys (the configurator's
// cost endpoint). Parity: for configurator-shaped cabinets the API's result must equal
// priceItem({ type:'cabinet', qty, params }) — the exact call the UI makes — so the
// configurator can never see a price the calculator wouldn't. Run: `npm test`.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Auth must be ON for these tests (the server bypasses auth when APP_PASSWORD is unset).
process.env.APP_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-secret';
process.env.API_TOKEN = 'test-bearer-token';
delete process.env.DATABASE_URL; // never touch a real DB from tests

const app = require(path.join(__dirname, '..', 'server.js'));
const P = require(path.join(__dirname, '..', 'public', 'pricing.js'));

let server, base;
before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => server.close(resolve)));

const AUTH = { authorization: `Bearer ${process.env.API_TOKEN}` };
// → { status, body } with the body read once (JSON when parseable, else raw text).
const post = async (body, headers = AUTH) => {
  const res = await fetch(`${base}/api/cabinet-cost`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
};
// JSON round-trip so undefined/NaN in the engine's output compare like the wire format.
const wire = o => JSON.parse(JSON.stringify(o));

// ─── Configurator-shaped cabinets ────────────────────────────────────────────
// These are what quoteCalcMapping.mapSpecToEngineInput() emits: engine-native keys,
// the configurator's FIXED house choices (DRW_BIRCH_PLY, HW_RUN_BLUM_SM, HW_HINGE_SM,
// HW_HDL_NONE, FRAME_NONE, hasStain false, qty 1), painted vs veneer door types by
// material, EDGE_MELAMINE for melamine else EDGE_ABS_PAINT, T_DRESSER for counter-height.
const FIXED = { drawerType: 'DRW_BIRCH_PLY', runnerKey: 'HW_RUN_BLUM_SM', hingeKey: 'HW_HINGE_SM', handleKey: 'HW_HDL_NONE', frameKey: 'FRAME_NONE', hasStain: false, qty: 1 };
const cab = (o) => ({ ...FIXED, edgebandKey: 'EDGE_ABS_PAINT', drawerCount: 0, shelfCount: 1, ...o });
const CABINETS = {
  'base 1-door primed MDF slab':          cab({ widthMm: 500,  heightMm: 770,  depthMm: 560, carcassMaterialKey: 'MAT_MDF_FH_18',       doorCount: 1, doorType: 'SLAB_PNT' }),
  'base 2-door primed MDF shaker':        cab({ widthMm: 1000, heightMm: 770,  depthMm: 560, carcassMaterialKey: 'MAT_MDF_FH_18',       doorCount: 2, doorType: 'SHAKER_PNT' }),
  'base 3-drawer birch, painted fronts':  cab({ widthMm: 600,  heightMm: 770,  depthMm: 560, carcassMaterialKey: 'MAT_BIRCH_PREF_18',   doorCount: 0, doorType: 'SLAB_PNT', drawerCount: 3, shelfCount: 0 }),
  'base open birch, 2 shelves':           cab({ widthMm: 600,  heightMm: 770,  depthMm: 560, carcassMaterialKey: 'MAT_BIRCH_PREF_18',   doorCount: 0, doorType: 'SLAB_PNT', shelfCount: 2 }),
  'wall 1-door oak veneer slab':          cab({ widthMm: 400,  heightMm: 720,  depthMm: 300, carcassMaterialKey: 'MAT_OAK_MDF_PREF_19', doorCount: 1, doorType: 'SLAB_VEN' }),
  'wall 2-door walnut veneer shaker':     cab({ widthMm: 900,  heightMm: 900,  depthMm: 350, carcassMaterialKey: 'MAT_WAL_MDF_PREF_19', doorCount: 2, doorType: 'SHAKER_VEN', shelfCount: 2 }),
  'wall small 1-door melamine':           cab({ widthMm: 300,  heightMm: 360,  depthMm: 300, carcassMaterialKey: 'MAT_MEL_EGGER_18',    doorCount: 1, doorType: 'SLAB_PNT', edgebandKey: 'EDGE_MELAMINE' }),
  'tall larder 1-door birch, 5 shelves':  cab({ widthMm: 600,  heightMm: 2100, depthMm: 560, carcassMaterialKey: 'MAT_BIRCH_PREF_18',   doorCount: 1, doorType: 'SLAB_PNT', shelfCount: 5 }),
  'tall 2-door shaker + 2 drawers':       cab({ widthMm: 1000, heightMm: 2200, depthMm: 600, carcassMaterialKey: 'MAT_MDF_FH_18',       doorCount: 2, doorType: 'SHAKER_PNT', drawerCount: 2, shelfCount: 4 }),
  'tall large oak unfinished, lacquered': cab({ widthMm: 1200, heightMm: 2400, depthMm: 650, carcassMaterialKey: 'MAT_OAK_MDF_UNF_19',  doorCount: 2, doorType: 'SLAB_VEN', shelfCount: 4, carcassFinish: 'lacquer' }),
  'counter-height dresser (T_DRESSER)':   cab({ widthMm: 1200, heightMm: 1400, depthMm: 400, carcassMaterialKey: 'MAT_MDF_FH_18',       doorCount: 2, doorType: 'SHAKER_PNT', shelfCount: 3, cabinetTypeKey: 'T_DRESSER' }),
  'counter-height open shinnoki':         cab({ widthMm: 800,  heightMm: 1400, depthMm: 400, carcassMaterialKey: 'MAT_SHINNOKI_19',     doorCount: 0, doorType: 'SLAB_VEN', shelfCount: 3, cabinetTypeKey: 'T_DRESSER' }),
  'base 2-door with 1 divider (shelf+1)': cab({ widthMm: 1000, heightMm: 770,  depthMm: 560, carcassMaterialKey: 'MAT_MDF_FH_18',       doorCount: 2, doorType: 'SLAB_PNT', shelfCount: 2 }),
  'base 2-door primed-only finish':       cab({ widthMm: 800,  heightMm: 770,  depthMm: 560, carcassMaterialKey: 'MAT_MDF_FH_18',       doorCount: 2, doorType: 'SHAKER_PNT', sprayFinishOverride: 'primed' }),
};

// ─── Parity ──────────────────────────────────────────────────────────────────
for (const [name, spec] of Object.entries(CABINETS)) {
  test(`parity: ${name}`, async () => {
    const { qty, ...params } = spec;
    const expected = wire(P.priceItem({ type: 'cabinet', qty, params }));
    const { status, body: got } = await post(spec);
    assert.equal(status, 200, JSON.stringify(got));
    assert.ok(Number.isFinite(got.totalCost) && got.totalCost > 0, `totalCost ${got.totalCost}`);
    assert.equal(got.totalCost, expected.totalCost);
    assert.deepEqual(got, expected); // whole result: cost, sell, breakdown (incl. hours + bom)
  });
}

test('parity: qty scales the total exactly as priceItem does', async () => {
  const spec = { ...CABINETS['base 2-door primed MDF shaker'], qty: 3 };
  const { qty, ...params } = spec;
  const { status, body: got } = await post(spec);
  assert.equal(status, 200);
  assert.equal(got.totalCost, P.priceItem({ type: 'cabinet', qty, params }).totalCost);
  assert.ok(Math.abs(got.totalCost - 3 * got.costPerUnit) < 1e-6);
});

// ─── Auth ────────────────────────────────────────────────────────────────────
test('auth: no token → 401', async () => {
  assert.equal((await post(CABINETS['base 1-door primed MDF slab'], {})).status, 401);
});
test('auth: wrong token → 401', async () => {
  assert.equal((await post(CABINETS['base 1-door primed MDF slab'], { authorization: 'Bearer nope' })).status, 401);
});
test('auth: keys endpoint is gated too', async () => {
  assert.equal((await fetch(`${base}/api/cabinet-cost/keys`)).status, 401);
  assert.equal((await fetch(`${base}/api/cabinet-cost/keys`, { headers: AUTH })).status, 200);
});

// ─── Validation: a clear 4xx, never a guess ──────────────────────────────────
const bad = async (patch, needle) => {
  const spec = { ...CABINETS['base 1-door primed MDF slab'], ...patch };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete spec[k];
  const { status, body } = await post(spec);
  assert.equal(status, 400, JSON.stringify(body));
  assert.ok(body.errors.some(e => e.includes(needle)), `expected an error mentioning "${needle}", got ${JSON.stringify(body.errors)}`);
};
test('400: missing / non-positive dims',      () => bad({ widthMm: undefined }, 'widthMm'));
test('400: dims as strings are rejected',     () => bad({ heightMm: '770' }, 'heightMm'));
test('400: unknown carcassMaterialKey',       () => bad({ carcassMaterialKey: 'MAT_NOPE' }, 'carcassMaterialKey'));
test('400: carcassMaterialKey is required',   () => bad({ carcassMaterialKey: undefined }, 'carcassMaterialKey is required'));
test('400: unknown doorType',                 () => bad({ doorType: 'GLASS' }, 'doorType'));
test('400: unknown hingeKey (engine would silently default it)', () => bad({ hingeKey: 'HW_HINGE_X' }, 'hingeKey'));
test('400: unknown edgebandKey',              () => bad({ edgebandKey: 'EDGE_X' }, 'edgebandKey'));
test('400: unknown cabinetTypeKey',           () => bad({ cabinetTypeKey: 'B_NOPE' }, 'cabinetTypeKey'));
test('400: unknown field (typo would be silently ignored by the engine)', () => bad({ doorcount: 2 }, 'unknown field'));
test('400: bad carcassFinish',                () => bad({ carcassFinish: 'gloss' }, 'carcassFinish'));
test('400: non-object body', async () => {
  assert.equal((await post([1, 2, 3])).status, 400);
});

// ─── Keys ────────────────────────────────────────────────────────────────────
test('keys: lists every table the mapping needs, with names', async () => {
  const k = await (await fetch(`${base}/api/cabinet-cost/keys`, { headers: AUTH })).json();
  assert.equal(k.materials.MAT_OAK_MDF_PREF_19, P.DB.materials.MAT_OAK_MDF_PREF_19.name);
  assert.equal(k.doorTypes.SHAKER_VEN, P.DB.doorTypes.SHAKER_VEN.name);
  assert.equal(k.drawerTypes.DRW_BIRCH_PLY, P.DB.drawerTypes.DRW_BIRCH_PLY.name);
  assert.ok(k.hardware.runners.HW_RUN_BLUM_SM && k.hardware.hinges.HW_HINGE_SM && k.hardware.handles.HW_HDL_NONE);
  assert.ok(k.frames.FRAME_NONE && k.edgebands.EDGE_ABS_PAINT && k.edgebands.EDGE_MELAMINE);
  assert.ok(k.cabinetTypes.T_DRESSER);
  assert.ok(k.carcassFinishes.includes('lacquer') && k.sprayFinishOverrides.includes('primed'));
  assert.ok(k.fields.includes('carcassMaterialKey'));
  assert.equal(k.settings.margin, P.DB.settings.margin);
});
