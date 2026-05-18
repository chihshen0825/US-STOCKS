// shortterm-stock-dashboard/tradingClient.js
// 與本機 TradingService (Windows Service, ws://127.0.0.1:1088) 通訊的小 client。
// 公開：window.tradingClient
//   - connect(url) / disconnect() / connected
//   - call(cmd, params, timeoutMs) -> Promise<data>   (req_id 自動配對)
//   - on(event, fn)  event: 'open' | 'close' | 'error' | 'trade_update' | 'message'
(function () {
  const DEFAULT_URL = "ws://127.0.0.1:1088/";
  const listeners = { open: [], close: [], error: [], trade_update: [], message: [] };
  const pending = new Map(); // req_id -> {resolve,reject,timer}
  let ws = null;
  let reqSeq = 1;
  let url = DEFAULT_URL;
  let reconnect = true;
  let reconnectTimer = null;

  function emit(ev, payload) {
    const arr = listeners[ev]; if (!arr) return;
    for (const fn of arr) { try { fn(payload); } catch (e) { console.warn("[ws] listener error", e); } }
  }
  function on(ev, fn) { if (!listeners[ev]) listeners[ev] = []; listeners[ev].push(fn); }
  function off(ev, fn) { const a = listeners[ev]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }

  function connected() { return ws && ws.readyState === 1; }

  function connect(u) {
    url = u || url || DEFAULT_URL;
    reconnect = true;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    try { ws = new WebSocket(url); }
    catch (e) { emit("error", e); scheduleReconnect(); return; }

    ws.onopen = () => { console.log("[ws] open", url); emit("open"); };
    ws.onerror = (e) => { console.warn("[ws] error", e); emit("error", e); };
    ws.onclose = (e) => {
      console.log("[ws] close", e.code, e.reason);
      // reject 所有 pending
      for (const [, p] of pending) { clearTimeout(p.timer); try { p.reject(new Error("ws closed")); } catch {} }
      pending.clear();
      emit("close", e);
      if (reconnect) scheduleReconnect();
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { emit("message", ev.data); return; }
      emit("message", msg);

      // 1) 回應某筆 call
      if (msg && msg.req_id && pending.has(msg.req_id)) {
        const p = pending.get(msg.req_id);
        pending.delete(msg.req_id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error || "ws error"));
        return;
      }
      // 2) 服務端 push (trade_update)
      if (msg && msg.cmd === "trade_update") {
        emit("trade_update", msg.data);
      }
    };
  }

  function disconnect() {
    reconnect = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { try { ws.close(); } catch {} ws = null; }
  }

  function scheduleReconnect() {
    if (!reconnect || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
  }

  function call(cmd, params, timeoutMs) {
    timeoutMs = timeoutMs || 8000;
    return new Promise((resolve, reject) => {
      if (!connected()) { reject(new Error("ws not connected")); return; }
      const req_id = "r" + (++reqSeq) + "-" + Math.random().toString(36).slice(2, 6);
      const payload = Object.assign({ cmd, req_id }, params || {});
      const timer = setTimeout(() => {
        if (pending.has(req_id)) { pending.delete(req_id); reject(new Error("ws timeout: " + cmd)); }
      }, timeoutMs);
      pending.set(req_id, { resolve, reject, timer });
      try { ws.send(JSON.stringify(payload)); }
      catch (e) { pending.delete(req_id); clearTimeout(timer); reject(e); }
    });
  }

  // 高階快捷
  const api = {
    DEFAULT_URL,
    get url() { return url; },
    get connected() { return connected(); },
    connect, disconnect, on, off, call,
    ping:        () => call("ping"),
    status:      () => call("status"),
    login:       (user, pwd, otp) => call("login", { user, pwd, otp }),
    logout:      () => call("logout"),
    openTrade:   (sym, qty, price, targetPct) => call("open_trade", { sym, qty, price, target_pct: targetPct }),
    abortTrade:  (id) => call("abort_trade", { id }),
    queryTrade:  (id) => call("query_trade", { id }),
    listTrades:  () => call("list_trades"),
  };
  window.tradingClient = api;
})();
