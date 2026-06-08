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

function createOverlay(recommendations) {
  removeOverlay();

  // Normalize scores for display when they're nearly identical
  if (recommendations.length > 1) {
    const spread = Math.max(...recommendations.map(r => r.score)) - Math.min(...recommendations.map(r => r.score));
    if (spread < 0.02) {
      recommendations = recommendations.map((r, i) => ({
        ...r,
        score: 1.0 - (i * (0.15 / Math.max(recommendations.length - 1, 1)))
      }));
    }
  }

  const overlay = document.createElement('div');
  overlay.id = 'swu-ai-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:999999;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif;';

  const box = document.createElement('div');
  box.style.cssText = 'background:#1e1e2e;border-radius:12px;padding:24px;min-width:320px;max-width:420px;box-shadow:0 8px 32px rgba(0,0,0,0.5);';

  const title = document.createElement('div');
  title.textContent = 'AI Recommendations';
  title.style.cssText = 'color:#cdd6f4;font-size:18px;font-weight:700;margin-bottom:16px;text-align:center;';

  box.appendChild(title);

  recommendations.forEach((r, i) => {
    const pct = Math.round((r.score || 0) * 100);

    const btn = document.createElement('button');
    btn.style.cssText = 'display:block;width:100%;padding:12px 16px;margin-bottom:8px;border:2px solid #89b4fa;border-radius:8px;background:#313244;color:#cdd6f4;font-size:15px;cursor:pointer;text-align:left;transition:background 0.15s;';
    btn.innerHTML = '<span style="font-weight:700;color:#89b4fa;">#' + (i + 1) + '</span> <span style="margin-left:8px;">' + r.description + '</span> <span style="float:right;color:#a6e3a1;">' + pct + '%</span>';

    btn.addEventListener('mouseenter', () => { btn.style.background = '#45475a'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#313244'; });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeOverlay();
      bgSend({ type: 'ACTION_CHOSEN', index: i });
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'INJECT_AND_EXECUTE') {
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
    createOverlay(msg.recommendations);
    sendResponse({ ok: true });
    return true;
  }
  return true;
});
