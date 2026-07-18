const { loadModel, loadGameRecordings, loadTrainingStats, saveTrainingStats, saveTrainingProgress } = require('./storage');
const { trainModelRanking } = require('./training');
async function run() {
  console.log('Loading model...');
  const model = await loadModel();
  console.log('Loading recordings...');
  const recordings = await loadGameRecordings();
  console.log('Training on', recordings.length, 'games...');
  await saveTrainingProgress({ startedAt: Date.now(), games: recordings.length });
  await trainModelRanking(model, recordings, {}, (epoch, total, prefAcc) => {
    console.log('Epoch', epoch, '/', total, 'prefAcc:', prefAcc);
  });
  await model.save();
  console.log('Training complete!');
  await saveTrainingProgress({ startedAt: Date.now(), games: recordings.length, completedAt: Date.now() });
  process.exit(0);
}
run().catch(e => { console.error(e.message||e); process.exit(1); });
