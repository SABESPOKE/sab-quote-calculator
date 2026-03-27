# SAB Quote Calculator

Steven Andrews Bespoke — a quote/pricing calculator for custom cabinetry and bespoke furniture.

## Tech Stack

- **Backend:** Node.js + Express + PostgreSQL (via `pg`)
- **Frontend:** React 18 (UMD from CDN) + Babel Standalone (in-browser JSX), all in a single `public/index.html`
- **PWA:** Service worker (`public/sw.js`) with cache-first for static assets, network-first for API
- **Deployment:** Railway (auto-deploy on push to `master`), PostgreSQL provided by Railway

## Project Structure

```
server.js            Express server & REST API routes
db.js                PostgreSQL connection & schema setup
public/index.html    Entire React app (monolithic ~3500 lines)
public/sw.js         Service worker (cache name: 'sab-v2')
public/manifest.json PWA manifest
public/icons/        App icons
```

## Commands

```bash
npm install          # install dependencies
npm start            # run server on port 3000
```

No build step — frontend is served as-is. No test suite.

## API Routes

All under `/api/`:
- `GET /api/health` — health check
- `GET /api/quotes` — list all quotes
- `PUT /api/quotes/:id` — upsert a quote
- `DELETE /api/quotes/:id` — delete a quote
- `POST /api/quotes/sync` — bulk sync (timestamp-based conflict resolution)

## Key Conventions

- The entire frontend is a single React component `SABQuoteTool()` in `index.html`
- Pricing logic is pure JS functions: `calcCabinetCost()`, `calcDoorCost()`, `calcDrawerCost()`, etc.
- Material/hardware lookup tables are embedded in `index.html`
- Styling uses inline React style objects + CSS with media queries for mobile (`max-width: 767px`)
- Theme colours: `#c8a96e` (gold accent), `#1a1a1a` (dark), `#f5f5f5` (light)
- Data persists to localStorage first, then syncs to PostgreSQL server
- When updating the frontend, bump the service worker cache version in `sw.js`

## Environment

- `DATABASE_URL` — PostgreSQL connection string (set automatically on Railway; optional for local dev which uses localStorage only)
- `PORT` — server port (defaults to 3000)
