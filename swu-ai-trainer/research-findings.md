# Research Findings: Forceteki & TCGEngine Architecture

## 1. Forceteki (Karabast Server)

**Location:** `../forceteki/`
**Language:** TypeScript (Node.js)
**Purpose:** Real-time multiplayer server for Star Wars: Unlimited

### Game Engine Architecture

The core game engine lives in `server/game/core/` and is centered on the `Game` class (`server/game/core/Game.ts`, ~2030 lines).

#### Game Pipeline (server/game/core/GamePipeline.ts)

A stack-based step execution system. Steps are pushed onto the pipeline and executed LIFO. When a step requires player input, it returns `false`, pausing the pipeline. When input arrives, the pipeline resumes. This is the mechanism we'd hook into for AI decisions.

```
pipeline steps:
  SetupPhase -> beginRound() -> ActionPhase -> RegroupPhase -> beginRound() -> ...
```

#### Player State (server/game/core/Player.ts, ~1369 lines)

Each player's state is organized into zones decorated with `@stateRef()`:

- `handZone` — cards in hand (hidden from opponent)
- `deckZone` — draw deck
- `discardZone` — discard pile
- `resourceZone` — resources with exhausted/ready tracking
- `baseZone` — the base card (HP tracking)
- `leader` — the leader card (deployed/undeployed, exhausted/ready, damage)
- `outsideTheGameZone` — tokens and removed cards

Additional state: `passedActionPhase`, `costAdjusters`, `decklist`, `promptState`

#### Arena Zones (server/game/core/zone/)

Cards on the battlefield are split into:
- `GroundArenaZone` — ground units
- `SpaceArenaZone` — space units
- `AllArenasZone` — combined view

Each zone supports card filtering by aspect, trait, type, keyword, or custom condition.

#### Game State Serialization (Game.getState(), line 1658)

State is serialized to JSON for client delivery via `getState()`. Each player sees their own hand but only the opponent's hand size (not contents). This is the same view the AI would have.

#### Action System (server/game/core/gameSteps/ActionWindow.ts, ~363 lines)

When it's a player's turn:
1. `ActionWindow` presents available actions to the player
2. `getCardLegalActions()` filters each card's actions by requirements (cost, targeting, etc.)
3. The player selects an action (card click or menu button)
4. The action goes through `AbilityResolver` -> `EventWindow` -> game state changes
5. After resolution, the pipeline rotates the active player

**This `ActionWindow.prompt()` pause-and-wait-for-input is the hook point for injecting an AI decision.** Instead of waiting for a WebSocket message, we'd call the model to pick from the `getCardLegalActions()` results.

#### Card Data Model (server/utils/cardData/CardDataInterfaces.ts)

Each card is defined by `ICardDataJson`:
- `id`, `title`, `subtitle`, `cost`, `hp`, `power`
- `aspects[]`, `traits[]`, `arena`, `keywords[]`, `types[]`
- `setId`, `internalName`

#### Game Systems (server/game/gameSystems/ ~97 files)

Game state changes are made through `GameSystem` subclasses: `DamageSystem`, `DrawSystem`, `ExhaustSystem`, `HealSystem`, `PlayCardSystem`, `PutIntoPlaySystem`, etc. Each has `canAffect()` (for legality checking) and `eventHandler()` (for applying changes).

#### Key Takeaway for AI Integration

**Forceteki has no AI/bot functionality.** Every decision point waits for human input via WebSocket. Integrating an AI requires:

1. Creating a new `Player` subclass (or modifying the existing one) that calls a model inference instead of waiting for WebSocket input
2. Hooking into `ActionWindow.getCardLegalActions()` to get the list of valid actions at each decision point
3. Returning the chosen action as if it came from a human

---

## 2. TCGEngine (SWUStats)

**Location:** `../TCGEngine/`
**Language:** PHP
**Purpose:** TCG deck builder, game simulator, and stats aggregation for multiple TCGs

### Game Data Collection

#### SubmitGameResult.php (APIs/SubmitGameResult.php)

Karabast sends game results to this endpoint after each game completes. The payload includes:

- Winner, first player, turn count, winner health
- Per-player `cardResults`: aggregated counts of how many times each card was `played`, `resourced`, `discarded`, `drawn`
- Deck links (swustats.net URLs)
- Leader and base IDs

