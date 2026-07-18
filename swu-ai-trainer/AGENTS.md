# SWU AI Trainer — Project Summary

## Goal
Support running bots that queue into Forceteki and play games autonomously handling all prompt types via neural net scoring. Build a headless self-play system for continuous training on a headless Ubuntu machine (6.8GB RAM).

## Constraints & Preferences
- **Incognito banned**: separate Chrome profiles (or Socket.IO bots) for each Forceteki account — cannot queue into yourself with same cookie jar
- **MV3 CSP blocks TF.js**: pure-JS NeuralNet (Float64Array math) instead; no `'unsafe-eval'`
- **Training**: ranking loss (hinge margin) on `(state, action)` score pairs, linear output (no sigmoid), topK mining, weight decay
- **Delay**: 1-3s (minWait-maxWait), halved for ≤2 actions, floored at 1000ms
- **Batch training**: every 10 games, not continuous — more memory-predictable
- **Persistence**: file-based (`server/data/weights.json`, `recordings.json`, `stats.json`, `decks.json`, `bot_decks.json`, `bot_status_*.json`)
- **SSH key auth** required for monitor; no password prompts (`BatchMode=yes`)

## Progress
### Done — Chrome Extension
- **Multi-game session routing**: globals replaced with `Map<serverGameId, session>`
- **`distributeAmongTargets`**: reads promptData, scores targets via NN, submits `statefulPromptResults`
- **`getAvailableActions`**: 4 extraction passes — buttons, dropdownListOptions, perCardButtons, getSelectableCardIds
- **Cancel/Close filtering**: plan path and fallback both filter cancel actions; `planTextMatches` prevents stale key collisions
- **`failedActionKeys`**: clears when all remaining actions filtered, retries with full set
- **Settings persistence for MV3 idle**: `loadAllSettings()` awaits 6 keys in parallel

### Done — Headless Bot (`bot/`)
- **`bot/model.js`**: NeuralNet, Layer, encodeGameState, encodeActions, selectBestAction — pure JS, 0 deps
- **`bot/storage.js`**: file-based load/save for weights, recordings, training stats, bot status
- **`bot/util.js`**: ported `getAvailableActions`, `selectAiAction`, `trySequences`, `cardToResource`, `describeAction`, etc.
- **`bot/training.js`**: `trainModelRanking` extracted (avoids circular dep with util)
- **`bot/decks.js`**: Cad Blue deck + custom deck loading from `server/data/decks.json`
- **`bot/bot.js`**: Socket.IO client — reads `bot_decks.json` for per-bot deck assignment, stores `deckName` and `playerName` in recordings
- **PID file**: `bot_pid_{id}` written on start for killable add/remove via monitor
- **Bot status**: state transitions persisted to `bot_status_{id}.json` for monitor polling

### Done — Monitor (`monitor/`)
- **`monitor/monitor.js`**: local HTTP server (port 3456) with SSH tunnel for real-time bot status
  - `POST /api/bot/status` — bots push live status updates via SSH reverse tunnel (port 3457)
  - In-memory `Map` stores bot statuses (no SSH polling for bot states)
  - `GET /api/status` — returns in-memory bot states + SSH-fetched training stats, server health, weights mtime
  - `POST /api/bots/add` — `nohup` starts a new bot with `MONITOR_URL` env var set to tunnel
  - `POST /api/bots/remove` — kills bot by PID file, cleans up status
  - `GET /api/decks` — lists custom decks from `server/data/decks.json`
  - `POST /api/decks` — add or update a deck (auto-generates name from leader/base titles)
  - `DELETE /api/decks` — remove a deck by name
  - `POST /api/bots/deck` — assign a deck to a bot (writes `bot_decks.json`)
  - `GET /api/matchups` — win/loss per deck pair over last 50 games per pair
- **SSH tunnel**: auto-started on monitor boot via `ssh -R 3457:localhost:3456`, auto-restarts on failure
- **`monitor/index.html`**: dark-themed dashboard with bot cards (add/remove, deck dropdown), decks list (add/remove), matchup matrix, training stats, server health; refreshes every 2s
- All SSH via `execFile` with argument arrays (no shell) to avoid Windows `cmd.exe` quoting issues
- Uses `MONITOR_SSH_HOST`/`MONITOR_SSH_USER` env vars (not `SSH_USER` — collides with hidden Windows env var)

