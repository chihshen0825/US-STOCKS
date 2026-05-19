using TradingService.Protocol;

namespace TradingService.Safety;

public sealed class SafetyOptions
{
    public bool DryRun { get; set; } = true;
    public bool KillSwitch { get; set; }
    public List<string> Whitelist { get; set; } = new();
    public DailyLimits Daily { get; set; } = new();
}

public sealed class DailyLimits
{
    public int OrdersMax { get; set; } = 20;
    public decimal AmountMaxUsd { get; set; } = 10000m;
}

/// <summary>
/// 集中管理日上限、白名單、kill switch。Thread-safe（lock）。
/// 每日 reset：按 UTC 日切；server 重啟也視為 reset。
/// </summary>
public sealed class SafetyGuard
{
    private readonly object _lock = new();
    private DateTime _utcDay = DateTime.UtcNow.Date;
    private int _ordersToday;
    private decimal _amountUsdToday;

    public bool DryRun        { get; }
    public bool KillSwitch    { get; private set; }
    public IReadOnlyList<string> Whitelist { get; }
    public int OrdersMax      { get; }
    public decimal AmountMax  { get; }

    public int OrdersCount    { get { lock (_lock) { Roll(); return _ordersToday; } } }
    public decimal AmountUsd  { get { lock (_lock) { Roll(); return _amountUsdToday; } } }

    public SafetyGuard(SafetyOptions o)
    {
        DryRun     = o.DryRun;
        KillSwitch = o.KillSwitch;
        Whitelist  = o.Whitelist.Select(s => s.Trim().ToUpperInvariant()).Where(s => s.Length > 0).ToList();
        OrdersMax  = Math.Max(0, o.Daily.OrdersMax);
        AmountMax  = Math.Max(0, o.Daily.AmountMaxUsd);
    }

    private void Roll()
    {
        var today = DateTime.UtcNow.Date;
        if (today != _utcDay)
        {
            _utcDay = today;
            _ordersToday = 0;
            _amountUsdToday = 0m;
        }
    }

    /// <summary>檢查 + 記帳。回傳 (ok, errorCode)。Ok=true 時已記入計數。</summary>
    public (bool ok, string? code, string? msg) TryReserve(string sym, int qty, decimal price)
    {
        lock (_lock)
        {
            Roll();
            if (KillSwitch)
                return (false, ErrorCodes.KillSwitchActive, "Kill switch is active");

            if (Whitelist.Count > 0 && !Whitelist.Contains(sym.ToUpperInvariant()))
                return (false, ErrorCodes.SymbolNotWhitelisted, $"Symbol {sym} not in whitelist");

            if (OrdersMax > 0 && _ordersToday + 1 > OrdersMax)
                return (false, ErrorCodes.DailyLimitExceeded, $"Daily orders limit {OrdersMax} reached");

            var amt = price * qty;
            if (AmountMax > 0 && _amountUsdToday + amt > AmountMax)
                return (false, ErrorCodes.DailyLimitExceeded, $"Daily amount limit ${AmountMax} would be exceeded");

            _ordersToday++;
            _amountUsdToday += amt;
            return (true, null, null);
        }
    }

    public void Refund(int qty, decimal price)
    {
        lock (_lock)
        {
            Roll();
            _ordersToday = Math.Max(0, _ordersToday - 1);
            _amountUsdToday = Math.Max(0m, _amountUsdToday - price * qty);
        }
    }

    public void SetKillSwitch(bool on)
    {
        lock (_lock) { KillSwitch = on; }
    }
}
