const bg = chrome.runtime;

function $id(id) { return document.getElementById(id); }

const NETWORK_LAYERS = [
  { label: 'Input', size: 459, detail: 'State 395 + Action 64', cls: 'input-layer', barPct: 100 },
  { label: 'Dense 1', size: 128, detail: 'ReLU', cls: '', barPct: 28 },
  { label: 'Dense 2', size: 64, detail: 'ReLU', cls: '', barPct: 14 },
  { label: 'Output', size: 1, detail: 'Linear (Score)', cls: 'output-layer', barPct: 0.5 },
];

function renderNetwork() {
  const el = document.getElementById('network-viz');
  if (!el) return;
  const arrowSvg = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 8h10M8 4l4 4-4 4" stroke="#30363d" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  el.innerHTML = NETWORK_LAYERS.map((l, i) => {
    const html = `<div class="layer ${l.cls}"><div class="layer-label">${l.label}</div><div class="layer-size">${l.size}</div><div class="layer-detail">${l.detail}</div><div class="size-bar" style="height:${l.barPct}%"></div></div>`;
    return i > 0 ? `<div class="arrow">${arrowSvg}</div>${html}` : html;
  }).join('');
}

function renderPlan(plan) {
  const section = $id('plan-section');
  const headerEl = $id('plan-header');
  const itemsEl = $id('plan-items');
  if (!plan || !plan.items || plan.items.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  headerEl.textContent = `Round ${plan.round ?? '?'} · ${(plan.phase || '?').charAt(0).toUpperCase() + (plan.phase || '?').slice(1)} Phase`;

  let html = '';
  for (const item of plan.items) {
    const isBot = item.source === 'bot';
    const status = item.status;
    const label = item.description || item.action?.arg || item.action?.cardId || 'Action';
    const score = item.score != null ? item.score.toFixed(3) : '';
    const cat = item.category || '';
    const statusIcon = status === 'done' ? '&#10003;' : status === 'current' ? '&#9654;' : status === 'predicted' ? '&#9670;' : '&nbsp;';
    const cls = `plan-item plan-${status === 'done' ? 'done' : status === 'current' ? 'current' : status === 'predicted' ? 'predicted' : 'pending'} plan-${isBot ? 'bot' : 'opp'}`;
    html += `<div class="${cls}" title="${cat}">`;
    html += `<span class="plan-icon">${statusIcon}</span>`;
    html += `<span class="plan-label">${label}</span>`;
    if (score) html += `<span class="plan-score">${score}</span>`;
    html += `<span class="plan-source">${isBot ? 'B' : 'O'}</span>`;
    html += `</div>`;
  }
  itemsEl.innerHTML = html;
}

function log(msg) {
  const el = $id('log');
  const d = document.createElement('div');
  d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
}

async function refreshStatus() {
  const [status, connection] = await Promise.all([
    bg.sendMessage({ type: 'GET_STATUS' }),
    bg.sendMessage({ type: 'CHECK_CONNECTION' }).catch(() => null)
  ]);
  if (!status) return;
  $id('game-count').textContent = status.recordings ?? 0;
  $id('trained-count').textContent = status.stats?.gamesTrained ?? 0;
  $id('model-accuracy').textContent = status.stats?.accuracy != null ? (status.stats.accuracy * 100).toFixed(1) + '%' : '--';
  $id('active-game').textContent = status.activeGame ? 'Yes' : 'No';
  $id('page-status').textContent = connection?.pageOk ? 'Yes' : 'No';
  $id('toggle-recording').checked = status.enabled !== false;
  $id('connection-status').className = 'status-dot ' + (connection?.pageOk && (status.activeGame || status.recordings > 0) ? 'online' : 'offline');

  $id('toggle-requeue').checked = status.autoRequeue === true;
  $id('toggle-auto-train').checked = status.autoTrain === true;
  $id('toggle-auto-play').checked = status.autoPlay === true;

  $id('wait-section').style.display = status.autoPlay ? 'block' : 'none';
  if (status.autoPlay) {
    const minSec = (status.minWait ?? 1000) / 1000;
    const maxSec = (status.maxWait ?? 3000) / 1000;
    $id('min-wait').value = minSec;
    $id('max-wait').value = maxSec;
    $id('min-wait-val').textContent = minSec.toFixed(1) + 's';
    $id('max-wait-val').textContent = maxSec.toFixed(1) + 's';
  }

  const canTriggerAi = status.isAiPlaying && status.activeGame;
  $id('toggle-ai-play').disabled = false;
  $id('toggle-ai-play').checked = status.isAiPlaying;
  $id('btn-trigger-ai').disabled = !canTriggerAi;

  // Load server URL
  if (status.syncServerUrl) {
    $id('server-url').value = status.syncServerUrl;
  }

  renderPlan(status.plan);
}

document.addEventListener('DOMContentLoaded', () => {
  renderNetwork();
  refreshStatus();
  setInterval(refreshStatus, 2000);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PLAN_UPDATE') {
    renderPlan(msg.plan);
  }
});

