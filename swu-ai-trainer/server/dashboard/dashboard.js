const API = '';
let autoRefresh = null;

async function api(path, opts = {}) {
  try {
    const res = await fetch(API + path, opts);
    if (!res.ok) throw new Error(res.statusText);
    return await res.json();
  } catch (e) {
    if (!path.startsWith('/api/health')) console.warn('API error', path, e.message);
    return null;
  }
}

async function refresh() {
  const health = await api('/api/health');
  document.getElementById('srv-status-dot').className = 'status-dot ' + (health ? 'online' : 'offline');

  const [stats, games, weights] = await Promise.all([
    api('/api/stats'),
    api('/api/games'),
    api('/api/weights')
  ]);

  renderStats(stats);
  renderGames(games);
  renderWeights(weights);
  renderNetwork();
}

function renderNetwork() {
  const el = document.getElementById('network-viz');
  const layers = [
    { name: 'Input', size: 459, detail: 'State 395 + Action 64', extra: '' },
    { name: 'Dense 1', size: 128, detail: 'ReLU', extra: '' },
    { name: 'Dense 2', size: 64, detail: 'ReLU', extra: '' },
    { name: 'Output', size: 1, detail: 'Linear ×5', extra: 'output-layer' }
  ];
  el.innerHTML = layers.map((l, i) => {
    const cls = l.extra ? ` class="${l.extra}"` : '';
    const html = `<div class="layer"${cls}><div class="name">${l.name}</div><div class="size">${l.size}</div><div class="detail">${l.detail}</div></div>`;
    return i > 0 ? `<div class="arrow">\u2192</div>${html}` : html;
  }).join('');
}

function renderStats(stats) {
  document.getElementById('stat-games').textContent = stats?.gamesTrained ?? 0;
  document.getElementById('stat-last').textContent = stats?.lastTrainedAt ? new Date(stats.lastTrainedAt).toLocaleString() : '--';
  document.getElementById('stat-accuracy').textContent = stats?.accuracy != null ? (stats.accuracy * 100).toFixed(1) + '%' : '--';
  document.getElementById('stat-examples').textContent = stats?.examples ?? 0;
  renderAccuracyChart(stats?.accuracyHistory || []);
}

function renderAccuracyChart(history) {
  const canvas = document.getElementById('accuracy-canvas');
  const parent = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const rect = parent.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);

  if (!history || history.length < 2) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Need at least 2 training runs for chart', w / 2, h / 2);
    return;
  }

  const pad = { top: 10, bottom: 20, left: 10, right: 10 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;
  const values = history.map(h => h.accuracy);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = Math.max(maxV - minV, 0.01);

  // Line
  ctx.strokeStyle = '#58a6ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < values.length; i++) {
    const x = pad.left + (i / (values.length - 1)) * cw;
    const y = pad.top + ch - ((values[i] - minV) / range) * ch;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Fill
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
  grad.addColorStop(0, 'rgba(88, 166, 255, 0.15)');
  grad.addColorStop(1, 'rgba(88, 166, 255, 0.0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(pad.left + 0, pad.top + ch);
  for (let i = 0; i < values.length; i++) {
    const x = pad.left + (i / (values.length - 1)) * cw;
    const y = pad.top + ch - ((values[i] - minV) / range) * ch;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(pad.left + cw, pad.top + ch);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#8b949e';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText((maxV * 100).toFixed(1) + '%', pad.left, pad.top - 2);
  ctx.fillText((minV * 100).toFixed(1) + '%', pad.left, pad.top + ch + 14);
  ctx.textAlign = 'right';
  ctx.fillText(history.length + ' runs', pad.left + cw, pad.top + ch + 14);
}

function renderGames(games) {
  document.getElementById('game-count').textContent = (games || []).length;
  const list = document.getElementById('game-list');
  if (!games || games.length === 0) {
    list.innerHTML = '<div style="color:var(--text-dim);padding:8px 0">No recorded games</div>';
    return;
  }
  list.innerHTML = games.map(g => {
    const ts = g.timestamp ? new Date(g.timestamp).toLocaleString() : '--';
    const won = g.winner ? (Array.isArray(g.winner) ? g.winner.join(',') : g.winner) : '--';
    return `<div class="game-item">
      <span class="id" onclick="showGameDetail('${g.gameId}')">#${g.gameNumber || '?'}</span>
      <span>${ts}</span>
      <span class="meta">
        <span>${g.stateCount || 0} states</span>
        <span>${g.actionCount || 0} actions</span>
        <span>P${g.playerId || '?'}</span>
        <span>Winner: ${won}</span>
        <span>${g.trained ? '\u2713 trained' : '\u25CB untrained'}</span>
      </span>
    </div>`;
  }).join('');
}

async function showGameDetail(gameId) {
  const detail = document.getElementById('game-detail');
  if (detail.style.display === 'block' && detail.dataset.gameId === gameId) {
    detail.style.display = 'none';
    return;
  }
  const game = await api('/api/games/' + gameId);
  if (!game) { detail.style.display = 'none'; return; }
  detail.dataset.gameId = gameId;
  detail.textContent = JSON.stringify(game, null, 2);
  detail.style.display = 'block';
}

function renderWeights(weights) {
  const el = document.getElementById('weights-status');
  if (!weights || !weights.layers) {
    el.textContent = 'No saved weights';
    return;
  }
  el.textContent = weights.layers.length + ' layers, ' + formatSize(JSON.stringify(weights).length);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / 1048576).toFixed(1) + 'MB';
}

async function exportData() {
  const games = await api('/api/games');
  if (!games || games.length === 0) { showToast('No games to export'); return; }
  const full = [];
  for (const g of games) {
    const game = await api('/api/games/' + g.gameId);
    if (game) full.push(game);
  }
  const blob = new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'swu-ai-games-' + Date.now() + '.json'; a.click();
  URL.revokeObjectURL(url);
  showToast('Exported ' + full.length + ' games');
}

async function exportWeights() {
  const weights = await api('/api/weights');
  if (!weights || !weights.layers) { showToast('No weights to export'); return; }
  const blob = new Blob([JSON.stringify(weights, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'swu-ai-weights-' + Date.now() + '.json'; a.click();
  URL.revokeObjectURL(url);
  showToast('Weights exported');
}

async function clearGames() {
  if (!confirm('Delete all game recordings?')) return;
  await api('/api/games', { method: 'DELETE' });
  showToast('Games cleared');
  refresh();
}

async function clearAll() {
  if (!confirm('Delete ALL data (games + weights + stats)? This cannot be undone.')) return;
  await api('/api/games', { method: 'DELETE' });
  await api('/api/weights', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await api('/api/stats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  showToast('All data cleared');
  refresh();
}

function showToast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 3000);
}

function startAutoRefresh() {
  refresh();
  let countdown = 30;
  const el = document.getElementById('refresh-countdown');
  autoRefresh = setInterval(() => {
    countdown--;
    el.textContent = countdown + 's';
    if (countdown <= 0) { countdown = 30; refresh(); }
  }, 1000);
}

document.addEventListener('DOMContentLoaded', startAutoRefresh);
