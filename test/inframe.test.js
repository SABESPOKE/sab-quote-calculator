// In-frame pricing from the existing rates (Steve, 13 Nov 2026): the optional cabinet param inframeFront.
// Run: `npm test`. The regression half needs git (baseline engine = master before this change).
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');

process.env.APP_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-secret';
process.env.API_TOKEN = 'test-bearer-token';
delete process.env.DATABASE_URL; // never touch a real DB from tests

const P = require(path.join(__dirname, '..', 'public', 'pricing.js'));
const app = require(path.join(__dirname, '..', 'server.js'));

let server, base;
before(async () => { await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${server.address().port}`; });
after(() => new Promise(resolve => server.close(resolve)));
const AUTH = { authorization: `Bearer ${process.env.API_TOKEN}` };
const post = async (body) => {
  const res = await fetch(`${base}/api/cabinet-cost`, { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const wire = o => JSON.parse(JSON.stringify(o));
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// What the configurator sends for a 600 base today (its house choices), and the four in-frame builds.
const CAB = { widthMm: 600, heightMm: 770, depthMm: 560, carcassMaterialKey: 'MAT_BIRCH_PREF_18', carcassFinish: 'none', doorCount: 2, doorType: 'SHAKER_PNT',
  drawerCount: 0, drawerType: 'DRW_SHEET', runnerKey: 'HW_RUN_BLUM_SM', hingeKey: 'HW_HINGE_SM', handleKey: 'HW_HDL_NONE', frameKey: 'FRAME_NONE', edgebandKey: 'EDGE_ABS_PAINT', hasStain: false, shelfCount: 1 };
const TULIP  = { timber: 'tulipwood', thicknessMm: 28, frameMm: 28, hinges: 'butt' };
const OAK    = { timber: 'oak',       thicknessMm: 28, frameMm: 28, hinges: 'butt' };
const OAK_SL = { timber: 'oak',       thicknessMm: 19, frameMm: 20, hinges: 'butt' };
const MDF    = { timber: 'mdf',       thicknessMm: 22, frameMm: 22, hinges: 'blum' };
const cabinet = (o = {}, qty = 1) => P.priceItem({ type: 'cabinet', qty, params: { ...CAB, ...o } });
const bomKeys = r => ({ door: r.breakdown.bom.doors[0].key, frame: r.breakdown.bom.frames[0] && r.breakdown.bom.frames[0].key, hinge: r.breakdown.bom.hardware[0].key });

// ─── Without inframeFront nothing may change (lay-on, and a frame picked in the calculator) ───
const BASE_REF = process.env.BASE_REF || 'f46b99d';
let OLD = null;
try {
  const src = execFileSync('git', ['show', `${BASE_REF}:public/pricing.js`], { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 1 << 24 });
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sab-inframe-base-')), 'pricing.js');
  fs.writeFileSync(tmp, src);
  OLD = require(tmp);
} catch { /* no git / unknown ref → the regression test skips */ }

test('regression: every cabinet without inframeFront prices exactly as the baseline engine', { skip: !OLD && 'baseline engine unavailable (git)' }, () => {
  const items = [];
  // (a cabinet with drawers and no drawerType was the birch ply box, and is the sheet box since the internal-drawers
  // change — test/internal-drawers.test.js; the old default is said out loud so this still compares everything else)
  const cab = (params, qty = 1) => items.push({ type: 'cabinet', qty, params: params.drawerCount && !params.drawerType ? { ...params, drawerType: 'DRW_BIRCH_PLY' } : params });
  for (const doorType of Object.keys(OLD.DB.doorTypes)) for (const frameKey of Object.keys(OLD.FRAME_MATERIALS)) for (const hingeKey of Object.keys(OLD.DB.hardware.hinges))
    cab({ ...CAB, doorType, frameKey, hingeKey, drawerCount: 1, timberSpeciesKey: 'TIM_TUL', frameThicknessMm: 28, frameMemberWidthMm: 32, frameCustomPricePerM3: 3000 });
  for (const sprayFinishOverride of ['', 'primed', 'edge_polish', 'none']) for (const carcassFinish of ['none', 'paint', 'lacquer'])
    cab({ ...CAB, widthMm: 1000, heightMm: 2100, drawerCount: 2, shelfCount: 4, sprayFinishOverride, carcassFinish, frameKey: 'FRAME_TIM_TUL' }, 2);
  for (const [k, t] of Object.entries(OLD.DB.cabinetTypes))   // every catalogue cabinet at its defaults
    cab({ widthMm: t.w, heightMm: t.h, depthMm: t.d, doorCount: t.doors, drawerCount: t.drawers, shelfCount: t.shelves, carcassMaterialKey: 'MAT_BIRCH_UNF_18', cabinetTypeKey: k });
  cab({ widthMm: 600, heightMm: 770, depthMm: 560 });         // engine defaults throughout
  // priceItem without its pricedWith stamp (the engine version moves by design).
  const priced = (E, item) => { const { pricedWith, ...p } = E.priceItem(item); return p; };
  for (const item of items) assert.deepStrictEqual(priced(P, item), priced(OLD, item), JSON.stringify(item.params));
  assert.ok(items.length > 500);
});

// ─── The four builds ─────────────────────────────────────────────────────────
test('painted shaker: solid tulipwood 28 doors in a tulipwood 28 frame on butt hinges, every part at its existing rate', () => {
  const r = cabinet({ inframeFront: TULIP, frameMemberWidthMm: 32 }), b = r.breakdown;
  assert.deepEqual(bomKeys(r), { door: 'SHAKER_TIM_PNT', frame: 'FRAME_TIM_TUL', hinge: 'HW_HINGE_BUTT' });
  // Doors: the engine's own solid-timber shaker door, sized to the opening (600 − 2 × 32 across two, 770 − 2 × 32 − 6).
  const butt = P.DB.hardware.hinges.HW_HINGE_BUTT.costEach;
  const door = P.calcDoorCost({ doorType: 'SHAKER_TIM_PNT', widthMm: 266, heightMm: 700, qty: 2, hingeCost: 2 * butt, handleCost: 0, timberSpeciesKey: 'TIM_TUL', frameThicknessMm: 28 });
  assert.ok(near(b.doors, door.totalCost));
  assert.ok(near(b.bom.doors[0].areaM2, +(0.266 * 0.7 * 2).toFixed(4)));
  // Frame: the engine's own face frame at the tulipwood rate, 28 thick, 32 face.
  assert.equal(b.frame, P.calcCabinetFaceFrameCost({ frameKey: 'FRAME_TIM_TUL', widthMm: 600, heightMm: 770, frameThicknessMm: 28, frameMemberWidthMm: 32 }).total);
  // Frame finish: painted as the doors — its face and reveal at the spray rates.
  const perimM = 2 * (600 + 770) / 1000;
  const spray = P.calcSprayFinishCost({ doorType: null, widthMm: 600, heightMm: 770, finishType: 'paint', surfaceType: 'panel', sprayAreaM2Override: perimM * 0.032, perimMOverride: perimM });
  assert.ok(near(b.frameFinish, spray.costPerDoor) && b.frameFinish > 0);
  assert.equal(b.edgeband, 0);
  // Hanging: 30 minutes a door on butt hinges at the bench rate (DB.settings.buttHingeHangMins), on its own line.
  assert.equal(P.DB.settings.buttHingeHangMins, 30);
  assert.equal(b.hangHrs, 1);
  assert.ok(near(b.hanging, 2 * 0.5 * P.er()));
  // The total is its lines; hours and the spray split include the frame.
  assert.ok(near(r.totalCost, b.carcassMaterial + b.carcassLabour + b.carcassHardware + b.doors + b.drawers + b.drawerFronts + b.frame + b.frameFinish + b.hanging));
  assert.equal(b.totalHrs, +(b.assemblyHrs + b.doorHrs + b.frameHrs + b.finishHrs + b.hangHrs).toFixed(3));
  assert.ok(near(b.finishHrs, b.sprayDetail.parts.door.totalHrs + b.sprayDetail.parts.frame.totalHrs, 1e-3));
  assert.equal(b.sprayDetail.parts.frame.totalHrs, b.frameFinishHrs);
  assert.ok(near(r.totalSellExVAT, r.totalCost * P.DB.settings.margin) && near(r.totalSellIncVAT, r.totalSellExVAT * (1 + P.DB.settings.vat)));
});

test('oak shaker: solid oak, lacquered — the door and the frame take the oak rate', () => {
  const r = cabinet({ doorType: 'SHAKER_VEN', inframeFront: OAK, frameMemberWidthMm: 32 });
  assert.deepEqual(bomKeys(r), { door: 'SHAKER_TIM_LAC', frame: 'FRAME_TIM_OAK', hinge: 'HW_HINGE_BUTT' });
  assert.ok(r.breakdown.sprayDetail.parts.frame.lacquerHrs > 0 && !r.breakdown.sprayDetail.parts.frame.primerHrs);
  assert.ok(r.totalCost > cabinet({ inframeFront: TULIP, frameMemberWidthMm: 32 }).breakdown.doors);
  // The same build spelt out in the engine's own fields, plus the frame's finish: nothing else is in the figure.
  const spelt = cabinet({ doorType: 'SHAKER_TIM_LAC', timberSpeciesKey: 'TIM_OAK', doorFrameThicknessMm: 28, frameKey: 'FRAME_TIM_OAK', frameThicknessMm: 28, frameMemberWidthMm: 32, hingeKey: 'HW_HINGE_BUTT' });
  assert.equal(r.breakdown.frame, spelt.breakdown.frame);
  assert.ok(r.breakdown.doors < spelt.breakdown.doors);   // (the spelt-out doors are lay-on size)
});

test('veneered slab: the 19 veneered door as sent, in a 20 frame of the species, on butt hinges', () => {
  const r = cabinet({ doorType: 'SLAB_VEN', inframeFront: OAK_SL, frameMemberWidthMm: 32 });
  assert.deepEqual(bomKeys(r), { door: 'SLAB_VEN', frame: 'FRAME_TIM_OAK', hinge: 'HW_HINGE_BUTT' });
  assert.equal(r.breakdown.frame, P.calcCabinetFaceFrameCost({ frameKey: 'FRAME_TIM_OAK', widthMm: 600, heightMm: 770, frameThicknessMm: 20, frameMemberWidthMm: 32 }).total);
});

test('painted slab: the 22 MDF door as sent, in the 22 MDF frame, on the Blum hinge sent', () => {
  const r = cabinet({ doorType: 'SLAB_PNT', inframeFront: MDF, frameMemberWidthMm: 32 });
  assert.deepEqual(bomKeys(r), { door: 'SLAB_PNT', frame: 'FRAME_MDF_22', hinge: 'HW_HINGE_SM' });
  assert.equal(r.breakdown.frame, P.calcCabinetFaceFrameCost({ frameKey: 'FRAME_MDF_22', widthMm: 600, heightMm: 770 }).total);
  assert.ok(r.breakdown.frameFinish > 0);
  assert.equal(r.breakdown.hanging, 0);   // Blum hinges: no butt-hinge hanging time
  // Primed only: the frame is primed as the doors are.
  const primed = cabinet({ doorType: 'SLAB_PNT', inframeFront: MDF, sprayFinishOverride: 'primed' }).breakdown.sprayDetail.parts.frame;
  assert.ok(primed.primerHrs > 0 && !primed.topCoatHrs);
});

test('drawer fronts sit in the opening too, the frame member defaults to 30, and qty scales', () => {
  const r = cabinet({ doorCount: 0, drawerCount: 3, shelfCount: 0, inframeFront: TULIP });
  assert.ok(near(r.breakdown.bom.doors[0].areaM2, +(0.536 * ((770 - 60 - 6) / 3 / 1000) * 3).toFixed(4), 1e-3));
  assert.equal(r.breakdown.bom.doors[0].key, 'SHAKER_TIM_PNT');
  assert.equal(r.breakdown.hanging, 0);   // drawers only: nothing hung
  // The calculator's defaults for each build (inframeDefaults) are the four builds above.
  assert.deepEqual([P.inframeDefaults(false, 'tulipwood'), P.inframeDefaults(false, 'oak'), P.inframeDefaults(true, 'oak'), P.inframeDefaults(true, 'mdf')], [TULIP, OAK, OAK_SL, MDF]);
  assert.ok(near(cabinet({ inframeFront: TULIP }, 3).totalCost, 3 * cabinet({ inframeFront: TULIP }).totalCost));
});

// ─── The API ─────────────────────────────────────────────────────────────────
test('API: /api/cabinet-cost prices inframeFront exactly as priceItem does', async () => {
  for (const [doorType, inframeFront] of [['SHAKER_PNT', TULIP], ['SHAKER_VEN', OAK], ['SLAB_VEN', OAK_SL], ['SLAB_PNT', MDF]]) {
    const params = { ...CAB, doorType, inframeFront, frameMemberWidthMm: 32 };
    const { status, body } = await post({ ...params, qty: 1 });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body, wire(P.priceItem({ type: 'cabinet', qty: 1, params })));
  }
});

test('API: a build that is not made in-frame is refused, never guessed', async () => {
  const refused = async (patch, needle) => {
    const { status, body } = await post({ ...CAB, ...patch });
    assert.equal(status, 400, JSON.stringify(body));
    assert.ok(body.errors.some(e => e.includes(needle)), `expected an error mentioning "${needle}", got ${JSON.stringify(body.errors)}`);
  };
  await refused({ inframeFront: { ...TULIP, timber: 'shinnoki' } }, 'inframeFront.timber');
  await refused({ inframeFront: { ...TULIP, hinges: 'concealed' } }, 'inframeFront.hinges');
  await refused({ inframeFront: { ...TULIP, frameMm: '28' } }, 'inframeFront.frameMm');
  await refused({ inframeFront: { timber: 'tulipwood', frameMm: 28, hinges: 'butt' } }, 'inframeFront.thicknessMm');
  await refused({ inframeFront: { ...MDF, frameMm: 28 } }, 'MDF frame');
  await refused({ inframeFront: { ...TULIP, species: 'oak' } }, 'unknown field');
  await refused({ inframeFront: 'tulipwood' }, 'inframeFront must be an object');
  await refused({ inframeFront: TULIP, frameMemberWidthMm: '32' }, 'frameMemberWidthMm');
});

test('API: /api/cabinet-cost/keys lists the field, its timbers and hinges', async () => {
  const k = await (await fetch(`${base}/api/cabinet-cost/keys`, { headers: AUTH })).json();
  assert.ok(k.fields.includes('inframeFront'));
  assert.deepEqual(k.inframeFront, { timbers: ['tulipwood', 'oak', 'walnut', 'maple', 'mdf'], hinges: ['butt', 'blum'] });
});

// ─── The calculator page (public/index.html), in headless Chrome ─────────────
// Needs Chrome (CHROME_PATH), Node 22+ (global WebSocket) and the CDN (React / Babel) — as test/locked-quotes.test.js.
// ponytail: a second copy of that file's little CDP harness; one shared helper if a third UI test ever needs it.
const CHROME = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => fs.existsSync(p));
async function page(url) {
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'sab-chrome-'))}`, 'about:blank']);
  const port = await new Promise((resolve, reject) => {
    let err = '';
    proc.stderr.on('data', d => { err += d; const m = err.match(/ws:\/\/127\.0\.0\.1:(\d+)\//); if (m) resolve(m[1]); });
    proc.on('exit', () => reject(new Error(`chrome exited: ${err}`)));
  });
  const [tab] = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === 'page');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  let n = 0;
  const waiting = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); } });
  const send = (method, params = {}) => new Promise(resolve => { waiting.set(++n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  // Evaluate an expression in the page → its value (JSON round-trip).
  const js = async expr => {
    const r = await send('Runtime.evaluate', { expression: `JSON.stringify(${expr})`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description || r.exceptionDetails.text} in: ${expr.slice(0, 200)}`);
    return r.result.value === undefined ? undefined : JSON.parse(r.result.value);
  };
  // Auth is on in these tests: sign in as the browser does and hand Chrome the session cookie.
  const login = await fetch(`${url}api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: process.env.APP_PASSWORD }) });
  const [name, value] = (login.headers.get('set-cookie') || '').split(';')[0].split(/=(.*)/s);
  await send('Network.setCookie', { name, value, url });
  await send('Page.navigate', { url });
  for (const t0 = Date.now(); !(await js(`typeof applyRoomInframe === 'function' && document.getElementById('root').textContent.includes('Quote Management')`).catch(() => false));) {
    if (Date.now() - t0 > 90000) { ws.close(); proc.kill(); throw new Error('the app never rendered (offline? it loads React/Babel from unpkg)'); }
    await new Promise(r => setTimeout(r, 200));
  }
  return { js, close: () => { ws.close(); proc.kill(); } };
}

