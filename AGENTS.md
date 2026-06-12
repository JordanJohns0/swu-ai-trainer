# SWU AI Trainer — Project Summary

## Goal
Train a neural network AI for Star Wars: Unlimited on Karabast that learns from recorded games, can play autonomously with structured turn planning, and persists data to a local server with a browser dashboard.

## Constraints & Preferences
- Web extension populates `index.html` UI from `status` object (storage + model state).
- Training uses ranking loss (hinge margin) on `(state, action)` score pairs — linear output, no sigmoid.
- Wins: taken action should score ≥ non-taken + margin (1.0). Losses: taken should score ≤ non-taken + margin (0.3, weak signal). Unknown outcomes skipped.
- Must track which player is the bot (`playerId` in recording) to determine win/loss outcome.
- Multi-model inference UX: best action for auto-play, top-5 suggestions for user overlay, and a separate per-card action ranker for `choose-card` prompts.
- TF.js is incompatible with MV3 extension service workers (Chrome blocks `'unsafe-eval'` in `extension_pages` CSP).
- User explicitly does not want multi-process training; keep everything in a single ModelScope flow.
- Turn planner should interleave bot actions with predicted opponent responses using initiative-based ordering, show in popup, and revise on each state change.
- Model weights and game data should persist to a local Node.js server (port 3456) as JSON files, viewable via a browser dashboard.

## Progress
### Done
- Added `playerId` field to game recordings (`startNewRecording`) and lazy detection in `handlePageMessage` (GAMESTATE + GAME_EVENT with players).
- Installed `@tensorflow/tfjs` v4.22.0 and rewrote `model.js` to use TF.js — reverted due to CSP `'unsafe-eval'` restriction in MV3.
- Added NaN/overflow guards to hand-rolled `Layer` class: sigmoid input clamped to [-100, 100], `isFinite(sum)` checks in forward + backward, gradient clipping (dz to [-5,5], weight updates to [-10,10]).
- Verified Forceteki and Forceteki-Client repos contain zero bot detection, anti-cheat, rate limiting, or behavior monitoring code.
- **Replaced BCE sigmoid with ranking loss**: output layer changed to `linear`; added `Layer.backward()`, `Layer.applyGradients()`, `NeuralNet.trainRankingStep()` with per-state gradient accumulation and `topK` hard-negative mining param; added `trainModelRanking()` with hinge margin and adaptive LR/margin scheduling across epochs.
- **Fixed `failedActionKeys` deadlock**: `selectAiAction`, `cardToResource`, `trySequences`, `sendRecommendations` now filter out `failedActionKeys` from action list. When all actions filtered, clears set and retries. Moved `lastSentStateHash` capture to after the delay to prevent false-positive failures.
- **Added faster delay for ≤2 actions**: delay halved when `actions.length <= 2`, with a hard floor of 1000ms.
- **Initiative logic**: default go-first; if leader is `Dedra Meero` AND base is `Colossus`, passes initiative instead.
- **Added network visualization** to popup: 4-layer card showing Input(459) → Dense1(128,ReLU) → Dense2(64,ReLU) → Output(1,Linear) with size bars.
- **Added "Train Model Now" confirmation dialog**: browser `confirm()` before `startTraining` via popup button.
- **Hard negative mining + adaptive LR/margin**: `trainRankingStep` accepts `topK` (default 3) to only compare taken vs top-K highest-scoring non-taken. `trainModelRanking` now takes a params object with linear scheduling: `lr 0.003→0.001`, `marginWin 2.0→1.0`, `marginLoss 0.6→0.3`, `epochs 5`, `topK 3`. Post-game `trainOnGame` uses 3 epochs.
- **Turn planner system**: generates plan with bot actions scored, categorized, and interleaved with opponent predictions (via `encodeGameStateForPlayer`). Revised on each state change. Plan displayed in popup with status icons and scores. Plan consulted by `selectAiAction` before model fallback.
- **Added `encodeGameStateForPlayer(state, playerId)`** — encodes game state from any player's perspective for opponent action prediction.
- **Fixed plan blocking trigger/confirmation prompts**: removed phase restriction in `sendRecommendations` plan generation; added phase check in `selectAiAction` to only consult plan during `'action'`/`'resource'` phases.
- **Fixed `categorizeAction` crash**: changed `(action.arg || '').toLowerCase()` to `String(action.arg ?? '').toLowerCase()` — handles non-string `arg` values (e.g., number `0`).
- **Fixed plan using wrong actions**: `generateTurnPlan` now uses `getActionsForPlayer(state, botId)` instead of `getAvailableActions(state)` (which mixed opponent actions into bot list). Added `getBotActionsHash()` for plan state hash. Updated `reviseTurnPlan`, `selectAiAction`, and `sendRecommendations` hash comparisons.
- **Fixed variance collapse through ReLU layers**: added `outputScale` parameter to `Layer` class (default 1). Last layer uses `outputScale=5`. Forward applies `val *= outputScale`. Backward for linear uses `dz[o] = target[o] * this.outputScale`. `outputScale` persisted via `getWeights`/`setWeights`.
- **Fixed identical scores display**: added per-action score dispersion `hashActionKey(key) * 0.02 - 0.01` (range ±0.01) to bot and opponent plan items. Added `hashActionKey()` helper.
- **Added weight decay**: `trainRankingStep` passes `weightDecay = 0.01` to `applyGradients`. L2 penalty `weightDecay * this.w[i]` added to gradient.
- **Amplified action features**: `encodeActions` multiplies all features by `ACTION_GAIN = 5` for both training and inference.
- **Created local data server + dashboard**: Express server on port 3456 with REST API (`/api/health`, `/api/weights`, `/api/stats`, `/api/games`) storing data as JSON files. Dashboard SPA (`dashboard/index.html` + `dashboard.js`) with network visualization, accuracy chart (canvas), game browser with detail view, and export/clear controls. Server and dashboard auto-refresh every 30s.
- **Created `start-local.ps1` / `start-local.bat`**: clone + install + launch Forceteki server (:9500), client (:3000), and data server (:3456).
- **Extension auto-sync to server**: `syncToServer()` / `syncAllToServer()` in storage.js. Game recordings sync on `finalizeRecording`. Weights + stats sync after training. Dashboard button + editable server URL + Sync button in popup.
- **Host permission**: added `http://localhost:3456/*` to manifest.json.