### Done — Bot Status POSTs
- **`bot/storage.js`**: `saveBotStatus` now also POSTs to `MONITOR_URL/api/bot/status` when `MONITOR_URL` env var is set
- File-based status writes kept as fallback (backward compatible when running without monitor)
- Bot started via monitor's add API receives `MONITOR_URL=http://localhost:3457` automatically

### Verified — Game Completes
- **Fixed `'game'` event wrapping**: Server listens for `'game'` event and dispatches by command name. Bot emits `socket.emit('game', 'menuButton', arg, uuid)` instead of bare `socket.emit('menuButton', ...)`.
- **Game runs to completion** (Bot-1 won, full turns played)
- **Training pipeline works**: batch training triggers every 10 games, weights persist
- **`pendingRequeue` flag**: prevents duplicate processing of stale gamestate events after game end
- **Persistent socket requeue**: emits `'requeue'` on existing socket — fixes 403 "already in a lobby"
- **Reconnect guard**: only re-queues on reconnect if no active game (`!gameId`)

### Known Minor Issue
- Frequent "no actions" diagnostic when bot is in waiting-prompt state (already acted, waiting for opponent). Shows `promptType:"resource"`/`"actionWindow"` with `buttons:0` — this is correct behavior, just noisy.

### Next Steps
1. Deploy updated bot files to server and restart
2. Create initial `decks.json` and `bot_decks.json` on server (monitor API will populate)
3. Test add/remove bot flow from dashboard
4. Test deck assignment and matchup stats after games

## Key Decisions
- **Encode/action port**: `encodeGameState` + `encodeActions` + `NeuralNet` from model.js (no deps); `getAvailableActions` + `selectAiAction` + `trySequences` from util.js (depends on model.js + storage.js); `trainModelRanking` in training.js (depends on both)
- **Socket.IO protocol**: connection URL `http://localhost:3000/ws?user=...&lobby=...&spectator=false` (path `/ws`), events: `gamestate` (receive), `menuButton(arg, uuid)` / `cardClicked(cardId)` / `statefulPromptResults(distribution, uuid)` (send)
- **Enter queue**: HTTP POST `/api/enter-queue` → socket connect → server finds user → matchmakes
- **Self-play mode**: `SELF_PLAY=true` starts two bot instances in parallel
- **execFile over exec**: using argument arrays bypasses `cmd.exe` on Windows, fixing quote-mangling
- **Bot status push**: instead of SSH polling every 5s, an SSH reverse tunnel lets bots POST live status directly to the monitor's in-memory store
- **SSH tunnel**: `ssh -R 3457:localhost:3456` started/restarted by monitor on boot; bots send status to `localhost:3457`
- **Deck storage**: custom decks in `server/data/decks.json`, bot-to-deck mapping in `server/data/bot_decks.json`
- **Deck name**: auto-generated as `"Leader Title / Base Title"` from pasted JSON, with optional `name` override
- **Matchup computation**: compares winner's username against `rec.playerName` (stored per game), cross-references `bot_decks.json` for opponent deck

## Relevant Files
- `bot/bot.js`: main bot loop — PID file, status writes, deck config, recording metadata
- `bot/decks.js`: deck definitions + custom deck loader
- `bot/storage.js`: file-based persistence for weights, recordings, stats, bot status
- `bot/util.js`: action extraction and selection
- `bot/model.js`: NeuralNet, Layer, encode, training
- `bot/training.js`: trainModelRanking
- `monitor/monitor.js`: HTTP server with SSH-backed API (bots, decks, matchups, status)
- `monitor/index.html`: dashboard UI
- `forceteki/server/gamenode/GameServer.ts`: Socket.IO setup, enter-queue handler
- `server/data/`: runtime directory for all persisted state (weights, recordings, stats, decks, bot configs, status files, PID files)