test('calculator: a solid-timber door\'s species and thickness reach its price; new cabinets take the room\'s; in-frame applies to a room', {
  skip: (!CHROME && 'Chrome not found (set CHROME_PATH)') || (typeof WebSocket === 'undefined' && 'needs Node 22+ (global WebSocket)'),
  timeout: 180000,
}, async () => {
  const b = await page(`${base}/`);
  try {
    // 1. The Door form (the bug: Steve, 12 Nov — "solid timber shaker, tulipwood, 28, and the price did not change").
    //    The form's params now carry the species and thickness, so the engine prices the door's timber.
    const DOOR = `{ ...ITEM_DEFAULTS.door, doorType: 'SHAKER_TIM_PNT', doorProfile: 'shaker_timber', widthMm: 600, heightMm: 2000 }`;
    const oak22 = await b.js(`doorItemParams(${DOOR})`);
    const tul28 = await b.js(`doorItemParams({ ...${DOOR}, timberSpeciesKey: 'TIM_TUL', frameThicknessMm: 28 })`);
    assert.deepEqual([oak22.timberSpeciesKey, oak22.frameThicknessMm, tul28.timberSpeciesKey, tul28.frameThicknessMm], ['TIM_OAK', 22, 'TIM_TUL', 28]);
    const cost = params => P.priceItem({ type: 'door', qty: 1, params }).totalCost;
    const { timberSpeciesKey, frameThicknessMm, ...asBefore } = tul28;   // what the form used to send: no species, no thickness
    assert.ok(cost(asBefore) < cost(tul28) && cost(tul28) < cost(oak22), 'the timber is priced, by species and thickness');
    assert.ok(near(cost(tul28) - cost(asBefore), 2 * 2.6 * 0.07 * 0.028 * 1.2 * P.DB.solidTimber.TIM_TUL.effectivePerM3, 1e-6), 'by exactly the frame\'s tulipwood');
    // The price preview is the saved price (it left out the hinges and the handle).
    assert.ok(oak22.hingeCost > 0 && oak22.handleCost > 0);
    // Any other door is sent exactly as before.
    assert.deepEqual(Object.keys(await b.js(`doorItemParams({ ...ITEM_DEFAULTS.door })`)), ['doorType', 'widthMm', 'heightMm', 'hasStain', 'sprayFinishOverride', 'hingeCost', 'handleCost']);

    // 2. A new cabinet takes the room's defaults — the solid-timber door's species and thickness, the frame, in-frame.
    const fromRoom = await b.js(`cabinetFormFromRoom({ doorProfile: 'shaker_timber', doorFinish: 'painted', timberSpeciesKey: 'TIM_TUL', doorFrameThicknessMm: 28, frameKey: 'FRAME_TIM_TUL', frameThicknessMm: 28 })`);
    assert.deepEqual([fromRoom.doorType, fromRoom.timberSpeciesKey, fromRoom.doorFrameThicknessMm, fromRoom.frameKey, fromRoom.frameThicknessMm, fromRoom.inframeFront], ['SHAKER_TIM_PNT', 'TIM_TUL', 28, 'FRAME_TIM_TUL', 28, undefined]);
    const plain = await b.js(`cabinetFormFromRoom(undefined)`), dflt = await b.js(`({ ...ITEM_DEFAULTS.cabinet, descriptionTouched: false })`);
    assert.deepEqual(plain, dflt, 'no room defaults: the cabinet defaults');
    const inRoom = await b.js(`cabinetFormFromRoom({ doorProfile: 'shaker', doorFinish: 'painted', inframeFront: ${JSON.stringify(TULIP)}, inframeFaceMm: 32 })`);
    assert.deepEqual([inRoom.inframeFront, inRoom.frameMemberWidthMm], [TULIP, 32]);

    // 3. "Apply in-frame to all cabinets in this room": the room's cabinets only, repriced as the engine prices them.
    const cab = (extra = {}) => ({ type: 'cabinet', description: 'Base', qty: 1, params: { ...CAB, handleKey: 'HW_HDL_BAR128', ...extra } });
    const items = [cab(), cab({ doorCount: 0, drawerCount: 3 }), { type: 'door', description: 'Door', qty: 1, params: { doorType: 'SHAKER_PNT', widthMm: 500, heightMm: 720 } }]
      .map(it => ({ ...it, pricing: P.priceItem(it) }));
    const quote = P.lockQuote({ id: 'Q1', rooms: { Kitchen: { defaults: { inframeFront: TULIP, inframeFaceMm: 32 }, items }, Utility: { items: [items[0]] } } });   // price-locked, like any saved quote
    await b.js(`(window.__q = ${JSON.stringify(quote)}, window.__after = applyRoomInframe(window.__q, 'Kitchen'), 1)`);
    const after = await b.js(`window.__after`);
    for (const i of [0, 1]) {
      const it = after.rooms.Kitchen.items[i];
      assert.deepEqual([it.params.inframeFront, it.params.frameMemberWidthMm, it.description], [TULIP, 32, 'Base — In-frame']);
      assert.equal(it.pricing.totalCost, P.priceItem({ type: 'cabinet', qty: 1, params: it.params }).totalCost);
      assert.ok(it.pricing.totalCost > items[i].pricing.totalCost);
    }
    assert.deepEqual(await b.js(`[__after.rooms.Kitchen.items[2] === __q.rooms.Kitchen.items[2], __after.rooms.Utility === __q.rooms.Utility, __after.pricingLock === __q.pricingLock]`), [true, true, true], 'the door, the other room and the lock are untouched');
    // Applied twice: nothing left to change. A website order (locked): returned as it is.
    assert.equal(await b.js(`applyRoomInframe(__after, 'Kitchen').rooms.Kitchen.items.every((it, i) => it === __after.rooms.Kitchen.items[i])`), true);
    assert.equal(await b.js(`(o => applyRoomInframe(o, 'Kitchen') === o)({ ...__q, locked: true })`), true, 'a website order is never touched');
    // The room's In-frame off again: the same action takes it off, back to the first prices.
    const off = await b.js(`(q => applyRoomInframe({ ...q, rooms: { ...q.rooms, Kitchen: { ...q.rooms.Kitchen, defaults: {} } } }, 'Kitchen'))(__after)`);
    assert.deepEqual(off.rooms.Kitchen.items.map(it => [it.description, it.params.inframeFront, +it.pricing.totalCost.toFixed(6)]), items.map(it => [it.description, undefined, +it.pricing.totalCost.toFixed(6)]));
  } finally { b.close(); }
});
