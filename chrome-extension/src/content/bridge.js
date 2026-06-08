function bgSend(msg) {
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) {}
}

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.source !== 'swu-ai-inject') return;
  const p = event.data.payload;
  if (p.type === 'DIAG_RESULT') {
    bgSend({ type: 'DIAG_RESULT', data: p.data });
  } else {
    bgSend({ type: 'FROM_PAGE', payload: p });
  }
});

function removeOverlay() {
  const el = document.getElementById('swu-ai-overlay');
  if (el) el.remove();
}

var swuAiPendingActions = null;
var swuAiCountdownTimer = null;

function createOverlay(recommendations) {
  removeOverlay();

  // Store action objects so the click handler can send them directly
  swuAiPendingActions = recommendations.map(function(r) { return r.action; });

  // Normalize scores for display when they're nearly identical
  if (recommendations.length > 1) {
    var spread = Math.max.apply(null, recommendations.map(function(r) { return r.score; })) - Math.min.apply(null, recommendations.map(function(r) { return r.score; }));
    if (spread < 0.02) {
      recommendations = recommendations.map(function(r, i) {
        return Object.assign({}, r, { score: 1.0 - (i * (0.15 / Math.max(recommendations.length - 1, 1))) });
      });
    }
  }

  var overlay = document.createElement('div');
  overlay.id = 'swu-ai-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:999999;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif;';

  var box = document.createElement('div');
  box.style.cssText = 'background:#1e1e2e;border-radius:12px;padding:24px;min-width:320px;max-width:420px;box-shadow:0 8px 32px rgba(0,0,0,0.5);';

  var title = document.createElement('div');
  title.textContent = 'AI Recommendations';
  title.style.cssText = 'color:#cdd6f4;font-size:18px;font-weight:700;margin-bottom:16px;text-align:center;';

  box.appendChild(title);

  recommendations.forEach(function(r, i) {
    var pct = Math.round((r.score || 0) * 100);

    var btn = document.createElement('button');
    btn.style.cssText = 'display:block;width:100%;padding:12px 16px;margin-bottom:8px;border:2px solid #89b4fa;border-radius:8px;background:#313244;color:#cdd6f4;font-size:15px;cursor:pointer;text-align:left;transition:background 0.15s;';
    btn.innerHTML = '<span style="font-weight:700;color:#89b4fa;">#' + (i + 1) + '</span> <span style="margin-left:8px;">' + r.description + '</span> <span style="float:right;color:#a6e3a1;">' + pct + '%</span>';

    btn.addEventListener('mouseenter', function() { btn.style.background = '#45475a'; });
    btn.addEventListener('mouseleave', function() { btn.style.background = '#313244'; });
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      removeOverlay();
      var act = swuAiPendingActions && swuAiPendingActions[i];
      if (act) bgSend({ type: 'ACTION_CHOSEN', action: act });
      swuAiPendingActions = null;
    });

    box.appendChild(btn);
  });

  const close = document.createElement('div');
  close.textContent = '✕';
  close.style.cssText = 'color:#6c7086;font-size:14px;text-align:center;cursor:pointer;padding:8px;margin-top:4px;';
  close.addEventListener('click', removeOverlay);
  box.appendChild(close);

  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function removeCountdown() {
  var el = document.getElementById('swu-ai-countdown');
  if (el) el.remove();
  if (swuAiCountdownTimer) { clearInterval(swuAiCountdownTimer); swuAiCountdownTimer = null; }
}

function showCountdown(description, totalMs) {
  removeCountdown();

  var start = Date.now();
  var el = document.createElement('div');
  el.id = 'swu-ai-countdown';
  el.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:999999;font-family:Arial,sans-serif;background:rgba(30,30,46,0.92);border:1px solid #89b4fa;border-radius:10px;padding:12px 20px;min-width:320px;max-width:480px;box-shadow:0 4px 24px rgba(0,0,0,0.6);color:#cdd6f4;font-size:14px;';

  var textRow = document.createElement('div');
  textRow.style.cssText = 'margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  textRow.textContent = 'AI: ' + description;
  el.appendChild(textRow);

  var timerRow = document.createElement('div');
  timerRow.style.cssText = 'display:flex;align-items:center;gap:8px;';

  var barBg = document.createElement('div');
  barBg.style.cssText = 'flex:1;height:6px;background:#45475a;border-radius:3px;overflow:hidden;';

  var barFill = document.createElement('div');
  barFill.style.cssText = 'height:100%;width:100%;background:#a6e3a1;border-radius:3px;transition:width 0.1s linear;';
  barBg.appendChild(barFill);

  var timeLabel = document.createElement('span');
  timeLabel.style.cssText = 'min-width:44px;text-align:right;font-size:13px;color:#a6e3a1;font-weight:700;';
  timeLabel.textContent = (totalMs / 1000).toFixed(1) + 's';

  timerRow.appendChild(barBg);
  timerRow.appendChild(timeLabel);
  el.appendChild(timerRow);

  document.body.appendChild(el);

  swuAiCountdownTimer = setInterval(function() {
    var elapsed = Date.now() - start;
    var remaining = Math.max(0, totalMs - elapsed);
    var pct = (elapsed / totalMs) * 100;
    barFill.style.width = Math.min(pct, 100) + '%';
    timeLabel.textContent = (remaining / 1000).toFixed(1) + 's';
    if (remaining <= 0) {
      clearInterval(swuAiCountdownTimer);
      swuAiCountdownTimer = null;
    }
  }, 50);
}

function clickRequeue() {
  // Find any button whose text content contains "Requeue"
  var buttons = document.querySelectorAll('button');
  for (var i = 0; i < buttons.length; i++) {
    var txt = buttons[i].textContent.trim();
    if (txt.indexOf('Requeue') !== -1 || txt.indexOf('requeue') !== -1) {
      buttons[i].click();
      return true;
    }
  }
  return false;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'INJECT_AND_EXECUTE') {
    removeCountdown();
    window.postMessage({ source: 'swu-ai-bridge', payload: { type: 'EXECUTE_ACTION', action: msg.action } }, '*');
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'PING') {
    sendResponse({ ok: true, url: window.location.href });
    return true;
  }
  if (msg.type === 'DIAG_WS') {
    window.postMessage({ source: 'swu-ai-bridge', payload: { type: 'DIAG_REQUEST' } }, '*');
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'SHOW_RECOMMENDATIONS') {
    removeCountdown();
    createOverlay(msg.recommendations);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'SHOW_COUNTDOWN') {
    showCountdown(msg.description, msg.totalMs);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'HIDE_COUNTDOWN') {
    removeCountdown();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'CLICK_REQUEUE') {
    var clicked = clickRequeue();
    // Retry up to 5 times with 1s delay if button not yet rendered
    if (!clicked) {
      var retries = 0;
      var timer = setInterval(function() {
        retries++;
        if (clickRequeue() || retries >= 5) clearInterval(timer);
      }, 1000);
    }
    sendResponse({ ok: true });
    return true;
  }
  return true;
});
