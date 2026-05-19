# TradingService WebSocket Protocol v1

連線端點：`ws://127.0.0.1:1088/`（僅 loopback；不對外）
編碼：UTF-8 JSON（每訊息一行）

---

## 1. 訊息封包

### Request（client → server）
```jsonc
{
  "cmd":    "open_trade",            // 必填，命令名
  "req_id": "r123-abcd",             // 必填，client 產生的唯一字串；用於配對回應
  "...":    "...其他參數依命令而定..."
}
```

### Response（server → client，回應某筆 request）
```jsonc
{
  "req_id": "r123-abcd",             // 對應原 request
  "ok":     true,                    // true=成功，false=失敗
  "data":   { ... },                 // ok=true 時的回傳內容
  "error":  "InvalidSymbol: AAPLX",  // ok=false 時的錯誤訊息
  "code":   "INVALID_SYMBOL"         // ok=false 時的錯誤分類碼（見 §5）
}
```

### Push（server → client，非回應，主動推播）
```jsonc
{
  "cmd":  "trade_update",            // 推播類型
  "data": { ... }                    // 內容
}
```

---

## 2. 命令列表

| cmd            | 方向 | 用途                              |
|----------------|------|-----------------------------------|
| `ping`         | C→S  | 心跳；server 回 `pong`            |
| `status`       | C→S  | 取得 server 狀態（broker 連線、kill switch、daily counters）|
| `login`        | C→S  | 登入券商（user/pwd/otp）          |
| `logout`       | C→S  | 登出                              |
| `open_trade`   | C→S  | 開新單                            |
| `abort_trade`  | C→S  | 取消單                            |
| `query_trade`  | C→S  | 查詢單                            |
| `list_trades`  | C→S  | 列出今日所有單                    |
| `kill_switch`  | C→S  | 緊急停止：取消所有未成交單並拒絕新單 |
| `trade_update` | S→C  | 單狀態變更推播                    |

### 2.1 `ping`
- Request: `{ "cmd": "ping", "req_id": "..." }`
- Response: `{ "req_id": "...", "ok": true, "data": { "ts": 1716100000000 } }`
- 建議 client 每 25 秒送一次以保活並偵測斷線。

### 2.2 `status`
- Response data:
```jsonc
{
  "version":          "1.0.0",
  "broker_connected": true,
  "broker_name":      "Simulated",   // 或實際 broker 名
  "dry_run":          true,          // 預設 true
  "kill_switch":      false,
  "session_user":     "abc123" | null,
  "daily": {
    "orders_count":  3,
    "orders_max":    20,
    "amount_usd":    1500.0,
    "amount_max_usd":10000.0
  },
  "open_trades": 1
}
```

### 2.3 `login`
- Request params: `{ user, pwd, otp? }`（pwd 為加密字串或明文；視 broker 而定）
- Response data: `{ ok: true, user, session_id }`
- 錯誤碼：`AUTH_FAILED`, `OTP_REQUIRED`, `BROKER_UNREACHABLE`

### 2.4 `open_trade`
- Request params:
```jsonc
{
  "sym":        "AAPL",          // 必填，股票代號
  "qty":        100,             // 必填，正整數
  "price":      178.50,          // 必填，買入限價（USD，小數至 4 位）
  "target_pct": 0.005,           // 必填，獲利目標%（正數，0.005 = 0.5%）
  "stop_pct":   0.01,            // 選填，停損% (0 或省略 = 不設停損)
  "tif":        "DAY"            // 選填，預設 DAY；可選 GTC, IOC, FOK
}
```
- Response data：trade 物件（見 §3）
- 錯誤碼：`SYMBOL_NOT_WHITELISTED`, `DAILY_LIMIT_EXCEEDED`, `KILL_SWITCH_ACTIVE`,
  `BROKER_REJECTED`, `INSUFFICIENT_BUYING_POWER`, `MARKET_CLOSED`

### 2.5 `abort_trade`
- Request params: `{ "id": "t-20260519-001" }`
- Response data: `{ "id": "...", "cancel_requested": true }`
- 真實狀態變更由後續 `trade_update` 推送。
- 錯誤碼：`TRADE_NOT_FOUND`, `TRADE_NOT_CANCELABLE`（已成交/已取消等）

