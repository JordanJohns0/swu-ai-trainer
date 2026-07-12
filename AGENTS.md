# SWU AI Trainer — Project Summary

## Goal
Support running 5 bots that queue into Forceteki and play multiple concurrent games without cross-game state corruption; make bots handle all prompt types (indirect damage, choose option from list) using the neural net.

## Constraints & Preferences
- Bots must be in separate Chrome profiles (not incognito) — incognito windows share cookies, cannot queue into each other
- Multi-game session routing committed: `gameSessions` Map replaces all singletons
- Training uses ranking loss (hinge margin) on `(state, action)` score pairs — linear output, no sigmoid
- Bots use 1-3s delay (minWait-maxWait, halved for ≤2 actions, floored at 1000ms) regardless of opponent type
- TF.js is incompatible with MV3 (CSP blocks `'unsafe-eval'`)
- User explicitly does not want multi-process training; keep everything in a single ModelScope flow
- Model weights and game data persist to local Node.js server (port 3456)

## Progress
### Done
- **Multi-game session routing** (committed): replaced all singleton per-game globals (`currentGameRecording`, `botPlayerId`, `failedActionKeys`, `currentTurnPlan`) with `Map<serverGameId, session>`. LOBBYSTATE uses `lobby_${tabId}` fallback, migrated on first GAMESTATE. `finalizeRecording` sends auto-requeue to all `session.tabIds`.
- **Removed self-play zero-delay**, dead `startNewRecording()` removed, `.gitignore` added
- All prior features: NaN guards, ranking loss, topK mining, outputScale, ACTION_GAIN, weight decay, turn planner, local server/dashboard, extension auto-sync

### Done
- **`distributeAmongTargets` rewritten**: Instead of clicking individual cards (which did nothing for stateful prompts), the handler now reads `promptState.distributeAmongTargets`, scores target cards via NN, distributes damage/ healing proportionally by score, and submits via new `statefulPromptResults` action type. Falls back to old cardClicked behavior if promptData is not available.
- **`main.js` supports 4 action types**: `cardClicked`, `menuButton`, `pass`, and `statefulPromptResults` — the latter sends `swuAiSend('game', 'statefulPromptResults', a.distribution, a.uuid)`.
- **`getAvailableActions` extracts `dropdownListOptions`**: creates `menuButton` actions for each dropdown option in `promptState.dropdownListOptions` (used by `DropdownListPrompt` for "choose from list" prompts).

## Key Decisions
- **Session key is server game ID (`data.id`)**: confirmed consistent across all game states
- **5 Chrome profiles replace incognito**: separate profiles give each bot its own cookie jar and Forceteki account
- **Prompt actions are `menuButton`, `cardClicked`, `pass`, or `statefulPromptResults`**: content script (`main.js`) sends `menuButton(arg, uuid)`, `cardClicked(cardId)`, or `statefulPromptResults(distribution, uuid)`
- **`distributeAmongTargets` now submits `statefulPromptResults`**: reads prompt data (`type, amount, canDistributeLess, canChooseNoTargets, maxTargets`), scores targets via NN (cardClicked encoding), distributes proportionally by score, submits `{ type, valueDistribution: [{ uuid, amount }] }`. Done button command `statefulPromptResults` detected from prompt buttons.
- **`getAvailableActions`**: now has four extraction passes — buttons, dropdownListOptions, perCardButtons+displayCards, getSelectableCardIds
- **Card UUID format**: `card.uuid = 'Card' + '_' + id` (Forceteki 2.0, from `GameStateManager.ts:88`). Format is `Card_58`, `Card_194`, etc. This is the same format as what `getSelectableCardIds` returns.

## Next Steps
1. Test Boba Fett distribute ability: run bot in prod, verify it submits `statefulPromptResults` instead of card clicks
2. Add `botPlayerId` setting for user identification in recordings
3. Pick up multi-game testing with 5 Chrome profiles