$id('toggle-recording').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  await bg.sendMessage({ type: 'TOGGLE_RECORDING', enabled });
  log(enabled ? 'Recording enabled' : 'Recording disabled');
});

$id('toggle-ai-play').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  await bg.sendMessage({ type: 'TOGGLE_AI_PLAY', enabled });
  log(enabled ? 'Show AI recommendations enabled' : 'Show AI recommendations disabled');
  refreshStatus();
});

$id('toggle-requeue').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  await bg.sendMessage({ type: 'TOGGLE_AUTO_REQUEUE', enabled });
  log(enabled ? 'Auto requeue enabled' : 'Auto requeue disabled');
});

$id('toggle-auto-train').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  await bg.sendMessage({ type: 'TOGGLE_AUTO_TRAIN', enabled });
  log(enabled ? 'Auto-train after game enabled' : 'Auto-train after game disabled');
});

$id('toggle-auto-play').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  await bg.sendMessage({ type: 'TOGGLE_AUTO_PLAY', enabled });
  log(enabled ? 'AI auto-play enabled' : 'AI auto-play disabled');
  refreshStatus();
});

function saveWaitTime() {
  const min = Math.round(parseFloat($id('min-wait').value) * 1000);
  const max = Math.round(parseFloat($id('max-wait').value) * 1000);
  bg.sendMessage({ type: 'SET_WAIT_TIME', min, max });
}

$id('min-wait').addEventListener('input', function() {
  const val = parseFloat(this.value);
  $id('min-wait-val').textContent = val.toFixed(1) + 's';
  const max = parseFloat($id('max-wait').value);
  if (val > max) { $id('max-wait').value = val; $id('max-wait-val').textContent = val.toFixed(1) + 's'; }
  saveWaitTime();
});

$id('max-wait').addEventListener('input', function() {
  const val = parseFloat(this.value);
  $id('max-wait-val').textContent = val.toFixed(1) + 's';
  const min = parseFloat($id('min-wait').value);
  if (val < min) { $id('min-wait').value = val; $id('min-wait-val').textContent = val.toFixed(1) + 's'; }
  saveWaitTime();
});

$id('btn-train').addEventListener('click', async () => {
  if (!confirm('Start training on all recorded games? This may take a while and the bot will not play during training.')) return;
  $id('btn-train').disabled = true;
  $id('btn-train').textContent = 'Training...';
  log('Training started...');
  await bg.sendMessage({ type: 'TRAIN_NOW' });
  log('Training complete!');
  $id('btn-train').disabled = false;
  $id('btn-train').textContent = 'Train Model Now';
  refreshStatus();
});

$id('btn-trigger-ai').addEventListener('click', async () => {
  log('Requesting AI recommendations...');
  const resp = await bg.sendMessage({ type: 'REQUEST_AI_PLAY' });
  if (resp?.ok) {
    log('Recommendations shown on the game page');
  } else {
    log('AI could not generate recommendations: ' + (resp?.error || 'unknown'));
  }
});

