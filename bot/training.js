const { NeuralNet, encodeGameState, encodeActions } = require('./model');
const { getAvailableActions } = require('./util');

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

async function trainModelRanking(model, games, params = {}, onProgress) {
  const {
    lrStart = 0.003, lrEnd = 0.001,
    marginWinStart = 2.0, marginWinEnd = 1.0,
    marginLossStart = 0.6, marginLossEnd = 0.3,
    epochs = 5, topK = 3, sampleStates = 1
  } = params;
  const prefAccs = [];
  for (let epoch = 0; epoch < epochs; epoch++) {
    const t = epochs > 1 ? epoch / (epochs - 1) : 0;
    const epochLr = lrStart + (lrEnd - lrStart) * t;
    const epochMarginWin = marginWinStart + (marginWinEnd - marginWinStart) * t;
    const epochMarginLoss = marginLossStart + (marginLossEnd - marginLossStart) * t;
    for (let i = games.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [games[i], games[j]] = [games[j], games[i]];
    }
    let totalViolations = 0;
    let totalStates = 0;
    let correctPref = 0;
    let totalPref = 0;
    for (const game of games) {
      const winners = Array.isArray(game.winner) ? game.winner : (game.winner ? [game.winner] : null);
      const botWon = winners && game.playerId ? winners.includes(game.playerId) : null;
      if (botWon === null) continue;
      for (let i = 0; i < game.states.length - 1; i += sampleStates) {
        const stateObj = game.states[i]?.state;
        if (!stateObj || !stateObj.players) continue;
        const takenActions = game.actions.filter(a => a.stateIndex === i);
        if (takenActions.length === 0) continue;
        const allActions = getAvailableActions(stateObj);
        if (allActions.length < 2) continue;
        const stateTensor = encodeGameState(stateObj);
        const actionTensors = encodeActions(allActions);
        let takenIndex = -1;
        for (let j = 0; j < allActions.length; j++) {
          if (takenActions.some(ta => {
            const taType = ta.event === 'game' ? ta.args[0] : ta.event;
            const taArg = ta.event === 'game' ? ta.args[1] : ta.args[0];
            if (taType === 'menuButton' && allActions[j].type === 'menuButton')
              return String(taArg) === String(allActions[j].arg);
            if (taType === 'cardClicked' && allActions[j].type === 'cardClicked')
              return String(taArg) === String(allActions[j].cardId);
            return false;
          })) { takenIndex = j; break; }
        }
        if (takenIndex === -1) continue;
        const scores = allActions.map((_, j) => model.forward(stateTensor, actionTensors[j]));
        if (botWon) {
          const maxOther = Math.max(...scores.filter((_, idx) => idx !== takenIndex));
          if (scores[takenIndex] >= maxOther) correctPref++;
        } else {
          const minOther = Math.min(...scores.filter((_, idx) => idx !== takenIndex));
          if (scores[takenIndex] <= minOther) correctPref++;
        }
        totalPref++;
        const margin = botWon ? epochMarginWin : epochMarginLoss;
        totalViolations += model.trainRankingStep(stateTensor, actionTensors, takenIndex, botWon, epochLr, margin, topK);
        totalStates++;
      }
    }
    const prefAcc = totalPref > 0 ? correctPref / totalPref : 0;
    const avgViolations = totalStates > 0 ? totalViolations / totalStates : 0;
    console.log(`Epoch ${epoch + 1}: lr=${epochLr.toFixed(5)} mWin=${epochMarginWin.toFixed(3)} mLoss=${epochMarginLoss.toFixed(3)} topK=${topK} avg_violations=${avgViolations.toFixed(4)} pref_acc=${(prefAcc * 100).toFixed(2)}% (${correctPref}/${totalPref})`);
    prefAccs.push(prefAcc);
    if (onProgress) onProgress(epoch + 1, epochs, prefAcc);
    await yieldToEventLoop();
  }
  return { history: { pref_acc: prefAccs } };
}

module.exports = { trainModelRanking };
