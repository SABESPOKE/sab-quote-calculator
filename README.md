# SAB Quote Calculator

Steven Andrews Bespoke — Quote & Pricing Calculator

## Local Development

```bash
npm install
npm start
```

Open http://localhost:3000

## Deployment

Deployed via Railway. Connect this repo in Railway and it will auto-deploy on every push.

## Configurator pricing fields

Optional fields the cabinet configurator sends to `POST /api/cabinet-cost` (Bearer `API_TOKEN`). The same params
can sit on a quote item (`rooms.<room>.items[].params`, e.g. a `cfg-<orderId>` website order), which prices with the
same `priceItem`. Every field is **off by default**: leave it out and a cabinet prices exactly as before. An unknown
field or key is a `400`; the valid keys are listed by `GET /api/cabinet-cost/keys`. All figures are costs, and the
margin applies to them as to every other line (`totalSellExVAT = totalCost × margin`).

### Push to open — `handleKey: "HW_HDL_PUSH"`

| Field | Values | Default |
|---|---|---|
| `handleKey` | `"HW_HDL_PUSH"` (an existing field's new key) | `"HW_HDL_BAR128"` |

Each front, door leaf or drawer front, gets one Blum Tip-On at £10.00 cost in place of a handle, plus 10 minutes'
bench fitting at the bench rate (`breakdown.hardwareFitHrs`). Hinges and runners are unchanged. One device per front,
tall doors included.

```json
POST /api/cabinet-cost
{ "widthMm": 600, "heightMm": 770, "depthMm": 560, "carcassMaterialKey": "MAT_BIRCH_PREF_18", "doorCount": 0,
  "drawerCount": 3, "drawerType": "DRW_SHEET", "doorType": "SLAB_PNT", "shelfCount": 0, "handleKey": "HW_HDL_PUSH" }
```

### Handleless channel rail per metre — `channelRails`

| Field | Values | Default |
|---|---|---|
| `channelRails` | object, below | absent: no rail line |
| `channelRails.materialKey` | the door board, a `materials` key (e.g. `MAT_MDF_FH_22` painted/primed 22, `MAT_SHINNOKI_19`) | required |
| `channelRails.finishType` | `none` \| `edge_polish` \| `primed` \| `paint` \| `lacquer` \| `stain_lacquer` | the board's natural finish (MDF `paint`, raw veneer `lacquer`, prefinished `none`) |
| `channelRails.thicknessMm` | door board thickness T, mm | the board's own thickness |
| `channelRails.rails[]` | `{ profile, lengthMm }`; `profile` `L` (top rail) \| `C` (mid-rail) \| `TALL_C` (a tall split's C) | required, at least one |

Prices the configurator's handleless rails and C-channels per metre run, in place of one end panel per piece. Board girth
per profile: L = 70 + T, C = 90 + 2T, TALL_C = 110 + 2T (mm). Each rail is priced as its board (girth × length ×
£/m² × waste) plus its spray (girth × length, one face, at the existing spray rates), plus 15 min/m bench labour and
one 10-minute setup per cabinet. It appears as `breakdown.channelRail` (cost) and `breakdown.channelRailHrs`; its
spray hours join `finishHrs` as `sprayDetail.parts.channelRail`. A split tall's fixed shelves are not part of it:
keep sending them as end panels to `POST /api/endpanel-cost`.

```json
POST /api/cabinet-cost
{ "widthMm": 600, "heightMm": 770, "depthMm": 560, "carcassMaterialKey": "MAT_BIRCH_PREF_18", "doorCount": 0,
  "drawerCount": 3, "drawerType": "DRW_SHEET", "doorType": "SLAB_PNT", "sprayFinishOverride": "primed", "shelfCount": 0,
  "channelRails": { "materialKey": "MAT_MDF_FH_22", "finishType": "primed",
    "rails": [{ "profile": "L", "lengthMm": 600 }, { "profile": "C", "lengthMm": 600 }, { "profile": "C", "lengthMm": 600 }] } }
```

### Bin frame — `binFrameKey`

| Field | Values | Default |
|---|---|---|
| `binFrameKey` | `"HW_BIN_ECOTOP"` — bin pull-out frame (Blum / LDL Ecotop) | absent: no frame |

One frame per cabinet: £200.00 net cost plus 30 minutes' bench fitting (`breakdown.binFrame`; hours in
`breakdown.hardwareFitHrs`). It is listed in `breakdown.bom.hardware`. Send it on the bin pull-out base unit.

```json
POST /api/cabinet-cost
{ "widthMm": 600, "heightMm": 770, "depthMm": 560, "carcassMaterialKey": "MAT_BIRCH_PREF_18", "doorCount": 0,
  "drawerCount": 1, "drawerType": "DRW_SHEET", "doorType": "SLAB_PNT", "shelfCount": 0, "binFrameKey": "HW_BIN_ECOTOP" }
```

### Freestanding legs — `legKey`, `legCount`

| Field | Values | Default |
|---|---|---|
| `legKey` | `"HW_LEG_OAK_150"` \| `"HW_LEG_WAL_150"`: tapered leg, 150 mm high, 45 mm square tapering to 28 mm | absent: no legs |
| `legCount` | integer ≥ 1 (needs `legKey`) | 4, or 6 over 1200 mm wide |

Per leg: oak £18.00 or walnut £24.00 cost, plus 10 minutes' bench fitting (`breakdown.legs`; hours in
`breakdown.hardwareFitHrs`). Listed in `breakdown.bom.hardware`. The calculator never charges a plinth on a cabinet,
so there is nothing to remove for a cabinet on legs.