### 2.6 `query_trade` / `list_trades`
- `query_trade` params: `{ "id": "..." }` → data: trade 物件
- `list_trades` → data: `{ "trades": [...] }`（今日所有單）

### 2.7 `kill_switch`
- Request params: `{ "enable": true }` 或 `{ "enable": false }`
- 啟用後 server 立刻取消所有未成交單，並拒絕新 `open_trade`（回 `KILL_SWITCH_ACTIVE`）。
- Response data: `{ "kill_switch": true, "canceled": 3 }`

### 2.8 `trade_update`（push）
- 完整 trade 物件，每次狀態變更時推送。client 依 `id` 配對本地 record。

---

## 3. Trade 物件

```jsonc
{
  "id":                "t-20260519-001",   // server 產生，全程唯一
  "sym":               "AAPL",
  "qty":               100,
  "price":             178.50,             // 原始買入限價
  "target_pct":        0.005,
  "stop_pct":          0.01,
  "tif":               "DAY",
  "state":             "BuyPending",       // 見 §4
  "created_utc":       "2026-05-19T13:30:00Z",
  "updated_utc":       "2026-05-19T13:30:01Z",
  "buy_filled_price":  178.48,             // null 直到成交
  "buy_filled_qty":    100,
  "buy_filled_utc":    "2026-05-19T13:30:02Z",
  "sell_filled_price": null,
  "sell_filled_qty":   0,
  "sell_filled_utc":   null,
  "broker_buy_order_id":  "BRK-12345",
  "broker_sell_order_id": null,
  "dry_run":           true,
  "last_error":        null
}
```

---

## 4. State 機器

```
                                    ┌─→ BuyCanceled
                                    │
        ┌─→ BuyPending ─→ BuyCancelling ──┘
  New ──┤                │
        │                └─→ BuyFilled ─→ SellPending ─→ SellFilled  (win)
        │                                     │
        │                                     └─→ SellCanceled (loss/manual)
        │
        └─→ BuyRejected | Expired | Failed
```

- **終態**：`SellFilled`, `BuyCanceled`, `BuyRejected`, `Expired`, `Failed`, `SellCanceled`
- 任何 state 變更 → server 推送 `trade_update`

---

## 5. 錯誤碼（`code` 欄位）

| code                          | 說明                              |
|-------------------------------|-----------------------------------|
| `UNKNOWN_COMMAND`             | 未知 cmd                          |
| `BAD_REQUEST`                 | 必填欄位缺失或型別錯誤            |
| `NOT_AUTHENTICATED`           | 需先 login                        |
| `AUTH_FAILED`                 | 帳號/密碼錯誤                     |
| `OTP_REQUIRED`                | 需 OTP                            |
| `BROKER_UNREACHABLE`          | 券商 API 連線失敗                 |
| `BROKER_REJECTED`             | 券商拒單（含 last_error 細節）    |
| `KILL_SWITCH_ACTIVE`          | kill switch 啟用中                |
| `DAILY_LIMIT_EXCEEDED`        | 超過日上限                        |
| `SYMBOL_NOT_WHITELISTED`      | 不在白名單                        |
| `MARKET_CLOSED`               | 非交易時段                        |
| `INSUFFICIENT_BUYING_POWER`   | 餘額/可用資金不足                 |
| `TRADE_NOT_FOUND`             | 找不到 trade id                   |
| `TRADE_NOT_CANCELABLE`        | 當前 state 無法取消               |
| `INTERNAL_ERROR`              | server 內部例外                   |

---

## 6. 安全機制

1. **僅 loopback 監聽**（127.0.0.1）；不允許從區網/外網連入。
2. **預設 dry_run = true**：所有 `open_trade` 僅在本地模擬狀態機，不真正送單到券商。
   要實單需在 `appsettings.json` 改 `"DryRun": false` **並重啟 service**（不接受透過 WS 即時切換）。
3. **每日上限**：`OrdersMax`, `AmountMaxUsd`；超過拒單。
4. **股票白名單**：`Whitelist`（空陣列 = 不限制）。
5. **Kill switch**：可由 client 或 service config 啟用；持久化至下次重啟。
6. **單一 client session**：同時只允許一個前端連線（避免多分頁打架）；新連線會踢掉舊連線。

---

## 7. 版本控管

- 本協定版本：**v1**
- 任何 breaking change → 升為 v2，並由 `status.protocol` 回報，client 自動拒絕不相容 server。