### In Progress
- (none — server sync layer is minimal but functional)

### Blocked
- (none)

## Key Decisions
- **Ranking loss over BCE**: sigmoid + BCE saturates at 0 when trained on mostly-loss data (all labels 0.0). Ranking loss compares taken vs non-taken directly, never saturates, and every state contributes signal regardless of game outcome.
- **Loss games use weak margin (0.3 vs 1.0)**: avoids assuming every non-taken action was better — a game can be lost for reasons unrelated to a specific decision. Win games dominate the learning signal.
- **Gradient accumulation per state**: all actions in a state are forward-scored on identical weights before any backward pass, then gradients are accumulated and applied once. Prevents later actions from training on shifted weights.
- **Hard negative mining (topK=3)**: focuses gradient on the most confusing non-taken actions instead of diluting with obviously bad ones.
- **Adaptive LR/margin scheduling**: early epochs aggressively separate scores, later epochs fine-tune. Post-game training goes from 1→3 epochs.
- **Turn planning for structure, not lookahead**: plan organizes and displays bot actions with opponent predictions, but NN still scores actions independently per state. No game simulator available for state transition simulation.
- **Plan consulted before model fallback in selectAiAction**: plan's `current` bot item takes priority. Only falls to model if plan has no valid current/pending item. Restricted to `'action'`/`'resource'` phases.
- **failedActionKeys fallback**: when all actions are in the failed set, clear and retry. Catches stale / deadlocked states where no action can succeed until opponent or timer changes the state.
- **Dedra Meero + Colossus passes initiative**: specific meta-call based on user strategy.
- **outputScale=5 on last layer**: compensates for variance collapse through 3 ReLU layers. Properly handled in forward (output amplification) and backward (dz = target × scale) passes.
- **ACTION_GAIN=5**: amplifies sparse action features to match state features' impact, preventing the network from ignoring action differences.
- **Server persistence**: model weights, stats, and games stored as JSON files on disk via Express server, replacing IndexedDB for persistent storage (extension keeps IndexedDB as cache). Dashboard reads from server for visualization.

