using System.Collections.Concurrent;
using System.Text.Json;
using TradingService.Protocol;

namespace TradingService.Storage;

/// <summary>
/// 簡易 trade 儲存：記憶體 dict + JSON 檔案（每次變更覆寫，appendonly 可後續優化）。
/// 啟動時自動載入；不要求 SQLite，降低相依。
/// </summary>
public sealed class TradeStore
{
    private readonly string _path;
    private readonly ConcurrentDictionary<string, Trade> _byId = new();
    private readonly object _saveLock = new();
    private static readonly JsonSerializerOptions _json = new() { WriteIndented = false };

    public TradeStore(string filePath)
    {
        _path = filePath;
        Load();
    }

    public Trade? Get(string id) => _byId.TryGetValue(id, out var t) ? t : null;
    public IReadOnlyCollection<Trade> All() => _byId.Values.ToList();

    public void Upsert(Trade t)
    {
        t.UpdatedUtc = DateTime.UtcNow;
        _byId[t.Id] = t;
        Save();
    }

    public string NextId()
    {
        var d = DateTime.UtcNow;
        var seq = Interlocked.Increment(ref _seq);
        return $"t-{d:yyyyMMdd}-{seq:000}";
    }
    private long _seq;

    private void Load()
    {
        try
        {
            if (!File.Exists(_path)) return;
            var json = File.ReadAllText(_path);
            var trades = JsonSerializer.Deserialize<List<Trade>>(json) ?? new();
            foreach (var t in trades) _byId[t.Id] = t;
            // 把 _seq 推到當日已知的最大值之後
            var todayPrefix = $"t-{DateTime.UtcNow:yyyyMMdd}-";
            long maxSeq = 0;
            foreach (var t in trades)
            {
                if (t.Id.StartsWith(todayPrefix) && long.TryParse(t.Id.AsSpan(todayPrefix.Length), out var n))
                    maxSeq = Math.Max(maxSeq, n);
            }
            Interlocked.Exchange(ref _seq, maxSeq);
        }
        catch { /* 啟動時 IO 錯不擋整個 service */ }
    }

    private void Save()
    {
        lock (_saveLock)
        {
            try
            {
                var dir = Path.GetDirectoryName(_path);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                var tmp = _path + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(_byId.Values, _json));
                File.Move(tmp, _path, overwrite: true);
            }
            catch { /* 持久化失敗不影響交易主流程 */ }
        }
    }
}