$id('btn-export').addEventListener('click', async () => {
  log('Exporting game data...');
  const resp = await bg.sendMessage({ type: 'EXPORT_DATA' });
  if (resp?.ok && resp.games) {
    const blob = new Blob([JSON.stringify(resp.games, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `swu-ai-data-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    log(`Exported ${resp.games.length} games`);
  }
});

$id('btn-clear').addEventListener('click', async () => {
  if (!confirm('Delete ALL recorded game data? This cannot be undone.')) return;
  await bg.sendMessage({ type: 'CLEAR_DATA' });
  log('All data cleared');
  refreshStatus();
});

$id('btn-dashboard').addEventListener('click', async () => {
  const url = $id('server-url').value.trim() || 'http://localhost:3456';
  chrome.tabs.create({ url });
});

$id('btn-sync').addEventListener('click', async () => {
  const url = $id('server-url').value.trim();
  await bg.sendMessage({ type: 'SET_SYNC_SERVER', url });
  await bg.sendMessage({ type: 'SYNC_NOW' });
  log('Synced to server: ' + url);
});

$id('server-url').addEventListener('change', async () => {
  const url = $id('server-url').value.trim();
  await bg.sendMessage({ type: 'SET_SYNC_SERVER', url });
});

$id('btn-diag').addEventListener('click', async () => {
  log('Running WebSocket diagnosis...');
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]) {
    await chrome.tabs.sendMessage(tabs[0].id, { type: 'DIAG_WS' });
    await new Promise(r => setTimeout(r, 500));
  }
  const resp = await bg.sendMessage({ type: 'GET_DIAG' });
  const diag = resp?.data;
  const el = $id('diag-content');
  const section = $id('diag-section');
  if (diag) {
    section.style.display = 'block';
    el.innerHTML = `
      <div>Injection: ${diag.reached ?? 'unknown'} (game socket: ${diag.gameSocket ? 'yes' : 'no'})</div>
      <div>Last event: ${diag.lastEvent ? diag.lastEvent.name + ' @ ' + new Date(diag.lastEvent.ts).toLocaleTimeString() : 'none'}</div>
      <div>Last msg prefix: ${diag.lastMsg ? diag.lastMsg.prefix + ' (' + diag.lastMsg.len + ' bytes)' : 'none'}</div>
      <div>Connections: ${(diag.conns || []).map(c => c.url + ' game=' + c.isGame).join('<br>') || 'none'}</div>
      <div style="margin-top:4px">Actions: ${(diag.buttons || []).map(b => b.type + ':' + (b.text ?? b.arg ?? b.cardId ?? '?') + (b.command ? '('+b.command+')' : '') + (b.uuid ? ' u:'+b.uuid.slice(0,8) : '')).join(', ') || 'none'}</div>
      <div>Prompt UUID: ${diag.promptUuid || 'none'}</div>
      <div>Raw buttons: ${diag.rawButtons ? diag.rawButtons.map(b => JSON.stringify(b)).join(' | ') : 'none'}</div>
      <div style="margin-top:4px">Unknown event: ${diag.lastUnknownEvent ? diag.lastUnknownEvent.name + ' keys=' + (diag.lastUnknownEvent.data ? Object.keys(diag.lastUnknownEvent.data).join(',') : 'null') : 'none'}</div>
      <div style="margin-top:4px">Last send: ${diag.lastSend ? (diag.lastSend.ok ? 'OK' : 'FAIL') + ' event=' + (diag.lastSend.event || '?') + ' args=' + JSON.stringify(diag.lastSend.args) + (diag.lastSend.reason ? ' reason=' + diag.lastSend.reason : '') + ' readyState=' + diag.lastSend.readyState : 'none'}</div>
    `;
    log('Diagnosis complete');
  } else {
    section.style.display = 'block';
    el.innerHTML = '<div style="color:#f85149">No diagnostic data. Is Karabast open?</div>';
    log('No diagnostic data available');
  }
});
