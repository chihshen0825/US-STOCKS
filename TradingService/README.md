# TradingService

短線儀表板的本機下單 service（.NET 8）。在 `ws://127.0.0.1:1088/` 監聽，協定見專案根目錄 [`PROTOCOL.md`](../PROTOCOL.md)。

## ⚠️ 安全預設值

- **`DryRun = true`**（預設）：所有 `open_trade` 只在本地模擬狀態機，**不會真正下單**。
- **`KillSwitch = false`**：可由前端或 config 啟用，啟用後立即取消所有未成交單並拒絕新單。
- **`Whitelist = []`**：白名單為空＝不限制；填入後只允許清單中的代號。
- **`Daily.OrdersMax = 20` / `AmountMaxUsd = 10000`**：超過拒單。
- **僅 loopback (127.0.0.1) 監聽**：拒絕區網/外網連線。
- **單一 session**：同時只允許一個前端連線。

## 開發 / 執行

```pwsh
cd TradingService
dotnet restore
dotnet run
```

Console 出現 `TradingService listening on ws://127.0.0.1:1088/` 即可。前端儀表板開「線上下單」就會自動連線。

## 切到實單

1. 編輯 `appsettings.json` → `Trading.DryRun = false`
2. **實作真實 broker adapter**（見下節）
3. 重啟 service（不接受透過 WS 即時切換 DryRun，刻意設計）

## 加新 Broker

1. 在 `Brokers/` 新增 `class XxxBroker : IBrokerAdapter`
2. 在 `Program.cs` 的 `switch (brokerName)` 加 case
3. 在 `appsettings.json` 設 `Trading.Broker = "Xxx"` 與 broker 專屬區段
4. 實作四個方法：`LoginAsync`, `SubmitBuyAsync`, `SubmitSellAsync`, `CancelAsync`
5. 當 broker 推送成交/拒單/取消時，呼叫 `OnTradeEvent?.Invoke(new TradeUpdate(...))`

## 持久化

- Trade 狀態存 `data/trades.json`（每次變更覆寫，相對 service 工作目錄）。
- 重啟 service 後自動載入；不會遺失今日 trade 記錄。
- 不需要 SQLite。如需高頻寫入再考慮升級。

## 安裝為 Windows Service

```pwsh
dotnet publish -c Release -r win-x64 --self-contained false -o C:\Program Files\TradingService
sc.exe create TradingService binPath= "C:\Program Files\TradingService\TradingService.exe" start= auto
sc.exe start TradingService
```

（要支援 Service 生命週期需引入 `Microsoft.Extensions.Hosting.WindowsServices`，未來再加。）

## 故障排查

| 症狀                                    | 處理                                                    |
|-----------------------------------------|---------------------------------------------------------|
| `HttpListenerException: Access is denied` | 用系統管理員執行，或 `netsh http add urlacl url=http://127.0.0.1:1088/ user=Everyone` |
| 前端「WS 連線中…」一直轉                | 確認 service 已啟動、port 沒被防火牆阻擋                |
| 503/拒絕：`KILL_SWITCH_ACTIVE`          | 在前端 popover 解除 kill switch，或編輯 config 重啟     |
| `DAILY_LIMIT_EXCEEDED`                  | 改 `Trading.Daily.OrdersMax` / `AmountMaxUsd` 並重啟    |
