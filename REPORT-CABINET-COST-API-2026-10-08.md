# Cabinet-cost API for the configurator — report (8 Oct 2026)

Branch: `feat/cabinet-cost-api-v2` (from `origin/master` @ `85f6ef1`). Not merged. Not deployed.
Nothing under `public/` changed — no UI behaviour or UI price is affected.

## What was added

Two auth-gated routes in `server.js`, a thin wrapper over the engine master already loads server-side
(`public/pricing.js` → `priceItem`). The body is priced with **the exact call the UI makes**:

```js
priceItem({ type: 'cabinet', qty, params })   // params = request body minus qty
```

| Route | Auth | Behaviour |
|---|---|---|
| `POST /api/cabinet-cost` | Bearer `API_TOKEN` (or cookie session) via the existing `authMiddleware` | Validates, prices, returns the `priceItem` result as-is: `{ costPerUnit, sellPerUnit, totalCost, totalSellExVAT, totalSellIncVAT, breakdown }` |
| `GET /api/cabinet-cost/keys` | same | Every keyed table with display names: `materials, doorTypes, drawerTypes, hardware.{runners,hinges,handles}, frames, edgebands, solidTimber, cabinetTypes`, plus `carcassFinishes`, `sprayFinishOverrides`, the accepted `fields` list and `settings.{margin,vat}` |

Error contract ("never a guess"):

| Status | When |
|---|---|
| 400 `{ error, errors[] }` | any unknown field; missing/non-positive dims; missing `carcassMaterialKey`; any key not in its engine table (material, door, drawer, runner, hinge, handle, frame, edgeband, timber, cabinet type); bad `carcassFinish` / `sprayFinishOverride` / `hasStain` / counts / `qty` |
| 401 | no token / wrong token (existing middleware) |
| 422 | engine threw or returned no finite `totalCost` |
| 503 | engine module failed to load |

Strict validation is deliberate: `calcCabinetCost` silently ignores unknown fields and silently falls back to a
default hinge/handle/runner for an unknown key, so a typo would price a different cabinet without anyone noticing.

The old branch `feature/cabinet-cost-api` (4f4f5ac) was used only for the request/response contract. Its
`pricing-engine.js` copy was not taken.

One incidental change to `server.js`: `module.exports = app`, with `initDB()`/`listen` now inside
`if (require.main === module)` so tests can boot the app on a random port. `npm start` is unchanged.

## Mapping table (configurator → engine)

`quoteCalcMapping.mapSpecToEngineInput()` already emits engine-native names, so the API does **no remapping**:
every field below is passed through to `calcCabinetCost` by name after validation.

| Configurator field (output of `mapSpecToEngineInput`) | Engine field (`calcCabinetCost` param) | Validation | Notes |
|---|---|---|---|
| `widthMm` / `heightMm` / `depthMm` (from `spec.dims.w/h/d`) | same | required, positive number | |
| `carcassMaterialKey` (Tables 1) | same | **required**, in `DB.materials` | `MAT_OAK_MDF_PREF_19`, `MAT_OAK_MDF_UNF_19`, `MAT_WAL_MDF_PREF_19`, `MAT_WAL_MDF_UNF_19`, `MAT_BIRCH_PREF_18`, `MAT_MEL_EGGER_18`, `MAT_SHINNOKI_19`, `MAT_MDF_FH_18` all exist on master |
| `doorCount` (door-leaf rule) | same | non-negative integer | |
| `doorType` (Table 2) | same | in `DB.doorTypes` | `SLAB_PNT`, `SLAB_VEN`, `SHAKER_PNT`, `SHAKER_VEN` all exist. With `doorCount: 0` the type still prices drawer fronts, as the mapping expects |
| `drawerCount` (`spec.drawers.length`) | same | non-negative integer | |
| `drawerType` = `DRW_BIRCH_PLY` | same | in `DB.drawerTypes` | |
| `runnerKey` = `HW_RUN_BLUM_SM` | same | in `DB.hardware.runners` | still the only runner key |
| `hingeKey` = `HW_HINGE_SM` | same | in `DB.hardware.hinges` | |
| `handleKey` = `HW_HDL_NONE` | same | in `DB.hardware.handles` | £0, exists |
| `shelfCount` (`shelfQty + dividers`) | same | non-negative integer | |
| `frameKey` = `FRAME_NONE` | same | in `FRAME_MATERIALS` | |
| `edgebandKey` (`EDGE_ABS_PAINT` / `EDGE_MELAMINE`) | same | in `EDGEBAND_TYPES` | engine skips edgeband for `MAT_BIRCH_UNF_*` or when a frame is fitted |
| `hasStain` = `false` | same | boolean | |
| `qty` = `1` | `item.qty` | positive integer | |
| `cabinetTypeKey` (Table 4b, `T_DRESSER`) | — (not read by the engine) | in `DB.cabinetTypes` if sent | **No pricing effect.** `calcCabinetCost` prices from dims/counts only; the mapping's comment that the engine "auto-derives" a type is a UI-side notion. Accepted so a bad key is still caught |

