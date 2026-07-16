const r = require('/home/jordan/swu/swu-ai-trainer/server/data/recordings.json');
console.log('total:', r.length);
const gs = {};
r.forEach(x => { const g = x.gameId; if (!gs[g]) gs[g] = []; gs[g].push(x); });
console.log('games:', Object.keys(gs).length);
Object.entries(gs).forEach(([gid, recs]) => {
  console.log('game', gid.substring(0,12), 'recs:', recs.length);
  recs.forEach(rec => console.log('  ', (rec.playerName||'?').substring(0,45), JSON.stringify(rec.winner)));
});
