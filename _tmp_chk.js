const r = require('/home/jordan/swu/swu-ai-trainer/server/data/recordings.json');
const gs = {};
r.forEach(x => { const g = x.gameId; if (!gs[g]) gs[g] = []; gs[g].push(x); });
console.log('total recs:', r.length, 'games:', Object.keys(gs).length);
Object.entries(gs).forEach(([gid, recs]) => {
  if (recs.length > 1) console.log('DUAL:', gid.substring(0,12), recs.length, recs.map(r => r.playerName?.substring(0,20)).join(','));
  else console.log('SINGLE:', gid.substring(0,12), recs[0].playerName?.substring(0,30), JSON.stringify(recs[0].winner));
});
