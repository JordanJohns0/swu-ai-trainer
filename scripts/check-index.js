var idx = JSON.parse(require('fs').readFileSync('/home/jordan/swu/swu-ai-trainer/server/data/recording_index.json', 'utf8'));
var w = idx.filter(function(e){ return e.winner && e.winner !== '[Circular]'; }).length;
var nw = idx.filter(function(e){ return !e.winner || e.winner === '[Circular]'; }).length;
console.log('valid: ' + w + ' bad: ' + nw + ' total: ' + idx.length);
if (idx.length > 0) console.log('sample:', JSON.stringify(idx.slice(0, 3)));
