using TradingService.Protocol;

namespace TradingService.Brokers;

/// <summary>
/// 抽象的下單適配介面。實作真實券商時建立新的 class 並在 Program.cs 註冊。
/// 所有方法都應為非同步、不丟未預期例外（用 BrokerResult 回報）。
/// </summary>
public interface IBrokerAdapter
{
    string Name { get; }
    bool IsConnected { get; }

    Task<BrokerResult> LoginAsync(string user, string pwd, string? otp, CancellationToken ct);
    Task LogoutAsync(CancellationToken ct);

    /// <summary>送出買入限價單。成功時 Trade.BrokerBuyOrderId 應填入；State 應轉為 BuyPending。</summary>
    Task<BrokerResult> SubmitBuyAsync(Trade trade, CancellationToken ct);

    /// <summary>送出賣出限價單（達 target 用）。成功時 Trade.BrokerSellOrderId 填入。</summary>
    Task<BrokerResult> SubmitSellAsync(Trade trade, decimal limitPrice, CancellationToken ct);

    /// <summary>取消單。對應 broker 的 orderId 取消。</summary>
    Task<BrokerResult> CancelAsync(Trade trade, string brokerOrderId, CancellationToken ct);

    /// <summary>
    /// Adapter 在收到 broker 推送（成交、拒單、取消）時，呼叫此 callback 通知 server 更新 trade。
    /// Server 啟動時會註冊。
    /// </summary>
    event Action<TradeUpdate>? OnTradeEvent;
}

public sealed record BrokerResult(bool Ok, string? ErrorCode = null, string? Error = null);

public sealed record TradeUpdate(
    string TradeId,
    TradeState? NewState,
    decimal? BuyFilledPrice  = null,
    int?     BuyFilledQty    = null,
    DateTime? BuyFilledUtc   = null,
    decimal? SellFilledPrice = null,
    int?     SellFilledQty   = null,
    DateTime? SellFilledUtc  = null,
    string?  LastError       = null,
    string?  BrokerOrderId   = null,
    bool     IsSellOrder     = false);
