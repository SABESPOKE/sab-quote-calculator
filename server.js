const express = require('express');
const path = require('path');
const { pool, initDB } = require('./db');
const { calcCabinetCost, DB: PRICING_DB, FRAME_MATERIALS, EDGEBAND_TYPES } = require('./pricing-engine');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// ─── API ROUTES ──────────────────────────────────────────────────────────────

// Health check (also tells the client if DB is available)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: !!pool });
});

// Get all quotes
app.get('/api/quotes', async (req, res) => {
  if (!pool) return res.json({});
  try {
    const { rows } = await pool.query('SELECT id, data, updated_at FROM quotes ORDER BY updated_at DESC');
    const quotes = {};
    for (const row of rows) {
      quotes[row.id] = { ...row.data, _serverUpdatedAt: row.updated_at };
    }
    res.json(quotes);
  } catch (err) {
    console.error('GET /api/quotes error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Upsert a single quote
app.put('/api/quotes/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { id } = req.params;
  const data = req.body;
  try {
    await pool.query(
      `INSERT INTO quotes (id, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [id, JSON.stringify(data)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/quotes error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Patch a quote (e.g. update status)
app.patch('/api/quotes/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { id } = req.params;
  const patch = req.body;
  try {
    // Read current data, merge patch fields into it, write back
    const { rows } = await pool.query('SELECT data FROM quotes WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const updated = { ...rows[0].data, ...patch };
    await pool.query(
      'UPDATE quotes SET data = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(updated), id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/quotes error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Delete a quote
app.delete('/api/quotes/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    await pool.query('DELETE FROM quotes WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/quotes error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Bulk sync — client sends all its quotes, server merges and returns result
app.post('/api/quotes/sync', async (req, res) => {
  if (!pool) return res.json({ quotes: req.body.quotes || {} });
  const clientQuotes = req.body.quotes || {};
  try {
    // Get all server quotes
    const { rows } = await pool.query('SELECT id, data, updated_at FROM quotes');
    const serverMap = {};
    for (const row of rows) {
      serverMap[row.id] = { data: row.data, updated_at: row.updated_at };
    }

    const merged = {};

    // Process client quotes — upsert if newer or missing on server
    for (const [id, quote] of Object.entries(clientQuotes)) {
      const clientTime = quote.updated_at ? new Date(quote.updated_at) : new Date(0);
      const serverEntry = serverMap[id];

      if (!serverEntry || clientTime > new Date(serverEntry.updated_at)) {
        // Client is newer — upsert to server
        await pool.query(
          `INSERT INTO quotes (id, data, updated_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = $3`,
          [id, JSON.stringify(quote), quote.updated_at || new Date().toISOString()]
        );
        merged[id] = quote;
      } else {
        // Server is newer — use server version
        merged[id] = serverEntry.data;
      }
      delete serverMap[id];
    }

    // Add quotes that only exist on server
    for (const [id, entry] of Object.entries(serverMap)) {
      merged[id] = entry.data;
    }

    res.json({ quotes: merged });
  } catch (err) {
    console.error('POST /api/quotes/sync error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── CABINET COST ENGINE (server-side) ─────────────────────────────────────────
// Additive, read-only endpoints that expose the cabinet cost engine (a verbatim
// server-side copy of the inline engine in public/index.html — see
// pricing-engine.js) so other apps (e.g. the cabinet configurator) can POST a
// native cabinet spec and get back the calculated cost. No DB access, no side
// effects, does not touch any existing route.

// POST /api/cabinet-cost — accepts the engine's NATIVE input object and returns
// the result of calcCabinetCost() as JSON. Caller is responsible for mapping its
// own spec onto these fields; we do NOT remap here.
app.post('/api/cabinet-cost', (req, res) => {
  const spec = req.body || {};
  const { widthMm, heightMm, depthMm } = spec;

  // Validate required dims are positive numbers.
  for (const [field, val] of [['widthMm', widthMm], ['heightMm', heightMm], ['depthMm', depthMm]]) {
    if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
      return res.status(400).json({ error: `${field} must be a positive number` });
    }
  }

  let result;
  try {
    result = calcCabinetCost(spec);
  } catch (err) {
    console.error('POST /api/cabinet-cost error:', err.message);
    return res.status(400).json({ error: 'Failed to calculate cabinet cost: ' + err.message });
  }

  // calcCabinetCost returns null for an unknown carcass material key.
  if (result === null) {
    return res.status(400).json({ error: 'Unknown carcassMaterialKey (or invalid spec) — see /api/cabinet-cost/keys' });
  }

  res.json(result);
});

// GET /api/cabinet-cost/keys — valid DB keys so the configurator can build its
// mapping. Returns just the keys (and human-readable names) for each category.
app.get('/api/cabinet-cost/keys', (req, res) => {
  const namesOf = (obj) => Object.fromEntries(
    Object.entries(obj || {}).map(([k, v]) => [k, (v && v.name) || k])
  );
  res.json({
    materials:   namesOf(PRICING_DB.materials),
    doorTypes:   namesOf(PRICING_DB.doorTypes),
    drawerTypes: namesOf(PRICING_DB.drawerTypes),
    hardware: {
      runners: namesOf(PRICING_DB.hardware.runners),
      hinges:  namesOf(PRICING_DB.hardware.hinges),
      handles: namesOf(PRICING_DB.hardware.handles),
    },
    frames:    namesOf(FRAME_MATERIALS),
    edgebands: namesOf(EDGEBAND_TYPES),
    settings: {
      margin: PRICING_DB.settings.margin,
      vat:    PRICING_DB.settings.vat,
    },
  });
});

// ─── CATCH-ALL ───────────────────────────────────────────────────────────────

// Serve index.html for any non-API route (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START ───────────────────────────────────────────────────────────────────

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`SAB Quote Calculator running on port ${PORT}`);
  });
});