```json
POST /api/cabinet-cost
{ "widthMm": 600, "heightMm": 770, "depthMm": 560, "carcassMaterialKey": "MAT_BIRCH_PREF_18", "doorCount": 1,
  "doorType": "SLAB_PNT", "shelfCount": 1, "legKey": "HW_LEG_OAK_150", "legCount": 4 }
```

### Painted MDF carcass — `carcassMaterialKey: "MAT_MDF_FH_18"` + `carcassFinish: "paint"`, `carcassFinishOutside`

| Field | Values | Default |
|---|---|---|
| `carcassMaterialKey` + `carcassFinish` | `"MAT_MDF_FH_18"` + `"paint"` (existing fields) | birch ply + `"none"` |
| `carcassFinishOutside` | `true` \| `false` | `false` |

A carcass in 18 mm MDF sprayed in a paint colour was already priceable with the two existing fields: the MDF board
rate plus the existing spray rates on the inside of the shell (sides, top, bottom, back, both faces of each shelf,
and the front edges; an open unit's shelf edges too). `carcassFinishOutside: true` also sprays the outer faces of
the sides, top and bottom. It is for an open unit, so the configurator's "Match doors" painted carcass can be
ordered. The back's outer face is not sprayed, since it sits against the wall. It applies to any `carcassFinish`
except `none` and `edge_polish`.

```json
POST /api/cabinet-cost
{ "widthMm": 600, "heightMm": 770, "depthMm": 560, "carcassMaterialKey": "MAT_MDF_FH_18", "carcassFinish": "paint",
  "carcassFinishOutside": true, "doorCount": 0, "drawerCount": 0, "shelfCount": 2 }
```

### Actual front heights — `doorHeightsMm`, `drawerFrontHeightsMm`

| Field | Values | Default |
|---|---|---|
| `doorHeightsMm` | array of mm, one per door leaf, in whole rows of `doorCount` leaves across | absent: `doorCount` leaves at the cabinet height − 6 |
| `drawerFrontHeightsMm` | array of mm, one per drawer front (length = `drawerCount`) | absent: an equal share of the height − 32, 3 mm gaps |

Lets handleless fronts price at their true size: base leaves 20–28 mm shorter, wall leaves 20 mm longer, and a split
tall's two leaves priced separately. A leaf's width stays the cabinet width ÷ `doorCount` − 2, so a split tall is
`doorCount: 1` with two heights, top and bottom (each full width), and a split tall double is `doorCount: 2` with four.
Each leaf gets the hinge count for its own height, and one handle position (one push-to-open device). Leave the
fields out and the fronts price as before.

```json
POST /api/cabinet-cost
{ "widthMm": 600, "heightMm": 2100, "depthMm": 560, "carcassMaterialKey": "MAT_BIRCH_PREF_18", "doorCount": 1,
  "doorType": "SLAB_PNT", "shelfCount": 4, "doorHeightsMm": [1300, 742] }
```

### Soffit LED channel — `POST /api/soffit-led-cost` (item type `soffit_led`)

| Field | Values | Default |
|---|---|---|
| `runs[]` | `{ lengthMm, position }`, at least one; `lengthMm` > 0 | required |
| `runs[].position` | `"front"` \| `"back"`: recorded, not priced | `"front"` |
| `qty` | integer ≥ 1 | `1` |

Built now, off by default: nothing is priced unless a design sends it. Send one line per design with all its runs,
because tape reels round up across the whole design. Extrusion is bought in 2 m lengths at £18.00, rounded up per run.
24 V tape (10 W/m) comes in 5 m reels at £35.00, rounded up for the design. One driver is picked from 30 / 60 / 100 /
150 W (£18 / £24 / £32 / £45), the smallest that covers the tape's watts plus 20%; over 150 W, several 150 W drivers.
Routing the 18 × 8 groove is 10 min per metre at the bench rate. The breakdown gives `extrusion`, `tape`, `driver`
and `labour` (£), `routeHrs` / `totalHrs`, and the counts in `breakdown.led`. On a quote it is an item
`{ "type": "soffit_led", "qty": 1, "params": { "runs": [...] } }`.

```json
POST /api/soffit-led-cost
{ "runs": [{ "lengthMm": 2400, "position": "front" }] }
```

### On a quote (the `cfg-` path)

A quote item's `params` are priced by the same `priceItem` as the endpoints above: on `GET /api/quotes`, and once,
when a website order is created, for its workshop hours and materials list. So every field here works on a stored
item exactly as on `POST /api/cabinet-cost`. The new hours (`hardwareFitHrs`, `channelRailHrs`, `routeHrs`) are
ordinary `*Hrs` breakdown figures. The bin frame and legs appear in the materials list's `hardware`, and
push-to-open devices in `handles`.

## WRP Mouldings price refresh

The WRP Timber Mouldings catalogue at `data/wrp_catalogue.json` is the source of truth (131 profiles across 10 categories). To refresh prices:

```bash
node scrape_wrp_prices.js
```

The script reads `data/wrp_catalogue.json`, scrapes the WRP site, and writes `data/wrp_catalogue_enriched.json`. Review the diff, then copy the enriched file over the catalogue and commit:

```bash
cp data/wrp_catalogue_enriched.json data/wrp_catalogue.json
git add data/wrp_catalogue.json
```

The scraper does NOT run on Railway (Puppeteer/cheerio require local network access). Run locally and commit the result.

Per-quote price entries made via the "Learn as you go" prompt in the WRP picker also persist back to `data/wrp_catalogue.json` via `PUT /api/wrp-catalogue/price/:id`. On Railway these writes are ephemeral (the filesystem resets on deploy), so accumulate prices in local development and commit periodically.

## In-frame — `inframeFront`

An optional cabinet param (`POST /api/cabinet-cost`, and `params.inframeFront` on a cabinet item). Absent, a cabinet
prices exactly as before. Every part is priced from the tables already in `pricing.js`; the one figure it adds is the
time to hang a door on butt hinges (`DB.settings.buttHingeHangMins`, 30 — Steve, 12 Nov 2026).

```json
"inframeFront": { "timber": "tulipwood", "thicknessMm": 28, "frameMm": 28, "hinges": "butt" }
```

| Field | Values | What it prices |
|---|---|---|
| `timber` | `tulipwood` \| `oak` \| `walnut` \| `maple` \| `mdf` | The face frame: solid timber by volume at the `DB.solidTimber` rate (`FRAME_TIM_*`), or `mdf` → `FRAME_MDF_<frameMm>` per metre. A shaker `doorType` is priced as the solid-timber shaker in that timber (`SHAKER_TIM_PNT` painted, `SHAKER_TIM_LAC` lacquered); a slab `doorType` stays as sent. |
| `thicknessMm` | number | The solid-timber shaker door's thickness (28). |
| `frameMm` | number (`mdf`: 18 or 22) | The face frame's thickness (28; 20 round a veneered slab; 22 MDF). |
| `hinges` | `butt` \| `blum` | `butt` → `HW_HINGE_BUTT` (£ per hinge × the hinges on the door) and each door hung at `buttHingeHangMins` at the bench rate (`breakdown.hanging`, `hangHrs`); `blum` → the `hingeKey` sent, no hanging time. |

Also in-frame: doors and drawer fronts are sized to the frame's opening (the cabinet less `frameMemberWidthMm`, 30
unless sent, on each side; `doorHeightsMm` / `drawerFrontHeightsMm`, when sent, are taken as they are); the frame is
finished as the doors are (`breakdown.frameFinish`, hours in `frameFinishHrs` and `finishHrs`); no edgebanding; no
centre mullion on a pair of doors. `frameKey`, `hingeKey` (butt), `timberSpeciesKey`, `frameThicknessMm` and
`doorFrameThicknessMm` are set from `inframeFront`, whatever is sent beside it.

