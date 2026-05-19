using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using TradingService.Brokers;
using TradingService.Protocol;
using TradingService.Safety;
using TradingService.Storage;

namespace TradingService.Server;

public sealed class WsServer : IDisposable
{
    private readonly ILogger<WsServer> _log;
    private readonly HttpListener _listener;
    private readonly string _bindUri;
    private readonly IBrokerAdapter _broker;
    private readonly SafetyGuard _safety;
    private readonly TradeStore _store;
    private readonly CancellationTokenSource _cts = new();

    // 單一活躍連線（新連線會踢掉舊的）
    private Session? _active;
    private readonly object _activeLock = new();

    public WsServer(string host, int port, IBrokerAdapter broker, SafetyGuard safety, TradeStore store, ILogger<WsServer> log)
    {
        _broker = broker;
        _safety = safety;
        _store = store;
        _log = log;
        _bindUri = $"http://{host}:{port}/";
        _listener = new HttpListener();
        _listener.Prefixes.Add(_bindUri);

        _broker.OnTradeEvent += HandleBrokerEvent;
    }

    public async Task RunAsync()
    {
        _listener.Start();
        _log.LogInformation("TradingService listening on ws://{Host}", _bindUri[7..]);

        while (!_cts.IsCancellationRequested)
        {
            HttpListenerContext ctx;
            try { ctx = await _listener.GetContextAsync(); }
            catch (HttpListenerException) { break; }
            catch (ObjectDisposedException) { break; }

            // 僅允許 loopback
            var remote = ctx.Request.RemoteEndPoint?.Address;
            if (remote is null || !IPAddress.IsLoopback(remote))
            {
                ctx.Response.StatusCode = 403;
                ctx.Response.Close();
                continue;
            }

            if (!ctx.Request.IsWebSocketRequest)
            {
                ctx.Response.StatusCode = 426;
                ctx.Response.Close();
                continue;
            }

            _ = HandleClientAsync(ctx);
        }
    }

    private async Task HandleClientAsync(HttpListenerContext ctx)
    {
        WebSocketContext wsCtx;
        try { wsCtx = await ctx.AcceptWebSocketAsync(subProtocol: null); }
        catch (Exception ex) { _log.LogWarning(ex, "WebSocket handshake failed"); return; }

        var session = new Session(wsCtx.WebSocket, _broker, _safety, _store, _log);

        // 踢掉舊連線
        Session? old;
        lock (_activeLock) { old = _active; _active = session; }
        if (old is not null)
        {
            try { await old.CloseAsync("replaced by new connection"); } catch { }
        }

        _log.LogInformation("Client connected");
        try { await session.RunAsync(_cts.Token); }
        catch (Exception ex) { _log.LogWarning(ex, "Session crashed"); }
        finally
        {
            lock (_activeLock) { if (_active == session) _active = null; }
            _log.LogInformation("Client disconnected");
        }
    }

    private void HandleBrokerEvent(TradeUpdate u)
    {
        var t = _store.Get(u.TradeId);
        if (t is null) return;
        if (u.NewState is { } s) t.State = s;
        if (u.BuyFilledPrice  is { } bp) { t.BuyFilledPrice  = bp; t.BuyFilledQty  = u.BuyFilledQty  ?? t.Qty; t.BuyFilledUtc  = u.BuyFilledUtc  ?? DateTime.UtcNow; }
        if (u.SellFilledPrice is { } sp) { t.SellFilledPrice = sp; t.SellFilledQty = u.SellFilledQty ?? t.Qty; t.SellFilledUtc = u.SellFilledUtc ?? DateTime.UtcNow; }
        if (u.LastError is not null) t.LastError = u.LastError;
        if (u.BrokerOrderId is not null)
        {
            if (u.IsSellOrder) t.BrokerSellOrderId = u.BrokerOrderId;
            else t.BrokerBuyOrderId = u.BrokerOrderId;
        }
        _store.Upsert(t);

        Session? s2; lock (_activeLock) { s2 = _active; }
        _ = s2?.PushAsync(new PushEnvelope { Cmd = "trade_update", Data = t });
    }

    public void Dispose()
    {
        _cts.Cancel();
        try { _listener.Stop(); _listener.Close(); } catch { }
        _broker.OnTradeEvent -= HandleBrokerEvent;
    }
}
