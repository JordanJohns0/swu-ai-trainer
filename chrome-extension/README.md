# SWU AI Trainer — Chrome Extension

A Chrome extension that hooks into [Karabast.net](https://karabast.net) to record Star Wars: Unlimited games and train a neural network AI that can play the game.

## Features

- **Game Recording** — Intercepts Socket.IO traffic on Karabast to record every game state and player action
- **Learning from wins/losses** — Labels each action as good (won the game) or bad (lost), then trains a TensorFlow.js model in-browser
- **AI Auto-Play** — The model can take over and play moves for you using what it's learned
- **Popup UI** — Shows recording stats, training progress, and controls at the click of the extension icon

## How It Works

### Data Collection

1. The extension injects a script into Karabast that patches the Socket.IO `io()` constructor
2. All `gamestate` events from the server are captured (full game state JSON)
3. All outgoing `game` and `lobby` events are captured (player actions)
4. At the end of a game, the entire recording (sequence of states + actions + winner) is saved to IndexedDB

### Training

1. Each game recording labels every action based on the outcome: actions from the winner get label `1.0`, actions from the loser get `0.0`
2. Game states are encoded into fixed-size feature vectors (scalar features + card-level features per zone)
3. A TensorFlow.js neural network is trained on pairs of (state, action) -> score
4. The model has two inputs: a state vector (256 floats) and an action feature vector (64 floats), with a shared dense network and a sigmoid output
5. Training runs entirely in the extension's service worker

### Inference (AI Play)

1. At each decision point, the extension reads the `promptState` from the latest `gamestate` to find available actions (buttons and selectable cards)
2. Each available action is encoded as a feature vector
3. The model scores each (state, action) pair
4. The highest-scoring action is sent back to the page via Socket.IO `emit('game', ...)`

## Architecture

```
chrome-extension/
├── manifest.json                 # MV3 manifest
├── icons/                        # Extension icons
├── src/
│   ├── content/
│   │   ├── index.js              # Content script — bridges page ↔ background
│   │   └── inject.js             # Injected into page — patches Socket.IO
│   ├── background/
│   │   ├── index.js              # Service worker — message routing, game recording, AI loop
│   │   ├── storage.js            # IndexedDB persistence layer
│   │   └── model.js              # TensorFlow.js model, encoder, trainer, inference
│   └── popup/
│       ├── index.html            # Popup UI
│       ├── index.js              # Popup logic
│       └── style.css             # Popup styles
```

### Data Flow

```
Karabast Page → inject.js (patches Socket.IO) → postMessage
    → content/index.js → runtime.sendMessage
        → background/index.js (records state, triggers AI)
            → IndexedDB (save/load games)
            → model.js (TensorFlow.js inference/training)
        ← background → content → page (AI action via socket.emit)
```

## Installation

1. Open Chrome and go to `chrome://extensions`
2. Enable "Developer mode" (toggle top-right)
3. Click "Load unpacked" and select the `chrome-extension/` folder
4. Navigate to Karabast.net and start a game

## Usage

1. Click the extension icon to open the popup
2. Toggle "Record Games" on (default)
3. Play games normally on Karabast — each game is recorded automatically
4. Click "Train Model Now" to train on recorded games (requires ~5+ games for meaningful results)
5. Toggle "AI Auto-Play" to let the AI make moves during a game
6. Use "Trigger AI Move" to request a single AI suggestion

## Data Privacy

All data is stored locally in IndexedDB within your browser. Nothing is sent to any server. Use "Export Data" to download your recordings as JSON, or "Clear All Data" to wipe everything.

## Limitations

- The current feature encoding uses simple hash-based card IDs instead of learned embeddings
- Training runs in the service worker and may be slow on very large datasets (100+ games)
- The model architecture is a basic MLP — not powerful enough for expert-level play
- Only handles `menuButton` and `cardClicked` actions (not `statefulPromptResults` for complex prompts like distribute-damage)

## Future Improvements

- Use Transformer/attention layers for better state understanding
- Proper card embeddings (train embeddings on card text/abilities)
- Reinforcement learning (self-play via headless Forceteki game engine)
- Export training data to Python for more powerful model training
- Handle all prompt types including distribute-damage and number prompts
- Integrate with Forceteki directly for self-play training without UI