Also accepted (engine params the configurator does not send today, all optional, validated the same way):
`carcassFinish`, `backMaterialKey`, `sprayFinishOverride`, `panelMaterialKey`, `timberSpeciesKey`,
`timberCustomSpeciesName`, `timberCustomPricePerM3`, `frameThicknessMm`, `frameMemberWidthMm`,
`frameCustomSpeciesName`, `frameCustomPricePerM3`, `frameStileWidthMm`, `doorFrameThicknessMm`.

## Unmapped / things the configurator should know

1. **`carcassFinish` is never sent → engine default `"none"`.** In the UI, picking a material auto-sets
   `carcassFinish` to the material's `naturalFinish` (`paint` for `MAT_MDF_FH_18`, `lacquer` for the
   `*_UNF_*` veneers and birch UNF, `none` for prefinished/melamine/Shinnoki). So a configurator
   `primed_mdf` cabinet, or an "unfinished" oak/walnut carcass, prices **without** the carcass spray
   the UI would apply by default. The API does not guess this (per brief); the configurator should
   send `carcassFinish` explicitly for those materials. The keys endpoint lists the valid values.
2. **`backMaterialKey` default has changed on master.** The mapping comment says "left unset → engine
   default `MAT_BACK_HDF_6`". On master the back now defaults to the **carcass material**. Harmless
   for parity (the UI does the same) but the comment is stale.
3. **Margin is not an input.** `sellPerUnit`/`totalSell*` use the engine's default margin; there is no
   per-quote override on this route. The configurator uses `totalCost` only, so this does not matter to it.
