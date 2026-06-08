if (!window.__swuAiPatched) {
  window.__swuAiPatched = true;
  window.__swuAiReached = 1;
  window.__swuAiConnections = [];
  window.__swuAiLastEvent = null;
  window.__swuAiLastMsg = null;

  var gameSocket = null;
  var OrigWebSocket = window.WebSocket;

  window.WebSocket = function(url, protocols) {
    var isGame = typeof url === 'string' && (url.indexOf('/ws') !== -1 || url.indexOf('EIO') !== -1 || url.indexOf('/socket.io/') !== -1);
    var ws = new OrigWebSocket(url, protocols);
    window.__swuAiConnections.push({ url: String(url).slice(0, 120), isGame: isGame, ts: Date.now() });

    if (isGame) {
      window.__swuAiReached = 2;
      gameSocket = ws;
      var origSend = ws.send.bind(ws);

      ws.send = function(data) {
        try {
          var msg = typeof data === 'string' ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : String(data);
          var parsed = parsePayload(msg);
          if (parsed) {
            window.postMessage({ source: 'swu-ai-inject', payload: { type: 'OUTGOING', event: parsed[0], args: parsed.slice(1) } }, '*');
          }
        } catch(e) { window.__swuAiError = String(e); }
        return origSend(data);
      };

      ws.addEventListener('message', function(event) {
        if (typeof event.data !== 'string') return;
        var d = event.data;
        window.__swuAiLastMsg = { prefix: d.slice(0, Math.min(12, d.length)), len: d.length, ts: Date.now() };

        if (d[0] === '0' || d[0] === '2') {
          if (d[0] === '2') try { origSend('3'); } catch(e) {}
          return;
        }
        var parsed = parsePayload(d);
        if (parsed) {
          var name = parsed[0], payload = parsed[1];
          window.__swuAiLastEvent = { name: name, ts: Date.now() };
          if (name === 'gamestate' || name === 'lobbystate') {
            window.postMessage({ source: 'swu-ai-inject', payload: { type: name === 'gamestate' ? 'GAMESTATE' : 'LOBBYSTATE', data: payload } }, '*');
          }
        }
      });
    }
    return ws;
  };
  window.WebSocket.prototype = OrigWebSocket.prototype;
  window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1; window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3;

  window.__swuAiReached = 3;

  function parsePayload(msg) {
    if (msg.length < 2 || msg[0] !== '4' || msg[1] !== '2') return null;
    var idx = 2;
    while (idx < msg.length && msg[idx] >= '0' && msg[idx] <= '9') idx++;
    if (idx >= msg.length || msg[idx] !== '[') return null;
    return JSON.parse(msg.slice(idx));
  }

  window.addEventListener('message', function(event) {
    if (!event.data || event.data.source !== 'swu-ai-bridge') return;
    var p = event.data.payload;
    if (p && p.type === 'EXECUTE_ACTION') {
      var a = p.action;
      if (a.type === 'cardClicked') return swuAiSend('game', 'cardClicked', a.cardId);
      if (a.type === 'menuButton') return swuAiSend('game', 'menuButton', a.arg||'', a.uuid||'', a.command||'');
      if (a.type === 'pass') return swuAiSend('game', 'menuButton', 'pass', '', '');
    }
    if (p && p.type === 'DIAG_REQUEST') {
      window.postMessage({ source: 'swu-ai-inject', payload: { type: 'DIAG_RESULT', data: {
        reached: window.__swuAiReached,
        conns: (window.__swuAiConnections||[]).slice(-5),
        lastEvent: window.__swuAiLastEvent,
        lastMsg: window.__swuAiLastMsg,
        error: window.__swuAiError
      } } }, '*');
    }
  });
}

function swuAiSend(eventName) {
  if (!gameSocket || gameSocket.readyState !== 1) return false;
  var args = Array.prototype.slice.call(arguments, 1);
  var parts = ['42["' + eventName + '"'];
  for (var i = 0; i < args.length; i++) { parts.push(','); parts.push(JSON.stringify(args[i])); }
  parts.push(']');
  gameSocket.send(parts.join(''));
  return true;
}
