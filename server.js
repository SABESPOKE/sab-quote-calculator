const express = require('express');
const path = require('path');
const { pool, initDB } = require('./db');

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
