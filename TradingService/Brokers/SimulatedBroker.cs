using Microsoft.Extensions.Logging;
using TradingService.Protocol;

namespace TradingService.Brokers;

/// <summary>
/// 預設 dry-run broker：不真正下單，按 config 模擬「延遲後成交（含 slippage）」或「拒單」。
/// 賣出單則接受並進入 SellPending（不會自動 fill — 真實成交由 dashboard 端的價格觸發 abort/refill 邏輯處理）。
/// </summary>
public sealed class SimulatedBroker : IBrokerAdapter
{
    private readonly ILogger<SimulatedBroker> _log;
    private readonly int _buyFillDelayMs;
    private readonly decimal _slippagePct;
    private readonly double _rejectProb;
    private readonly Random _rng = new();

    public string Name => "Simulated";
    public bool IsConnected => true;
    public event Action<TradeUpdate>? OnTradeEvent;

    public SimulatedBroker(ILogger<SimulatedBroker> log, int buyFillDelayMs, decimal slippagePct, double rejectProb)
    {
        _log = log;
        _buyFillDelayMs = Math.Max(0, buyFillDelayMs);
        _slippagePct = slippagePct;
        _rejectProb = Math.Clamp(rejectProb, 0, 1);
    }

    public Task<BrokerResult> LoginAsync(string user, string pwd, string? otp, CancellationToken ct)
        => Task.FromResult(new BrokerResult(true));

    public Task LogoutAsync(CancellationToken ct) => Task.CompletedTask;

    public Task<BrokerResult> SubmitBuyAsync(Trade trade, CancellationToken ct)
    {
        var orderId = "SIM-B-" + Guid.NewGuid().ToString("N")[..10];
        trade.BrokerBuyOrderId = orderId;

        // 模擬 broker ack：轉 BuyPending，等延遲後再 fill 或 reject
        OnTradeEvent?.Invoke(new TradeUpdate(trade.Id, TradeState.BuyPending, BrokerOrderId: orderId));

        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(_buyFillDelayMs, ct);
                if (_rng.NextDouble() < _rejectProb)
                {
                    OnTradeEvent?.Invoke(new TradeUpdate(trade.Id, TradeState.BuyRejected, LastError: "Simulated reject"));
                    return;
                }
                var fillPx = trade.Price * (1m - _slippagePct);
                OnTradeEvent?.Invoke(new TradeUpdate(
                    trade.Id, TradeState.BuyFilled,
                    BuyFilledPrice: Math.Round(fillPx, 4),
                    BuyFilledQty: trade.Qty,
                    BuyFilledUtc: DateTime.UtcNow));
            }
            catch (OperationCanceledException) { }
            catch (Exception ex) { _log.LogWarning(ex, "SimulatedBroker buy-fill task failed"); }
        }, ct);

        return Task.FromResult(new BrokerResult(true));
    }

    public Task<BrokerResult> SubmitSellAsync(Trade trade, decimal limitPrice, CancellationToken ct)
    {
        var orderId = "SIM-S-" + Guid.NewGuid().ToString("N")[..10];
        trade.BrokerSellOrderId = orderId;
        OnTradeEvent?.Invoke(new TradeUpdate(trade.Id, TradeState.SellPending, BrokerOrderId: orderId, IsSellOrder: true));
        return Task.FromResult(new BrokerResult(true));
    }

    public Task<BrokerResult> CancelAsync(Trade trade, string brokerOrderId, CancellationToken ct)
    {
        // 模擬：直接回 canceled（依買/賣判斷下一個 state）
        var isSell = brokerOrderId == trade.BrokerSellOrderId;
        var next = isSell ? TradeState.SellCanceled : TradeState.BuyCanceled;
        OnTradeEvent?.Invoke(new TradeUpdate(trade.Id, next));
        return Task.FromResult(new BrokerResult(true));
    }
}
