using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using TradingService.Brokers;
using TradingService.Safety;
using TradingService.Server;
using TradingService.Storage;

var cfg = new ConfigurationBuilder()
    .SetBasePath(AppContext.BaseDirectory)
    .AddJsonFile("appsettings.json", optional: false)
    .Build();

using var loggerFactory = LoggerFactory.Create(b => b
    .AddConsole(o => o.FormatterName = "simple")
    .AddSimpleConsole(o => { o.TimestampFormat = "HH:mm:ss "; o.SingleLine = true; }));
var log = loggerFactory.CreateLogger("TradingService");

var host = cfg["Server:ListenHost"] ?? "127.0.0.1";
var port = int.TryParse(cfg["Server:ListenPort"], out var p) ? p : 1088;

var safetyOpts = new SafetyOptions();
cfg.GetSection("Trading").Bind(safetyOpts);
var safety = new SafetyGuard(safetyOpts);

var storePath = Path.Combine(AppContext.BaseDirectory, "data", "trades.json");
var store = new TradeStore(storePath);

// 選擇 broker。預設 Simulated；要接真實 broker，新增 class 並在此判斷。
IBrokerAdapter broker;
var brokerName = cfg["Trading:Broker"] ?? "Simulated";
switch (brokerName.ToLowerInvariant())
{
    case "simulated":
    default:
        var simDelay = int.TryParse(cfg["Simulated:BuyFillDelayMs"], out var d) ? d : 800;
        var simSlip  = decimal.TryParse(cfg["Simulated:BuyFillSlippagePct"], out var s) ? s : 0.0005m;
        var simRej   = double.TryParse (cfg["Simulated:BuyRejectProbability"], out var r) ? r : 0.0;
        broker = new SimulatedBroker(loggerFactory.CreateLogger<SimulatedBroker>(), simDelay, simSlip, simRej);
        break;
}

log.LogInformation("Broker={Broker}  DryRun={DryRun}  KillSwitch={KS}", broker.Name, safety.DryRun, safety.KillSwitch);
if (!safety.DryRun)
    log.LogWarning("**** DryRun = FALSE — orders will be sent to real broker! ****");

using var server = new WsServer(host, port, broker, safety, store, loggerFactory.CreateLogger<WsServer>());

// graceful shutdown
Console.CancelKeyPress += (_, e) => { e.Cancel = true; server.Dispose(); };

await server.RunAsync();
