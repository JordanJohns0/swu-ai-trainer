# SWU AI Trainer

A neural network-based AI that learns to play **Star Wars: Unlimited** (SWU) by training on game data from Karabast.

## Goal

Train a neural network to select the optimal game action at any decision point in a SWU game. Given the full game state, the model should output a single action from the set of currently legal actions.

## Input Features

The model accepts a structured encoding of the entire observable game state:

| Input | Description |
|-------|-------------|
| **Decklist** | The full 50-card deck (leader, base, main deck, sideboard) as card ID embeddings |
| **Cards in Hand** | Cards currently in the player's hand (up to ~10) |
| **Cards in Resources** | Cards currently in the resource zone, split by exhausted vs ready |
| **Cards in Discard Pile** | Cards in the player's discard pile (present and past game actions) |
| **Cards in Deck** | Remaining cards in the draw deck (with position known for RL, unknown for supervised) |
| **Board State** | Units in play across Ground and Space arenas, with: card ID, damage, exhaust status, upgrades, tokens, modifiers |
| **Leader & Base** | Current state of the leader (active/deployed side, exhausted/ready, damage) and base (remaining HP) |
| **Opponent's Discard Pile** | Visible cards in the opponent's discard pile |
| **Opponent's Hand Size** | Number of cards in opponent's hand (contents are hidden) |
| **Opponent's Resources** | Number of exhausted and ready opponent resources |
| **Available Game Actions** | Encoded list of all currently legal actions the player can take (play card X, attack with Y, activate ability Z, pass) |
| **Resource Counts** | Number of exhausted and ready friendly resources |
| **Turn/Phase Info** | Current turn number, phase, action number, initiative status |

## Output

A **single selected action** from the set of available actions. Each possible action is scored, and the highest-scoring legal action is chosen.

This can be formulated as:
- **Classification**: Choose from a fixed-size action embedding space (masked to legal actions)
- **Pointer Network**: Select one item from a variable-length list of action candidates

## Training Approaches

### Approach 1: Supervised Learning (Behavioral Cloning)

Log every decision point from human games on Karabast — the full game state + the action the human took — and train the model to imitate human play.

**Pros:** Can use existing game replay data. Mimics human strategy.
**Cons:** Limited by the quality of the training data; won't exceed human performance.

**Data source:** Forceteki's action pipeline already captures every decision. Each `ActionWindow` pause (waiting for a `cardClicked` or `menuButton` event) is a natural logging point. We would need to record:
- Serialized game state at the decision point
- The chosen action (card + mode + target)
- The outcome (eventual win/loss for optional reward weighting)

### Approach 2: Reinforcement Learning (Self-Play)

Have the AI play games against itself (or a rules-based bot) via Forceteki's game engine. After each game, assign a reward (+1 for win, -1 for loss) and use a policy gradient method (e.g., PPO, DQN, or A2C) to update the model.

**Pros:** Can discover novel strategies and surpass human play.
**Cons:** Much harder to train; requires integrating the neural network directly into Forceteki's action loop; computationally expensive; sparse reward signal.

**Data source:** The Forceteki engine runs games deterministically given seeded RNG. The AI hooks into the `ActionWindow.getCardLegalActions()` call and replaces the human-input wait with a model inference call.

## Project Structure

```
swu-ai-trainer/
  README.md                    # This file
  research-findings.md         # Analysis of Forceteki & TCGEngine architectures
  data/                        # Training data (logged games)
  model/                       # Neural network definition
  trainer/                     # Training pipeline
  inference/                   # Model inference / AI player
  config/                      # Hyperparameters and config
```

## Implementation Plan (Future)

1. **Data Pipeline** - Instrument Forceteki to log game states + actions to a file/database
2. **Feature Encoding** - Build encoders to convert game state into tensor format
3. **Model Definition** - Design the neural network architecture
4. **Training** - Implement supervised or RL training loop
5. **Integration** - Create an AI player module that plugs into Forceteki's action window
6. **Evaluation** - Test win rate vs baseline opponents

## Technologies (TBD)

- Python + PyTorch or TensorFlow for the neural network
- Forceteki's TypeScript engine for game simulation
- File-based or database storage for training data
