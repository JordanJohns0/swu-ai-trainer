const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const PORT = 3456;
const BIND_HOST = process.env.SERVER_BIND_HOST || '127.0.0.1';
const API_KEY = process.env.SERVER_API_KEY || '';
const CORS_ORIGIN = process.env.SERVER_CORS_ORIGIN || null;
const DATA_DIR = path.join(__dirname, 'data');
const WEIGHTS_FILE = path.join(DATA_DIR, 'weights.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const GAMES_DIR = path.join(DATA_DIR, 'games');

// Ensure data directories exist
for (const dir of [DATA_DIR, GAMES_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

if (!API_KEY) {
  console.warn('WARNING: SERVER_API_KEY is not set — /api/* is unauthenticated.');
  console.warn('This is only safe because BIND_HOST defaults to 127.0.0.1. Set SERVER_API_KEY before ever exposing this beyond localhost.');
}

const app = express();
// Only reflect a specific configured origin; default is "no cross-origin access"
// rather than the previous wide-open cors() (Access-Control-Allow-Origin: *),
// which let any website's JS read/write this API from a visitor's browser.
app.use(cors(CORS_ORIGIN ? { origin: CORS_ORIGIN } : { origin: false }));
app.use(express.json({ limit: '100mb' }));

// Require x-api-key on every /api/* route when SERVER_API_KEY is configured.
// Static dashboard files and the health check stay open so the dashboard can
// at least load and report status without the key.
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  if (!API_KEY) return next(); // no key configured: rely on localhost-only bind
  if (req.get('x-api-key') === API_KEY) return next();
  res.status(401).json({ error: 'unauthorized' });
});

app.use(express.static(path.join(__dirname, 'dashboard')));

// ── Health ────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── Weights ───────────────────────────────────────────
app.get('/api/weights', (req, res) => {
  try {
    if (fs.existsSync(WEIGHTS_FILE)) {
      res.json(JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8')));
    } else {
      res.json({ weights: null });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/weights', (req, res) => {
  try {
    fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Stats ─────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  try {
    if (fs.existsSync(STATS_FILE)) {
      res.json(JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')));
    } else {
      res.json({});
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/stats', (req, res) => {
  try {
    const existing = fs.existsSync(STATS_FILE) ? JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) : {};
    const merged = { ...existing, ...req.body, updatedAt: Date.now() };
    // Keep accuracy history
    if (req.body.accuracy != null) {
      if (!merged.accuracyHistory) merged.accuracyHistory = [];
      merged.accuracyHistory.push({ accuracy: req.body.accuracy, gamesTrained: merged.gamesTrained || 0, at: Date.now() });
      if (merged.accuracyHistory.length > 100) merged.accuracyHistory = merged.accuracyHistory.slice(-100);
    }
    fs.writeFileSync(STATS_FILE, JSON.stringify(merged, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Games ─────────────────────────────────────────────
app.get('/api/games', (req, res) => {
  try {
    const files = fs.existsSync(GAMES_DIR) ? fs.readdirSync(GAMES_DIR) : [];
    const games = files
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const raw = fs.readFileSync(path.join(GAMES_DIR, f), 'utf8');
          const game = JSON.parse(raw);
          return {
            gameId: game.gameId,
            timestamp: game.timestamp,
            gameNumber: game.gameNumber,
            playerId: game.playerId,
            winner: game.winner,
            trained: game.trained,
            completedAt: game.completedAt,
            stateCount: (game.states || []).length,
            actionCount: (game.actions || []).length
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    res.json(games);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/games/:id', (req, res) => {
  try {
    const file = path.join(GAMES_DIR, `${req.params.id}.json`);
    if (fs.existsSync(file)) {
      res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
    } else {
      res.status(404).json({ error: 'not found' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/games', (req, res) => {
  try {
    const game = req.body;
    if (!game.gameId) return res.status(400).json({ error: 'missing gameId' });
    fs.writeFileSync(path.join(GAMES_DIR, `${game.gameId}.json`), JSON.stringify(game, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/games', (req, res) => {
  // This wipes every recorded game — require an explicit confirmation flag
  // on top of API-key auth so a stray/scripted request can't empty the
  // training corpus by accident.
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'pass {"confirm": true} in the request body to wipe all games' });
  }
  try {
    if (fs.existsSync(GAMES_DIR)) {
      const files = fs.readdirSync(GAMES_DIR);
      for (const f of files) fs.unlinkSync(path.join(GAMES_DIR, f));
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Dashboard fallback ────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

app.listen(PORT, BIND_HOST, () => {
  console.log(`SWU AI Server running on http://${BIND_HOST}:${PORT}`);
  console.log(`  Dashboard: http://${BIND_HOST}:${PORT}/`);
  console.log(`  API:       http://${BIND_HOST}:${PORT}/api/`);
});
