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

## Known Issues — Do Not Touch Without Discussion
- W_GLASS cabinet type exists but has no corresponding glass door type in doorTypes table — glass cost may not be captured correctly. Do not attempt to fix without explicit discussion
- Client view restructure planned: baking project costs proportionally into item prices rather than showing as separate line items — do not change pricing display logic without discussion

## Safety Guardrails — Critical

### Never Do These Without Explicit "CONFIRM" From Steve
- Never deploy to Railway production — note: Railway auto-deploys on push to master, so never push to master without approval
- Never delete quotes or client data
- Never drop or alter PostgreSQL tables
- Never modify .env files or expose DATABASE_URL or any credentials
- Never push directly to master branch — always use a feature branch

### Working Rules
- Always work on a feature branch, never master
- Always test pricing calculations locally before suggesting any deployment
- Always show diffs before committing any changes to pricing logic
- Never change how VAT or margins are calculated without explicit discussion
- Never modify quote PDF output format without approval
- Always ask before installing new npm packages

### Safe to Do Autonomously
- Adding new UI components
- Fixing display bugs
- Writing tests for pricing calculations
- Improving error handling and logging
- Code cleanup and refactoring