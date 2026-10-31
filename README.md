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