4. **Response `breakdown` now includes `bom`** (material quantities, added on master in PR #46). The
   configurator's `breakdownToLineItems` skips non-numeric values, so it is ignored safely.
5. **UI-only params are rejected**: `doorProfile`, `doorFinish`, `description` are UI bookkeeping the
   engine never reads. The configurator doesn't send them. If a caller needs them accepted, add them
   to `CABINET_FIELDS`.
6. **Settings overrides live in the browser.** The UI can hold edited rates in `localStorage`
   (`sab_db_settings`); the server prices with the defaults in `pricing.js`. This is the same situation
   as the existing recompute on `GET /api/quotes`, not new to this route.
7. `W_GLASS` has no glass door type (known issue, untouched); no configurator type maps to it.

## Parity (API `totalCost` vs `priceItem` for the same item)

Generated against this branch. "full object equal" = the entire JSON result (cost, sell, breakdown incl. hours and bom) is identical.

| # | Cabinet | W×H×D | Material | Doors / drawers / shelves | Door type | API totalCost | priceItem totalCost | Match |
|---|---|---|---|---|---|---|---|---|
| 1 | base 1-door primed MDF slab | 500×770×560 | MAT_MDF_FH_18 | 1 / 0 / 1 | SLAB_PNT | £231.72 | £231.72 | exact, full object equal |
| 2 | base 2-door primed MDF shaker | 1000×770×560 | MAT_MDF_FH_18 | 2 / 0 / 1 | SHAKER_PNT | £473.51 | £473.51 | exact, full object equal |
| 3 | base 3-drawer birch, painted fronts | 600×770×560 | MAT_BIRCH_PREF_18 | 0 / 3 / 0 | SLAB_PNT | £696.08 | £696.08 | exact, full object equal |
| 4 | base open birch, 2 shelves | 600×770×560 | MAT_BIRCH_PREF_18 | 0 / 0 / 2 | SLAB_PNT | £208.40 | £208.40 | exact, full object equal |
| 5 | wall 1-door oak veneer slab | 400×720×300 | MAT_OAK_MDF_PREF_19 | 1 / 0 / 1 | SLAB_VEN | £197.73 | £197.73 | exact, full object equal |
| 6 | wall 2-door walnut veneer shaker | 900×900×350 | MAT_WAL_MDF_PREF_19 | 2 / 0 / 2 | SHAKER_VEN | £507.85 | £507.85 | exact, full object equal |
| 7 | wall small 1-door melamine | 300×360×300 | MAT_MEL_EGGER_18 | 1 / 0 / 1 | SLAB_PNT | £131.28 | £131.28 | exact, full object equal |
| 8 | tall larder 1-door birch, 5 shelves | 600×2100×560 | MAT_BIRCH_PREF_18 | 1 / 0 / 5 | SLAB_PNT | £653.39 | £653.39 | exact, full object equal |
| 9 | tall 2-door shaker + 2 drawers | 1000×2200×600 | MAT_MDF_FH_18 | 2 / 2 / 4 | SHAKER_PNT | £1780.07 | £1780.07 | exact, full object equal |
| 10 | tall large oak unfinished, lacquered | 1200×2400×650 | MAT_OAK_MDF_UNF_19 | 2 / 0 / 4 | SLAB_VEN, carcass lacquer | £1167.86 | £1167.86 | exact, full object equal |
| 11 | counter-height dresser (T_DRESSER) | 1200×1400×400 | MAT_MDF_FH_18 | 2 / 0 / 3 | SHAKER_PNT | £733.73 | £733.73 | exact, full object equal |
| 12 | counter-height open shinnoki | 800×1400×400 | MAT_SHINNOKI_19 | 0 / 0 / 3 | SLAB_VEN | £338.19 | £338.19 | exact, full object equal |
| 13 | base 2-door with 1 divider (shelf+1) | 1000×770×560 | MAT_MDF_FH_18 | 2 / 0 / 2 | SLAB_PNT | £397.56 | £397.56 | exact, full object equal |
| 14 | base 2-door primed-only finish | 800×770×560 | MAT_MDF_FH_18 | 2 / 0 / 1 | SHAKER_PNT (primed) | £338.81 | £338.81 | exact, full object equal |

Plus `qty: 3` on cabinet 2 → `totalCost` equals `priceItem` and equals 3 × `costPerUnit`.

All rows use the configurator's fixed house choices (`DRW_BIRCH_PLY`, `HW_RUN_BLUM_SM`, `HW_HINGE_SM`,
`HW_HDL_NONE`, `FRAME_NONE`, `hasStain: false`, `qty: 1`).

## Test results

`npm test` (`node --test`) on this branch:

```
ℹ tests 71
ℹ pass 71
ℹ fail 0
```

New file `test/cabinet-cost-api.test.js` (24 tests): 14 parity + qty scaling, 3 auth (no token 401,
wrong token 401, keys gated), 11 validation (dims, string dims, unknown material/door/hinge/edgeband/
cabinet type, missing material, unknown field, bad carcassFinish, non-object body), 1 keys. The
existing 47 pricing-engine tests are unchanged and green.

## Diff stat

```
 server.js                     | 108 ++++++++++++++++++++++++++++++++--
 test/cabinet-cost-api.test.js | 131 ++++++++++++++++++++++++++++++++++++++++++
 2 files changed, 234 insertions(+), 5 deletions(-)
```
(+ this report.) `public/` diff: 0 lines.

## Not done (by design)

- No merge to `master`, no deploy, no PR opened — Cowork reviews; master merge/deploy only on Steve's CONFIRM DEPLOY.
- No change to the configurator repo (read-only reference).
- No secrets touched; tests set throwaway `APP_PASSWORD`/`API_TOKEN` values in-process only.
