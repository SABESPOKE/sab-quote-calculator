const express = require('express');
const path = require('path');
const fs = require('fs');
const { pool, initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

// ─── WRP CATALOGUE ──────────────────────────────────────────────────────────
const WRP_CATALOGUE_PATH = path.join(__dirname, 'data', 'wrp_catalogue.json');
let wrpCatalogue = null;
try {
  wrpCatalogue = JSON.parse(fs.readFileSync(WRP_CATALOGUE_PATH, 'utf8'));
} catch (err) {
  console.warn('WRP catalogue not found at', WRP_CATALOGUE_PATH);
}

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

// ─── WRP CATALOGUE ROUTES ───────────────────────────────────────────────────

// Get full WRP catalogue
app.get('/api/wrp-catalogue', (req, res) => {
  if (!wrpCatalogue) return res.status(404).json({ error: 'WRP catalogue not loaded' });
  res.json(wrpCatalogue);
});

// Update a single profile's price (learn-as-you-go)
app.put('/api/wrp-catalogue/price/:id', (req, res) => {
  if (!wrpCatalogue) return res.status(404).json({ error: 'WRP catalogue not loaded' });
  const profileId = parseInt(req.params.id, 10);
  const { price_per_metre_gbp } = req.body;

  const profile = wrpCatalogue.profiles.find(p => p.id === profileId);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  profile.price_per_metre_gbp = typeof price_per_metre_gbp === 'number' ? price_per_metre_gbp : null;
  profile.price_last_updated = new Date().toISOString().split('T')[0];

  // Persist to disk
  try {
    fs.writeFileSync(WRP_CATALOGUE_PATH, JSON.stringify(wrpCatalogue, null, 2), 'utf8');
    res.json({ ok: true, profile });
  } catch (err) {
    console.error('Failed to save WRP catalogue:', err.message);
    res.status(500).json({ error: 'Failed to save catalogue' });
  }
});

// Proxy WRP images to avoid browser referrer/CORS issues
app.get('/api/wrp-image/:hash', async (req, res) => {
  const url = `https://www.wrp-timber-mouldings.co.uk/uploads/${req.params.hash}`;
  try {
    const https = require('https');
    https.get(url, upstream => {
      if (upstream.statusCode !== 200) return res.status(upstream.statusCode).end();
      res.set('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=604800');
      upstream.pipe(res);
    }).on('error', () => res.status(502).end());
  } catch { res.status(500).end(); }
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
