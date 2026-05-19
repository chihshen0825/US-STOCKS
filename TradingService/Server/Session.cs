using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using TradingService.Brokers;
using TradingService.Protocol;
using TradingService.Safety;
using TradingService.Storage;

namespace TradingService.Server;

/// <summary>
/// 一個 WebSocket 連線的 session：解析訊息、路由 cmd、回應。
/// 不負責 broker 推送（由 WsServer.HandleBrokerEvent 走 PushAsync）。
/// </summary>
public sealed class Session
{
    private readonly WebSocket _ws;
    private readonly IBrokerAdapter _broker;
    private readonly SafetyGuard _safety;
    private readonly TradeStore _store;
    private readonly ILogger _log;
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = null,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    public Session(WebSocket ws, IBrokerAdapter broker, SafetyGuard safety, TradeStore store, ILogger log)
    {
        _ws = ws; _broker = broker; _safety = safety; _store = store; _log = log;
    }

    public async Task RunAsync(CancellationToken ct)
    {
        var buffer = new byte[16 * 1024];
        var sb = new StringBuilder();
        while (_ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            sb.Clear();
            WebSocketReceiveResult result;
            do
            {
                result = await _ws.ReceiveAsync(buffer, ct);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", ct);
                    return;
                }
                sb.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
            } while (!result.EndOfMessage);

            await DispatchAsync(sb.ToString(), ct);
        }
    }

    public async Task CloseAsync(string reason)
    {
        try { await _ws.CloseAsync(WebSocketCloseStatus.PolicyViolation, reason, CancellationToken.None); } catch { }
    }

    public async Task PushAsync(PushEnvelope env)
    {
        if (_ws.State != WebSocketState.Open) return;
        await SendJsonAsync(env);
    }

    private async Task DispatchAsync(string text, CancellationToken ct)
    {
        RequestEnvelope? req;
        try { req = JsonSerializer.Deserialize<RequestEnvelope>(text); }
        catch { await SendJsonAsync(ResponseEnvelope.Failure("", ErrorCodes.BadRequest, "Invalid JSON")); return; }
        if (req is null || string.IsNullOrEmpty(req.Cmd) || string.IsNullOrEmpty(req.ReqId))
        { await SendJsonAsync(ResponseEnvelope.Failure(req?.ReqId ?? "", ErrorCodes.BadRequest, "Missing cmd/req_id")); return; }

        try
        {
            var resp = req.Cmd switch
            {
                "ping"         => Pong(req),
                "status"       => StatusCmd(req),
                "login"        => await LoginCmd(req, ct),
                "logout"       => await LogoutCmd(req, ct),
                "open_trade"   => await OpenTrade(req, ct),
                "abort_trade"  => await AbortTrade(req, ct),
                "query_trade"  => QueryTrade(req),
                "list_trades"  => ListTrades(req),
                "kill_switch"  => KillSwitchCmd(req),
                _              => ResponseEnvelope.Failure(req.ReqId, ErrorCodes.UnknownCommand, $"Unknown cmd: {req.Cmd}"),
            };
            await SendJsonAsync(resp);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Cmd {Cmd} crashed", req.Cmd);
            await SendJsonAsync(ResponseEnvelope.Failure(req.ReqId, ErrorCodes.InternalError, ex.Message));
        }
    }

    // ── Commands ────────────────────────────────────────────

    private static ResponseEnvelope Pong(RequestEnvelope req)
        => ResponseEnvelope.Success(req.ReqId, new { ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });

    private ResponseEnvelope StatusCmd(RequestEnvelope req) => ResponseEnvelope.Success(req.ReqId, new
    {
        version = "1.0.0",
        protocol = "v1",
        broker_connected = _broker.IsConnected,
        broker_name = _broker.Name,
        dry_run = _safety.DryRun,
        kill_switch = _safety.KillSwitch,
        daily = new
        {
            orders_count   = _safety.OrdersCount,
            orders_max     = _safety.OrdersMax,
            amount_usd     = _safety.AmountUsd,
            amount_max_usd = _safety.AmountMax,
        },
        open_trades = _store.All().Count(t => t.State is TradeState.BuyPending or TradeState.BuyFilled or TradeState.SellPending),
    });

    private async Task<ResponseEnvelope> LoginCmd(RequestEnvelope req, CancellationToken ct)
    {
        var user = ReadString(req, "user") ?? "";
        var pwd  = ReadString(req, "pwd")  ?? "";
        var otp  = ReadString(req, "otp");
        var r = await _broker.LoginAsync(user, pwd, otp, ct);
        return r.Ok
            ? ResponseEnvelope.Success(req.ReqId, new { ok = true, user })
            : ResponseEnvelope.Failure(req.ReqId, r.ErrorCode ?? ErrorCodes.AuthFailed, r.Error ?? "login failed");
    }

    private async Task<ResponseEnvelope> LogoutCmd(RequestEnvelope req, CancellationToken ct)
    {
        await _broker.LogoutAsync(ct);
        return ResponseEnvelope.Success(req.ReqId, new { ok = true });
    }

    private async Task<ResponseEnvelope> OpenTrade(RequestEnvelope req, CancellationToken ct)
    {
        var sym       = (ReadString(req, "sym") ?? "").Trim().ToUpperInvariant();
        var qty       = ReadInt(req, "qty");
        var price     = ReadDecimal(req, "price");
        var targetPct = ReadDecimal(req, "target_pct");
        var stopPct   = ReadDecimal(req, "stop_pct") ?? 0m;
        var tif       = (ReadString(req, "tif") ?? "DAY").ToUpperInvariant();

        if (sym.Length == 0 || qty is null or <= 0 || price is null or <= 0m || targetPct is null)
            return ResponseEnvelope.Failure(req.ReqId, ErrorCodes.BadRequest, "Missing/invalid sym|qty|price|target_pct");

        var (ok, code, msg) = _safety.TryReserve(sym, qty.Value, price.Value);
        if (!ok) return ResponseEnvelope.Failure(req.ReqId, code!, msg!);

        var t = new Trade
        {
            Id = _store.NextId(),
            Sym = sym,
            Qty = qty.Value,
            Price = price.Value,
            TargetPct = targetPct.Value,
            StopPct = stopPct,
            Tif = tif,
            State = TradeState.New,
            CreatedUtc = DateTime.UtcNow,
            UpdatedUtc = DateTime.UtcNow,
            DryRun = _safety.DryRun,
        };
        _store.Upsert(t);

        var br = await _broker.SubmitBuyAsync(t, ct);
        if (!br.Ok)
        {
            t.State = TradeState.BuyRejected;
            t.LastError = br.Error;
            _store.Upsert(t);
            _safety.Refund(t.Qty, t.Price);
            return ResponseEnvelope.Failure(req.ReqId, br.ErrorCode ?? ErrorCodes.BrokerRejected, br.Error ?? "broker rejected");
        }
        return ResponseEnvelope.Success(req.ReqId, t);
    }

    private async Task<ResponseEnvelope> AbortTrade(RequestEnvelope req, CancellationToken ct)
    {
        var id = ReadString(req, "id");
        if (string.IsNullOrEmpty(id))
            return ResponseEnvelope.Failure(req.ReqId, ErrorCodes.BadRequest, "Missing id");
        var t = _store.Get(id);
        if (t is null)
            return ResponseEnvelope.Failure(req.ReqId, ErrorCodes.TradeNotFound, $"Trade {id} not found");

        string? orderId;
        switch (t.State)
        {
            case TradeState.BuyPending:
                orderId = t.BrokerBuyOrderId;
                t.State = TradeState.BuyCancelling;
                _store.Upsert(t);
                break;
            case TradeState.SellPending:
                orderId = t.BrokerSellOrderId;
                break;
            default:
                return ResponseEnvelope.Failure(req.ReqId, ErrorCodes.TradeNotCancelable, $"Trade in state {t.State}");
        }
        if (orderId is null)
            return ResponseEnvelope.Failure(req.ReqId, ErrorCodes.TradeNotCancelable, "No broker order id");
        var r = await _broker.CancelAsync(t, orderId, ct);
        return r.Ok
            ? ResponseEnvelope.Success(req.ReqId, new { id = t.Id, cancel_requested = true })
            : ResponseEnvelope.Failure(req.ReqId, r.ErrorCode ?? ErrorCodes.BrokerRejected, r.Error ?? "cancel failed");
    }

    private ResponseEnvelope QueryTrade(RequestEnvelope req)
    {
        var id = ReadString(req, "id");
        if (string.IsNullOrEmpty(id))
            return ResponseEnvelope.Failure(req.ReqId, ErrorCodes.BadRequest, "Missing id");
        var t = _store.Get(id);
        return t is null
            ? ResponseEnvelope.Failure(req.ReqId, ErrorCodes.TradeNotFound, $"Trade {id} not found")
            : ResponseEnvelope.Success(req.ReqId, t);
    }

    private ResponseEnvelope ListTrades(RequestEnvelope req)
        => ResponseEnvelope.Success(req.ReqId, new { trades = _store.All().OrderByDescending(x => x.CreatedUtc).ToList() });

    private ResponseEnvelope KillSwitchCmd(RequestEnvelope req)
    {
        var enable = ReadBool(req, "enable") ?? true;
        _safety.SetKillSwitch(enable);
        int canceled = 0;
        if (enable)
        {
            foreach (var t in _store.All())
            {
                if (t.State == TradeState.BuyPending && t.BrokerBuyOrderId != null)
                {
                    _ = _broker.CancelAsync(t, t.BrokerBuyOrderId, CancellationToken.None);
                    canceled++;
                }
                else if (t.State == TradeState.SellPending && t.BrokerSellOrderId != null)
                {
                    _ = _broker.CancelAsync(t, t.BrokerSellOrderId, CancellationToken.None);
                    canceled++;
                }
            }
        }
        return ResponseEnvelope.Success(req.ReqId, new { kill_switch = enable, canceled });
    }

    // ── helpers ─────────────────────────────────────────────

    private async Task SendJsonAsync(object env)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(env, _json);
        await _sendLock.WaitAsync();
        try
        {
            if (_ws.State == WebSocketState.Open)
                await _ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, CancellationToken.None);
        }
        finally { _sendLock.Release(); }
    }

    private static string?  ReadString (RequestEnvelope r, string k)
        => r.Extra is { } d && d.TryGetValue(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static int?     ReadInt    (RequestEnvelope r, string k)
        => r.Extra is { } d && d.TryGetValue(k, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : null;
    private static decimal? ReadDecimal(RequestEnvelope r, string k)
        => r.Extra is { } d && d.TryGetValue(k, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDecimal(out var n) ? n : null;
    private static bool?    ReadBool   (RequestEnvelope r, string k)
        => r.Extra is { } d && d.TryGetValue(k, out var v) && (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False) ? v.GetBoolean() : null;
}