## Next Steps
- Run training to verify preference accuracy with outputScale, weight decay, and ACTION_GAIN fixes.
- Play games to confirm turn planner displays differentiated scores and auto-play works across all prompt types.
- Self-play (bot vs bot): use regular + incognito Chrome windows for separate extensions. Add `botPlayerId` setting.

## Critical Context
- **Accuracy metric is preference accuracy**: `score[taken] >= max(score[non-taken])` for wins, `score[taken] <= min(score[non-taken])` for losses. Fraction of states where correct. Stored as decimal, displayed as `(value * 100).toFixed(1) + '%'`.
- `trainModelRanking(model, games, params)` accepts object: `{ lrStart=0.003, lrEnd=0.001, marginWinStart=2.0, marginWinEnd=1.0, marginLossStart=0.6, marginLossEnd=0.3, epochs=5, topK=3 }`. Per-epoch scheduling via linear interpolation.
- `trainRankingStep(..., topK=0, weightDecay=0.01)` — when `topK > 0 && actions.length > 2`, only computes gradient against top-K highest-scoring non-taken actions. Weight decay applies L2 penalty during gradient application.
- Plan structure: `{ phase, round, stateHash, items: [{ action, description, score, source:'bot'|'opponent', status:'done'|'current'|'pending'|'predicted', category }], botId, oppId, generatedAt }`.
- Plan generated by `generateTurnPlan(state)` (async, loads model), revised by `reviseTurnPlan(state, plan)` (sync, async model load for new actions). Plan broadcast to popup via `PLAN_UPDATE` message and `GET_STATUS` response.
- Plan state hash uses `getBotActionsHash(state)` (bot-only actions via `getActionsForPlayer(state, botId)`) instead of `getActionSetHash` (all players).
- Plan items include dispersion `hashActionKey(key) * 0.02 - 0.01` added to score to prevent identical display values.
- `Layer` class `outputScale` is persisted in `getWeights()`/`setWeights()` for cross-session consistency.
- Forceteki has zero bot-detection or anti-automation code — no rate limits, timing analysis, action pattern monitors, or TOS against bots.
- Popup network visualization auto-renders via `renderNetwork()` on refresh. Layers hardcoded in `NETWORK_LAYERS` constant.
- Local server running on port 3456 provides REST API and dashboard SPA at `http://localhost:3456/`.
- Extension auto-syncs game recordings, weights, and stats to server on save/training. Sync is fire-and-forget (silent on failure).
- Popup has "Open Dashboard" button, editable server URL, and "Sync" button to bulk-push all data to server.

## Relevant Files
- `server/server.js`: Express server on port 3456, REST API for weights/stats/games, serves dashboard static files.
- `server/dashboard/index.html`: Dashboard SPA layout with network viz, stats, accuracy chart canvas, game list, export/clear controls.
- `server/dashboard/dashboard.js`: Dashboard logic — auto-refresh, fetch API, render accuracy chart (canvas 2D), game browser, toast notifications.
- `server/package.json`: Dependencies (express, cors).
- `src/background/model.js`: NeuralNet + Layer classes with `outputScale`, `backward` with scaled linear `dz`, `trainRankingStep` with `weightDecay`. `ACTION_GAIN=5` in `encodeActions`. `hashActionKey()` helper.
- `src/background/index.js`: Plan functions using `getActionsForPlayer`/`getBotActionsHash`, dispersion on plan scores, phase guards in `selectAiAction` and `sendRecommendations`, `categorizeAction` crash fix. Server sync handlers (`SET_SYNC_SERVER`, `SYNC_NOW`, `syncAllToServer()`).
- `src/background/storage.js`: IndexedDB persistence. Server sync helpers: `syncToServer()`, `loadFromServer()`, `getSyncServerUrl()`, `setSyncServerUrl()`.
- `src/popup/index.html`: Popup UI with network viz card, plan card, dashboard button, server URL input, sync button.
- `src/popup/index.js`: `renderNetwork()` draws 4-layer architecture; `renderPlan()` with status icons and scores; `PLAN_UPDATE` listener. Dashboard button opens server URL in new tab.
- `start-local.ps1` / `start-local.bat`: Clone + launch Forceteki server (:9500), client (:3000), and data server (:3456).
- `manifest.json`: Host permissions include `http://localhost:3456/*`.