In the calculator, a cabinet's **In-frame** tick sets `inframeFront` from the build rules (`inframeDefaults` in
`pricing.js`: painted shaker → tulipwood 28 in 28, butt; lacquered shaker → the timber 28 in 28, butt; veneered slab →
19 in a 20 frame, butt; painted slab → 22 MDF in 22 MDF, Blum) — every value editable, and a configurator draft's
`inframeFront` opens in the same controls.

A room can be In-frame too (Room Setup ⚙ → **In-frame**, with its timber, hinges, door thickness, frame thickness and
frame face): new cabinets in the room then start in-frame. Existing cabinets change only by **Apply in-frame to all
cabinets in this room** (with the tick off: **Remove in-frame…**), which shows the room's price before and after and
saves on OK. Those cabinets are repriced at today's rates, as any edited item is; nothing else in the quote moves, and
a website order (`locked: true`) is never touched. The hanging minutes are on the Settings screen (Carcass Assembly
Labour).

End panels and fillers are not part of the cabinet: send each to `POST /api/endpanel-cost` in its board
(`MAT_MDF_FH_18`, `MAT_MDF_FH_12`, `MAT_MDF_FH_22`). `GET /api/cabinet-cost/keys` lists the timbers and hinges
(`inframeFront`). Tests: `test/inframe.test.js`.

