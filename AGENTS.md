# SWU AI Trainer — Project Summary

## Goal
Support running bots that queue into Forceteki and play games autonomously handling all prompt types via neural net scoring. Build a headless self-play system for continuous training on a headless Ubuntu machine (6.8GB RAM).

## Constraints & Preferences
- **Incognito banned**: separate Chrome profiles (or Socket.IO bots) for each Forceteki account — cannot queue into yourself with same cookie jar
- **MV3 CSP blocks TF.js**: pure-JS NeuralNet (Float64Array math) instead; no `'unsafe-eval'`
- **Training**: ranking loss (hinge margin) on `(state, action)` score pairs, linear output (no sigmoid), topK mining, weight decay
- **Delay**: 1-3s (minWait-maxWait), halved for ≤2 actions, floored at 1000ms
- **Batch training**: every N games (default 5), not continuous — more memory-predictable
- **Persistence**: file-based (`server/data/weights.json`, `recordings.json`, `stats.json`)

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
- **`bot/storage.js`**: file-based load/save for weights, recordings, training stats
- **`bot/util.js`**: ported `getAvailableActions`, `selectAiAction`, `trySequences`, `cardToResource`, `describeAction`, etc.
- **`bot/training.js`**: `trainModelRanking` extracted (avoids circular dep with util)
- **`bot/decks.js`**: Cad Blue deck (Cad Bane ASH/011, Nevarro City ASH/020)
- **`bot/bot.js`**: Socket.IO client — HTTP enter-queue (once) → persistent socket → game loop (receive gamestate → NN action → emit `'game'` events) → batch train → emit `'requeue'` on same socket

### Verified — Game Completes
- **Fixed `'game'` event wrapping**: Server listens for `'game'` event and dispatches by command name (`Lobby.ts:1470-1474`). Bot now emits `socket.emit('game', 'menuButton', arg, uuid)` instead of bare `socket.emit('menuButton', ...)`. All bot actions were silently dropped before this fix.
- **Game runs to completion** (Bot-1 won, full turns played)
- **Training pipeline works**: batch training triggers every N games, 5 epochs, weights persist
- **`pendingRequeue` flag**: prevents duplicate processing of stale gamestate events after game end
- **Persistent socket requeue**: emits `'requeue'` on existing socket (no new HTTP queue or socket creation) — fixes 403 "already in a lobby"
- **Reconnect guard**: only re-queues on reconnect if no active game (`!gameId`)

### Known Minor Issue
- Frequent "no actions" diagnostic when bot is in waiting-prompt state (already acted, waiting for opponent). Shows `promptType:"resource"`/`"actionWindow"` with `buttons:0` — this is correct behavior (the waiting prompt has no buttons/selectable cards), just noisy.

### Next Steps
1. Let requeue run over multiple games to verify persistent socket cycle works
2. Debug any prompt types the bot can't handle (new Forceteki 2.0 changes)
3. Add more decks for variety

## Key Decisions
- **Encode/action port**: `encodeGameState` + `encodeActions` + `NeuralNet` from model.js (no deps); `getAvailableActions` + `selectAiAction` + `trySequences` from util.js (depends on model.js + storage.js); `trainModelRanking` in training.js (depends on both)
- **Socket.IO protocol**: connection URL `http://localhost:3000/ws?user=...&lobby=...&spectator=false` (path `/ws`), events: `gamestate` (receive), `menuButton(arg, uuid)` / `cardClicked(cardId)` / `statefulPromptResults(distribution, uuid)` (send)
- **Enter queue**: HTTP POST `/api/enter-queue` with `{ user: {id, username}, format: 'premier', cardPool: 'current', gamesToWinMode: 'bestOfOne', deck }` → then socket connect → server finds user in queue → matchmakes
- **Self-play mode**: `SELF_PLAY=true` starts two bot instances in parallel (separate processes), each with own id/name
- **Cancel/Close filtered everywhere**: both in `sendRecommendations` and `selectAiAction`
- **Card UUID format**: Forceteki 2.0 `Card_58`, `Card_194`, etc.

## Relevant Files
- `chrome-extension/src/background/index.js`: action selection (line 580), getAvailableActions (line 1527), trySequences (line 1355), helpers (lines 678-1354)
- `chrome-extension/src/background/model.js`: NeuralNet, Layer, encode, training
- `bot/model.js`: ported NeuralNet + encoding standalone
- `bot/util.js`: ported getAvailableActions, selectAiAction, trySequences, cardToResource
- `bot/storage.js`: file-based persistence
- `bot/training.js`: trainModelRanking (avoids circular dep)
- `bot/bot.js`: Socket.IO main loop
- `bot/decks.js`: deck definitions
- `forceteki/server/gamenode/GameServer.ts`: Socket.IO setup (line 300), enter-queue handler (line 1509)
- `forceteki/server/socket.js`: custom Socket wrapper — `send(evt, ...args)` = `socket.emit(evt, ...args)`