## Critical Context
- **Incognito shares cookies**: all incognito tabs/windows from one Chrome profile share cookies. Cannot play against yourself. Need separate Chrome profiles (Settings → Profiles → Add profile) for each bot
- **`getAvailableActions`** in `index.js:1527`: now has four extraction passes — buttons, dropdownListOptions, perCardButtons+displayCards, getSelectableCardIds
- **`trySequences` distribute handler** in `index.js:1367`: reads `promptState.distributeAmongTargets`, scores targets via NN, submits `statefulPromptResults` with proportional distribution
- **`getSelectableCardIds`** in `index.js:1643`: checks card piles + player leader/base + `promptState.displayCards` for selectable cards
- **`sendRecommendations` fallback** in `index.js:1066`: scans `['buttons', 'options', 'choices', 'actions', 'menuItems', 'selections', 'prompts', 'triggers', 'items', 'entries', 'perCardButtons', 'players']` arrays, object-type `['options', 'choices', 'actions', 'selections']`, and creates cardClicked entries from `displayCards`
- **Prompt data flow**: Karabast WebSocket → `main.js` (MAIN world) → `window.postMessage` → `bridge.js` (ISOLATED) → `chrome.runtime.sendMessage` → `background/index.js`. Actions back: `bridge.js` → `chrome.tabs.sendMessage({ type: 'INJECT_AND_EXECUTE', action })` → `window.postMessage({ source: 'swu-ai-bridge', payload: { type: 'EXECUTE_ACTION', action } })` → `main.js` → `gameSocket.send()`
- **`encodeActions` handles `cardId`**: line 186 of model.js pushes `hashCardId(action.cardId)` for any action with a `cardId` property
- **`statefulPromptResults` bypasses client UI**: sends `42["game","statefulPromptResults",distribution,uuid]` directly via Socket.IO. Server calls `game.statefulPromptResults(userId, results, uuid)` → `DistributeAmongTargetsPrompt.onStatefulPromptResults`. Server expects `{ type: 'distributeDamage'|..., valueDistribution: [{ uuid: string, amount: number }] }`.
- **`DistributePromptType` enum values**: `'distributeDamage'`, `'distributeIndirectDamage'`, `'distributeHealing'`, `'distributeExperience'`, `'distributeAdvantage'`. Amounts must be integers, total should equal `amount` (unless `canDistributeLess` is true).
- **Card UUIDs in Forceteki 2.0**: `card.uuid = 'Card' + '_' + nextId` from `GameStateManager.ts:88`. `card.uuid === cardId` matching via `Game.findAnyCardInAnyList(cardId)`. `DistributeAmongTargetsPrompt.formatPromptResults` matches `target.uuid === card.uuid`.
- **Accuracy metric**: preference accuracy — `score[taken] >= max(score[non-taken])` for wins
- All other context from prior versions still applies (ranking loss, plan system, server sync, etc.)

## Relevant Files
- `chrome-extension/src/background/index.js`: core service worker — `loadAllSettings` (line 116), `trySequences` distribute handler (line 1367), `getAvailableActions` (line 1527), `getSelectableCardIds` (line 1643), `sendRecommendations` fallback (line 1066), `describeAction` (line 718), `getActionKey` (line 94)
- `chrome-extension/src/background/model.js`: NeuralNet, Layer, `encodeActions` with `cardId` hashing (line 186)
- `chrome-extension/src/content/main.js`: `EXECUTE_ACTION` handler with `statefulPromptResults` support (line 90), `swuAiSend` function
- `chrome-extension/src/content/bridge.js`: passes `INJECT_AND_EXECUTE` messages from background to main world
- `forceteki/server/game/core/gameSteps/prompts/DistributeAmongTargetsPrompt.ts`: server-side prompt handler, `formatPromptResults` matches against `legalTargets` by `card.uuid`
- `forceteki/server/game/core/Game.ts`: `findAnyCardInAnyList(cardId)` at line 691 finds card by `uuid`, `statefulPromptResults` at line 1076
- `forceteki/server/game/core/GameStateManager.ts:88`: UUID assignment `go.uuid = go.getGameObjectName() + '_' + nextId`
- `forceteki/server/game/core/card/Card.ts`: `getGameObjectName()` returns `'Card'`, `getSummary` at line 1389, `getCardState` at line 1436
- `src/background/storage.js`: IndexedDB persistence + server sync
- `src/content/main.js`: content script — sends `menuButton` and `cardClicked` actions
- `src/popup/index.html` / `index.js`: UI with network viz, plan card, dashboard button
- `server/`: Express server on port 3456, dashboard SPA
- `manifest.json`: host permissions include `http://localhost:3456/*`