**Critically, this is NOT turn-by-turn data.** It's a post-game summary of aggregated card stats. There is no sequence of game states or actions — just final results and per-card usage counts.

#### Database Schema (Database/database.sql)

The `completedgame` table stores per-game summaries, and `deck_game_raw_data` stores the raw JSON payload for later processing. The `cardmetastats` and `carddeckstats` tables track aggregated card performance across many games.

### Game Simulation Engine

TCGEngine has its own game simulation engine (separate from Forceteki) with:
- File-based gamestate storage (`Gamestate.txt`)
- Decision queue system (`DecisionQueueController.php`)
- Turn controller state machine (generated from `TurnSchema.txt`)
- Card ability scripts stored in the database (`card_abilities` table)
- Regression testing framework (`RegressionTestFramework.php`) for recording/replaying games

This engine supports multiple TCGs (Grand Archive, Azuki, Gudnak, etc.) but its SWU support is limited to deck building, not full game simulation.

### Key Takeaway for AI Integration

**TCGEngine does NOT contain turn-by-turn game data.** It only receives post-game aggregated summaries. This means:

- There is no existing repository of (state, action) pairs at decision granularity
- **Supervised learning** would require new instrumentation in Forceteki to log each decision point
- TCGEngine's regression test framework shows the recording format we'd want: initial state + sequence of actions + final state

---

## 3. Recommendations for Data Collection

### For Supervised Learning

Instrument Forceteki to log a training record at every `ActionWindow` decision point:

```
{
  "gameId": "uuid",
  "timestamp": 1234567890,
  "player": "p1",
  "roundNumber": 3,
  "phase": "action",
  "gameState": { /* full serialized game state via getState() */ },
  "legalActions": [ /* list of { cardId, actionType, targets } */ ],
  "chosenAction": { /* the action the human selected */ },
  "eventualWinner": "p1"
}
```

This would be written to a file or database for offline training.

[See TCGEngine's RegressionTestFramework.php](file:///C:/Users/epicm/Desktop/Shared/SWUBot/TCGEngine/Core/RegressionTestFramework.php) for a model of action-by-action recording.

### For Reinforcement Learning

Create an `AIPlayer` class in the Forceteki codebase that:
1. Extends the existing `Player` class
2. Overrides the input-waiting methods to call a neural network
3. Uses the `Game` class's `Randomness` provider for seeded reproducibility
4. Connects to a Python inference server (or runs ONNX model directly in Node.js)

The training loop:
1. Start a game with two `AIPlayer` instances
2. At each `ActionWindow`, the model picks an action
3. After the game, compute reward (+1 for win, -1 for loss)
4. Store the trajectory (state, action, reward) for policy gradient updates

### Hybrid Approach

Start with supervised learning (collect human game logs), then fine-tune with RL (self-play). This is the standard approach used by AlphaGo and similar game AIs.

---

## 4. File Reference

### Forceteki (Key Files)

| File | Purpose |
|------|---------|
| `server/game/core/Game.ts` | Central game orchestrator |
| `server/game/core/GamePipeline.ts` | Step execution engine |
| `server/game/core/Player.ts` | Player state and zones |
| `server/game/core/gameSteps/ActionWindow.ts` | Action/pass loop — AI hook point |
| `server/game/core/gameSteps/AbilityResolver.ts` | Ability resolution pipeline |
| `server/game/core/card/Card.ts` | Base card class |
| `server/game/core/Constants.ts` | All enums (ZoneName, CardType, etc.) |
| `server/game/core/zone/` | Zone implementations (Hand, Deck, Discard, Resource, Arena) |
| `server/game/gameSystems/` | Game state change systems (~97 files) |
| `server/utils/cardData/CardDataInterfaces.ts` | Card JSON data types |

### TCGEngine (Key Files)

| File | Purpose |
|------|---------|
| `APIs/SubmitGameResult.php` | Game result submission endpoint |
| `Core/RegressionTestFramework.php` | Action recording/replay framework |
| `Database/database.sql` | Database schema |
| `ProcessInput.php` | Action processing entry point |
| `Core/EngineActionRunner.php` | Action execution engine |
| `Core/DecisionQueueController.php` | Decision queue management |
