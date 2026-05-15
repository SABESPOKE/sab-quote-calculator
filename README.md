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