## Internal drawers — `drawerPosition`

A cabinet's drawers are priced as two separate lines: the boxes with their runners (`breakdown.drawers`) and the fronts
(`breakdown.drawerFronts`). `drawerPosition` says what the fronts are.

| Field | Values | Default |
|---|---|---|
| `drawerPosition` | `"external"` \| `"internal"` | `"external"` — as before |

- **External**: each drawer has a front in the door finish, priced like a door (sized from the cabinet, sprayed, with
  its handle).
- **Internal** (drawers behind doors — a wardrobe, a tall cupboard): the same box, and a plain front in the cabinet's
  **carcass board**: the board (opening wide, the box's 180 mm high unless `drawerFrontHeightsMm` is sent, with the
  board's waste) plus the CNC cut of it (`DB.settings.cncPerSheetCost`, 1 = the cut costs the sheet again). No door
  finish, no spray, no handle, no making labour. In the materials list the plain fronts are carcass board.

The box, the runner (`runnerKey`) and the box's assembly time are the existing ones either way. A cabinet with drawers
and no `drawerType` is priced with the sheet box in its own carcass board (`DRW_SHEET`; it was the birch ply box), and a
standalone `drawer` item with no `drawerType` is the sheet box too (it had no price at all).

In the calculator: **Drawer fronts** on a cabinet, and **Drawers behind doors** in Room Setup, which new cabinets in
the room start with and which is applied to the room's cabinets that have both doors and drawers. `POST
/api/cabinet-cost` takes the field (`drawerPositions` in `/api/cabinet-cost/keys`). Tests: `test/internal-drawers.test.js`.
