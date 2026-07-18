# Fixes applied (this pass)

## Security

**`monitor/monitor.js`**
- Was bound to `0.0.0.0` (all interfaces) with zero authentication on any route, and built remote SSH shell commands by directly interpolating client-supplied values (e.g. bot name) into a quoted string — a bot/deck name containing a `'` or `$(...)` could run arbitrary shell commands on your Ubuntu box as your SSH user.
- Now binds to `127.0.0.1` by default (`MONITOR_BIND_HOST` to change), requires an `x-api-key` header matching `MONITOR_API_KEY` on every `/api/*` route when that env var is set, and logs a loud warning on startup if it's running without a key. All values that reach a remote SSH command are now either shell-escaped (`shellEscape()`) or passed through as base64 + piped to stdin instead of being spliced into a quoted string.
- **Action needed:** set `MONITOR_API_KEY` to a random secret before you ever expose this beyond localhost, and pass the same value as the `x-api-key` header from wherever you load the dashboard.

**`server/server.js`** (the data/dashboard API on the Ubuntu box)
- Was bound to all interfaces, had `cors()` wide open (`Access-Control-Allow-Origin: *`), and let anyone hit `DELETE /api/games` to wipe your entire training corpus with no confirmation.
- Now binds to `127.0.0.1` by default (`SERVER_BIND_HOST`), gates `/api/*` behind `SERVER_API_KEY` when set, restricts CORS to `SERVER_CORS_ORIGIN` if you set one (default: no cross-origin access), and `DELETE /api/games` now requires `{"confirm": true}` in the body on top of the key.

**`bot/driver.js`**
- Was implicitly bound to all interfaces (Node's default), so its unauthenticated bot-control endpoints (`/api/bots/remove`, etc.) were reachable directly from the LAN, bypassing the SSH tunnel entirely.
- Now explicitly binds to `127.0.0.1` (`DRIVER_BIND_HOST` to change) — it's only ever meant to be reached from `monitor.js` via the SSH tunnel or from `localhost`.

## Correctness — self-play concurrency

**`bot/util.js`**
- `failedActionKeys`, `currentPlayerId`, and the model cache were module-level singletons. In self-play mode `bot.js` runs both bots in one process, so this state was shared: bot1 marking a generic action key (e.g. `menuButton:done`) as failed could silently suppress that action for bot2's unrelated game.
- Replaced with `createBotContext()` — each bot instance now gets its own independent state object, threaded through `selectAiAction`, `trySequences`, `cardToResource`, and `getMyPlayerState`.
- As part of the same refactor: `cachedModel` was declared but **never actually assigned**, so every single decision point was re-reading and re-parsing `weights.json` from disk and rebuilding a `NeuralNet` from scratch. The new per-bot context now really does cache the model, invalidating only when `weights.json`'s mtime changes (i.e., after training writes new weights).

**`bot/bot.js`**
- Both the `connect_error` (after 5 failures) and `disconnect` handlers independently called `startBot(id, name)` with no guard, so a single disconnect event could spawn two concurrent processes/sockets for the same bot id. Added a `restarting` flag so only one restart happens per drop.
- `gamesPlayed` (which gates `TRAIN_EVERY_N`) was incremented independently by each self-play bot for what's really one shared game (both bots receive the same game's completion event), so training triggered roughly twice as often as intended. Added `countGameOnce()` to dedupe by `gameId`.

## Performance

**`bot/training.js`**
- `trainModelRanking` only yielded to the event loop once per epoch. On a large batch this could block the single Node process — including the live Socket.IO connections for actively-playing bots — for an extended stretch. Now yields every few games.

**`bot/storage.js`**
- `loadGameRecordings()` read and JSON-parsed *every* recorded game from disk on every training run, even though only games newer than the last training cutoff are used. It now `stat()`s each file first and skips parsing anything older than the cutoff (recordings are written right after game completion, so file mtime is a reliable proxy for `completedAt`), and yields periodically during the scan.

## Housekeeping
- Removed `chrome-extension/src/background/model.js.bak`, a stray backup file that had been committed to the repo.

## Not changed (flagged, not fixed — worth a decision from you)
- `chrome-extension/src/background/` still duplicates the action-selection/model logic in `bot/` as a separate implementation for browser-based play. A fix in one won't propagate to the other. Consolidating them (e.g. a shared package) is a bigger refactor than this pass covers.
- `selectAiAction`'s hardcoded overrides (never pick Cancel/Close, avoid `pass`/`done` in favor of a card click) still override whatever the network scores highest. Left in place since removing them changes bot behavior, not just fixes a bug — your call whether/how much to loosen them.
