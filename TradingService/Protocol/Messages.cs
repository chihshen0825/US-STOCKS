using System.Text.Json.Serialization;

namespace TradingService.Protocol;

public sealed class RequestEnvelope
{
    [JsonPropertyName("cmd")]    public string Cmd { get; set; } = "";
    [JsonPropertyName("req_id")] public string ReqId { get; set; } = "";
    [JsonExtensionData]
    public Dictionary<string, System.Text.Json.JsonElement>? Extra { get; set; }
}

public sealed class ResponseEnvelope
{
    [JsonPropertyName("req_id")] public string ReqId { get; set; } = "";
    [JsonPropertyName("ok")]     public bool Ok { get; set; }
    [JsonPropertyName("data")]   public object? Data { get; set; }
    [JsonPropertyName("error")]  public string? Error { get; set; }
    [JsonPropertyName("code")]   public string? Code { get; set; }

    public static ResponseEnvelope Success(string reqId, object? data)
        => new() { ReqId = reqId, Ok = true, Data = data };

    public static ResponseEnvelope Failure(string reqId, string code, string error)
        => new() { ReqId = reqId, Ok = false, Code = code, Error = error };
}

public sealed class PushEnvelope
{
    [JsonPropertyName("cmd")]  public string Cmd { get; set; } = "";
    [JsonPropertyName("data")] public object? Data { get; set; }
}

public enum TradeState
{
    New,
    BuyPending,
    BuyCancelling,
    BuyFilled,
    BuyCanceled,
    BuyRejected,
    SellPending,
    SellFilled,
    SellCanceled,
    Expired,
    Failed,
}

public sealed class Trade
{
    [JsonPropertyName("id")]                   public string Id { get; set; } = "";
    [JsonPropertyName("sym")]                  public string Sym { get; set; } = "";
    [JsonPropertyName("qty")]                  public int Qty { get; set; }
    [JsonPropertyName("price")]                public decimal Price { get; set; }
    [JsonPropertyName("target_pct")]           public decimal TargetPct { get; set; }
    [JsonPropertyName("stop_pct")]             public decimal StopPct { get; set; }
    [JsonPropertyName("tif")]                  public string Tif { get; set; } = "DAY";
    [JsonPropertyName("state")]
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public TradeState State { get; set; } = TradeState.New;
    [JsonPropertyName("created_utc")]          public DateTime CreatedUtc { get; set; }
    [JsonPropertyName("updated_utc")]          public DateTime UpdatedUtc { get; set; }
    [JsonPropertyName("buy_filled_price")]     public decimal? BuyFilledPrice { get; set; }
    [JsonPropertyName("buy_filled_qty")]       public int BuyFilledQty { get; set; }
    [JsonPropertyName("buy_filled_utc")]       public DateTime? BuyFilledUtc { get; set; }
    [JsonPropertyName("sell_filled_price")]    public decimal? SellFilledPrice { get; set; }
    [JsonPropertyName("sell_filled_qty")]      public int SellFilledQty { get; set; }
    [JsonPropertyName("sell_filled_utc")]      public DateTime? SellFilledUtc { get; set; }
    [JsonPropertyName("broker_buy_order_id")]  public string? BrokerBuyOrderId { get; set; }
    [JsonPropertyName("broker_sell_order_id")] public string? BrokerSellOrderId { get; set; }
    [JsonPropertyName("dry_run")]              public bool DryRun { get; set; }
    [JsonPropertyName("last_error")]           public string? LastError { get; set; }
}

public static class ErrorCodes
{
    public const string UnknownCommand          = "UNKNOWN_COMMAND";
    public const string BadRequest              = "BAD_REQUEST";
    public const string NotAuthenticated        = "NOT_AUTHENTICATED";
    public const string AuthFailed              = "AUTH_FAILED";
    public const string OtpRequired             = "OTP_REQUIRED";
    public const string BrokerUnreachable       = "BROKER_UNREACHABLE";
    public const string BrokerRejected          = "BROKER_REJECTED";
    public const string KillSwitchActive        = "KILL_SWITCH_ACTIVE";
    public const string DailyLimitExceeded      = "DAILY_LIMIT_EXCEEDED";
    public const string SymbolNotWhitelisted    = "SYMBOL_NOT_WHITELISTED";
    public const string MarketClosed            = "MARKET_CLOSED";
    public const string InsufficientBuyingPower = "INSUFFICIENT_BUYING_POWER";
    public const string TradeNotFound           = "TRADE_NOT_FOUND";
    public const string TradeNotCancelable      = "TRADE_NOT_CANCELABLE";
    public const string InternalError           = "INTERNAL_ERROR";
}
