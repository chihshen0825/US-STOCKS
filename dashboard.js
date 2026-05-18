// @ts-check
// 短線技術面儀表板
// 同時監看 3 檔，每 3 秒輕量刷新（兩金 + sparkline + MACD 圖），每 30 秒重算 MACD/RSI 與新聞。
// 警告：本工具僅顯示技術指標讀值與綜合計分，不構成投資建議。
//
// ─── 共用工具 ─────────────────────────────────────────────────────────────
// • safeFetchJson(url, opts, retries)  指數退避重試 + JSON 解析；429 / 5xx 自動重試
// • throttleSym(sym)                   per-symbol 最小間隔節流（避免並發打爆 Yahoo）
// • saveSnapshot / loadSnapshot        chrome.storage.session 快取上一輪 watchlist
// • emitTelemetry(event, data)         可選評分埋點（window.__dashTelemetry = true 啟用）

/** 簡單 sleep */
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** per-symbol 最後 fetch 時間，用以限流 */
const _lastFetchAt = new Map();
const MIN_FETCH_INTERVAL_MS = 250;
async function throttleSym(key) {
  const now = Date.now();
  const last = _lastFetchAt.get(key) || 0;
  const wait = MIN_FETCH_INTERVAL_MS - (now - last);
  if (wait > 0) await _sleep(wait);
  _lastFetchAt.set(key, Date.now());
}

/** API 健康計數：記錄近 60s 成功 / 失敗 + 429 全域冷卻 */
const __apiStats = {
  recent: /** @type {Array<{t:number, ok:boolean}>} */([]),
  lastErr: "",
  lastUrl: "",
  cooldownUntil: 0,   // 429 冷卻到期時間戳
  cooldownStreak: 0,  // 連續 429 次數（指數退避用）
};
function recordApiCall(ok, errMsg, url) {
  __apiStats.recent.push({ t: Date.now(), ok });
  if (__apiStats.recent.length > 300) __apiStats.recent.splice(0, __apiStats.recent.length - 300);
  if (!ok && errMsg) { __apiStats.lastErr = String(errMsg).slice(0, 200); __apiStats.lastUrl = (url || "").slice(0, 160); }
}
function getApiHealth() {
  const cutoff = Date.now() - 60_000;
  const recent = __apiStats.recent.filter(x => x.t >= cutoff);
  const cooling = Date.now() < __apiStats.cooldownUntil;
  if (!recent.length && !cooling) return { rate: 0, total: 0, fails: 0, dot: "\uD83D\uDFE2", label: "API: 近 60s 無流量" };
  const fails = recent.filter(x => !x.ok).length;
  const rate = recent.length ? fails / recent.length : 1;
  const dot = cooling ? "\uD83D\uDD34" : (rate >= 0.25 ? "\uD83D\uDD34" : rate >= 0.05 ? "\uD83D\uDFE1" : "\uD83D\uDFE2");
  const coolMsg = cooling ? `\n冷卻中：還剩 ${Math.ceil((__apiStats.cooldownUntil - Date.now())/1000)}s（Yahoo 429連續 ${__apiStats.cooldownStreak} 次）` : "";
  const lastLine = (__apiStats.lastErr && (rate > 0 || cooling))
    ? `\n最後錯誤: ${__apiStats.lastErr}${__apiStats.lastUrl ? "\nURL: " + __apiStats.lastUrl : ""}` : "";
  return { rate, total: recent.length, fails, dot,
           label: `API: ${dot} 失敗率 ${(rate*100).toFixed(0)}% (${fails}/${recent.length} 近 60s)\n\u2265 25%起為紅、≥ 5%起為黃${coolMsg}${lastLine}` };
}
function renderApiHealth() {
  const el = document.getElementById("apiHealth");
  if (!el) return;
  const h = getApiHealth();
  el.textContent = h.dot;
  el.title = h.label;
  el.className = "api-health " + (h.rate >= 0.25 ? "api-bad" : h.rate >= 0.05 ? "api-warn" : "api-ok");
}

/** 關鍵門檻：可使用者調整、佔 chrome.storage.local */
const DEFAULT_THR = {
  atrMin: 0.3,
  volBurst: 3,
  volExtreme: 5,
  scoreBuy: 1.5,           // 預設放寬：BUY 門檻 3→1.5，讓中等強度訊號能出現
  scoreStrongBuy: 3.5,     // STRONG 門檻 5→3.5，避免全表都是 HOLD
  refreshSec: 2,
  cooldownBaseSec: 15,
};
const PRESETS_THR = {
  conservative: { atrMin: 0.5, volBurst: 4, volExtreme: 6, scoreBuy: 2.5, scoreStrongBuy: 5,   refreshSec: 3, cooldownBaseSec: 20 },
  standard:     { ...DEFAULT_THR },
  aggressive:   { atrMin: 0.2, volBurst: 2, volExtreme: 4, scoreBuy: 1,   scoreStrongBuy: 2.5, refreshSec: 1, cooldownBaseSec: 10 },
};
const THR_KEY = "dash_thresholds_v1";
const THR_PRESET_KEY = "dash_threshold_preset_v1";       // 目前選用的 preset
const THR_PRESET_OVERRIDES_KEY = "dash_threshold_overrides_v1"; // 各 preset 自訂值
/** @type {typeof DEFAULT_THR} */
let THR = { ...DEFAULT_THR };
/** 目前選用的 preset id（conservative / standard / aggressive） */
let CURRENT_PRESET = "standard";
/** 各 preset 的 sliders 值（含使用者調整後的覆寫） */
let PRESET_OVERRIDES = {
  conservative: { ...PRESETS_THR.conservative },
  standard:     { ...PRESETS_THR.standard },
  aggressive:   { ...PRESETS_THR.aggressive },
};
async function loadThresholds() {
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      const o = await new Promise(res => chrome.storage.local.get(
        [THR_KEY, THR_PRESET_KEY, THR_PRESET_OVERRIDES_KEY], res));
      const savedOv = o && o[THR_PRESET_OVERRIDES_KEY];
      if (savedOv && typeof savedOv === "object") {
        for (const p of Object.keys(PRESET_OVERRIDES)) {
          if (savedOv[p] && typeof savedOv[p] === "object") {
            Object.assign(PRESET_OVERRIDES[p], PRESETS_THR[p], savedOv[p]);
          }
        }
      }
      const savedPreset = o && o[THR_PRESET_KEY];
      if (savedPreset && PRESET_OVERRIDES[savedPreset]) CURRENT_PRESET = savedPreset;
      // 套用：先用該 preset 的 overrides；若舊版有 dash_thresholds_v1，當作 standard 的覆寫保留
      Object.assign(THR, DEFAULT_THR, PRESET_OVERRIDES[CURRENT_PRESET]);
      const legacy = o && o[THR_KEY];
      if (legacy && typeof legacy === "object" && !savedOv) {
        Object.assign(THR, legacy);
        Object.assign(PRESET_OVERRIDES[CURRENT_PRESET], legacy);
      }
    }
  } catch { /* noop */ }
}
function saveThresholds() {
  try {
    // 把當前 THR 同步寫回所選 preset 的 overrides
    Object.assign(PRESET_OVERRIDES[CURRENT_PRESET], THR);
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({
        [THR_KEY]: THR,
        [THR_PRESET_KEY]: CURRENT_PRESET,
        [THR_PRESET_OVERRIDES_KEY]: PRESET_OVERRIDES,
      });
    }
  } catch { /* noop */ }
}
function _labelByScore(score) {
  const a = THR.scoreStrongBuy, b = THR.scoreBuy;
  if (score >=  a) return { label: "STRONG BUY",  cls: "signal-strongbuy" };
  if (score >=  b) return { label: "BUY",         cls: "signal-buy" };
  if (score <= -a) return { label: "STRONG SELL", cls: "signal-strongsell" };
  if (score <= -b) return { label: "SELL",        cls: "signal-sell" };
  return { label: "HOLD", cls: "signal-hold" };
}

/** 並發限制 + 429 全域冷卻，避免一口氣打爆 Yahoo */
const MAX_INFLIGHT = 4;
let __inflight = 0;
const __waitQueue = /** @type {Array<() => void>} */ ([]);
function _acquireSlot() {
  if (__inflight < MAX_INFLIGHT) { __inflight++; return Promise.resolve(); }
  return new Promise(res => __waitQueue.push(() => { __inflight++; res(); }));
}
function _releaseSlot() {
  __inflight--;
  const next = __waitQueue.shift();
  if (next) next();
}
/** 抛出特殊錯誤，讓上層 catch 不要亂導致類 .card.error。使用者可透過 instanceof 判斷。 */
class ApiCooldownError extends Error { constructor(msg) { super(msg); this.name = "ApiCooldownError"; } }

/** 帶指數退避的 fetch + JSON：429/5xx 重試，最多 3 次；並受限於全域並發 slot 与 429 cooldown */
async function safeFetchJson(url, opts = {}, retries = 2) {
  // 1) 全域 cooldown：這些代表 Yahoo 才剛拒絕過我們，直接跳過並記一筆失敗
  if (Date.now() < __apiStats.cooldownUntil) {
    recordApiCall(false, "cooldown中（選擇不發送）", url);
    throw new ApiCooldownError("API cooldown");
  }
  // 2) 並發 slot
  await _acquireSlot();
  try {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let attemptOk = false;
      let attemptErr = "";
      try {
        const r = await fetch(url, opts);
        if (r.status === 429) {
          // 一碰到 429 就全域冷卻，指數退避 15s → 30s → 60s ... 上限 5min
          __apiStats.cooldownStreak = Math.min(__apiStats.cooldownStreak + 1, 6);
          const wait = Math.min((THR.cooldownBaseSec * 1000) * Math.pow(2, __apiStats.cooldownStreak - 1), 300_000);
          __apiStats.cooldownUntil = Date.now() + wait;
          throw new Error("HTTP 429 → 冷卻 " + Math.round(wait/1000) + "s");
        }
        if (r.status >= 500 && r.status < 600) throw new Error("HTTP " + r.status);
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        if (j && j.chart && j.chart.error) throw new Error("Yahoo: " + (j.chart.error.code || "error"));
        attemptOk = true;
        __apiStats.cooldownStreak = 0; // 成功就重置指數
        return j;
      } catch (e) {
        lastErr = e;
        attemptErr = (e && (e.message || e.toString())) || "unknown";
        // 遇到 429 不再 retry，直接跳出由 cooldown 接手
        if (/HTTP 429/.test(attemptErr)) { recordApiCall(false, attemptErr, url); throw e; }
        if (attempt < retries) await _sleep(300 * Math.pow(2, attempt));
      } finally {
        if (!/HTTP 429/.test(attemptErr)) recordApiCall(attemptOk, attemptErr, url);
      }
    }
    throw lastErr || new Error("safeFetchJson failed");
  } finally {
    _releaseSlot();
  }
}

/** chrome.storage.session 快取（fallback 為 sessionStorage） */
function saveSnapshot(key, value) {
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.session) {
      chrome.storage.session.set({ [key]: value });
    } else if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(key, JSON.stringify(value));
    }
  } catch { /* noop */ }
}
async function loadSnapshot(key) {
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.session) {
      const o = await chrome.storage.session.get(key);
      return o ? o[key] : null;
    } else if (typeof sessionStorage !== "undefined") {
      const s = sessionStorage.getItem(key);
      return s ? JSON.parse(s) : null;
    }
  } catch { /* noop */ }
  return null;
}

/** 評分埋點（預設關閉；於 console 設 window.__dashTelemetry = true 即啟用） */
function emitTelemetry(event, data) {
  // @ts-ignore
  if (typeof window !== "undefined" && window.__dashTelemetry) {
    try {
      const arr = JSON.parse(sessionStorage.getItem("__dashTelemetry") || "[]");
      arr.push({ t: Date.now(), event, data });
      if (arr.length > 2000) arr.splice(0, arr.length - 2000);
      sessionStorage.setItem("__dashTelemetry", JSON.stringify(arr));
    } catch { /* noop */ }
  }
}

const DEFAULT_SYMBOLS = ["INTC", "AMD", "PLTR"];
const SYMBOL_COUNT = 3;
const QUOTE_REFRESH_MS_DEFAULT = 5_000;
let quoteRefreshMs = QUOTE_REFRESH_MS_DEFAULT;
const INTERVAL_KEY = "dash_interval_v3";
const AUTO_REFRESH_KEY = "dash_auto_refresh_v1";
const HEAVY_REFRESH_MS = 30_000;
const WATCHLIST_REFRESH_MS = 60_000;   // 備選清單刷新間隔（預設 60s，可調）
const WL_INTERVAL_KEY = "dash_wl_interval_v3";
const WL_AUTO_KEY = "dash_wl_auto_v1";
let watchlistRefreshMs = WATCHLIST_REFRESH_MS;
let watchlistAutoEnabled = true;       // 備選清單是否自動刷新（與主畫面 autoRefresh 獨立）
let autoRefreshEnabled = true;         // 主畫面自動刷新（persist 到 storage）
const WATCHLIST_BATCH = 6;             // 並發批次大小

// ---- 自動點擊（每隔 N 秒自動觸發指定按鈕）----
const AUTO_CLICK_KEY = "dash_auto_click_v1";
const autoClickCfg = { enabled: false, targetId: "", intervalSec: 30 };
let _autoClickTimer = null;     // setInterval id（每秒 tick 用於倒數）
let _autoClickNextTs = 0;       // 下次觸發時間（ms）
const STORAGE_KEY = "dash_symbols_v3";
const PANELS_KEY = "dash_panels_v1";
const ACTIVE_PANEL_KEY = "dash_active_panel_v1";
const PARKING_KEY = "dash_parking_v1";
/** @type {string[]} 已從監看移除、可隨時拖回的代碼 */
let parking = [];
/** @type {{id:string,name:string}[]} */
const PANEL_DEFS = [
  { id: "temp",  name: "工作頁籤(3卡片)" },
  { id: "watch", name: "額外自選頁籤(3卡片)" },
];
/** @type {Object<string, string[]>} */
let PANELS = {
  temp:  [...DEFAULT_SYMBOLS],
  watch: [],
};
let activePanelId = "temp";
const TF_KEY = "dash_tf_v3";
const BAR_COUNT_KEY = "dash_bar_count_v1";
const BAR_COUNT_OPTIONS = [5, 10, 15, 30, 60, 90, 120, 180, 240, 300, 360, 420, 480, 540, 600];
let barCount = 60;
const CATALOG_KEY = "dash_catalog_v1";
const WL_PINNED_KEY = "dash_wl_pinned_v1";
const TSSCO_URL_KEY = "dash_tssco_url_v1";
const TSSCO_URL_DEFAULT = "https://www.tssco.com.tw/trading-info";
let tsscoUrl = TSSCO_URL_DEFAULT;

// Yahoo 允許的 interval 與需要的最小 range
const TIMEFRAMES = {
  "1m":  { range: "1d",  label: "1分",  bars: 60  },
  "5m":  { range: "5d",  label: "5分",  bars: 60  },
  "30m": { range: "1mo", label: "30分", bars: 60  },
  "60m": { range: "3mo", label: "60分", bars: 60  },
};
let timeframe = "1m";

const POSITIVE_KEYWORDS = [
  "beat","beats","surge","surges","soar","soars","rally","rallies","upgrade","upgrades",
  "raises","raise","strong","record","growth","wins","win","deal","partnership","expand",
  "expands","outperform","buy rating","bullish","milestone","breakthrough","launch","launches",
  "jump","jumps","jumped","gain","gains","gained","rise","rises","rose","climb","climbs","climbed",
  "advance","advances","rebound","rebounds","rebounded","top","tops","topped","beats estimates",
  "all-time high","record high","new high","outperforms","upbeat","optimistic","boost","boosts",
  "上漲","大漲","暴漲","飆漲","飆升","看好","利多","突破","創新高","成長","獲利","調升","強勁","拿下","新訂單",
  "走高","攀升","站上","強彈","反彈","回升","勁揚","收紅","跳空"
];
const NEGATIVE_KEYWORDS = [
  "miss","misses","drop","drops","fall","falls","plunge","plunges","decline","downgrade",
  "downgrades","cuts","cut","weak","loss","losses","lawsuit","probe","investigation","layoff",
  "layoffs","warns","warning","underperform","sell rating","bearish","concerns","risk","delay","recall",
  "tumble","tumbles","tumbled","slump","slumps","slumped","crash","crashes","crashed","sink","sinks",
  "sank","slide","slides","slid","dive","dives","dived","sell-off","selloff","slip","slips","slipped",
  "lower","lowers","plummets","plummet","plummeted","skid","skids","skidded","rout","routs","headwind",
  "headwinds","下跌","大跌","暴跌","重挫","跳水","崩跌","崩盤","崩落","摔落","殺低","殺出","看壞","利空",
  "跌破","新低","虧損","裁員","下修","疲弱","警告","延遲","召回","訴訟","失血","失守","跳空跌"
];

let symbols = [...DEFAULT_SYMBOLS];
let quoteTimer = null;
let heavyTimer = null;
let watchlistTimer = null;
let indicesTimer = null;
let apiHealthTimer = null;
// 大盤參考：供 calcSignal 中「大盤同向 / 相對強弱」使用
const marketChgMap = new Map(); // sym -> pct
function marketAvgPct() {
  const arr = [...marketChgMap.values()].filter(v => typeof v === "number" && Number.isFinite(v));
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
const heavyCache = new Map();
let wlSortKey = "score1"; let wlSortDesc = true;
const wlData = new Map();
// 釘選的股票代碼（依目前順序排列），會永遠顯示在備選清單最上方，不受排序影響。
// 透過列首的 📌 圖示切換，並可在釘選區內部以拖拉重新排序。
let wlPinned = [];
function loadPinned() {
  return new Promise(resolve => {
    try {
      chrome.storage?.local.get([WL_PINNED_KEY], (r) => {
        const v = r?.[WL_PINNED_KEY];
        if (Array.isArray(v)) wlPinned = v.map(s => String(s || "").toUpperCase()).filter(Boolean);
        resolve();
      });
    } catch { resolve(); }
  });
}
function savePinned() {
  try { chrome.storage?.local.set({ [WL_PINNED_KEY]: wlPinned }); } catch {}
}
function isPinned(sym) { return wlPinned.indexOf(sym) >= 0; }
function togglePin(sym) {
  if (!sym) return;
  sym = String(sym).toUpperCase();
  const i = wlPinned.indexOf(sym);
  if (i >= 0) wlPinned.splice(i, 1);
  else        wlPinned.push(sym);
  savePinned();
  renderWatchlist();
}
// 將 sym 拖到 beforeSym 之前；beforeSym 為 null 代表拖到最後。
function reorderPin(sym, beforeSym) {
  sym = String(sym || "").toUpperCase();
  if (!sym) return;
  const i = wlPinned.indexOf(sym);
  if (i < 0) return;
  wlPinned.splice(i, 1);
  if (beforeSym) {
    const j = wlPinned.indexOf(String(beforeSym).toUpperCase());
    wlPinned.splice(j < 0 ? wlPinned.length : j, 0, sym);
  } else {
    wlPinned.push(sym);
  }
  savePinned();
  renderWatchlist();
}

// ---- Chart 請求去重 + 短期快取 ----
// In-flight: 同 URL 同時的 N 個呼叫共用同一個 Promise，避免重複網路。
// Result TTL: 刚完成的 chart 結果在 1.5s 內直接命中，填平 heavy→quick、以及
// heavy + watchlist 同時要 15m 的空窗。內容有異動 (1m bar) 時不會空等太久。
const _chartInflight = new Map(); // url -> Promise
const _chartCache    = new Map(); // url -> { ts, value }
const CHART_FETCH_TTL_MS = 1500;
// 定期清掉過期條目（每 30s），避免長時間開啟頁面導致 Map 無限增長
setInterval(() => {
  const cutoff = Date.now() - CHART_FETCH_TTL_MS * 4;
  for (const [k, v] of _chartCache) if (v.ts < cutoff) _chartCache.delete(k);
}, 30_000);


// 大盤指數
const INDICES = [
  ["^DJI",  "道瓊"],
  ["^IXIC", "納斯達克"],
  ["^GSPC", "S&P 500"],
  ["^SOX",  "費半"],
  ["^RUT",  "羅素2000"],
  ["^TWII", "台股加權"],
];
const INDICES_REFRESH_MS = 5_000;

document.addEventListener("DOMContentLoaded", async () => {
  await loadSymbols();
  await loadTimeframe();
  await loadInterval();
  await loadAutoRefresh();
  await loadCatalog();
  await loadPinned();
  await loadSigHistory();
  await loadThresholds();
  await loadParking();
  await loadSimTrades();
  buildGrid();
  buildIndices();
  buildPanelTabs();
  bindUI();
  bindThresholdPanel();
  bindSimPanel();
  initTradingClient();
  renderSimPanel();
  // 每秒重繪 sim 面板，讓「持有時間」與 Live 價格/PnL 持續跳動（只在有 pending/open 時才繪）
  try {
    setInterval(() => {
      if (!Array.isArray(simTrades) || simTrades.length === 0) return;
      const hasLive = simTrades.some(t => t && (t.status === "pending" || t.status === "open" || t.status === "selling"));
      if (!hasLive) return;
      if (document.hidden) return;
      renderSimPanel();
    }, 1000);
  } catch (_) {}
  renderCatalogEditor();
  // 開啟 popup/tab 時先用上一輪 watchlist 快照即時顯示，背景再刷新真實資料
  try {
    const snap = await loadSnapshot("dash_wl_snapshot_v1");
    if (snap && Array.isArray(snap)) {
      for (const [k, v] of snap) wlData.set(k, v);
      renderWatchlist();
    }
  } catch { /* noop */ }
  await heavyRefreshAll();
  await quickRefreshAll();
  refreshIndices();
  if (autoRefreshEnabled) startTimers();
  refreshWatchlist();           // 不阻塞主畫面
  // 線上更版檢查：讀取 background 寫入的最新版資訊；若有新版則顯示右下橫幅
  try { initUpdateBanner(); } catch (e) { try { console.warn("[update] banner init failed:", e); } catch {} }
});

async function loadInterval() {
  return new Promise(resolve => {
    chrome.storage?.local.get([INTERVAL_KEY], (r) => {
      const sec = parseInt(r?.[INTERVAL_KEY], 10);
      if (sec >= 1 && sec <= 30) quoteRefreshMs = sec * 1000;
      resolve();
    });
  });
}

async function loadAutoRefresh() {
  return new Promise(resolve => {
    if (!chrome?.storage?.local) { resolve(); return; }
    chrome.storage.local.get([AUTO_REFRESH_KEY], (r) => {
      if (r && typeof r[AUTO_REFRESH_KEY] === "boolean") {
        autoRefreshEnabled = r[AUTO_REFRESH_KEY];
      }
      resolve();
    });
  });
}

async function loadTimeframe() {
  return new Promise(resolve => {
    chrome.storage?.local.get([TF_KEY], (r) => {
      const t = r?.[TF_KEY];
      if (t && TIMEFRAMES[t]) timeframe = t;
      resolve();
    });
  });
}
function saveTimeframe(tf) {
  timeframe = tf;
  chrome.storage?.local.set({ [TF_KEY]: tf });
}

async function loadSymbols() {
  return new Promise(resolve => {
    if (!chrome?.storage?.local) { symbols = PANELS[activePanelId]; resolve(); return; }
    chrome.storage.local.get([STORAGE_KEY, PANELS_KEY, ACTIVE_PANEL_KEY], (r) => {
      const p = r?.[PANELS_KEY];
      if (p && typeof p === "object") {
        for (const def of PANEL_DEFS) {
          const v = p[def.id];
          if (!Array.isArray(v)) continue;
          // 所有 panel 都允許 0..SYMBOL_COUNT
          PANELS[def.id] = v.slice(0, SYMBOL_COUNT);
        }
      } else {
        // 興舊版 STORAGE_KEY 協同到 temp panel
        const s = r?.[STORAGE_KEY];
        if (Array.isArray(s)) PANELS.temp = s.slice(0, SYMBOL_COUNT);
      }
      const ap = r?.[ACTIVE_PANEL_KEY];
      if (ap && PANEL_DEFS.some(d => d.id === ap)) activePanelId = ap;
      symbols = PANELS[activePanelId];
      resolve();
    });
  });
}
async function saveSymbols(s) {
  symbols = s;
  PANELS[activePanelId] = s;
  return new Promise(resolve => {
    if (!chrome?.storage?.local) { resolve(); return; }
    chrome.storage.local.set({
      [PANELS_KEY]: PANELS,
      [ACTIVE_PANEL_KEY]: activePanelId,
      [STORAGE_KEY]: s, // 保留與舊版相容
    }, resolve);
  });
}

// ── 暫存區（卸下監看的代碼） ──
async function loadParking() {
  return new Promise(resolve => {
    if (!chrome?.storage?.local) { resolve(); return; }
    chrome.storage.local.get([PARKING_KEY], (r) => {
      const v = r?.[PARKING_KEY];
      if (Array.isArray(v)) parking = v.filter(s => typeof s === "string" && s);
      resolve();
    });
  });
}
function saveParking() {
  if (!chrome?.storage?.local) return;
  chrome.storage.local.set({ [PARKING_KEY]: parking });
}
function renderParking() {
  const box = document.getElementById("parkingBar");
  if (!box) return;
  box.innerHTML =
    `<span class="parking-label" title="把卡片拖來這裡可從監看中移除；點代碼可拖回監看">📥 卡片卸下區</span>` +
    (parking.length === 0
      ? `<span class="parking-empty">（空，拖卡片到這裡卸下）</span>`
      : parking.map(s => `<span class="parking-chip" draggable="true" data-park-sym="${s}" title="拖回卡片區可重新加入監看；雙擊移除">${s}</span>`).join("")) +
    (parking.length > 0
      ? `<button id="parkingClearAllBtn" type="button" class="parking-clear-all" title="清空整個卡片卸下區（${parking.length} 檔）">⌫</button>`
      : "");
  const clearBtn = box.querySelector("#parkingClearAllBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (!confirm(`確定清空卡片卸下區全部 ${parking.length} 檔？`)) return;
      parking = [];
      saveParking();
      renderParking();
    });
  }
  // chip drag-out
  box.querySelectorAll(".parking-chip").forEach(chip => {
    chip.addEventListener("dragstart", (e) => {
      _dragSrc = { type: "park", sym: chip.dataset.parkSym };
      chip.classList.add("dragging");
      try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", _dragSrc.sym); } catch(_) {}
    });
    chip.addEventListener("dragend", () => {
      _dragSrc = null;
      chip.classList.remove("dragging");
    });
    chip.addEventListener("dblclick", async () => {
      parking = parking.filter(x => x !== chip.dataset.parkSym);
      saveParking();
      renderParking();
    });
  });
  // accept drop from grid card
  if (!box.dataset.dropBound) {
    box.dataset.dropBound = "1";
    box.addEventListener("dragover", parkingDragOver);
    box.addEventListener("dragleave", parkingDragLeave);
    box.addEventListener("drop", parkingDrop);
  }
}
function parkingDragOver(e) {
  if (!_dragSrc || _dragSrc.type !== "card") return;
  e.preventDefault();
  try { e.dataTransfer.dropEffect = "move"; } catch(_) {}
  e.currentTarget.classList.add("drag-over");
}
function parkingDragLeave(e) {
  e.currentTarget.classList.remove("drag-over");
}
async function parkingDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove("drag-over");
  if (!_dragSrc || _dragSrc.type !== "card") return;
  const sym = _dragSrc.sym;
  _dragSrc = null;
  if (!sym || !symbols.includes(sym)) return;
  const next = symbols.filter(s => s !== sym);
  if (!parking.includes(sym)) parking.unshift(sym);
  if (parking.length > 50) parking.length = 50;
  saveParking();
  await applySymbolsAndReload(next);
  renderParking();
}

// 移除區：拖卡片過去 → 從 symbols 移除（不進 parking）；拖 parking chip 過去 → 從 parking 永久移除
function bindTrashBar() {
  const box = document.getElementById("trashBar");
  if (!box || box.dataset.dropBound) return;
  box.dataset.dropBound = "1";
  // 全清按鈕
  const clearBtn = document.getElementById("trashClearAllBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (symbols.length === 0) return;
      const def = PANEL_DEFS.find(d => d.id === activePanelId);
      if (!confirm(`確定清空 [${def?.name || activePanelId}] 全部 ${symbols.length} 檔監看卡片？\n（不會進卸下區）`)) return;
      await applySymbolsAndReload([]);
    });
  }
  box.addEventListener("dragover", (e) => {
    if (!_dragSrc) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "move"; } catch(_) {}
    box.classList.add("drag-over");
  });
  box.addEventListener("dragleave", () => box.classList.remove("drag-over"));
  box.addEventListener("drop", async (e) => {
    e.preventDefault();
    box.classList.remove("drag-over");
    if (!_dragSrc) return;
    const src = _dragSrc;
    _dragSrc = null;
    if (src.type === "card") {
      if (!symbols.includes(src.sym)) return;
      const next = symbols.filter(s => s !== src.sym);
      await applySymbolsAndReload(next);
    } else if (src.type === "park") {
      parking = parking.filter(s => s !== src.sym);
      saveParking();
      renderParking();
    }
  });
}
// 上一組 / 下一組 symbols 的紀錄堆疊（供「還原 / 重做」使用）
const symbolsHistory = [];
const symbolsRedo = [];
function updateUndoBtn() {
  const isTemp = activePanelId === "temp";
  const bar = document.getElementById("panelTabs");
  if (!bar) return;
  const u = bar.querySelector('button.panel-extra-btn[data-act="undo"]');
  const r = bar.querySelector('button.panel-extra-btn[data-act="redo"]');
  const c = bar.querySelector('button.panel-extra-btn[data-act="clear"]');
  if (u) u.disabled = !isTemp || symbolsHistory.length === 0;
  if (r) r.disabled = !isTemp || symbolsRedo.length === 0;
  if (c) c.disabled = !isTemp || (symbolsHistory.length === 0 && symbolsRedo.length === 0);
}
async function applySymbolsAndReload(newList, { pushHistory = true, pushRedo = false, clearRedo = true } = {}) {
  if (!Array.isArray(newList)) return;
  // 所有 panel 都允許 0..SYMBOL_COUNT
  if (newList.length > SYMBOL_COUNT) {
    newList = newList.slice(0, SYMBOL_COUNT);
  }
  // 完全相同就跳過
  if (newList.length === symbols.length && newList.every((s, i) => s === symbols[i])) return;
  // [自選] 分頁不使用 undo/redo 機制
  const useHistory = activePanelId === "temp";
  if (useHistory && pushHistory) {
    symbolsHistory.push([...symbols]);
    if (symbolsHistory.length > 20) symbolsHistory.shift();
  }
  if (useHistory && pushRedo) {
    symbolsRedo.push([...symbols]);
    if (symbolsRedo.length > 20) symbolsRedo.shift();
  }
  if (useHistory && clearRedo) symbolsRedo.length = 0;
  await saveSymbols(newList);
  // 只清除「被移除」的 symbols，保留仍然存在者的 heavyCache，避免重複拉取
  {
    const keep = new Set(newList);
    for (const k of [...heavyCache.keys()]) if (!keep.has(k)) heavyCache.delete(k);
  }
  buildGrid();
  await heavyRefreshAll();
  await quickRefreshAll();
  updateUndoBtn();
}

// 從 watchlist 資料挑出 score 最高的前 3 檔
function pickTop3FromWatchlist(scoreKey) {
  const rows = [...wlData.values()].filter(r => r && typeof r[scoreKey] === "number");
  if (rows.length < SYMBOL_COUNT) return null;
  rows.sort((a, b) => b[scoreKey] - a[scoreKey]);
  return rows.slice(0, SYMBOL_COUNT).map(r => r.sym);
}

// 依備選清單「目前排序」取前 3 名（與 renderWatchlist 一致的 cmp 邏輯）
function pickTop3FromCurrentSort() {
  const rows = [...wlData.values()];
  if (rows.length < SYMBOL_COUNT) return null;
  const tieKey = wlSortKey === "score1" ? "score5"
              : wlSortKey === "score5" ? "score1" : null;
  const getVal = (row, key) => {
    if (key === "prePct")  return row.pre?.changePct;
    if (key === "postPct") return row.post?.changePct;
    if (key === "confluence") {
      // 共振強度：三共振多 +3、雙共振多 +2、中性/分歧 0、雙共振空 -2、三共振空 -3
      const d = row.confluenceDir; const c = row.confluenceCount;
      return (typeof d === "number" && typeof c === "number") ? d * c : 0;
    }
    return row[key];
  };
  rows.sort((a, b) => {
    let av = getVal(a, wlSortKey), bv = getVal(b, wlSortKey);
    if (typeof av === "string" || typeof bv === "string") {
      av = (av ?? ""); bv = (bv ?? "");
      return wlSortDesc ? bv.localeCompare(av) : av.localeCompare(bv);
    }
    av = av == null ? -Infinity : av;
    bv = bv == null ? -Infinity : bv;
    const c = wlSortDesc ? bv - av : av - bv;
    if (c !== 0 || !tieKey) return c;
    const tav = a[tieKey] == null ? -Infinity : a[tieKey];
    const tbv = b[tieKey] == null ? -Infinity : b[tieKey];
    return tbv - tav;
  });
  return rows.slice(0, SYMBOL_COUNT).map(r => r.sym);
}
async function applyTop3(scoreKey, label) {
  const top = pickTop3FromWatchlist(scoreKey);
  if (!top) {
    alert(`監控清單尚未載入完成，請稍候再試（${label}）`);
    return;
  }
  // 一致性：TOP3 點選後也讓 watchlist 依對應分數進行排序
  wlSortKey = scoreKey; wlSortDesc = true;
  updateSortIndicators(); renderWatchlist();
  await applySymbolsAndReload(top);
}

// 跌深反彈得分：今日跌越多 + 1分5分線佔強 + MACD-H 轉正 + RSI 不是超買 = 倒車偏多倉位
function reboundScoreOf(r) {
  if (!r) return -Infinity;
  let s = 0;
  if (typeof r.chgPct === "number" && r.chgPct < 0) s += Math.min(20, Math.abs(r.chgPct)) * 0.6;
  if (typeof r.score1 === "number") s += r.score1 * 1.5;
  if (typeof r.score5 === "number") s += r.score5 * 0.8;
  if (typeof r.hist5 === "number" && r.hist5 > 0) s += 2;
  if (typeof r.rsi5  === "number") {
    if (r.rsi5 >= 30 && r.rsi5 <= 55) s += 1.5;       // 刚從超賣反彈上來
    else if (r.rsi5 < 30) s += 0.5;                    // 還在超賣，但可能是初始反彈
    else if (r.rsi5 > 70) s -= 1;                      // 超買不合適進場
  }
  return s;
}
function pickTop3Rebound() {
  const rows = [...wlData.values()].filter(r =>
    r &&
    typeof r.score1 === "number" &&
    typeof r.chgPct === "number" &&
    r.chgPct < 0 &&            // 今日下跌
    r.score1 > 0               // 1 分線轉強
  );
  if (rows.length < SYMBOL_COUNT) return null;
  rows.sort((a, b) => reboundScoreOf(b) - reboundScoreOf(a));
  return rows.slice(0, SYMBOL_COUNT).map(r => r.sym);
}
async function applyTop3Rebound() {
  const top = pickTop3Rebound();
  if (!top) {
    alert("目前沒有足夠「跌深且 1 分線轉強」的個股，請稍候再試");
    return;
  }
  wlSortKey = "score1"; wlSortDesc = true;
  updateSortIndicators(); renderWatchlist();
  await applySymbolsAndReload(top);
}

// 🔥 飆股潛力 TOP3：依 hotScore 排序，過濾 RSI5 過熱（避免追在山頂）
function pickTop3Hot() {
  const rows = [...wlData.values()].filter(r =>
    r && typeof r.hotScore === "number" && r.hotScore >= 3 &&
    !(typeof r.rsi5 === "number" && r.rsi5 >= 85)
  );
  if (rows.length < SYMBOL_COUNT) return null;
  rows.sort((a, b) => (b.hotScore - a.hotScore) || ((b.score1 ?? -Infinity) - (a.score1 ?? -Infinity)));
  return rows.slice(0, SYMBOL_COUNT).map(r => r.sym);
}
async function applyTop3Hot() {
  const top = pickTop3Hot();
  if (!top) { alert("目前備選清單中沒有足夠飆股潛力候選（hotScore ≥ 3 且 RSI5 < 85），請稍候再試"); return; }
  // 同時讓下方 watchlist 依 hotScore 降序排序，快速看到飆股排名
  wlSortKey = "hotScore"; wlSortDesc = true;
  updateSortIndicators(); renderWatchlist();
  await applySymbolsAndReload(top);
}

// ❄ 超跌續弱 TOP3：依 coldScore 排序，過濾 RSI5 過冷（避免空在地板）
function pickTop3Cold() {
  const rows = [...wlData.values()].filter(r =>
    r && typeof r.coldScore === "number" && r.coldScore >= 3 &&
    !(typeof r.rsi5 === "number" && r.rsi5 <= 15)
  );
  if (rows.length < SYMBOL_COUNT) return null;
  rows.sort((a, b) => (b.coldScore - a.coldScore) || ((a.score1 ?? Infinity) - (b.score1 ?? Infinity)));
  return rows.slice(0, SYMBOL_COUNT).map(r => r.sym);
}
async function applyTop3Cold() {
  const top = pickTop3Cold();
  if (!top) { alert("目前備選清單中沒有足夠超跌續弱候選（coldScore ≥ 3 且 RSI5 > 15），請稍候再試"); return; }
  // 下方 watchlist 改以 hotScore 升序（越低越超跌）排序
  wlSortKey = "hotScore"; wlSortDesc = false;
  updateSortIndicators(); renderWatchlist();
  await applySymbolsAndReload(top);
}

// ↗ +0.5% 勝率 TOP3
function pickTop3Wr050() {
  const rows = [...wlData.values()].filter(r => r && typeof r.wr050 === "number" && r.wr050 > 0);
  if (rows.length < SYMBOL_COUNT) return null;
  rows.sort((a, b) => b.wr050 - a.wr050);
  return rows.slice(0, SYMBOL_COUNT).map(r => r.sym);
}
async function applyTop3Wr050() {
  const top = pickTop3Wr050();
  if (!top) { alert("目前備選清單中沒有足夠「+0.5% 勝率 > 0」的個股，請稍候再試"); return; }
  wlSortKey = "wr050"; wlSortDesc = true;
  updateSortIndicators(); renderWatchlist();
  await applySymbolsAndReload(top);
}

// ↘ -0.5% 賠率 TOP3
function pickTop3Wr050Down() {
  const rows = [...wlData.values()].filter(r => r && typeof r.wr050d === "number" && r.wr050d > 0);
  if (rows.length < SYMBOL_COUNT) return null;
  rows.sort((a, b) => b.wr050d - a.wr050d);
  return rows.slice(0, SYMBOL_COUNT).map(r => r.sym);
}
async function applyTop3Wr050Down() {
  const top = pickTop3Wr050Down();
  if (!top) { alert("目前備選清單中沒有足夠「-0.5% 賠率 > 0」的個股，請稍候再試"); return; }
  wlSortKey = "wr050d"; wlSortDesc = true;
  updateSortIndicators(); renderWatchlist();
  await applySymbolsAndReload(top);
}

// 最近 1 分鐘漲幅最高 3 檔（使用表格顯示的同一個欄位 last1mPct，避免與 chg1mPct 連個來源不一致）
function pickTop3Gain1m() {
  const rows = [...wlData.values()].filter(r =>
    r && typeof r.last1mPct === "number" && r.last1mPct > 0
  );
  if (rows.length < SYMBOL_COUNT) return null;
  rows.sort((a, b) => (b.last1mPct - a.last1mPct) || ((b.score1 ?? -Infinity) - (a.score1 ?? -Infinity)));
  return rows.slice(0, SYMBOL_COUNT).map(r => r.sym);
}
async function applyTop3Gain1m() {
  const top = pickTop3Gain1m();
  if (!top) {
    alert("目前備選清單中沒有足夠主勢上漲的個股（最近 1 分鐘改變為正），請稍候再試");
    return;
  }
  wlSortKey = "last1mPct"; wlSortDesc = true;
  updateSortIndicators(); renderWatchlist();
  await applySymbolsAndReload(top);
}

// ─── 反向版本：挑分數最低 / 漲高回檔 / 1分跌幅最大 ───
function pickBottom3FromWatchlist(scoreKey) {
  const rows = [...wlData.values()].filter(r => r && typeof r[scoreKey] === "number");
  if (rows.length < SYMBOL_COUNT) return null;
  rows.sort((a, b) => a[scoreKey] - b[scoreKey]);
  return rows.slice(0, SYMBOL_COUNT).map(r => r.sym);
}
async function applyBottom3(scoreKey, label) {
  const bot = pickBottom3FromWatchlist(scoreKey);
  if (!bot) {
    alert(`監控清單尚未載入完成，請稍候再試（${label}）`);
    return;
  }
  wlSortKey = scoreKey; wlSortDesc = false;
  updateSortIndicators(); renderWatchlist();
  await applySymbolsAndReload(bot);
}

// 漲高回檔：今日漲多 + 1分線轉弱 + MACD-H 轉負 + RSI 不是超賣
function pullbackScoreOf(r) {
  if (!r) return -Infinity;
  let s = 0;
  if (typeof r.chgPct === "number" && r.chgPct > 0) s += Math.min(20, r.chgPct) * 0.6;
  if (typeof r.score1 === "number") s += -r.score1 * 1.5;
  if (typeof r.score5 === "number") s += -r.score5 * 0.8;
  if (typeof r.hist5 === "number" && r.hist5 < 0) s += 2;
  if (typeof r.rsi5  === "number") {
    if (r.rsi5 >= 45 && r.rsi5 <= 70) s += 1.5;       // 從超買轉弱下來
    else if (r.rsi5 > 70) s += 0.5;                    // 還在超買，可能是初始回檔
    else if (r.rsi5 < 30) s -= 1;                      // 超賣不適合進場試空
  }
  return s;
}
function pickTop3Pullback() {
  const rows = [...wlData.values()].filter(r =>
    r &&
    typeof r.score1 === "number" &&
    typeof r.chgPct === "number" &&
    r.chgPct > 0 &&            // 今日上漲
    r.score1 < 0               // 1 分線轉弱
  );
  if (rows.length < SYMBOL_COUNT) return null;
  rows.sort((a, b) => pullbackScoreOf(b) - pullbackScoreOf(a));
  return rows.slice(0, SYMBOL_COUNT).map(r => r.sym);
}
async function applyTop3Pullback() {
  const top = pickTop3Pullback();
  if (!top) {
    alert("目前沒有足夠「漲多且 1 分線轉弱」的個股，請稍候再試");
    return;
  }
  wlSortKey = "score1"; wlSortDesc = false;
  updateSortIndicators(); renderWatchlist();
  await applySymbolsAndReload(top);
}

// 最近 1 分鐘跌幅最大 3 檔（使用表格顯示的同一個欄位 last1mPct）
function pickTop3Loss1m() {
  const rows = [...wlData.values()].filter(r =>
    r && typeof r.last1mPct === "number" && r.last1mPct < 0
  );
  if (rows.length < SYMBOL_COUNT) return null;
  rows.sort((a, b) => (a.last1mPct - b.last1mPct) || ((a.score1 ?? Infinity) - (b.score1 ?? Infinity)));
  return rows.slice(0, SYMBOL_COUNT).map(r => r.sym);
}
async function applyTop3Loss1m() {
  const top = pickTop3Loss1m();
  if (!top) {
    alert("目前備選清單中沒有足夠下跌的個股（最近 1 分鐘變動為負），請稍候再試");
    return;
  }
  wlSortKey = "last1mPct"; wlSortDesc = false;
  updateSortIndicators(); renderWatchlist();
  await applySymbolsAndReload(top);
}

function bindUI() {
  // ---- 按鈕 re-entrancy guard ----
  // 解決：使用者連點 refresh 或 TOP3 時可能觸發多次重疊的 applySymbolsAndReload
  //       造成 symbols / 歷史堆疊 race，以及對網路多次重複請求
  let _btnBusy = false;
  function withBtnGuard(fn) {
    return async (...args) => {
      if (_btnBusy) return; // 忽略連點
      _btnBusy = true;
      const btns = document.querySelectorAll(
        '#refreshBtn, #top1Btn, #top5Btn, #top1SellBtn, #top5SellBtn, ' +
        '#topReboundBtn, #topHotBtn, #topColdBtn, ' +
        '#topWr050UpBtn, #topWr050DownBtn, ' +
        '#topGain1mBtn, #topLoss1mBtn, #topPullbackBtn'
      );
      btns.forEach(b => { b.disabled = true; b.classList.add('btn-busy'); });
      try { await fn(...args); }
      catch (e) { console.error('[btn]', e); }
      finally {
        _btnBusy = false;
        btns.forEach(b => { b.disabled = false; b.classList.remove('btn-busy'); });
      }
    };
  }
  $("refreshBtn").addEventListener("click", withBtnGuard(async () => {
    await heavyRefreshAll();
    await quickRefreshAll();
  }));
  $("autoRefresh").addEventListener("change", () => {
    autoRefreshEnabled = $("autoRefresh").checked;
    chrome.storage?.local.set({ [AUTO_REFRESH_KEY]: autoRefreshEnabled });
    if (autoRefreshEnabled) startTimers(); else stopTimers();
  });
  // 套用之前 storage 讀出的狀態
  if ($("autoRefresh")) $("autoRefresh").checked = autoRefreshEnabled;
  // 刷新間隔下拉
  const sel = $("refreshInterval");
  if (sel) {
    sel.value = String(quoteRefreshMs / 1000);
    sel.addEventListener("change", () => {
      const sec = Math.max(1, Math.min(30, parseInt(sel.value, 10) || 5));
      quoteRefreshMs = sec * 1000;
      chrome.storage?.local.set({ [INTERVAL_KEY]: sec });
      if (autoRefreshEnabled) startTimers();
    });
  }
  // settingsBtn 由 buildPanelTabs() 動態插入到分頁列並在那裡綁定
  $("top1Btn")?.addEventListener("click", withBtnGuard(() => applyTop3("score1", "TOP3 1分")));
  $("top5Btn")?.addEventListener("click", withBtnGuard(() => applyTop3("score5", "TOP3 5分")));
  $("topReboundBtn")?.addEventListener("click", withBtnGuard(applyTop3Rebound));
  $("topHotBtn")?.addEventListener("click", withBtnGuard(applyTop3Hot));
  $("topColdBtn")?.addEventListener("click", withBtnGuard(applyTop3Cold));
  $("topWr050UpBtn")?.addEventListener("click", withBtnGuard(applyTop3Wr050));
  $("topWr050DownBtn")?.addEventListener("click", withBtnGuard(applyTop3Wr050Down));
  $("topGain1mBtn")?.addEventListener("click", withBtnGuard(applyTop3Gain1m));
  $("top1SellBtn")?.addEventListener("click", withBtnGuard(() => applyBottom3("score1", "TOP3 1分 SELL")));
  $("top5SellBtn")?.addEventListener("click", withBtnGuard(() => applyBottom3("score5", "TOP3 5分 SELL")));
  $("topPullbackBtn")?.addEventListener("click", withBtnGuard(applyTop3Pullback));
  $("topLoss1mBtn")?.addEventListener("click", withBtnGuard(applyTop3Loss1m));
  // undo/redo/clearHist 按鈕現在由 buildPanelTabs() 動態建立並綁定（專屬暫存 tab）
  // 備選清單刷新間距下拉
  const wlSel = $("wlInterval");
  if (wlSel) {
    chrome.storage?.local.get([WL_INTERVAL_KEY], (r) => {
      const sec = parseInt(r?.[WL_INTERVAL_KEY], 10);
      if ([1, 3, 5, 10, 15, 30, 60, 90, 120].includes(sec)) {
        watchlistRefreshMs = sec * 1000;
        wlSel.value = String(sec);
      } else {
        wlSel.value = String(watchlistRefreshMs / 1000);
      }
    });
    wlSel.addEventListener("change", () => {
      const sec = parseInt(wlSel.value, 10) || 60;
      watchlistRefreshMs = sec * 1000;
      chrome.storage?.local.set({ [WL_INTERVAL_KEY]: sec });
      if ($("autoRefresh").checked) startTimers();
    });
  }
  $("wlRefreshBtn")?.addEventListener("click", refreshWatchlist);
  // 備選清單「自動」checkbox：關閉時只停止備選清單計時器，
  // 不影響上方主表格的 autoRefresh
  const wlAutoEl = $("wlAutoRefresh");
  if (wlAutoEl) {
    chrome.storage?.local.get([WL_AUTO_KEY], (r) => {
      const v = r?.[WL_AUTO_KEY];
      if (v === false) {
        watchlistAutoEnabled = false;
        wlAutoEl.checked = false;
      }
    });
    wlAutoEl.addEventListener("change", () => {
      watchlistAutoEnabled = wlAutoEl.checked;
      chrome.storage?.local.set({ [WL_AUTO_KEY]: watchlistAutoEnabled });
      // 只重起 / 停止備選清單計時器，不動其他計時器
      if (watchlistTimer) { clearInterval(watchlistTimer); watchlistTimer = null; }
      if (watchlistAutoEnabled && $("autoRefresh").checked) {
        watchlistTimer = setInterval(refreshWatchlist, watchlistRefreshMs);
      }
    });
  }
  $("wlApplyTopBtn")?.addEventListener("click", async () => {
    const top = pickTop3FromCurrentSort();
    if (!top) { alert("備選清單尚未載入完成，請稍候再試"); return; }
    await applySymbolsAndReload(top);
  });
  $("wlCopyBtn")?.addEventListener("click", async () => {
    const btn = $("wlCopyBtn");
    const tsv = buildWatchlistTSV();
    if (!tsv) { if (btn) { const o = btn.textContent; btn.textContent = "⚠ 無資料"; setTimeout(() => btn.textContent = o, 1200); } return; }
    try {
      await navigator.clipboard.writeText(tsv);
      if (btn) { const o = btn.textContent; btn.textContent = "✓ 已複製"; setTimeout(() => btn.textContent = o, 1200); }
    } catch (e) {
      // fallback：建立暫時 textarea
      try {
        const ta = document.createElement("textarea");
        ta.value = tsv; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        if (btn) { const o = btn.textContent; btn.textContent = "✓ 已複製"; setTimeout(() => btn.textContent = o, 1200); }
      } catch {
        alert("複製失敗：" + (e?.message || e));
      }
    }
  });
  document.querySelectorAll("#wlTable thead th").forEach((th, i) => {
    // 訊號欄合併分數：score1 / score5 為排序鍵
    const keys = ["sym","name","price","chgPct","prePct","postPct","score1","score5","wr030","wr050","wr050d","confluence","rs5d","hotScore","mom5UpPre","mom5UpRth","mom5UpPost","mom5DnPre","mom5DnRth","mom5DnPost","last1mPct","rsi5","hist5","winRate"];
    th.dataset.k = keys[i];
    // 加上排序指示符 placeholder（預設顯示 ↕）
    if (!th.querySelector(".sort-ind")) {
      const ind = document.createElement("span");
      ind.className = "sort-ind";
      ind.textContent = "↕";
      th.appendChild(ind);
    }
    th.addEventListener("click", () => {
      const k = th.dataset.k;
      if (wlSortKey === k) wlSortDesc = !wlSortDesc;
      else { wlSortKey = k; wlSortDesc = true; }
      updateSortIndicators();
      renderWatchlist();
    });
  });
  updateSortIndicators();
  bindWlSymPopover();
  bindWlNamePopover();
  // 點選備選清單代碼 → 未滿則 append；已滿則交給 popover 讓使用者選 slot
  document.querySelector("#wlTable tbody")?.addEventListener("click", async (e) => {
    const td = e.target.closest("td.sym");
    if (!td) return;
    const tr = td.closest("tr");
    const sym = (tr?.dataset.sym || td.textContent || "").trim().toUpperCase();
    if (!sym) return;
    if (symbols.includes(sym)) return; // 已在追蹤清單
    if (symbols.length < SYMBOL_COUNT) {
      const next = [...symbols, sym];
      await applySymbolsAndReload(next);
    }
    // 已滿 → 不自動覆寫，使用者可透過 popover 選 slot
  });
  $("cancelSymbols").addEventListener("click", () => $("settingsPanel").classList.add("hidden"));
  $("resetSymbols").addEventListener("click", () => $("symbolsInput").value = DEFAULT_SYMBOLS.join(" "));
  $("saveSymbols").addEventListener("click", async () => {
    const raw = $("symbolsInput").value.trim();
    const list = raw.split(/[\s,]+/).map(s => s.toUpperCase()).filter(Boolean).slice(0, SYMBOL_COUNT);
    // [暫存] 與 [自選] 都允許 0..${SYMBOL_COUNT} 檔
    // 驗證：每一檔代碼都必須出現在快速挑選清單（CATALOG）裡，否則拒絕儲存
    const invalid = list.filter(s => !catalogHas(s));
    if (invalid.length) {
      alert(`下列代碼不在「快速挑選」清單中，無法儲存：\n  ${invalid.join(", ")}\n\n請先到下方「備選清單編輯」加入該代碼，或從快速挑選中點選現有代碼。`);
      $("symbolsInput").focus();
      return;
    }
    $("settingsPanel").classList.add("hidden");
    await applySymbolsAndReload(list);
  });
  // 時間框架切換
  syncTfButtons();
  $("tfGroup").addEventListener("click", async (e) => {
    const btn = e.target.closest("button.tf");
    if (!btn) return;
    const tf = btn.dataset.tf;
    if (!TIMEFRAMES[tf] || tf === timeframe) return;
    saveTimeframe(tf);
    syncTfButtons();
    updateChartLabels();
    heavyCache.clear();
    await heavyRefreshAll();
    await quickRefreshAll();
  });
  // 顯示根數
  const bcSel = $("barCount");
  if (bcSel) {
    chrome.storage?.local.get([BAR_COUNT_KEY], (r) => {
      const n = parseInt(r?.[BAR_COUNT_KEY], 10);
      if (BAR_COUNT_OPTIONS.includes(n)) {
        barCount = n;
        bcSel.value = String(n);
      } else {
        bcSel.value = String(barCount);
      }
      updateChartLabels();
    });
    bcSel.addEventListener("change", async () => {
      const n = parseInt(bcSel.value, 10);
      if (!BAR_COUNT_OPTIONS.includes(n)) return;
      barCount = n;
      chrome.storage?.local.set({ [BAR_COUNT_KEY]: n });
      updateChartLabels();
      await quickRefreshAll();
      await heavyRefreshAll();
    });
  }
  updateChartLabels();

  // 備選清單編輯
  const addForm = $("catalogAddForm");
  if (addForm) {
    addForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const inp = $("catalogAddInput");
      const v = (inp?.value || "").trim();
      if (!v) return;
      const btn = addForm.querySelector("button[type=submit]");
      if (btn) btn.disabled = true;
      try { await addCatalogSymbols(v); inp.value = ""; }
      finally { if (btn) btn.disabled = false; }
    });
  }
  $("catalogResetBtn")?.addEventListener("click", () => {
    if (confirm("確定要回復預設備選清單？")) resetCatalog();
  });
  $("catalogClearBtn")?.addEventListener("click", () => {
    if (confirm("確定要清空所有備選代碼？")) clearCatalog();
  });
  $("catalogTsscoBtn")?.addEventListener("click", async () => {
    const btn = $("catalogTsscoBtn");
    if (btn) btn.disabled = true;
    try {
      setCatalogStatus("從台新證券抓取手續費優惠名單…");
      const { syms, error } = await fetchTsscoPromoSymbols();
      if (!syms.length) {
        const msg = error || "無法解析台新證券頁面（可能版面改版或網路阻擋）";
        setCatalogStatus(`匯入失敗：${msg}`, "err");
        // 維護中時提供開啟頁面按鈕，方便手動確認
        if (/維護/.test(error || "")) {
          try {
            const open = confirm(`${msg}\n\n要在新分頁開啟 TSSCO 頁面確認嗎？\n${tsscoUrl || TSSCO_URL_DEFAULT}`);
            if (open) chrome.tabs?.create({ url: tsscoUrl || TSSCO_URL_DEFAULT });
          } catch {}
        }
        return;
      }
      setCatalogStatus(`抓到 ${syms.length} 檔代碼，開始查名…`);
      await addCatalogSymbols(syms.join(" "));
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // TSSCO 來源網址（可由使用者自行調整）
  const urlInp = $("catalogTsscoUrl");
  if (urlInp) {
    chrome.storage?.local.get([TSSCO_URL_KEY], (r) => {
      const v = (r?.[TSSCO_URL_KEY] || "").trim();
      tsscoUrl = v || TSSCO_URL_DEFAULT;
      urlInp.value = tsscoUrl;
    });
    const saveUrl = () => {
      const v = (urlInp.value || "").trim();
      tsscoUrl = v || TSSCO_URL_DEFAULT;
      try { chrome.storage?.local.set({ [TSSCO_URL_KEY]: tsscoUrl }); } catch {}
    };
    urlInp.addEventListener("change", saveUrl);
    urlInp.addEventListener("blur",   saveUrl);
  }
  $("catalogTsscoUrlReset")?.addEventListener("click", () => {
    tsscoUrl = TSSCO_URL_DEFAULT;
    if (urlInp) urlInp.value = TSSCO_URL_DEFAULT;
    try { chrome.storage?.local.set({ [TSSCO_URL_KEY]: TSSCO_URL_DEFAULT }); } catch {}
    setCatalogStatus("已重設 TSSCO 來源網址", "ok");
  });

  // 自動點擊：載入 storage、綁定控制列、啟動計時器
  setupAutoClick();
}

// ─── 自動點擊 ─────────────────────────────────────────────────
// 每隔 N 秒自動觸發指定按鈕（refresh / TOP3）。實作要點：
//   1) 直接呼叫 btn.click()，會走原本的 withBtnGuard，
//      所以在前一輪還沒跑完時自動 no-op，不會疊單。
//   2) 用單一 1 秒 tick 計時器計算倒數，到時觸發並重置 next。
//   3) 切換頁籤隱藏 (document.hidden) 時暫停以省資源。
//   4) 設定 persist 到 chrome.storage.local。
function setupAutoClick() {
  const cbEnable = $("autoClickEnable");
  const selTgt   = $("autoClickTarget");
  const inpSec   = $("autoClickInterval");
  const elStat   = $("autoClickStatus");
  if (!cbEnable || !selTgt || !inpSec || !elStat) return;

  const persist = () => {
    try { chrome.storage?.local.set({ [AUTO_CLICK_KEY]: { ...autoClickCfg } }); } catch {}
  };
  const stopTimer = () => {
    if (_autoClickTimer) { clearInterval(_autoClickTimer); _autoClickTimer = null; }
    _autoClickNextTs = 0;
    elStat.textContent = "--";
    elStat.classList.remove("armed", "firing");
  };
  const tick = () => {
    if (!autoClickCfg.enabled || !autoClickCfg.targetId) { stopTimer(); return; }
    // 頁籤隱藏時暫停倒數（避免後台亂點）
    if (document.hidden) {
      elStat.textContent = "⏸";
      elStat.classList.remove("armed", "firing");
      _autoClickNextTs = Date.now() + autoClickCfg.intervalSec * 1000;
      return;
    }
    const remain = Math.max(0, Math.ceil((_autoClickNextTs - Date.now()) / 1000));
    elStat.textContent = remain + "s";
    elStat.classList.toggle("armed", remain > 0);
    elStat.classList.toggle("firing", remain === 0);
    if (Date.now() >= _autoClickNextTs) {
      _autoClickNextTs = Date.now() + autoClickCfg.intervalSec * 1000;
      const btn = document.getElementById(autoClickCfg.targetId);
      if (btn && !btn.disabled) {
        try { btn.click(); }
        catch (e) { console.error("[autoClick]", e); }
      }
      // 若按鈕被 disabled（正在執行），下一輪 tick 再試
    }
  };
  const restart = () => {
    stopTimer();
    if (!autoClickCfg.enabled || !autoClickCfg.targetId) return;
    _autoClickNextTs = Date.now() + autoClickCfg.intervalSec * 1000;
    _autoClickTimer = setInterval(tick, 1000);
    tick(); // 立即更新顯示
  };

  // 載入持久化設定
  try {
    chrome.storage?.local.get([AUTO_CLICK_KEY], (r) => {
      const v = r?.[AUTO_CLICK_KEY];
      if (v && typeof v === "object") {
        autoClickCfg.enabled = !!v.enabled;
        autoClickCfg.targetId = typeof v.targetId === "string" ? v.targetId : "";
        const s = parseInt(v.intervalSec, 10);
        if (Number.isFinite(s) && s >= 5 && s <= 3600) autoClickCfg.intervalSec = s;
      }
      cbEnable.checked = autoClickCfg.enabled;
      selTgt.value = autoClickCfg.targetId;
      inpSec.value = String(autoClickCfg.intervalSec);
      restart();
    });
  } catch {
    cbEnable.checked = autoClickCfg.enabled;
    selTgt.value = autoClickCfg.targetId;
    inpSec.value = String(autoClickCfg.intervalSec);
  }

  // 綁定變更
  cbEnable.addEventListener("change", () => {
    autoClickCfg.enabled = cbEnable.checked && !!autoClickCfg.targetId;
    if (cbEnable.checked && !autoClickCfg.targetId) {
      alert("請先選擇要自動點擊的按鈕");
      cbEnable.checked = false;
    }
    persist(); restart();
  });
  selTgt.addEventListener("change", () => {
    autoClickCfg.targetId = selTgt.value;
    if (!autoClickCfg.targetId) { autoClickCfg.enabled = false; cbEnable.checked = false; }
    persist(); restart();
  });
  inpSec.addEventListener("change", () => {
    let s = parseInt(inpSec.value, 10);
    if (!Number.isFinite(s)) s = 30;
    s = Math.max(5, Math.min(3600, s));
    inpSec.value = String(s);
    autoClickCfg.intervalSec = s;
    persist(); restart();
  });
  // 頁籤從隱藏恢復可見時，重新對齊倒數起點，避免顯示 0s 立即觸發
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && autoClickCfg.enabled) {
      _autoClickNextTs = Date.now() + autoClickCfg.intervalSec * 1000;
      tick();
    }
  });
}

// ── TSSCO 美股手續費優惠名單抓取 ──
// 頁面每季會更新（標題、日期、文案皆可能不同），以兩階段策略解析：
//   1) DOM 解析：找出表頭含「標的代碼」的所有表格，從第 1 欄抽出代碼。
//   2) 若 DOM 解析失敗，退回 regex 抽取：先以「美股／美國市場」區段裁切，
//      再用 [A-Z]{2,5} 匹配，並過濾頁面常見噪音字。
async function fetchTsscoPromoSymbols() {
  const url = (tsscoUrl && /^https?:\/\//i.test(tsscoUrl)) ? tsscoUrl : TSSCO_URL_DEFAULT;
  let html = "";
  let httpStatus = 0;
  try {
    const r = await fetch(url, { credentials: "omit" });
    httpStatus = r.status;
    if (!r.ok) { return { syms: [], error: `HTTP ${r.status}` }; }
    html = await r.text();
  } catch (e) { return { syms: [], error: `網路錯誤：${e?.message || e}` }; }

  // 偵測「維護公告」頁面（台新證券會在維護期顯示這個頁面）
  const title = (html.match(/<title>([^<]*)<\/title>/)?.[1] || "").trim();
  if (/維護公告|維護中|系統維護/.test(title) || (/維護公告|系統維護中/.test(html) && !/標的代碼/.test(html))) {
    return { syms: [], error: `台新證券網站維護中（頁面標題：「${title || "維護公告"}」），請稍後再試` };
  }

  // 嘗試從頁面抓取優惠期間 / 標題等，提示給使用者
  const period =
    html.match(/於\s*([\d/.\- ]+\s*[-~–至]\s*[\d/.\- ]+)/)?.[1] ||
    html.match(/(\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}\s*[-~–至]\s*\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2})/)?.[1] ||
    "";
  if (period) setCatalogStatus(`偵測到優惠期間：${period.trim()}，解析中…`);

  // (1) DOM 解析：找含「標的代碼」表頭的 table
  const symsFromDom = parseTsscoTable(html);
  if (symsFromDom.length) return { syms: symsFromDom, error: "" };

  // (2) Regex fallback
  const symsFromRegex = parseTsscoFallback(html);
  if (symsFromRegex.length) return { syms: symsFromRegex, error: "" };

  // 頁面取得了但解析不到任何代碼
  return { syms: [], error: `頁面已取得 (HTTP ${httpStatus}, ${html.length} bytes) 但找不到代碼欄位，可能版面改版` };
}

function parseTsscoTable(html) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch { return []; }
  if (!doc) return [];

  const result = [];
  const seen = new Set();
  // 找包含「標的代碼」或「代碼」字樣的表格（表頭通常會出現此關鍵字）
  const tables = doc.querySelectorAll("table");
  for (const tb of tables) {
    if (!/標的代碼|代碼/.test(tb.textContent || "")) continue;
    // 直接掃描每一個 cell，若文字符合純大寫字母 1~5 碼即視為代碼。
    // 表格可能是 4 欄（代碼/名稱/代碼/名稱），不依賴欄位索引推斷更穩健。
    const cells = tb.querySelectorAll("th, td");
    for (const cell of cells) {
      const txt = (cell.textContent || "").trim();
      if (/^[A-Z]{1,5}$/.test(txt) && !seen.has(txt)) {
        seen.add(txt);
        result.push(txt);
      }
    }
  }
  return result;
}

function parseTsscoFallback(html) {
  // 取「美股交易特惠 / 美國市場手續費」區段到下一節之間
  const startIdx = html.search(/美股交易特惠|美國市場手續費|美國市場手續費及相關費用/);
  if (startIdx >= 0) {
    const tail = html.slice(startIdx);
    const stop = tail.search(/以上標的為本公司|稅負及費用|稅賦及費用|香港市場|日本市場|新加坡市場|澳洲市場|英國市場|德國市場|陸港通/);
    html = stop >= 0 ? tail.slice(0, stop) : tail;
  }
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

  const seen = new Set();
  const out = [];
  const re = /(?:^|[^A-Za-z0-9])([A-Z]{2,5})(?=[^A-Za-z0-9]|$)/g;
  const NOISE = new Set([
    "USD","TWD","HKD","JPY","SGD","AUD","GBP","EUR","RMB","CNY",
    "ETF","ADR","GDR","TAF","DTC","DRS","DWAC","API","APP","EN","EZ",
    "NYSE","NASDAQ","ARCA","SPDR","ESG","MSCI","SPY","TOP","IPO",
    "PM","AM","Q1","Q2","Q3","Q4","ID","FAQ","CEO","COO",
    "II","III","IV","VI",
  ]);
  let m;
  while ((m = re.exec(text))) {
    const sym = m[1];
    if (NOISE.has(sym)) continue;
    if (seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
  }
  return out;
}

function syncTfButtons() {
  document.querySelectorAll("#tfGroup .tf").forEach(b => {
    b.classList.toggle("active", b.dataset.tf === timeframe);
  });
}
function updateChartLabels() {
  const tfLabel = TIMEFRAMES[timeframe].label;
  document.querySelectorAll(".spark-label").forEach(el => {
    el.textContent = `近 ${barCount} 根 ${tfLabel} K 線走勢`;
  });
}

function openSettings() {
  $("symbolsInput").value = symbols.join(" ");
  const def = PANEL_DEFS.find(d => d.id === activePanelId);
  const title = $("settingsTitle");
  if (title && def) {
    const common = `0~${SYMBOL_COUNT} 檔，用空白或逗號分隔，例：INTC AMD PLTR`;
    const hint = activePanelId === "temp"
      ? `可隨時被上方 Top / 漲跌幅 等按鈕覆寫，支援 還原 / 重做`
      : `永久固定，不會被自動挑選覆寫`;
    title.textContent = `編輯 [${def.name}] 股票代碼（${common}；${hint}）`;
  }
  renderCatalog();
  $("settingsPanel").classList.remove("hidden");
}

// ── 備選標的目錄 ──
const DEFAULT_CATALOG = {
  stocks: [
    ["AAPL", "蘋果"], ["MSFT", "微軟"], ["NVDA", "輝達"], ["AMD", "超微半導體"],
    ["INTC", "英特爾"], ["AMZN", "亞馬遜"], ["GOOG", "Alphabet"],
    ["META", "Meta"], ["NFLX", "網飛"],
    ["TSLA", "特斯拉"], ["TSM", "台積電"], ["AVGO", "博通"], ["ASML", "艶司摩爾"],
    ["QCOM", "高通"], ["KLAC", "科磊"], ["MU", "美光科技"], ["STX", "希捷科技"],
    ["SNDK", "晉碟"], ["PLTR", "帕蘭提爾"], ["COIN", "比特幣基地全球"],
    ["ALAB", "Astera Labs"], ["CRWV", "CoreWeave"], ["ONDS", "Ondas"],
    ["RKLB", "Rocket Lab"], ["OKLO", "Oklo"], ["SMR", "NuScale Power"],
    ["LEU", "Centrus Energy"], ["CEG", "星座能源"], ["GEV", "奇異維諾瓦"],
    ["ETN", "伊頓"],
  ],
  etfs: [
    ["QQQ",  "Invesco 納斯達克 100"],
    ["VOO",  "Vanguard 標普 500"],
    ["XLV",  "SPDR 健康護理"],
    ["ESGV", "Vanguard ESG 美股"],
    ["GLD",  "SPDR 黃金"],
    ["SLV",  "iShares 白銀"],
    ["EWJ",  "iShares MSCI 日本"],
    ["SOXX", "iShares 半導體"],
    ["LQD",  "iShares 投級公司債"],
    ["IGV",  "iShares 科技軟體"],
    ["TSLL", "Direxion 2倍多 TSLA"],
  ],
};
let CATALOG = { stocks: [...DEFAULT_CATALOG.stocks], etfs: [...DEFAULT_CATALOG.etfs] };

function renderCatalog() {
  const current = ($("symbolsInput").value || "")
    .split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  for (const cat of ["stocks", "etfs"]) {
    const wrap = document.querySelector(`.chip-grid[data-cat="${cat}"]`);
    if (!wrap) continue;
    wrap.innerHTML = "";
    for (const [sym, name] of CATALOG[cat]) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip" + (current.includes(sym) ? " active" : "");
      chip.dataset.sym = sym;
      chip.innerHTML = `<span class="chip-sym">${sym}</span><span class="chip-name">${name}</span>`;
      chip.addEventListener("click", () => toggleChip(sym));
      wrap.appendChild(chip);
    }
  }
}

function toggleChip(sym) {
  const input = $("symbolsInput");
  let list = (input.value || "")
    .split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  const idx = list.indexOf(sym);
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    if (list.length >= SYMBOL_COUNT) list.shift();   // 超過上限時踢出最舊的
    list.push(sym);
  }
  input.value = list.join(" ");
  renderCatalog();
}

// ── 備選清單編輯 ──
let editorAnchorActive = 0;
function loadCatalog() {
  return new Promise(resolve => {
    chrome.storage?.local.get([CATALOG_KEY], (r) => {
      const v = r?.[CATALOG_KEY];
      if (v && Array.isArray(v.stocks) && Array.isArray(v.etfs)) {
        const norm = arr => arr
          .map(x => Array.isArray(x) ? [String(x[0] || "").toUpperCase(), String(x[1] || "")] : null)
          .filter(x => x && x[0]);
        CATALOG = { stocks: norm(v.stocks), etfs: norm(v.etfs) };
      }
      resolve();
    });
  });
}
function saveCatalog() {
  try { chrome.storage?.local.set({ [CATALOG_KEY]: CATALOG }); } catch {}
}
function setCatalogStatus(msg, kind = "") {
  const el = $("catalogStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "cat-status" + (kind ? " " + kind : "");
}
function pruneWlData() {
  const allow = new Set([
    ...CATALOG.stocks.map(([s]) => s),
    ...CATALOG.etfs.map(([s]) => s),
  ]);
  // 同步剔除已不在備選清單中的釘選代碼
  const _pinBefore = wlPinned.length;
  wlPinned = wlPinned.filter(s => allow.has(s));
  if (wlPinned.length !== _pinBefore) savePinned();
  for (const sym of [...wlData.keys()]) {
    if (!allow.has(sym)) wlData.delete(sym);
  }
}
async function lookupSymbolInfo(sym) {
  const url = `https://query2.finance.yahoo.com/v1/finance/search`
            + `?q=${encodeURIComponent(sym)}&newsCount=0&quotesCount=6`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const quotes = j.quotes || [];
    let q = quotes.find(x => (x.symbol || "").toUpperCase() === sym.toUpperCase());
    if (!q) q = quotes[0];
    if (!q || !q.symbol) return null;
    const name = q.longname || q.shortname || q.symbol;
    const t = (q.quoteType || "").toUpperCase();
    const kind = t === "ETF" ? "etfs" : "stocks";
    return { sym: q.symbol.toUpperCase(), name, kind };
  } catch { return null; }
}
function catalogHas(sym) {
  return CATALOG.stocks.some(([s]) => s === sym) || CATALOG.etfs.some(([s]) => s === sym);
}
function removeFromCatalog(sym) {
  CATALOG.stocks = CATALOG.stocks.filter(([s]) => s !== sym);
  CATALOG.etfs   = CATALOG.etfs.filter(([s]) => s !== sym);
  saveCatalog();
  pruneWlData();
  renderCatalogEditor();
  renderCatalog();
  renderWatchlist();
  refreshWatchlist();
}
function resetCatalog() {
  CATALOG = { stocks: [...DEFAULT_CATALOG.stocks], etfs: [...DEFAULT_CATALOG.etfs] };
  saveCatalog();
  pruneWlData();
  renderCatalogEditor();
  renderCatalog();
  renderWatchlist();
  refreshWatchlist();
  setCatalogStatus("已回復預設清單", "ok");
}
function clearCatalog() {
  CATALOG = { stocks: [], etfs: [] };
  saveCatalog();
  pruneWlData();
  renderCatalogEditor();
  renderCatalog();
  renderWatchlist();
  setCatalogStatus("已清空所有備選代碼", "ok");
}
async function addCatalogSymbols(text) {
  const list = (text || "")
    .split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!list.length) return;
  editorAnchorActive++;
  const added = [], skipped = [], failed = [];
  setCatalogStatus(`查詢中… 0 / ${list.length}`);
  let done = 0;
  try {
    for (const sym of list) {
      done++;
      if (catalogHas(sym)) { skipped.push(sym); setCatalogStatus(`查詢中… ${done} / ${list.length}`); continue; }
      const info = await lookupSymbolInfo(sym);
      if (!info) { failed.push(sym); setCatalogStatus(`查詢中… ${done} / ${list.length}`); continue; }
      if (catalogHas(info.sym)) { skipped.push(info.sym); setCatalogStatus(`查詢中… ${done} / ${list.length}`); continue; }
      CATALOG[info.kind].push([info.sym, info.name]);
      added.push(info.sym);
      setCatalogStatus(`查詢中… ${done} / ${list.length}`);
      renderCatalogEditor();
    }
    saveCatalog();
    renderCatalog();
    if (added.length) refreshWatchlist();
    const parts = [];
    if (added.length)   parts.push(`新增 ${added.length}：${added.join(",")}`);
    if (skipped.length) parts.push(`已存在 ${skipped.length}：${skipped.join(",")}`);
    if (failed.length)  parts.push(`查無 ${failed.length}：${failed.join(",")}`);
    setCatalogStatus(parts.join("　") || "完成", failed.length ? "err" : "ok");
  } finally {
    // 給一點時間讓後續 refreshWatchlist 重繪也能使用 anchor
    setTimeout(() => { editorAnchorActive = Math.max(0, editorAnchorActive - 1); }, 1500);
  }
}
function renderCatalogEditor() {
  for (const cat of ["stocks", "etfs"]) {
    const wrap = document.querySelector(`.editor-grid[data-edit-cat="${cat}"]`);
    if (!wrap) continue;
    wrap.innerHTML = "";
    for (const [sym, name] of CATALOG[cat]) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.innerHTML =
        `<span class="chip-sym">${sym}</span>` +
        `<span class="chip-name">${name || ""}</span>` +
        `<button type="button" class="chip-remove" title="移除">×</button>`;
      chip.querySelector(".chip-remove").addEventListener("click", () => removeFromCatalog(sym));
      wrap.appendChild(chip);
    }
  }
  const sCnt = $("catCntStocks"); if (sCnt) sCnt.textContent = String(CATALOG.stocks.length);
  const eCnt = $("catCntEtfs");   if (eCnt) eCnt.textContent = String(CATALOG.etfs.length);
}

function buildGrid() {
  const grid = $("grid");
  grid.innerHTML = "";
  const tpl = $("cardTpl");
  for (const sym of symbols) {
    const node = tpl.content.cloneNode(true);
    const card = node.querySelector(".card");
    card.dataset.symbol = sym;
    card.querySelector(".sym").textContent = sym;
    card.classList.add("loading");
    // draggable 只在「排序模式」下開啟，避免與 hover tooltip 衝突
    grid.appendChild(node);
  }
  bindCardDrag(grid);
  bindCardLongPress(grid);
  bindGridDrop(grid);
  // 若使用者仍在排序模式（剛才 reorder 完重建 grid），保持 draggable + 暫停 tooltip
  if (_sortMode) {
    grid.querySelectorAll(".card").forEach(c => c.setAttribute("draggable", "true"));
    grid.querySelectorAll("[title]").forEach(el => {
      el.dataset.savedTitle = el.getAttribute("title");
      el.removeAttribute("title");
    });
  }
  toggleGridEmptyHint(grid);
}

function toggleGridEmptyHint(grid) {
  let hint = grid.querySelector(".grid-empty-hint");
  if (symbols.length === 0) {
    if (!hint) {
      hint = document.createElement("div");
      hint.className = "grid-empty-hint";
      hint.textContent = "目前沒有監看股票。從右上「卸下區」拖代碼到這裡加入，或按 ⚙ 編輯。";
      grid.appendChild(hint);
    }
  } else if (hint) {
    hint.remove();
  }
}

// #grid 容器層級的拖放：接受卸下區 chip → 加入監看（含 0 卡片或未滿 SYMBOL_COUNT 時直接 append）
let _gridDropBound = false;
function bindGridDrop(grid) {
  if (_gridDropBound) return;
  _gridDropBound = true;
  grid.addEventListener("dragover", (e) => {
    if (!_dragSrc || _dragSrc.type !== "park") return;
    // 只在卡片以外 / 空容器才接管，避免吃掉卡片自己的 drop
    if (e.target.closest(".card")) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "move"; } catch(_) {}
    grid.classList.add("drag-over");
  });
  grid.addEventListener("dragleave", (e) => {
    if (e.target === grid) grid.classList.remove("drag-over");
  });
  grid.addEventListener("drop", async (e) => {
    if (!_dragSrc || _dragSrc.type !== "park") return;
    if (e.target.closest(".card")) return;
    e.preventDefault();
    grid.classList.remove("drag-over");
    const sym = _dragSrc.sym;
    _dragSrc = null;
    if (!sym || symbols.includes(sym)) return;
    let next;
    if (symbols.length < SYMBOL_COUNT) {
      next = [...symbols, sym];
    } else {
      // 已滿 → 把最後一張推回 parking
      const evicted = symbols[symbols.length - 1];
      next = [...symbols.slice(0, -1), sym];
      if (!parking.includes(evicted)) parking.unshift(evicted);
    }
    parking = parking.filter(x => x !== sym);
    if (parking.length > 50) parking.length = 50;
    saveParking();
    await applySymbolsAndReload(next);
    renderParking();
  });
}

let _dragSrc = null; // { type: "card"|"park", sym: string }

// ── 排序模式（長按 400ms 進入，Esc / 點空白 / 拖完離開）──
let _sortMode = false;
let _longPressTimer = null;
let _pressOrigin = null;
const LONG_PRESS_MS = 400;
const LONG_PRESS_MOVE_TOL = 6;

function enterSortMode() {
  if (_sortMode) return;
  _sortMode = true;
  document.body.classList.add("sort-mode");
  // 暫存並清空 #grid 內所有 title，避免 hover tooltip 干擾
  document.querySelectorAll("#grid [title]").forEach(el => {
    el.dataset.savedTitle = el.getAttribute("title");
    el.removeAttribute("title");
  });
  document.querySelectorAll("#grid .card").forEach(c => c.setAttribute("draggable", "true"));
  let toast = document.getElementById("sortToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "sortToast";
    toast.className = "sort-toast";
    toast.innerHTML = "🔀 排序模式：拖曳卡片調整順序　·　按 <kbd>Esc</kbd> 或點空白結束";
    document.body.appendChild(toast);
  }
  toast.style.display = "";
}

function exitSortMode() {
  if (!_sortMode) return;
  _sortMode = false;
  document.body.classList.remove("sort-mode");
  document.querySelectorAll("#grid [data-saved-title]").forEach(el => {
    const t = el.dataset.savedTitle;
    if (t != null) el.setAttribute("title", t);
    delete el.dataset.savedTitle;
  });
  document.querySelectorAll("#grid .card").forEach(c => c.removeAttribute("draggable"));
  const toast = document.getElementById("sortToast");
  if (toast) toast.style.display = "none";
}

function bindCardLongPress(grid) {
  if (grid.dataset.longPressBound) return;
  grid.dataset.longPressBound = "1";
  grid.addEventListener("pointerdown", (e) => {
    if (_sortMode) return;
    if (e.button !== 0) return;
    const card = e.target.closest(".card");
    if (!card) return;
    // 排除卡內互動元件
    if (e.target.closest("button, input, select, textarea, a, .liq-badge, .thr-info, .ms-badge")) return;
    _pressOrigin = { x: e.clientX, y: e.clientY };
    clearTimeout(_longPressTimer);
    _longPressTimer = setTimeout(() => {
      _longPressTimer = null;
      enterSortMode();
    }, LONG_PRESS_MS);
  });
  const cancelPress = () => {
    if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
    _pressOrigin = null;
  };
  grid.addEventListener("pointerup", cancelPress);
  grid.addEventListener("pointercancel", cancelPress);
  grid.addEventListener("pointerleave", cancelPress);
  grid.addEventListener("pointermove", (e) => {
    if (!_pressOrigin || !_longPressTimer) return;
    if (Math.hypot(e.clientX - _pressOrigin.x, e.clientY - _pressOrigin.y) > LONG_PRESS_MOVE_TOL) {
      cancelPress();
    }
  });
}

// 全域離開：Esc / 點在非卡片處
if (typeof window !== "undefined" && !window.__sortModeGlobalBound) {
  window.__sortModeGlobalBound = true;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _sortMode) exitSortMode();
  });
  document.addEventListener("click", (e) => {
    if (!_sortMode) return;
    if (e.target.closest("#grid .card")) return;
    if (e.target.closest("#sortToast")) return;
    exitSortMode();
  }, true);
}

function bindCardDrag(grid) {
  grid.querySelectorAll(".card").forEach(card => {
    card.addEventListener("dragstart", (e) => {
      _dragSrc = { type: "card", sym: card.dataset.symbol };
      card.classList.add("dragging");
      try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", _dragSrc.sym); } catch(_) {}
    });
    card.addEventListener("dragend", () => {
      _dragSrc = null;
      card.classList.remove("dragging");
      grid.querySelectorAll(".card.drag-over").forEach(c => c.classList.remove("drag-over"));
    });
    card.addEventListener("dragover", (e) => {
      if (!_dragSrc) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "move"; } catch(_) {}
      if (_dragSrc.type === "park" || card.dataset.symbol !== _dragSrc.sym) {
        card.classList.add("drag-over");
      }
    });
    card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
    card.addEventListener("drop", async (e) => {
      e.preventDefault();
      card.classList.remove("drag-over");
      const src = _dragSrc;
      _dragSrc = null;
      if (!src) return;
      const dst = card.dataset.symbol;
      if (src.type === "card") {
        if (src.sym === dst) return;
        const next = [...symbols];
        const si = next.indexOf(src.sym);
        const di = next.indexOf(dst);
        if (si < 0 || di < 0) return;
        next.splice(si, 1);
        next.splice(di, 0, src.sym);
        await applySymbolsAndReload(next);
      } else if (src.type === "park") {
        if (symbols.includes(src.sym)) return;
        // 取代目標卡：把 dst 放回 parking，把 src 放到 dst 位置
        const next = [...symbols];
        const di = next.indexOf(dst);
        if (di < 0) return;
        next.splice(di, 1, src.sym);
        parking = parking.filter(x => x !== src.sym);
        if (!parking.includes(dst)) parking.unshift(dst);
        if (parking.length > 50) parking.length = 50;
        saveParking();
        await applySymbolsAndReload(next);
        renderParking();
      }
    });
  });
}

function buildPanelTabs() {
  const bar = $("panelTabs");
  if (!bar) return;
  bar.innerHTML = PANEL_DEFS.map((p, i) => {
    const hk = i < 9 ? `Alt+${i + 1}` : "";
    const extra = p.id === "temp"
      ? `<span class="panel-extra-sep" aria-hidden="true">│</span>` +
        `<span class="panel-extra-label" title="以下只適用於 [${p.name}] 分頁">[${p.name}] 歷史</span>` +
        `<button class="panel-extra-btn" data-act="undo"  title="還原成上一次的清單（僅 [${p.name}]）" disabled>↶</button>` +
        `<button class="panel-extra-btn" data-act="redo"  title="重做下一步（僅 [${p.name}]）" disabled>↷</button>` +
        `<button class="panel-extra-btn" data-act="clear" title="清空還原 / 重做歷史紀錄（僅 [${p.name}]）" disabled>🗑</button>`
      : "";
    const tipActive = `✓ 目前分頁：${p.name}${hk ? `\n快捷鍵：${hk}（Ctrl+\` 循環切換）` : ""}`;
    const tipIdle   = `點此切換到「${p.name}」${hk ? `\n快捷鍵：${hk}（Ctrl+\` 循環切換）` : ""}`;
    return `<span class="panel-tab-group" data-pid="${p.id}">` +
      `<button class="panel-tab${p.id===activePanelId?" active":""}" data-pid="${p.id}" title="${p.id===activePanelId?tipActive:tipIdle}">${p.name}${hk ? `<span class="panel-tab-hk" aria-hidden="true">${hk}</span>` : ""}</button>` +
      `<button class="panel-edit-btn" data-edit-pid="${p.id}" title="編輯 [${p.name}] 的股票代碼">⚙</button>` +
      extra +
    `</span>`;
  }).join("") +
    `<span class="panel-tabs-hk" title="快捷鍵：G 跳到上方儀表板（? 查看所有熱鍵）" aria-hidden="true"><span class="sec-hk">G</span></span>` +
    `<div id="trashBar" class="trash-bar" title="把卡片拖到這裡 → 從監看完全移除（不會進卸下區）">🗑 卡片移除區<button id="trashClearAllBtn" type="button" class="trash-clear-all" title="一次清空目前分頁所有監看卡片">⌫</button></div>` +
    `<div id="parkingBar" class="parking-bar" title="卸下 / 拖回 監看的代碼"></div>`;
  renderParking();
  bindTrashBar();
  bar.querySelectorAll("button.panel-tab").forEach(btn => {
    btn.addEventListener("click", () => switchPanel(btn.dataset.pid));
  });
  bar.querySelectorAll("button.panel-edit-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const pid = btn.dataset.editPid;
      if (pid && pid !== activePanelId) await switchPanel(pid);
      if (typeof openSettings === "function") openSettings();
    });
  });
  bar.querySelectorAll("button.panel-extra-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const act = btn.dataset.act;
      if (act === "undo") {
        const prev = symbolsHistory.pop();
        if (!prev) return;
        await applySymbolsAndReload(prev, { pushHistory: false, pushRedo: true, clearRedo: false });
      } else if (act === "redo") {
        const next = symbolsRedo.pop();
        if (!next) return;
        await applySymbolsAndReload(next, { pushHistory: true, pushRedo: false, clearRedo: false });
      } else if (act === "clear") {
        if (symbolsHistory.length === 0 && symbolsRedo.length === 0) return;
        if (!confirm("確定要清空還原 / 重做歷史紀錄？")) return;
        symbolsHistory.length = 0;
        symbolsRedo.length = 0;
        updateUndoBtn();
      }
    });
  });
  updatePanelLockState();
  updateUndoBtn();
  bindPanelTabHotkeys();
}

/** 全域快捷鍵：分頁切換 / 跳卡片 / 跳區塊 / 顯示說明。只綁定一次。 */
let _panelTabHotkeysBound = false;
function bindPanelTabHotkeys() {
  if (_panelTabHotkeysBound) return;
  _panelTabHotkeysBound = true;
  document.addEventListener("keydown", (e) => {
    // 在輸入框/編輯區內不攔截
    const tgt = e.target;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT" || tgt.isContentEditable)) return;
    // Alt+1 ~ Alt+9：直接切到第 N 個分頁
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
      const idx = parseInt(e.key, 10) - 1;
      const def = PANEL_DEFS[idx];
      if (def) {
        e.preventDefault();
        if (def.id !== activePanelId) switchPanel(def.id);
        // 自動捲動讓「分頁列 + 上方儀表板」進入視野，避免使用者切了 tab 卻看不到內容
        const tabsEl = document.getElementById("panelTabs");
        if (tabsEl) _scrollAndFlash(tabsEl);
      }
      return;
    }
    // Ctrl+`：循環切換到下一個分頁（Ctrl+Shift+` 反向）
    if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "`" || e.key === "~")) {
      e.preventDefault();
      const n = PANEL_DEFS.length;
      if (n < 2) return;
      let cur = PANEL_DEFS.findIndex(p => p.id === activePanelId);
      if (cur < 0) cur = 0;
      const next = e.shiftKey ? (cur - 1 + n) % n : (cur + 1) % n;
      const def = PANEL_DEFS[next];
      if (def && def.id !== activePanelId) switchPanel(def.id);
      const tabsEl = document.getElementById("panelTabs");
      if (tabsEl) _scrollAndFlash(tabsEl);
      return;
    }
    // 以下快捷鍵：必須「無任何 modifier」才生效
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const k = (e.key || "").toLowerCase();
    // 1~9：跳到目前儀表板第 N 張卡片
    if (/^[1-9]$/.test(k)) {
      const idx = parseInt(k, 10) - 1;
      const cards = document.querySelectorAll("#grid .card");
      if (cards[idx]) {
        e.preventDefault();
        _scrollAndFlash(cards[idx]);
      }
      return;
    }
    // 字母熱鍵：t=最上面, g=分頁列+儀表板, w=備選清單訊號, s=模擬交易紀錄, c=備選清單編輯, ?=顯示說明
    if (k === "t") {
      e.preventDefault();
      try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { window.scrollTo(0, 0); }
      return;
    }
    const jumpMap = { g: "panelTabs", w: "watchlist", s: "simPanel", c: "catalogEditor" };
    if (jumpMap[k]) {
      const el = document.getElementById(jumpMap[k]);
      if (el) {
        e.preventDefault();
        _scrollAndFlash(el);
      }
      return;
    }
    if (e.key === "?" || e.key === "/") {
      e.preventDefault();
      _showHotkeyHelp();
    }
  });
}

/** 將元素滾動到視窗內並短暫高亮，提示使用者位置。 */
function _scrollAndFlash(el) {
  if (!el) return;
  try { el.scrollIntoView({ behavior: "smooth", block: "start" }); } catch { el.scrollIntoView(); }
  el.classList.remove("hk-flash");
  // force reflow 讓 animation 可重跑
  void el.offsetWidth;
  el.classList.add("hk-flash");
  setTimeout(() => el.classList.remove("hk-flash"), 1200);
}

/** 顯示 / 切換熱鍵說明浮層。 */
function _showHotkeyHelp() {
  let pop = document.getElementById("hkHelpPop");
  if (pop) { pop.remove(); return; }
  pop = document.createElement("div");
  pop.id = "hkHelpPop";
  pop.className = "hk-help-pop";
  pop.innerHTML = `
    <div class="hk-help-head">
      <span>⌨ 快捷鍵</span>
      <button type="button" class="hk-help-close" title="關閉 (Esc)">✕</button>
    </div>
    <div class="hk-help-body">
      <div class="hk-help-sec">分頁切換</div>
      <div class="hk-row"><kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>9</kbd><span>直接切到第 N 個分頁</span></div>
      <div class="hk-row"><kbd>Ctrl</kbd>+<kbd>\`</kbd><span>循環下一個分頁（加 Shift 反向）</span></div>
      <div class="hk-help-sec">跳到卡片 / 區塊</div>
      <div class="hk-row"><kbd>1</kbd>…<kbd>9</kbd><span>跳到目前儀表板第 N 張卡片</span></div>
      <div class="hk-row"><kbd>T</kbd><span>跳到頁面最上方</span></div>
      <div class="hk-row"><kbd>G</kbd><span>跳到上方儀表板 (Grid)</span></div>
      <div class="hk-row"><kbd>W</kbd><span>跳到備選清單訊號 (Watchlist)</span></div>
      <div class="hk-row"><kbd>S</kbd><span>跳到模擬交易紀錄 (Sim)</span></div>
      <div class="hk-row"><kbd>C</kbd><span>跳到備選清單編輯 (Catalog)</span></div>
      <div class="hk-help-sec">說明</div>
      <div class="hk-row"><kbd>?</kbd><span>顯示 / 關閉此說明</span></div>
      <div class="hk-row"><kbd>Esc</kbd><span>關閉此說明</span></div>
      <div class="hk-help-foot">焦點在輸入框 / 下拉選單時所有熱鍵自動失效，不會干擾打字。</div>
    </div>`;
  document.body.appendChild(pop);
  pop.querySelector(".hk-help-close")?.addEventListener("click", () => pop.remove());
  const onEsc = (ev) => { if (ev.key === "Escape") { pop.remove(); document.removeEventListener("keydown", onEsc, true); } };
  document.addEventListener("keydown", onEsc, true);
}

/** 在 [自選] 分頁時，鎖住所有「自動挑選 / 套用排序」相關按鈕。 */
function updatePanelLockState() {
  const isTemp = activePanelId === "temp";
  const lockedTip = "自選分頁採手動編輯，停用自動挑選按鈕";
  const ids = [
    ["topHotBtn",       "🔥 飆股潛力分（score1×1+score5×0.7+5分↑×1.5+5m量爆+1.5−RSI5≥80×2）TOP3"],
    ["top1Btn",         "從監控清單挑出 1 分線分數最高的 3 檔放入監看"],
    ["top5Btn",         "從監控清單挑出 5 分線分數最高的 3 檔放入監看"],
    ["topReboundBtn",   "今日跌深、但 1分5分線訊號轉強 / MACD-H 轉正的反彈候選"],
    ["topGain1mBtn",    "備選清單中最近 1 分鐘漲幅最高的 3 檔"],
    ["topColdBtn",      "❄ 超跌續弱分（-score1×1-score5×0.7+5分↓×1.5+5m量爆+1.5−RSI5≤20×2）TOP3"],
    ["topWr050UpBtn",   "↗ +0.5% 勝率 TOP3：以近 20 根 1m 為樣本，未來 10 分鐘內最高漲幅 ≥ +0.5% 的機率最高 3 檔"],
    ["topWr050DownBtn", "↘ -0.5% 賠率 TOP3：以近 20 根 1m 為樣本，未來 10 分鐘內最低跌幅 ≤ -0.5% 的機率最高 3 檔"],
    ["top1SellBtn",     "監控清單中 1 分線分數最低的 3 檔"],
    ["top5SellBtn",     "監控清單中 5 分線分數最低的 3 檔"],
    ["topPullbackBtn",  "今日漲多、但 1分5分線訊號轉弱 / MACD-H 轉負的回檔候選"],
    ["topLoss1mBtn",    "備選清單中最近 1 分鐘跌幅最大的 3 檔"],
    ["wlApplyTopBtn",   "以目前排序取前 3 名加入上方儀表板"],
  ];
  for (const [id, origTip] of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.disabled = !isTemp;
    el.title = isTemp ? origTip : lockedTip;
  }
}
async function switchPanel(pid) {
  if (!PANELS[pid] || pid === activePanelId) return;
  activePanelId = pid;
  symbols = PANELS[pid];
  try { chrome.storage?.local.set({ [ACTIVE_PANEL_KEY]: pid }); } catch {}
  buildGrid();
  buildPanelTabs();
  updateUndoBtn();
  await heavyRefreshAll();
  await quickRefreshAll();
}

function buildIndices() {
  const wrap = $("indices");
  if (!wrap) return;
  wrap.innerHTML = "";
  for (const [sym, name] of INDICES) {
    const el = document.createElement("div");
    el.className = "idx";
    el.dataset.sym = sym;
    el.innerHTML =
      `<span class="idx-name">${name}</span>` +
      `<span class="idx-val">--</span>` +
      `<span class="idx-chg flat">--</span>`;
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      // 同一張卡再次點擊 = 收合
      if (idxPopoverEl && !idxPopoverEl.classList.contains("hidden") && idxPopoverAnchorSym === sym) {
        hideIdxPopoverNow();
      } else {
        showIdxPopover(el, sym, name);
      }
    });
    wrap.appendChild(el);
  }
}

// ── 大盤指數 hover 浮層 K 線 ──
let idxPopoverEl = null;
let idxPopoverHideTimer = null;
let idxPopoverToken = 0;
let idxPopoverAnchorSym = null;
const idxChartCache = new Map(); // sym -> { ts, data }
const IDX_CHART_TTL_MS = 30_000;

function ensureIdxPopover() {
  if (idxPopoverEl) return idxPopoverEl;
  const el = document.createElement("div");
  el.id = "idxPopover";
  el.className = "idx-popover hidden";
  el.innerHTML =
    `<div class="idxp-head">` +
      `<span class="idxp-name"></span>` +
      `<span class="idxp-val"></span>` +
      `<span class="idxp-chg"></span>` +
      `<button type="button" class="idxp-close" title="關閉" aria-label="關閉">✕</button>` +
    `</div>` +
    `<canvas class="idxp-spark" width="360" height="120"></canvas>` +
    `<div class="idxp-foot">今日 1 分線（含盤前 / 盤後）</div>`;
  // 點 ✕ 關閉
  el.querySelector(".idxp-close")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    hideIdxPopoverNow();
  });
  // 點浮層內部不會被外部 click 關閉
  el.addEventListener("click", (ev) => ev.stopPropagation());
  document.body.appendChild(el);
  // 點空白處關閉
  document.addEventListener("click", () => hideIdxPopoverNow());
  // Esc 也可關閉
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") hideIdxPopoverNow();
  });
  idxPopoverEl = el;
  return el;
}

async function showIdxPopover(anchor, sym, name) {
  const pop = ensureIdxPopover();
  if (idxPopoverHideTimer) { clearTimeout(idxPopoverHideTimer); idxPopoverHideTimer = null; }
  idxPopoverAnchorSym = sym;

  // 定位：在 anchor 下方，超出右側則向左對齊
  const r = anchor.getBoundingClientRect();
  const POP_W = 380, POP_H = 170;
  let left = r.left;
  if (left + POP_W > window.innerWidth - 8) left = window.innerWidth - POP_W - 8;
  if (left < 8) left = 8;
  let top = r.bottom + 6;
  if (top + POP_H > window.innerHeight - 8) top = r.top - POP_H - 6;
  pop.style.left = left + "px";
  pop.style.top  = top + "px";

  // 先顯示頭部資料（由 .idx 內容複製）
  const valTxt = anchor.querySelector(".idx-val")?.textContent || "--";
  const chgEl  = anchor.querySelector(".idx-chg");
  pop.querySelector(".idxp-name").textContent = name;
  pop.querySelector(".idxp-val").textContent  = valTxt;
  const popChg = pop.querySelector(".idxp-chg");
  popChg.textContent = chgEl?.textContent || "--";
  popChg.className = "idxp-chg " + (chgEl?.className.replace("idx-chg", "").trim() || "flat");
  pop.classList.remove("hidden");

  // 拽 K 線（1m 清單不到時走 5m）
  const token = ++idxPopoverToken;
  try {
    let data = idxChartCache.get(sym);
    if (!data || Date.now() - data.ts > IDX_CHART_TTL_MS) {
      let d;
      try { d = await fetchChartLite(sym, "1m", "1d"); }
      catch { d = await fetchChartLite(sym, "5m", "5d"); }
      if (!d.bars || d.bars.length < 5) d = await fetchChartLite(sym, "5m", "5d");
      data = { ts: Date.now(), data: d };
      idxChartCache.set(sym, data);
    }
    if (token !== idxPopoverToken) return; // 已被其他 hover 取代
    drawSpark(pop.querySelector(".idxp-spark"), data.data.bars);
  } catch {
    /* 徽徽失敗就不畫 */
  }
}

function hideIdxPopoverNow() {
  if (idxPopoverHideTimer) { clearTimeout(idxPopoverHideTimer); idxPopoverHideTimer = null; }
  if (idxPopoverEl) idxPopoverEl.classList.add("hidden");
  idxPopoverAnchorSym = null;
}

function hideIdxPopover() {
  if (idxPopoverHideTimer) clearTimeout(idxPopoverHideTimer);
  idxPopoverHideTimer = setTimeout(() => {
    if (idxPopoverEl) idxPopoverEl.classList.add("hidden");
    idxPopoverHideTimer = null;
  }, 120);
}

async function refreshIndices() {
  await Promise.allSettled(INDICES.map(async ([sym]) => {
    try {
      const d = await fetchChartLite(sym, "1m", "1d");
      const price = d.price;
      const prev  = d.prevClose;
      if (price == null) return;
      const chg  = prev != null ? price - prev : null;
      const pct  = chg != null && prev ? (chg / prev) * 100 : null;
      const el = document.querySelector(`.idx[data-sym="${CSS.escape(sym)}"]`);
      if (!el) return;
      const cls = pct == null ? "flat" : pct > 0 ? "up" : pct < 0 ? "down" : "flat";
      const sign = pct != null && pct > 0 ? "+" : "";
      el.querySelector(".idx-val").textContent = price.toLocaleString(undefined, { maximumFractionDigits: 2 });
      const ch = el.querySelector(".idx-chg");
      ch.className = "idx-chg " + cls;
      ch.textContent = pct == null ? "--"
        : `${sign}${chg.toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
      if (pct != null) marketChgMap.set(sym, pct);
    } catch { /* skip */ }
  }));
}

function startTimers() {
  stopTimers();
  quoteTimer = setInterval(quickRefreshAll, quoteRefreshMs);
  heavyTimer = setInterval(heavyRefreshAll, HEAVY_REFRESH_MS);
  watchlistTimer = watchlistAutoEnabled
    ? setInterval(refreshWatchlist, watchlistRefreshMs)
    : null;
  indicesTimer = setInterval(refreshIndices, INDICES_REFRESH_MS);
  if (!apiHealthTimer) apiHealthTimer = setInterval(renderApiHealth, 3000);
  renderApiHealth();
}
function stopTimers() {
  if (quoteTimer) { clearInterval(quoteTimer); quoteTimer = null; }
  if (heavyTimer) { clearInterval(heavyTimer); heavyTimer = null; }
  if (watchlistTimer) { clearInterval(watchlistTimer); watchlistTimer = null; }
  if (indicesTimer) { clearInterval(indicesTimer); indicesTimer = null; }
}

let _quickRefreshInflight = false;
async function quickRefreshAll() {
  if (_quickRefreshInflight) return;            // 上一輪還未跑完，跳過避免最絡堆疊
  _quickRefreshInflight = true;
  try {
  const results = await Promise.allSettled(symbols.map(fetchIntraday));
  results.forEach((r, i) => {
    const sym = symbols[i];
    const card = cardOf(sym);
    if (!card) return;
    if (r.status === "fulfilled") {
      card.classList.remove("error");
      renderQuick(card, sym, r.value);
    } else {
      card.classList.add("error");
    }
  });
  $("updated").textContent = new Date().toLocaleTimeString();
  expireOldSimTrades();
  } finally { _quickRefreshInflight = false; }
}

let _heavyRefreshInflight = false;
async function heavyRefreshAll() {
  if (_heavyRefreshInflight) return;
  _heavyRefreshInflight = true;
  try {
  const results = await Promise.allSettled(symbols.map(async (sym) => {
    const [intra, news, lite15] = await Promise.all([
      fetchIntraday(sym),
      fetchNews(sym),
      fetchChartLite(sym, "15m", "5d").catch(() => null),
    ]);
    const closes = intra.bars.map(b => b.c);
    const macd = calcMACD(closes);
    const rsi  = calcRSI(closes, 14);
    return { bars: intra.bars, macd, rsi, news, closes, bars15: lite15?.bars || [] };
  }));
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      heavyCache.set(symbols[i], r.value);
      const card = cardOf(symbols[i]);
      if (card) {
        card.classList.remove("loading");
        renderHeavy(card, symbols[i], r.value);
      }
    }
  });
  } finally { _heavyRefreshInflight = false; }
}

// ── 「今日快照」快取：昨日收盤 + 即時價 + 高低量 + 市場狀態
// 使用独立的日線拉取（range=5d&interval=1d），讓不同時間框架都共用同一個來源，
// 避免切換 1m/5m/30m/60m 時個股价、高低、量跳動。 ──
const dailySnap = new Map(); // sym -> { ts, value: { prevClose, price, high, low, volume, avgDaily, marketState, name, meta } }
const DAILY_SNAP_TTL_MS = 2_000;  // 即時價需要高鮮度；昨收頯帶 5分鐘快取走上層
const yClose = new Map();
const Y_CLOSE_TTL_MS = 5 * 60 * 1000;
async function fetchDailySnap(symbol) {
  const cached = dailySnap.get(symbol);
  if (cached && Date.now() - cached.ts < DAILY_SNAP_TTL_MS) return cached.value;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
                `?range=5d&interval=1d&includePrePost=true`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const res = j.chart.result?.[0];
    if (!res) throw new Error("no data");
    const m = res.meta;
    const q = res.indicators?.quote?.[0] || {};
    const ts = res.timestamp || [];
    const opens  = q.open  || [];
    const highs  = q.high  || [];
    const lows   = q.low   || [];
    // 用 timestamp + 交易所時區判斷「最後一根日線是不是今天」。
    // 盤前(PRE / PREPRE) 時 Yahoo 還不會放今天的日線，這時 closes[-1] 已經是「昨收」，
    // 不能再往前抓 closes[-2]，否則 prevClose 會變成兩天前的收盤，
    // 導致盤前漲跌、現價漲跌全部用錯基準價。
    const allCloses = q.close || [];
    const validIdx = allCloses.map((c, i) => c != null ? i : -1).filter(i => i >= 0);
    const tzOffset = (m.gmtoffset ?? 0) * 1000;
    const dayKey = (epochSec) => {
      // 以交易所當地日期作為 key（YYYYMMDD）
      const d = new Date(epochSec * 1000 + tzOffset);
      return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    };
    const todayKey = dayKey(Math.floor(Date.now() / 1000));
    const lastValidI = validIdx.length ? validIdx[validIdx.length - 1] : -1;
    const lastBarIsToday = lastValidI >= 0 && ts[lastValidI] != null
      && dayKey(ts[lastValidI]) === todayKey;
    // 今日 bar 存在 → 用 [-2]/[-3] 當昨收/前日收
    // 今日 bar 不存在（盤前或假日）→ 用 [-1]/[-2]
    const closes = allCloses.filter(c => c != null);
    const closeOffset = lastBarIsToday ? 2 : 1;
    const prevClose = closes.length >= closeOffset
      ? closes[closes.length - closeOffset]
      : (m.chartPreviousClose ?? null);
    const prevPrevClose = closes.length >= closeOffset + 1
      ? closes[closes.length - closeOffset - 1]
      : null;
    // 用日線拉取（range=5d&interval=1d）抽出今日 / 昨日 OHL
    // 注意：q.close 已經 filter 掉 null，但 open/high/low 沒有；用同步 index 對應到 timestamp
    // 同樣依「今日 bar 是否存在」決定 today/prev 的索引
    const lastI = lastBarIsToday ? lastValidI : -1;
    const prevValidI = lastBarIsToday
      ? (validIdx.length >= 2 ? validIdx[validIdx.length - 2] : -1)
      : lastValidI;
    const prevI = prevValidI;
    const todayOpen = lastI >= 0 ? opens[lastI] : null;
    const todayHigh = lastI >= 0 ? highs[lastI] : null;
    const todayLow  = lastI >= 0 ? lows[lastI]  : null;
    const prevOpen  = prevI >= 0 ? opens[prevI] : null;
    const prevHigh  = prevI >= 0 ? highs[prevI] : null;
    const prevLow   = prevI >= 0 ? lows[prevI]  : null;
    const value = {
      prevClose,
      prevPrevClose,
      price:    m.regularMarketPrice ?? null,
      high:     m.regularMarketDayHigh ?? todayHigh ?? null,
      low:      m.regularMarketDayLow  ?? todayLow  ?? null,
      volume:   m.regularMarketVolume ?? null,
      avgDaily: m.averageDailyVolume3Month ?? m.averageDailyVolume10Day ?? null,
      marketState: m.marketState,
      name: m.shortName || m.longName || symbol,
      todayOpen, todayHigh, todayLow,
      prevOpen, prevHigh, prevLow,
      meta: m,
    };
    dailySnap.set(symbol, { ts: Date.now(), value });
    yClose.set(symbol, { ts: Date.now(), value: prevClose });
    return value;
  } catch {
    return null;
  }
}
async function fetchYesterdayClose(symbol) {
  const cached = yClose.get(symbol);
  if (cached && Date.now() - cached.ts < Y_CLOSE_TTL_MS) return cached.value;
  const snap = await fetchDailySnap(symbol);
  return snap?.prevClose ?? null;
}

async function fetchIntraday(symbol) {
  const tf = TIMEFRAMES[timeframe] || TIMEFRAMES["1m"];
  // 含盤前 / 盤後撮合：includePrePost=true
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
              `?range=${tf.range}&interval=${timeframe}&includePrePost=true`;
  // 短期快取 / 去重：解決手動 refresh 時 heavyRefreshAll + quickRefreshAll 對同檔重複打網路
  const cached = _chartCache.get(url);
  if (cached && Date.now() - cached.ts < CHART_FETCH_TTL_MS) return cached.value;
  const pending = _chartInflight.get(url);
  if (pending) return pending;
  const p = (async () => {
  const [r, snap] = await Promise.all([
    fetch(url),
    fetchDailySnap(symbol),
  ]);
  const prevDaily = snap?.prevClose ?? null;
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const res = j.chart.result?.[0];
  if (!res) throw new Error("no data");
  const meta = res.meta;
  const ts = res.timestamp || [];
  const q = res.indicators.quote[0] || {};
  const bars = ts.map((t, i) => ({
    t,
    o: q.open?.[i], h: q.high?.[i], l: q.low?.[i],
    c: q.close?.[i], v: q.volume?.[i],
  })).filter(b => b.c != null);

  // Fallback：meta 取不到時從 bars 推算（解決盤前 / 盤後 metrics 顯示 -- 的問題）
  const highs = bars.map(b => b.h).filter(v => v != null);
  const lows  = bars.map(b => b.l).filter(v => v != null);
  const vols  = bars.map(b => b.v).filter(v => v != null);
  const lastClose = bars.length ? bars[bars.length - 1].c : null;

  // 從 currentTradingPeriod + bars 推算盤前 / 盤後撮合價
  // （Yahoo chart meta 並不包含 preMarketPrice / postMarketPrice，只能自己算）
  const tp = meta.currentTradingPeriod || {};
  // 以「昨日收盤」為基準計漲跌（regularMarketPreviousClose / previousClose）
  // 避免使用 chartPreviousClose：那是圖表起始點前一根的收盤，
  // 在 60m / 1mo 等多日時間框架下會變成 1 個月前的收盤，造成漲跌顯示全錯
  // 最可靠：另做一次日線拉取 (range=5d&interval=1d) 取得昨日收盤
  const prevC = prevDaily ?? meta.regularMarketPreviousClose ?? meta.previousClose ?? meta.chartPreviousClose;
  let derivedPre = null, derivedPost = null;
  if (tp.pre && bars.length) {
    const preBars = bars.filter(b => b.t >= tp.pre.start && b.t < tp.pre.end);
    if (preBars.length) {
      const lb = preBars[preBars.length - 1];
      const pHighs = preBars.map(b => b.h).filter(v => v != null);
      const pLows  = preBars.map(b => b.l).filter(v => v != null);
      derivedPre = {
        price: lb.c, time: lb.t,
        change: prevC != null ? lb.c - prevC : null,
        changePct: prevC ? ((lb.c - prevC) / prevC) * 100 : null,
        high: pHighs.length ? Math.max(...pHighs) : null,
        low:  pLows.length  ? Math.min(...pLows)  : null,
      };
    }
  }
  if (tp.post && bars.length) {
    const postBars = bars.filter(b => b.t >= tp.post.start && b.t < tp.post.end);
    if (postBars.length) {
      const lb = postBars[postBars.length - 1];
      const regClose = meta.regularMarketPrice ?? prevC;
      const pHighs = postBars.map(b => b.h).filter(v => v != null);
      const pLows  = postBars.map(b => b.l).filter(v => v != null);
      derivedPost = {
        price: lb.c, time: lb.t,
        change: regClose != null ? lb.c - regClose : null,
        changePct: regClose ? ((lb.c - regClose) / regClose) * 100 : null,
        high: pHighs.length ? Math.max(...pHighs) : null,
        low:  pLows.length  ? Math.min(...pLows)  : null,
      };
    }
  }

  return {
    meta, bars,
    // 以下「今日快照」都來自 snap，讓切換時間框架不會造成跳動
    price: snap?.price ?? meta.regularMarketPrice ?? lastClose,
    prevClose: prevDaily ?? meta.regularMarketPreviousClose ?? meta.previousClose ?? meta.chartPreviousClose ?? bars[0]?.c,
    high: snap?.high ?? meta.regularMarketDayHigh ?? (highs.length ? Math.max(...highs) : null),
    low:  snap?.low  ?? meta.regularMarketDayLow  ?? (lows.length  ? Math.min(...lows)  : null),
    volume: snap?.volume ?? meta.regularMarketVolume ?? (vols.length ? vols.reduce((a, b) => a + b, 0) : null),
    avgDailyVolume: snap?.avgDaily ?? meta.averageDailyVolume3Month ?? meta.averageDailyVolume10Day ?? null,
    name: snap?.name ?? meta.shortName ?? meta.longName ?? symbol,
    marketState: snap?.marketState ?? meta.marketState,
    // 今日 / 昨日 OHL（皆來自 daily snap，跨時間框架不會跳動）
    todayOpen: snap?.todayOpen ?? null,
    todayHigh: snap?.todayHigh ?? snap?.high ?? null,
    todayLow:  snap?.todayLow  ?? snap?.low  ?? null,
    prevOpen:  snap?.prevOpen  ?? null,
    prevHigh:  snap?.prevHigh  ?? null,
    prevLow:   snap?.prevLow   ?? null,
    prevPrevClose: snap?.prevPrevClose ?? null,
    preMarketPrice:  meta.preMarketPrice  ?? derivedPre?.price,
    preMarketChange: meta.preMarketChange ?? derivedPre?.change,
    preMarketChangePct: meta.preMarketChangePercent ?? derivedPre?.changePct,
    preMarketTime:   meta.preMarketTime   ?? derivedPre?.time,
    preMarketHigh:   derivedPre?.high,
    preMarketLow:    derivedPre?.low,
    postMarketPrice:  meta.postMarketPrice  ?? derivedPost?.price,
    postMarketChange: meta.postMarketChange ?? derivedPost?.change,
    postMarketChangePct: meta.postMarketChangePercent ?? derivedPost?.changePct,
    postMarketTime:   meta.postMarketTime   ?? derivedPost?.time,
    postMarketHigh:  derivedPost?.high,
    postMarketLow:   derivedPost?.low,
  };
  })();
  _chartInflight.set(url, p);
  try {
    const value = await p;
    _chartCache.set(url, { ts: Date.now(), value });
    return value;
  } finally {
    _chartInflight.delete(url);
  }
}

async function fetchNews(symbol) {
  const url = `https://query2.finance.yahoo.com/v1/finance/search` +
              `?q=${symbol}&newsCount=15&quotesCount=0`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.news || []).map(n => ({
      title: n.title, link: n.link, publisher: n.publisher,
      time: n.providerPublishTime ? new Date(n.providerPublishTime * 1000) : null,
    }));
  } catch { return []; }
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = []; let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    const v = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(v); prev = v;
  }
  return out;
}
function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const f = ema(closes, fast), s = ema(closes, slow);
  const macd = f.map((v, i) => v - s[i]);
  const sig  = ema(macd, signal);
  const hist = macd.map((v, i) => v - sig[i]);
  return { macd, sig, hist };
}
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  const rsis = [];
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    const rs = avgL === 0 ? 100 : avgG / avgL;
    rsis.push(avgL === 0 ? 100 : 100 - 100 / (1 + rs));
  }
  return rsis;
}

function classifyNews(items) {
  const pos = [], neg = [], neu = [];
  for (const n of items) {
    const t = (n.title || "").toLowerCase();
    let s = 0;
    for (const w of POSITIVE_KEYWORDS) if (t.includes(w.toLowerCase())) s++;
    for (const w of NEGATIVE_KEYWORDS) if (t.includes(w.toLowerCase())) s--;
    if (s > 0) pos.push(n);
    else if (s < 0) neg.push(n);
    else neu.push(n);
  }
  return { pos, neg, neu };
}

// 為「1～5 分鐘 / 0.25–0.5%」超短線最佳化的計分系統
//   ⓪ 流動性差 → 強制 HOLD（避免滑價吃光獲利）
//   ⓪ ATR < 0.3% → 強制 HOLD（波動不足，目標難達成）
//   ① VWAP（含過遠偏離警訊）
//   ② MA20（移除 MA60，1 分線下太慢）
//   ③ MACD 降權至 ±0.5/±0.3（避免 12/26/9 滯後吃掉 scalping 訊號）
//   ④ RSI 閾值放寬至 80/20，並降權
//   ⑤ 量爆 — 看「最後 1 根 ≥ 3x」而非 5 根均量
//   ⑥ 微動能加速度（最後 3 根 bar 動量，scalping 最關鍵）
//   ⑦ 突破 / 跌破近 20 根高低（含量能驗證假突破）
//   ⑧ 5 分同向（降權）
//   ⑨ 大盤同向 / 相對強弱（降權）
//   流動性「中」 → 整體 ×0.7；門檻 ±3.5 / ±1.5（放寬：HOLD 過多時更易出訊號）
function calcSignal(intra, heavy, sym) {
  const reasons = [];
  let score = 0;
  const price = intra.price;
  const bars  = intra.bars;
  const closes = bars.map(b => b.c);
  const highs  = bars.map(b => b.h).filter(v => v != null);
  const lows   = bars.map(b => b.l).filter(v => v != null);

  // ⓪-A 流動性閘門：低流動性 → 直接 HOLD（避免推薦不好進出的股）
  let liqTier = null;
  try { liqTier = computeLiquidity(intra)?.tier; } catch {}
  if (liqTier === "low") {
    return { label: "HOLD", cls: "signal-hold", score: 0,
      reasons: ["流動性低(HOLD)"], rsi: null, volRatio: 1 };
  }

  // ⓪-B ATR 可行性閘門：1m ATR(14) < 0.3% → 0.25–0.5% 目標難達成
  let atrPct = null;
  if (bars.length >= 15) {
    const trs = [];
    for (let i = bars.length - 14; i < bars.length; i++) {
      const b = bars[i], pp = bars[i - 1];
      if (!b || !pp) continue;
      const bh = b.h ?? b.c, bl = b.l ?? b.c;
      trs.push(Math.max(bh - bl, Math.abs(bh - pp.c), Math.abs(bl - pp.c)));
    }
    if (trs.length) {
      const atr = avg(trs);
      atrPct = price ? (atr / price) * 100 : null;
    }
  }
  if (atrPct != null && atrPct < THR.atrMin) {
    return { label: "HOLD", cls: "signal-hold", score: 0,
      reasons: [`波動不足 ATR ${atrPct.toFixed(2)}%(HOLD)`],
      rsi: null, volRatio: 1 };
  }

  // ① VWAP
  const vBars = bars.filter(b => b && b.v != null && b.v > 0 && b.c != null);
  if (vBars.length >= 5) {
    let pv = 0, sv = 0;
    for (const b of vBars) {
      const tp = (b.h != null && b.l != null) ? (b.h + b.l + b.c) / 3 : b.c;
      pv += tp * b.v; sv += b.v;
    }
    if (sv > 0) {
      const vwap = pv / sv;
      if (price > vwap) { score += 1; reasons.push("價>VWAP"); }
      else if (price < vwap) { score -= 1; reasons.push("價<VWAP"); }
      // 距 VWAP 過遠（>0.5%）→ 反轉風險，整體弱化（不直接扣分，僅標示）
      const dev = Math.abs((price - vwap) / price) * 100;
      if (dev > 0.5) reasons.push(`距VWAP ${dev.toFixed(1)}%`);
    }
  }

  // ② MA20（已移除 MA60；1 分線下 60 分鐘均線對 1–5 分目標無意義）
  const last20 = closes.slice(-20);
  if (last20.length >= 10) {
    const a20 = avg(last20);
    if (price > a20) { score += 1; reasons.push("價>MA20"); }
    else { score -= 1; reasons.push("價<MA20"); }
  }

  // ③ MACD（降權至 ±0.5/±0.3，scalping 中 MACD 太滯後）
  const m = heavy?.macd;
  if (m) {
    const i = m.hist.length - 1;
    const h = m.hist[i], hp = m.hist[i - 1] ?? h;
    const dif = m.macd[i];
    if (h > 0 && h > hp) { score += 0.5; reasons.push("MACD多頭擴張"); }
    else if (h > 0)       { score += 0.3; reasons.push("MACD多頭"); }
    else if (h < 0 && h < hp) { score -= 0.5; reasons.push("MACD空頭擴張"); }
    else                  { score -= 0.3; reasons.push("MACD空頭"); }
    if (dif > 0 && h > 0) { score += 0.2; reasons.push("MACD>0軸"); }
    else if (dif < 0 && h < 0) { score -= 0.2; reasons.push("MACD<0軸"); }
  }

  // ④ RSI（閾值 80/20，避免 1 分線過敏；超買/超賣 ±0.5、強/弱 ±0.3）
  const rsiArr = heavy?.rsi;
  let rsiLast = null;
  if (rsiArr && rsiArr.length) {
    rsiLast = rsiArr[rsiArr.length - 1];
    if (rsiLast >= 80) { score -= 0.5; reasons.push(`RSI${rsiLast.toFixed(0)}超買`); }
    else if (rsiLast <= 20) { score += 0.5; reasons.push(`RSI${rsiLast.toFixed(0)}超賣`); }
    else if (rsiLast > 50) { score += 0.3; reasons.push(`RSI${rsiLast.toFixed(0)}強勢`); }
    else { score -= 0.3; reasons.push(`RSI${rsiLast.toFixed(0)}弱勢`); }
  }

  // ⑤ 量爆（scalping 重點：最後 1 根 vs 過往 9 根均量）
  const vols = bars.map(b => b.v).filter(v => v != null);
  let volRatio = 1;     // 5 根 vs 全區間（保留供 UI 顯示）
  let lastVolRatio = 1; // 最後 1 根 vs 過往 9 根
  if (vols.length >= 10) {
    volRatio = avg(vols.slice(-5)) / (avg(vols) || 1);
    const baseN = avg(vols.slice(-10, -1));
    lastVolRatio = vols[vols.length - 1] / (baseN || 1);
    let volBonus = 0;
    if (lastVolRatio >= THR.volExtreme)  volBonus = 2;
    else if (lastVolRatio >= THR.volBurst) volBonus = 1;
    else if (volRatio >= 2)     volBonus = 0.5;
    if (volBonus > 0) {
      const tag = `量爆 x${lastVolRatio.toFixed(1)}`;
      if (score > 0) { score += volBonus; reasons.push(tag); }
      else if (score < 0) { score -= volBonus; reasons.push(tag); }
    }
  }

  // ⑥ 微動能加速度（scalping 最關鍵：最後 3 根 bar 動量 + 最後 1 根方向確認）
  if (bars.length >= 4) {
    const c0 = bars[bars.length - 1].c;
    const c3 = bars[bars.length - 4].c;
    const c1Prev = bars[bars.length - 2].c;
    const m3 = c3 ? ((c0 - c3) / c3) * 100 : 0;
    const lastDir = c0 - c1Prev;
    if (m3 > 0.2 && lastDir > 0) {
      score += 1.5; reasons.push(`動能加速多 ${m3.toFixed(2)}%`);
    } else if (m3 < -0.2 && lastDir < 0) {
      score -= 1.5; reasons.push(`動能加速空 ${m3.toFixed(2)}%`);
    } else if ((m3 > 0.1 && lastDir < 0) || (m3 < -0.1 && lastDir > 0)) {
      score += (lastDir > 0 ? 0.5 : -0.5);
      reasons.push("動能轉折");
    }
  }

  // ⑦ 突破 / 跌破近 20 根高低（含量能驗證假突破）
  if (highs.length >= 21 && lows.length >= 21) {
    const recentHigh = Math.max(...highs.slice(-21, -1));
    const recentLow  = Math.min(...lows.slice(-21, -1));
    const burst = lastVolRatio >= 1.5;
    if (price > recentHigh) {
      if (burst) { score += 1; reasons.push("突破近20高"); }
      else       { score -= 0.5; reasons.push("假突破(無量)"); }
    } else if (price < recentLow) {
      if (burst) { score -= 1; reasons.push("跌破近20低"); }
      else       { score += 0.5; reasons.push("假跌破(無量)"); }
    }
  }

  // ⑧ 5 分線同向確認（降權至 ±0.5；逆向警訊 ±0.3）
  if (sym && wlData && wlData.has(sym)) {
    const s5 = wlData.get(sym)?.score5;
    if (typeof s5 === "number") {
      if (score > 0 && s5 > 0) { score += 0.5; reasons.push("5分同向多"); }
      else if (score < 0 && s5 < 0) { score -= 0.5; reasons.push("5分同向空"); }
      else if (score > 0 && s5 < 0) { score -= 0.3; reasons.push("5分逆向警訊"); }
      else if (score < 0 && s5 > 0) { score += 0.3; reasons.push("5分逆向警訊"); }
    }
  }

  // ⑨ 大盤同向 / 相對強弱（降權）
  const mktPct = marketAvgPct();
  const stockPct = (intra.prevClose && intra.price)
    ? ((intra.price - intra.prevClose) / intra.prevClose) * 100
    : null;
  if (mktPct != null && stockPct != null && Math.abs(mktPct) >= 0.1) {
    if (stockPct > 0 && mktPct > 0) { score += 0.3; reasons.push("大盤同向多"); }
    else if (stockPct < 0 && mktPct < 0) { score -= 0.3; reasons.push("大盤同向空"); }
    if (stockPct > 1 && mktPct < 0) { score += 0.7; reasons.push(`相對強勢(大盤${mktPct.toFixed(2)}%)`); }
    else if (stockPct < -1 && mktPct > 0) { score -= 0.7; reasons.push(`相對弱勢(大盤+${mktPct.toFixed(2)}%)`); }
  }

  // 流動性「中」→ 整體分數 ×0.7（spread/滑價影響仍存在）
  if (liqTier === "mid") {
    score = score * 0.7;
    reasons.push("流動性中(×0.7)");
  }

  // 閾值 ±3.5 / ±1.5（放寬：原 ±5/±3 在實盤幾乎全是 HOLD）
  let label, cls;
  ({ label, cls } = _labelByScore(score));

  return { label, cls, score: +score.toFixed(1), scoreRaw: score, reasons, rsi: rsiLast, volRatio, atrPct };
}

const avg = a => a.reduce((x, y) => x + y, 0) / a.length;

function renderQuick(card, sym, intra) {
  card.querySelector(".name").textContent = intra.name;
  card.querySelector(".price").textContent = fmt(intra.price, 2);
  const diff = intra.price - intra.prevClose;
  const pct  = (diff / intra.prevClose) * 100;
  const cls  = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  const sign = diff > 0 ? "+" : "";
  const ch = card.querySelector(".change");
  ch.className = "change " + cls;
  ch.textContent = `${sign}${fmt(diff, 2)} (${sign}${fmt(pct, 2)}%)`;
  // 建議購買價格：取自 wlData（由 watchlist row 計算）
  const sb = card.querySelector(".suggest-buy");
  if (sb) {
    const sg = wlData.get(sym)?.suggestPx;
    if (sg != null && isFinite(sg)) {
      sb.textContent = `建議購買價格:${fmt(sg, 2)}`;
      sb.classList.remove("dim");
      const ok = intra.price != null && intra.price <= sg;
      sb.title = ok
        ? `現價 ${fmt(intra.price,2)} ≤ 建議 ${fmt(sg,2)}：可考慮進場`
        : `現價 ${fmt(intra.price,2)} > 建議 ${fmt(sg,2)}：避免追高`;
    } else {
      sb.textContent = `建議購買價格:--`;
      sb.classList.add("dim");
    }
  }
  card.querySelector(".range").textContent = `${fmt(intra.high,2)}/${fmt(intra.low,2)}`;
  // 今日 / 昨日 OHL（下方顯示相對基準的 %）
  // 今日 其他都以 昨收為基；昨日 其他都以 前日收為基
  const setOHL = (sel, v, base) => {
    const el = card.querySelector(sel);
    if (!el) return;
    el.textContent = fmt(v, 2);
    const pctEl = el.parentElement?.querySelector(".ohl-pct");
    if (!pctEl) return;
    if (v == null || base == null || !base) {
      pctEl.textContent = "";
      pctEl.className = "ohl-pct";
      return;
    }
    const p = ((v - base) / base) * 100;
    const cls = p > 0 ? "up" : p < 0 ? "down" : "flat";
    const sign = p > 0 ? "+" : "";
    pctEl.textContent = `${sign}${p.toFixed(2)}%`;
    pctEl.className = `ohl-pct ${cls}`;
  };
  const baseToday = intra.prevClose;
  const basePrev  = intra.prevPrevClose;
  setOHL(".ohl-todayO", intra.todayOpen, baseToday);
  setOHL(".ohl-todayH", intra.todayHigh, baseToday);
  setOHL(".ohl-todayL", intra.todayLow,  baseToday);
  setOHL(".ohl-prevO",  intra.prevOpen,  basePrev);
  setOHL(".ohl-prevH",  intra.prevHigh,  basePrev);
  setOHL(".ohl-prevL",  intra.prevLow,   basePrev);
  setOHL(".ohl-prevC",  intra.prevClose, basePrev);
  drawSpark(card.querySelector(".spark"), intra.bars.slice(-barCount), intra.prevClose, computeLevels(intra));
  drawWinRate(card, intra.bars);
  bindWrMiniClicks(card, sym);
  bindWsTestButton(card, sym);
  settleSimTradesForSymbol(sym, intra);
  renderExtended(card, intra);
  renderLiquidity(card, intra);

  const heavy = heavyCache.get(sym);
  if (heavy) {
    const sig = calcSignal(intra, heavy, sym);
    applySignal(card, sig, intra);
    const swingSig = calcSwingSignal(heavy.bars15, intra.price, intra.prevClose, sym);
    applySwingSignal(card, swingSig);
  }
}

// 計算當沖流動性（以日均量 + 今日成交金額估算滑價 / 出入場難易程度）
function computeLiquidity(intra) {
  const avgDaily = intra.avgDailyVolume;
  const todayVol = intra.volume;
  const price    = intra.price;
  // 今日每分鐘平均金額（bars 主要為 1m 或 5m，依個數近似）
  const minutesElapsed = Math.max(1, intra.bars.length);
  const dollarPerMin = (todayVol != null && price != null)
    ? (todayVol * price) / minutesElapsed
    : null;
  const avgDailyDollar = (avgDaily != null && price != null) ? avgDaily * price : null;

  // 判斷序：先看日均金額，再看今日每分鐘金額
  let tier = "high", label = "高";
  if (avgDailyDollar != null) {
    if (avgDailyDollar < 50_000_000) { tier = "low";  label = "低"; }
    else if (avgDailyDollar < 500_000_000) { tier = "mid";  label = "中"; }
  } else if (avgDaily != null) {
    if (avgDaily < 500_000) { tier = "low";  label = "低"; }
    else if (avgDaily < 5_000_000) { tier = "mid";  label = "中"; }
  }
  // 今日即時金額太低也降級
  if (dollarPerMin != null && dollarPerMin < 100_000 && tier === "high") tier = "mid";
  if (dollarPerMin != null && dollarPerMin < 30_000) { tier = "low"; label = "低"; }

  return { tier, label, avgDaily, avgDailyDollar, dollarPerMin };
}

function renderLiquidity(card, intra) {
  const liq = computeLiquidity(intra);
  // 更新內嵌徽章
  const badge = card.querySelector(".liq-badge");
  if (badge) {
    badge.textContent = `流動: ${liq.label}`;
    badge.className = "liq-badge liq-" + liq.tier;
  }
  // 警告列
  const warn = card.querySelector(".liquidity-warn");
  if (!warn) return;
  if (liq.tier === "low") {
    const dpmTxt = liq.dollarPerMin != null ? `｜今日/分 ≈ $${(liq.dollarPerMin/1000).toFixed(0)}k` : "";
    const adTxt  = liq.avgDaily != null ? `｜日均量 ${(liq.avgDaily/1e6).toFixed(2)}M` : "";
    warn.textContent = `⚠ 量能不足，不建議短線當沖（進出場滑價風險高）${adTxt}${dpmTxt}`;
    warn.style.display = "block";
  } else {
    warn.style.display = "none";
  }
}

function renderExtended(card, intra) {
  const wrap = card.querySelector(".extended");
  if (!wrap) return;
  const baseForExt = intra.prevClose; // 高/低 也以昨收為基計 %

  const fmtHL = (v) => {
    if (v == null || baseForExt == null || !baseForExt) return `--`;
    const p = ((v - baseForExt) / baseForExt) * 100;
    const s = p > 0 ? "+" : "";
    const c = p > 0 ? "up" : p < 0 ? "down" : "flat";
    return `${fmt(v, 2)} <span class="ext-hlpct ${c}">(${s}${p.toFixed(2)}%)</span>`;
  };
  const renderRow = (label, cls, price, ch, pct, ts, hi, lo) => {
    if (price == null) return "";
    const dirCls = (ch ?? 0) > 0 ? "up" : (ch ?? 0) < 0 ? "down" : "flat";
    const sign = (ch ?? 0) > 0 ? "+" : "";
    const tStr = ts ? new Date(ts * 1000).toLocaleTimeString() : "";
    const hlBlock = (hi != null || lo != null)
      ? `<span class="ext-hl">` +
        `<span class="ext-hl-pair"><span class="ext-hl-lbl">高</span>${fmtHL(hi)}</span>` +
        `<span class="ext-hl-pair"><span class="ext-hl-lbl">低</span>${fmtHL(lo)}</span>` +
        `</span>`
      : "";
    return `<div class="ext-row ${cls}">` +
      `<span class="ext-tag">${label}</span>` +
      `<span class="ext-pricebox">` +
        `<span class="ext-price">${fmt(price, 2)}</span>` +
        `<span class="ext-change ${dirCls}">${sign}${fmt(ch ?? 0, 2)} (${sign}${fmt(pct ?? 0, 2)}%)</span>` +
      `</span>` +
      hlBlock +
      (tStr ? `<span class="ext-time">${tStr}</span>` : "") +
      `</div>`;
  };

  const preHtml  = renderRow("盤前", "ext-pre",
    intra.preMarketPrice, intra.preMarketChange, intra.preMarketChangePct,
    intra.preMarketTime, intra.preMarketHigh, intra.preMarketLow);
  const postHtml = renderRow("盤後", "ext-post",
    intra.postMarketPrice, intra.postMarketChange, intra.postMarketChangePct,
    intra.postMarketTime, intra.postMarketHigh, intra.postMarketLow);

  if (!preHtml && !postHtml) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "flex";
  wrap.className = "extended";
  wrap.innerHTML = preHtml + postHtml;
}

function renderHeavy(card, sym, heavy) {
  if (heavy.macd) {
    const i = heavy.macd.hist.length - 1;
    const h = heavy.macd.hist[i];
    const m = heavy.macd.macd[i];
    const s = heavy.macd.sig[i];
    const el = card.querySelector(".macdH");
    el.textContent = fmt(h, 4);
    el.className = "val macdH " + (h > 0 ? "up" : h < 0 ? "down" : "flat");
    const inline = card.querySelector(".macd-inline");
    if (inline) {
      const tipMACD =
        "MACD 線（DIF）= EMA12 − EMA26&#10;" +
        "・正值：短均高於長均 → 偏多動能&#10;" +
        "・負值：短均低於長均 → 偏空動能&#10;" +
        "・由負翻正：黃金交叉雛形；由正翻負：死亡交叉雛形";
      const tipSig =
        "Signal 線 = MACD 的 9 期 EMA（平滑值）&#10;" +
        "・MACD 上穿 Signal：黃金交叉（買進訊號）&#10;" +
        "・MACD 下穿 Signal：死亡交叉（賣出訊號）&#10;" +
        "・兩線距離拉大 → 動能加速";
      const tipHist =
        "Histogram = MACD − Signal（柱狀圖）&#10;" +
        "・>0 紅柱：多方動能；<0 綠柱：空方動能&#10;" +
        "・柱體放大 → 動能增強；縮小 → 動能轉弱&#10;" +
        "・由負翻正：短線轉強；由正翻負：短線轉弱";
      const histColor = h > 0 ? "#ef5350" : h < 0 ? "#26a69a" : "#cbd2d9";
      inline.innerHTML =
        `<span title="${tipMACD}" style="color:#4fc3f7"><b>MACD</b> ${fmt(m,3)}</span> │ ` +
        `<span title="${tipSig}" style="color:#ffb74d"><b>Sig</b> ${fmt(s,3)}</span> │ ` +
        `<span title="${tipHist}" style="color:${histColor}"><b>Hist</b> ${fmt(h,3)}</span>`;
    }
    drawMACD(card.querySelector(".macd"), heavy.macd, heavy.bars, barCount);
  }
  if (heavy.rsi && heavy.rsi.length) {
    const r = heavy.rsi[heavy.rsi.length - 1];
    const el = card.querySelector(".rsi");
    el.textContent = r.toFixed(1);
    el.className = "val rsi " + (r >= 70 ? "down" : r <= 30 ? "up" : "flat");
  }
  const news = classifyNews(heavy.news || []);
  card.querySelector(".np").textContent = news.pos.length;
  card.querySelector(".nn").textContent = news.neg.length;
  const nuEl = card.querySelector(".nu");
  if (nuEl) nuEl.textContent = news.neu.length;
  fillNewsPopover(card.querySelector(".pos-pop"), news.pos, "正面新聞");
  fillNewsPopover(card.querySelector(".neg-pop"), news.neg, "負面新聞");
  const neuPop = card.querySelector(".neu-pop");
  if (neuPop) fillNewsPopover(neuPop, news.neu, "中立新聞");
  const top = news.pos[0] || news.neg[0] || news.neu[0] || (heavy.news || [])[0];
  const head = card.querySelector(".news-headline");
  if (top) {
    head.textContent = top.title;
    head.title = top.title;
    // 類似中文則不翻譯
    if (!isMostlyChinese(top.title)) {
      translateText(top.title).then(zh => {
        if (zh && zh !== top.title) {
          head.textContent = zh;
          head.title = `${zh}\n\n原文：${top.title}`;
        }
      });
    }
  } else {
    head.textContent = "—"; head.title = "";
  }
}

// ── 翻譯快取 ──
const translateCache = new Map();
function isMostlyChinese(s) {
  if (!s) return false;
  const cn = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return cn >= 3 || cn / s.length > 0.3;
}
async function translateText(text) {
  if (!text) return "";
  if (translateCache.has(text)) return translateCache.get(text);
  try {
    const url = `https://translate.googleapis.com/translate_a/single` +
                `?client=gtx&sl=auto&tl=zh-TW&dt=t&q=${encodeURIComponent(text)}`;
    const r = await fetch(url);
    if (!r.ok) return "";
    const j = await r.json();
    const zh = (j[0] || []).map(seg => seg[0]).join("");
    translateCache.set(text, zh);
    return zh;
  } catch {
    return "";
  }
}

function fillNewsPopover(el, items, label) {
  if (!el) return;
  el.innerHTML = "";
  const title = document.createElement("div");
  title.className = "pop-title";
  title.textContent = `${label}（${items.length}）`;
  el.appendChild(title);
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "無相關新聞";
    el.appendChild(empty);
    return;
  }
  for (const n of items) {
    const a = document.createElement("a");
    a.href = n.link || "#";
    a.target = "_blank";
    a.rel = "noopener noreferrer";

    const orig = document.createElement("span");
    orig.className = "orig";
    orig.textContent = n.title || "(no title)";
    a.appendChild(orig);

    if (n.title && !isMostlyChinese(n.title)) {
      const zhEl = document.createElement("span");
      zhEl.className = "zh";
      zhEl.textContent = "翻譯中…";
      a.appendChild(zhEl);
      a.dataset.zh = "翻譯中…";
      translateText(n.title).then(zh => {
        const txt = zh && zh !== n.title ? zh : "";
        zhEl.textContent = txt;
        if (!txt) zhEl.remove();
        a.dataset.zh = txt;
      });
    } else if (n.title) {
      a.dataset.zh = n.title; // 已是中文
    }

    if (n.publisher || n.time) {
      const pub = document.createElement("span");
      pub.className = "pub";
      const t = n.time ? n.time.toLocaleString() : "";
      pub.textContent = [n.publisher, t].filter(Boolean).join(" · ");
      a.appendChild(pub);
    }
    el.appendChild(a);
  }
}

// ─── 備選清單訊號表 ───
let _refreshWatchlistInflight = false;
let _refreshWatchlistSkipCount = 0;
async function refreshWatchlist() {
  const tbody = document.querySelector("#wlTable tbody");
  const status = $("wlStatus");
  if (!tbody) return;
  // 防重入：上一輪還沒跑完就被 setInterval 再次叫起 → 跳過此輪，避免疊加 N 倍網路請求把整體拖更慢
  if (_refreshWatchlistInflight) {
    _refreshWatchlistSkipCount++;
    if (status) {
      const cur = status.textContent || "";
      // 在原有「更新中…(x/40)」後面附加 (略過 N) 提示
      if (!/略過/.test(cur)) status.textContent = `${cur} · 略過 ${_refreshWatchlistSkipCount}`;
      else status.textContent = cur.replace(/略過 \d+/, `略過 ${_refreshWatchlistSkipCount}`);
    }
    return;
  }
  _refreshWatchlistInflight = true;
  _refreshWatchlistSkipCount = 0;
  try {
  const all = [...CATALOG.stocks, ...CATALOG.etfs];
  if (status) status.textContent = `更新中…(0 / ${all.length})`;

  // tbody 第一次載入時插入 placeholder 列
  if (!tbody.children.length) {
    for (const [sym, name] of all) {
      const tr = document.createElement("tr");
      tr.dataset.sym = sym;
      tr.innerHTML =
        `<td class="sym">${sym}</td>` +
        `<td class="name">${name}</td>` +
        `<td class="num">--</td><td class="num">--</td>` +
        `<td class="num">--</td><td class="num">--</td>` +
        `<td><span class="sig signal-loading">…</span></td>` +
        `<td><span class="sig signal-loading">…</span></td>` +
        `<td class="num">--</td>` +
        `<td class="num">--</td>` +
        `<td class="num">--</td><td class="num">--</td><td class="num">--</td><td class="num">--</td><td class="num">--</td><td class="num">--</td><td class="num">--</td><td class="num">--</td>`;
      tbody.appendChild(tr);
    }
  }

  let done = 0;
  for (let i = 0; i < all.length; i += WATCHLIST_BATCH) {
    const batch = all.slice(i, i + WATCHLIST_BATCH);
    await Promise.allSettled(batch.map(async ([sym, name]) => {
      try {
        const row = await computeWatchlistRow(sym, name);
        wlData.set(sym, row);
      } catch { /* skip */ }
      done++;
      if (status) status.textContent = `更新中…(${done} / ${all.length})`;
    }));
  }
  if (status) status.textContent = "已更新";
  $("wlUpdated").textContent = new Date().toLocaleTimeString();
  renderWatchlist();
  // 自動買入：wlData 剛刷新，立刻掃一次
  try { if (typeof runSimAutoScan === "function") runSimAutoScan(); } catch {}
  // 寫入 session 快照供下次開啟即時顯示（限 50 筆 / 體積上限）
  try {
    const arr = [...wlData.entries()].slice(0, 50);
    saveSnapshot("dash_wl_snapshot_v1", arr);
  } catch { /* noop */ }
  // 命中率歷史 → chrome.storage.local（dirty 才寫）
  flushSigHistory();
  } finally { _refreshWatchlistInflight = false; }
}

async function computeWatchlistRow(sym, name) {
  const [d1, d5, d15] = await Promise.all([
    fetchChartLite(sym, "1m", "1d"),
    fetchChartLite(sym, "5m", "5d"),
    fetchChartLite(sym, "15m", "5d").catch(() => null),
  ]);
  // A：1m chart meta 不一定包含 preMarketPrice / postMarketPrice / regularMarketDayHigh，充心由 5m chart meta 補上。
  // 否則 miniSignal(d1) 看不到 gap 與昨高低，score1 會漏計。例：NVDA 盤前 +2.01% 卻計 0.0。
  d1.pre     = d1.pre     ?? d5.pre;
  d1.post    = d1.post    ?? d5.post;
  d1.dayHigh = d1.dayHigh ?? d5.dayHigh;
  d1.dayLow  = d1.dayLow  ?? d5.dayLow;
  d1.marketState = _correctMarketState(d1.marketState || d5.marketState);
  d5.marketState = _correctMarketState(d5.marketState || d1.marketState);
  const sig1 = miniSignal(d1, "1m");
  const sig5 = miniSignal(d5, "5m");
  const sig15 = d15 ? miniSignal(d15, "15m") : null;
  // ATR / 信心度 / 共振
  const atrPct1 = calcAtrPct(d1.bars, d1.price);
  const atrPct5 = calcAtrPct(d5.bars, d5.price);
  const conf1 = calcConfidence(sig1, atrPct1);
  const conf5 = calcConfidence(sig5, atrPct5);
  // 低信心度→把 STRONG 降級
  const dg1 = degradeLowConf(sig1.label, sig1.cls, conf1);
  const dg5 = degradeLowConf(sig5.label, sig5.cls, conf5);
  sig1.label = dg1.label; sig1.cls = dg1.cls;
  sig5.label = dg5.label; sig5.cls = dg5.cls;
  const confluence = calcConfluence(sig1, sig5, sig15);
  // 反向偵測：用 score (toFixed 後) 即可
  const flip = detectFlip(sym, sig1.score, sig5.score);
  // 命中率：以 5m 訊號入庫（最具代表性），用 1m 即時價評估成熟條目
  // 這裡統一取「時間戳最新的價」代替 d1.price，避免盤後 regularMarketPrice 凍結成收盤價。
  const dir5 = signalDir(sig5);
  const _freshPx1 = _pickFreshIntraPrice(d1);
  const curPx = (_freshPx1.price != null) ? _freshPx1.price : (d1.price ?? d5.price);
  if (dir5 !== 0 && curPx != null) recordSignal(sym, "5m", dir5, sig5.scoreRaw ?? sig5.score, curPx);
  evaluateMatured(sym, curPx);
  const stats = getSymbolStats(sym);
  // RS rating：以 5d 起始到現在的報酬 − 同期大盤 (SPY / 0050.TW / 2800.HK) 報酬
  const stockRet5d = (curPx != null && d5.bars.length >= 2 && d5.bars[0].c)
    ? ((curPx - d5.bars[0].c) / d5.bars[0].c) * 100 : null;
  const benchSym = benchSymFor(sym);
  const benchRet5d = await getBenchmarkRet5d(benchSym);
  const rs5d = (stockRet5d != null && benchRet5d != null) ? +(stockRet5d - benchRet5d).toFixed(2) : null;
  const closes5 = d5.bars.map(b => b.c);
  const macd5 = calcMACD(closes5);
  const rsi5  = calcRSI(closes5, 14);
  const lastH = macd5 && macd5.hist.length ? macd5.hist[macd5.hist.length - 1] : null;
  const lastR = rsi5 && rsi5.length ? rsi5[rsi5.length - 1] : null;
  // price / chgPct 同樣採「時間戳最新」；prevClose 仍用昨日收盤，
  // 只是分子改為含盤前/後的最新價，使漲跌與右上 popover 卡一致。
  const price = curPx;
  const priceSrc = _freshPx1.src;  // "pre" | "post" | "reg"
  const prev  = d1.prevClose ?? d5.prevClose;
  const chg   = price != null && prev ? price - prev : null;
  const chgP  = chg != null && prev ? (chg / prev) * 100 : null;
  // 最近 1 分鐘漲幅統一由 lastBarChangePct 計算（避免重複公式 / 多個真實源）
  const _m5 = maxRangePct(d1.bars, 300);
  const _m5bs = _m5 ? _m5.bySession : null;
  const row = { sym, name, price, chgPct: chgP,
           mom5Pct:     _m5 ? _m5.up    : null,
           mom5UpT:     _m5 ? _m5.upT   : null,
           mom5DownPct: _m5 ? _m5.down  : null,
           mom5DownT:   _m5 ? _m5.downT : null,
           mom5Sessions: _m5bs,
           // 平軝出供表格欄位 / 排序使用
           mom5UpPre:   _m5bs?.pre?.up   ?? null,
           mom5UpRth:   _m5bs?.rth?.up   ?? null,
           mom5UpPost:  _m5bs?.post?.up  ?? null,
           mom5UpPreT:  _m5bs?.pre?.upT  ?? null,
           mom5UpRthT:  _m5bs?.rth?.upT  ?? null,
           mom5UpPostT: _m5bs?.post?.upT ?? null,
           mom5DnPre:   _m5bs?.pre?.down   ?? null,
           mom5DnRth:   _m5bs?.rth?.down   ?? null,
           mom5DnPost:  _m5bs?.post?.down  ?? null,
           mom5DnPreT:  _m5bs?.pre?.downT  ?? null,
           mom5DnRthT:  _m5bs?.rth?.downT  ?? null,
           mom5DnPostT: _m5bs?.post?.downT ?? null,
           last1mPct: lastBarChangePct(d1.bars),
           last1mT:   d1.bars.length ? d1.bars[d1.bars.length - 1].t : null,
           label1: sig1.label, score1: sig1.score, score1Raw: sig1.scoreRaw, cls1: sig1.cls,
           sig1Reasons: sig1.reasons, sig1Scores: sig1.scores,
           label5: sig5.label, score5: sig5.score, score5Raw: sig5.scoreRaw, cls5: sig5.cls,
           sig5Reasons: sig5.reasons, sig5Scores: sig5.scores,
           label15: sig15 ? sig15.label : null, score15: sig15 ? sig15.score : null, cls15: sig15 ? sig15.cls : null,
           conf1, conf5,
           confluenceLabel: confluence.label, confluenceCls: confluence.cls,
           confluenceDir: confluence.dir, confluenceCount: confluence.count, confluenceDetail: confluence.detail,
           winRate: stats ? stats.winRate : null, avgRet: stats ? stats.avgRet : null, statsN: stats ? stats.n : 0,
           flip,
           rs5d, benchSym, stockRet5d, benchRet5d,
           volRatio5: sig5.lastVolRatio,
           rsi5: lastR, hist5: lastH,
           // 盤前 / 盤後即時價（1m 資料最完整）
           pre: d1.pre ?? d5.pre,
           post: d1.post ?? d5.post,
           // 昨日高低 / 52w 高低（供突破評估 + 位階提示）
           dayHigh: d1.dayHigh ?? d5.dayHigh ?? null,
           dayLow:  d1.dayLow  ?? d5.dayLow  ?? null,
           fwHigh:  d1.fwHigh  ?? d5.fwHigh  ?? null,
           fwLow:   d1.fwLow   ?? d5.fwLow   ?? null,
           marketState: d1.marketState ?? d5.marketState };
  row.hotScore  = calcHotScore(row);
  row.coldScore = calcColdScore(row);
  // P2：超賣反彈 / 衝高回吐修正
  //   規則：「今日累計跌幅 ≤ -3%」且「盤前/後 gap ≥ +2%」 → score1 +1.5（超賣反彈）
  //   「今日累計漲幅 ≥ +3%」且「盤前/後 gap ≤ -2%」 → score1 -1.5（衝高回吐）
  //   修正 score1 / score1Raw 同步推進 hot/cold 重新計算。
  const _pre = row.pre?.changePct;
  const _post = row.post?.changePct;
  const _gap = (typeof _pre === "number") ? _pre : (typeof _post === "number") ? _post : null;
  const _gapSrcRow = (typeof _pre === "number") ? "盤前" : (typeof _post === "number") ? "盤後" : null;
  if (typeof row.chgPct === "number" && _gap != null) {
    let _adj = 0, _reason = null;
    if (row.chgPct <= -3 && _gap >= +2) {
      _adj = +1.5;
      _reason = `P2:超賣反彈 +1.5 (今日${row.chgPct.toFixed(1)}% + ${_gapSrcRow}+${_gap.toFixed(1)}%)`;
    } else if (row.chgPct >= +3 && _gap <= -2) {
      _adj = -1.5;
      _reason = `P2:衝高回吐 -1.5 (今日+${row.chgPct.toFixed(1)}% + ${_gapSrcRow}${_gap.toFixed(1)}%)`;
    }
    if (_adj !== 0) {
      row.score1Raw = (row.score1Raw ?? 0) + _adj;
      row.score1 = +row.score1Raw.toFixed(1);
      const lab = _labelByScore(row.score1Raw);
      row.label1 = lab.label; row.cls1 = lab.cls;
      if (Array.isArray(row.sig1Reasons)) row.sig1Reasons.push(_reason);
      if (Array.isArray(row.sig1Scores))  row.sig1Scores.push(_adj);
      // hot/cold 重新計算以反映調整
      row.hotScore  = calcHotScore(row);
      row.coldScore = calcColdScore(row);
    }
  }
  // 52w 位階 %（(price - low)/(high - low)*100）：越大越接近年高，越小越接近年低。
  if (price != null && row.fwHigh && row.fwLow && row.fwHigh > row.fwLow) {
    row.pos52w = +(((price - row.fwLow) / (row.fwHigh - row.fwLow)) * 100).toFixed(1);
  } else {
    row.pos52w = null;
  }
  // 勝率：優先 1m（K=10 ≈ 10 分鐘）；盤前/早盤 1m bar 不足時 fallback 用 5m（K=2 ≈ 10 分鐘）
  // 5m fallback：K=3 根 ≈ 真 15 分鐘；WIN=12 對應近 ±60 分鐘。
  // （原本 WIN=40 跳回三天前，記憶太長、隻 wr 變楫家，兩見偏 0% / 100%。）
  // simCfg.wrRthOnly：勾選後只取 09:30-16:00 ET 的 bars，避免盤前/後稀疏 bar 把勝率算高/低。
  const _wrRthOnly = !!(typeof simCfg !== "undefined" && simCfg && simCfg.wrRthOnly);
  const _filtBars = (bars) => {
    if (!_wrRthOnly || !bars || !bars.length) return bars;
    return bars.filter(b => b && b.t && _usSessionOfTs(b.t * 1000) === "rth");
  };
  const _d1Bars = _filtBars(d1.bars);
  const _d5Bars = _filtBars(d5.bars);
  // 返回實際取樣窗數（供 wr tooltip 顯示「樣本 N 根」以判斷勝率可信度）
  const _wrN = (bars, K, WIN) => {
    if (!bars || bars.length <= K) return 0;
    return Math.min(WIN, bars.length - K);
  };
  const _wrFb = (target, isDown) => {
    const fn = isDown ? winRateDownPct : winRatePct;
    const v1 = fn(_d1Bars, target, 10, 20);
    if (v1 != null) return { v: v1, src: "1m", n: _wrN(_d1Bars, 10, 20) };
    const v5 = fn(_d5Bars, target, 3, 12);
    if (v5 != null) return { v: v5, src: "5m", n: _wrN(_d5Bars, 3, 12) };
    return { v: null, src: "1m", n: 0 };
  };
  { const o = _wrFb(0.003, false); row.wr030 = o.v; row.wrN030 = o.n; }
  { const o = _wrFb(0.005, false); row.wr050 = o.v; row.wrN050 = o.n; }
  { const o = _wrFb(0.005, true ); row.wr050d = o.v; row.wrN050d = o.n; }
  // 紀錄勝率資料來源 + 計算範圍，方便 hover 提示 & debug
  const _wr1mOk  = winRatePct(_d1Bars, 0.003, 10, 20) != null;
  row.wrSrc     = _wr1mOk ? "1m" : "5m";
  row.wrScope   = _wrRthOnly ? "rth" : "mixed";
  // 建議進場價：最近 5 根 1m 的 VWAP / 低點參考，不高於現價，避免追高
  row.suggestPx = (() => {
    const last5 = d1.bars.slice(-5).filter(b => b && b.c != null);
    if (!last5.length || price == null) return null;
    let vSum = 0, pvSum = 0, lowMin = Infinity, hiMax = -Infinity;
    for (const b of last5) {
      const v = (b.v && b.v > 0) ? b.v : 1;
      const c = b.c;
      vSum += v; pvSum += v * c;
      const lo = b.l != null ? b.l : c;
      const hi = b.h != null ? b.h : c;
      if (lo < lowMin) lowMin = lo;
      if (hi > hiMax) hiMax = hi;
    }
    const vwap = vSum > 0 ? pvSum / vSum : null;
    if (!isFinite(lowMin) || !isFinite(hiMax) || vwap == null) return null;
    // 取「近 5 分 VWAP」與「近 5 分低點 + 1/3 區間」兩者較小者，並不超過現價
    const blend = lowMin + (hiMax - lowMin) * 0.33;
    return Math.min(price, Math.min(vwap, blend));
  })();
  // 評分埋點（預設關閉）：方便日後比對 score → 隔日報酬
  emitTelemetry("watchlist_row", {
    sym, t: Date.now(), price: row.price,
    score1: row.score1, score5: row.score5,
    hotScore: row.hotScore, coldScore: row.coldScore,
    rsi5: row.rsi5
  });
  return row;
}

async function fetchChartLite(symbol, interval, range) {
  // 包含盤前 / 盤後：開盤初期 1 分線不足 35 根時，可透過 pre-market 補齊 MACD 需要的長度
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
              `?range=${range}&interval=${interval}&includePrePost=true`;
  // 短期快取命中（1.5s 內）：避免同一輪 refresh 內多條路徑重複打網路
  const cached = _chartCache.get(url);
  if (cached && Date.now() - cached.ts < CHART_FETCH_TTL_MS) return cached.value;
  // In-flight 去重：兩個並發呼叫者共用同一個 Promise
  const pending = _chartInflight.get(url);
  if (pending) return pending;
  const p = (async () => {
    await throttleSym(`chart:${symbol}:${interval}`);
    const [j, prevDaily] = await Promise.all([
      safeFetchJson(url),
      fetchYesterdayClose(symbol).catch(() => null),
    ]);
  const res = j.chart.result?.[0];
  if (!res) throw new Error("no data");
  const meta = res.meta;
  const ts = res.timestamp || [];
  const q = res.indicators.quote[0] || {};
  const bars = ts.map((t, i) => ({
    t, c: q.close?.[i], v: q.volume?.[i],
    h: q.high?.[i], l: q.low?.[i], o: q.open?.[i],
  })).filter(b => b.c != null);
  const lastClose = bars.length ? bars[bars.length - 1].c : null;
  const prevC = prevDaily ?? meta.regularMarketPreviousClose ?? meta.previousClose ?? meta.chartPreviousClose;
  const regPrice = meta.regularMarketPrice ?? lastClose;

  // 推算盤前 / 盤後撮合（meta 不一定有 preMarketPrice / postMarketPrice）
  const tp = meta.currentTradingPeriod || {};
  let pre = null, post = null;
  let preTime = null, postTime = null;
  if (meta.preMarketPrice != null) {
    pre = {
      price: meta.preMarketPrice,
      changePct: meta.preMarketChangePercent ?? (prevC ? ((meta.preMarketPrice - prevC) / prevC) * 100 : null),
    };
    preTime = meta.preMarketTime || null;
  } else if (tp.pre && bars.length) {
    const pb = bars.filter(b => b.t >= tp.pre.start && b.t < tp.pre.end);
    if (pb.length) {
      const lb = pb[pb.length - 1];
      pre = { price: lb.c, changePct: prevC ? ((lb.c - prevC) / prevC) * 100 : null };
      preTime = lb.t;
    }
  }
  if (meta.postMarketPrice != null) {
    post = {
      price: meta.postMarketPrice,
      changePct: meta.postMarketChangePercent ?? (regPrice ? ((meta.postMarketPrice - regPrice) / regPrice) * 100 : null),
    };
    postTime = meta.postMarketTime || null;
  } else if (tp.post && bars.length) {
    const pb = bars.filter(b => b.t >= tp.post.start && b.t < tp.post.end);
    if (pb.length) {
      const lb = pb[pb.length - 1];
      post = { price: lb.c, changePct: regPrice ? ((lb.c - regPrice) / regPrice) * 100 : null };
      postTime = lb.t;
    }
  }

  return {
    bars,
    price: regPrice,
    prevClose: prevC ?? bars[0]?.c,
    marketState: meta.marketState,
    pre, post,
    // 平鋪欄位讓 _pickFreshIntraPrice() 能挑「時間戳最新」的價（盤前/後/RTH）
    preMarketPrice:  pre  ? pre.price  : null,
    postMarketPrice: post ? post.price : null,
    preMarketTime:   preTime,
    postMarketTime:  postTime,
    // 額外 meta：以針對 04:00 ET 盤前、他高突破 / 極長期位階評估。
    // 註：regularMarketDayHigh/Low 在盤前仍指「昨日 RTH」高低（Yahoo 未換日前）。
    dayHigh:   meta.regularMarketDayHigh ?? null,
    dayLow:    meta.regularMarketDayLow  ?? null,
    fwHigh:    meta.fiftyTwoWeekHigh ?? null,
    fwLow:     meta.fiftyTwoWeekLow  ?? null,
    meta: { regularMarketTime: meta.regularMarketTime || null },
  };
  })();
  _chartInflight.set(url, p);
  try {
    const value = await p;
    _chartCache.set(url, { ts: Date.now(), value });
    return value;
  } finally {
    _chartInflight.delete(url);
  }
}

// 輕量訊號（watchlist 表格中用）—— 對齊主 calcSignal 的 scalping 設定
//   處理 1m / 5m 兩種資料。未取得類別，只輸出 score / label，是兩個時間框架指標。
function miniSignal(d, tf) {
  // 依 tf 限縮 bars 取樣窗：避免「1m×1d 含昨日全天 RTH」把今日盤前 3 根新 bar 變成雜訊。
  //   1m  → 只看最近 60 根 ≈ 1 小時
  //   5m  → 只看最近 78 根 ≈ 1 個交易日 (6.5h)
  //   15m → 只看最近 52 根 ≈ 2 個交易日
  const _allBars = d.bars || [];
  const _slice = tf === "1m" ? 60 : tf === "5m" ? 78 : tf === "15m" ? 52 : null;
  const bars   = (_slice && _allBars.length > _slice) ? _allBars.slice(-_slice) : _allBars;
  const closes = bars.map(b => b.c).filter(c => c != null);
  if (closes.length < 5) return { label: "—", score: 0, scoreRaw: 0, cls: "signal-neutral", reasons: ["資料不足"], scores: [null] };
  const price = d.price ?? closes[closes.length - 1];
  let score = 0;
  const reasons = [];
  const scores  = [];
  const add = (delta, text) => { reasons.push(text); scores.push(delta); };

  // P1（1m 新鮮度偵測）：盤前/盤後且最後一根 1m bar > 30 分鐘。
  // bars[].t 為 Yahoo 秒級 timestamp。過時時「價>VWAP / 價>MA20 / MACD / RSI / 近20根高低」
  // 都是昨日 RTH 收尾的镜像，對盤前訊號並無意義、反而讓大型股統統出 score=0。
  // 偵測到過時則記標，在進入「⊥gap / 昨高低突破 / 大盤同向」的 P1 reset 點將其他累計零化。
  const _lastBarT = bars.length ? bars[bars.length - 1].t : null;
  const _barAgeMin = (_lastBarT != null) ? (Date.now()/1000 - _lastBarT) / 60 : Infinity;
  const _isPrePost = d.marketState === "PRE" || d.marketState === "PREPRE" || d.marketState === "POST" || d.marketState === "POSTPOST";
  const stale1m = (tf === "1m") && _isPrePost && _barAgeMin > 30;

  // ATR 閘門 + 後續使用：保留 atrPct 給跳空缺口使用相對門檻
  let atrPct = null;
  if (bars.length >= 15) {
    const trs = [];
    for (let i = bars.length - 14; i < bars.length; i++) {
      const b = bars[i], pp = bars[i - 1];
      if (!b || !pp) continue;
      const bh = b.h ?? b.c, bl = b.l ?? b.c;
      trs.push(Math.max(bh - bl, Math.abs(bh - pp.c), Math.abs(bl - pp.c)));
    }
    if (trs.length) {
      const atr = avg(trs);
      atrPct = price ? (atr / price) * 100 : null;
      if (atrPct != null && atrPct < THR.atrMin) {
        return { label: "HOLD", score: 0, scoreRaw: 0, cls: "signal-hold",
                 reasons: [`波動不足 ATR ${atrPct.toFixed(2)}%(HOLD)`], scores: [null] };
      }
    }
  }

  // ① VWAP（與主 calcSignal 一致）
  const vBars = bars.filter(b => b && b.v != null && b.v > 0 && b.c != null);
  if (vBars.length >= 5) {
    let pv = 0, sv = 0;
    for (const b of vBars) {
      const tp = (b.h != null && b.l != null) ? (b.h + b.l + b.c) / 3 : b.c;
      pv += tp * b.v; sv += b.v;
    }
    if (sv > 0) {
      const vwap = pv / sv;
      if (price > vwap)      { score += 1; add(+1, "價>VWAP"); }
      else if (price < vwap) { score -= 1; add(-1, "價<VWAP"); }
    }
  }

  // ② MA20（hoist 出去供 RSI 條件式扣分使用）
  let ma20 = null;
  if (closes.length >= 10) {
    ma20 = avg(closes.slice(-20));
    if (price > ma20) { score += 1; add(+1, "價>MA20"); }
    else              { score -= 1; add(-1, "價<MA20"); }
  }

  // ③ MACD ±0.5 / ±0.3
  const m = calcMACD(closes);
  let macdHist = null;
  if (m && m.hist.length >= 2) {
    const i = m.hist.length - 1;
    const h = m.hist[i], hp = m.hist[i - 1];
    macdHist = h;
    if (h > 0 && h > hp)      { score += 0.5; add(+0.5, "MACD多頭擴張"); }
    else if (h > 0)           { score += 0.3; add(+0.3, "MACD多頭"); }
    else if (h < 0 && h < hp) { score -= 0.5; add(-0.5, "MACD空頭擴張"); }
    else                      { score -= 0.3; add(-0.3, "MACD空頭"); }
  }

  // ④ RSI（強趨勢過濾）：RSI ≥70 只在 價<MA20 或 MACD 翻空 時才扣分；強多頭(價>MA20 + MACD>0)時 RSI 75+ 視為動能延續，給 +0.3
  const rsi = calcRSI(closes, 14);
  if (rsi && rsi.length) {
    const r = rsi[rsi.length - 1];
    const rn = Math.round(r);
    const trendUp   = (ma20 != null && price > ma20) && (macdHist != null && macdHist > 0);
    const trendDown = (ma20 != null && price < ma20) && (macdHist != null && macdHist < 0);
    if (r >= 70) {
      if (trendUp)    { score += 0.3; add(+0.3, `RSI${rn}強多延續`); }
      else            { score -= 1;   add(-1,   `RSI${rn}超買`); }
    } else if (r <= 30) {
      if (trendDown)  { score -= 0.3; add(-0.3, `RSI${rn}弱空延續`); }
      else            { score += 1;   add(+1,   `RSI${rn}超賣`); }
    } else if (r > 50)  { score += 0.3; add(+0.3, `RSI${rn}強勢`); }
    else                { score -= 0.3; add(-0.3, `RSI${rn}弱勢`); }
  }

  // ⑤ 量爆：最後 1 根 / 過往 9 根均量
  const vols = bars.map(b => b.v).filter(v => v != null);
  let lastVolRatio = 1;
  if (vols.length >= 10) {
    const baseN = avg(vols.slice(-10, -1));
    lastVolRatio = vols[vols.length - 1] / (baseN || 1);
    let volBonus = 0;
    if (lastVolRatio >= THR.volExtreme)  volBonus = 2;
    else if (lastVolRatio >= THR.volBurst) volBonus = 1;
    if (volBonus > 0 && score !== 0) {
      const dir = score > 0 ? 1 : -1;
      score += dir * volBonus;
      add(dir * volBonus, `量爆${lastVolRatio.toFixed(1)}x`);
    }
  }

  // ⑥ 微動能加速度（最後 3 根）
  if (bars.length >= 4) {
    const c0 = bars[bars.length - 1].c;
    const c3 = bars[bars.length - 4].c;
    const c1Prev = bars[bars.length - 2].c;
    const m3 = c3 ? ((c0 - c3) / c3) * 100 : 0;
    const lastDir = c0 - c1Prev;
    if (m3 > 0.2 && lastDir > 0)        { score += 1.5; add(+1.5, `微動能多 ${m3.toFixed(2)}%`); }
    else if (m3 < -0.2 && lastDir < 0)  { score -= 1.5; add(-1.5, `微動能空 ${m3.toFixed(2)}%`); }
    else if (m3 > 0.1 && lastDir < 0)   { score -= 0.5; add(-0.5, "動能背離(轉弱)"); }
    else if (m3 < -0.1 && lastDir > 0)  { score += 0.5; add(+0.5, "動能背離(轉強)"); }
  }

  // ⑦ 突破近 20 根高低（需量能驗證）
  const highs = bars.map(b => b.h).filter(v => v != null);
  const lows  = bars.map(b => b.l).filter(v => v != null);
  if (highs.length >= 21 && lows.length >= 21) {
    const recentHigh = Math.max(...highs.slice(-21, -1));
    const recentLow  = Math.min(...lows.slice(-21, -1));
    const burst = lastVolRatio >= 1.5;
    if (price > recentHigh) {
      if (burst) { score += 1;   add(+1,   "突破近20根高"); }
      else       { score -= 0.5; add(-0.5, "假突破(無量)"); }
    } else if (price < recentLow) {
      if (burst) { score -= 1;   add(-1,   "跌破近20根低"); }
      else       { score += 0.5; add(+0.5, "假跌破(無量)"); }
    }
  }

  // ⑧ 跳空缺口：用 ATR 相對門檻（gap / atr ≥ 0.5σ → ±0.5）取代固定 ±0.5%
  if (d.prevClose && bars.length) {
    const open0 = bars[0].o ?? bars[0].c;
    if (open0 != null) {
      const gapPct = ((open0 - d.prevClose) / d.prevClose) * 100;
      // 若無 ATR 退回固定 0.5%；有 ATR 則需 |gap| ≥ 0.5×ATR
      const gapTh = (atrPct != null && atrPct > 0) ? Math.max(0.5 * atrPct, 0.3) : 0.5;
      if (gapPct >= gapTh)        { score += 0.5; add(+0.5, `跳空多 ${gapPct.toFixed(2)}%(門檻${gapTh.toFixed(2)})`); }
      else if (gapPct <= -gapTh)  { score -= 0.5; add(-0.5, `跳空空 ${gapPct.toFixed(2)}%(門檻${gapTh.toFixed(2)})`); }
    }
  }

  // ⑨ 大盤同向 / 相對強弱
  const mktPct = marketAvgPct();
  const stockPct = (d.prevClose && price)
    ? ((price - d.prevClose) / d.prevClose) * 100
    : null;
  if (mktPct != null && stockPct != null && Math.abs(mktPct) >= 0.1) {
    if (stockPct > 0 && mktPct > 0)      { score += 0.3; add(+0.3, "大盤同向多"); }
    else if (stockPct < 0 && mktPct < 0) { score -= 0.3; add(-0.3, "大盤同向空"); }
    if (stockPct > 1 && mktPct < 0)       { score += 0.7; add(+0.7, `相對強勢(大盤${mktPct.toFixed(2)}%)`); }
    else if (stockPct < -1 && mktPct > 0) { score -= 0.7; add(-0.7, `相對弱勢(大盤+${mktPct.toFixed(2)}%)`); }
  }

  // ③′ 盤前/盤後 gap（P3a）：預市/盤後強勢是隔日隱含性很高的訊號，以前 miniSignal 完全未券重。
  // 規則：|Δ%| > 1.5% → ±1、> 3% → ±2、> 5% → ±3（D 增加極端層）。同時紀錄 reason 供 tooltip。
  // P1：若 1m 過時，在進入 gap/昨高低/大盤同向之前先重置前面的技術評分 (都是昨 RTH 殘影)
  if (stale1m) {
    score = 0;
    reasons.length = 0;
    scores.length = 0;
    add(0, `1m bar 已 ${Math.round(_barAgeMin)} 分鐘未更新（盤前/後無新成交），已重置技術評分，僅依 gap + 昨高低 + 大盤同向`);
  }
  // P0：gap 來源依 marketState 決定（避免盤後仍用早上的 pre.changePct = 12 小時殘影）
  //   PRE/PREPRE   → 用 pre
  //   POST/POSTPOST → 用 post（不再 fallback pre，避免取到當日早上盤前殘值）
  //   REGULAR/其他 → 取 |Δ| 較大且 ≥0.3% 者；都沒就 null
  const _msNow = d.marketState || "";
  const _preP  = (typeof d.pre?.changePct  === "number") ? d.pre.changePct  : null;
  const _postP = (typeof d.post?.changePct === "number") ? d.post.changePct : null;
  let _gapPct = null, _gapSrc = null;
  if (_msNow === "PRE" || _msNow === "PREPRE") {
    if (_preP != null) { _gapPct = _preP; _gapSrc = "盤前"; }
  } else if (_msNow === "POST" || _msNow === "POSTPOST") {
    if (_postP != null) { _gapPct = _postP; _gapSrc = "盤後"; }
  } else {
    const pickPre = _preP != null && Math.abs(_preP) >= 0.3;
    const pickPost = _postP != null && Math.abs(_postP) >= 0.3;
    if (pickPre && pickPost) {
      if (Math.abs(_postP) >= Math.abs(_preP)) { _gapPct = _postP; _gapSrc = "盤後"; }
      else                                     { _gapPct = _preP;  _gapSrc = "盤前"; }
    } else if (pickPre)  { _gapPct = _preP;  _gapSrc = "盤前"; }
      else if (pickPost) { _gapPct = _postP; _gapSrc = "盤後"; }
  }
  if (_gapPct != null && _gapSrc) {
    if      (_gapPct >  5)   { score += 3;  add(+3,  `${_gapSrc} gap +${_gapPct.toFixed(2)}% (極強)`); }
    else if (_gapPct >  3)   { score += 2;  add(+2,  `${_gapSrc} gap +${_gapPct.toFixed(2)}% (強)`); }
    else if (_gapPct >  1.5) { score += 1;  add(+1,  `${_gapSrc} gap +${_gapPct.toFixed(2)}%`); }
    else if (_gapPct < -5)   { score -= 3;  add(-3,  `${_gapSrc} gap ${_gapPct.toFixed(2)}% (極弱)`); }
    else if (_gapPct < -3)   { score -= 2;  add(-2,  `${_gapSrc} gap ${_gapPct.toFixed(2)}% (強)`); }
    else if (_gapPct < -1.5) { score -= 1;  add(-1,  `${_gapSrc} gap ${_gapPct.toFixed(2)}%`); }
  }

  // ③″ 突破昨日高/低（對盤前、對跨日都很重要）。dayHigh/Low 在盤前仍為昨日值。
  if (price != null && d.dayHigh && d.dayLow) {
    const _bo  = (price - d.dayHigh) / d.dayHigh * 100;   // >0 即突破昨高
    const _bd  = (price - d.dayLow)  / d.dayLow  * 100;   // <0 即跌破昨低
    if      (_bo >  0.2)  { score += 1;   add(+1,   `突破昨日高 +${_bo.toFixed(2)}%`); }
    else if (_bo > -0.2)  { score += 0.3; add(+0.3, `迫近昨日高`); }
    if      (_bd < -0.2)  { score -= 1;   add(-1,   `跌破昨日低 ${_bd.toFixed(2)}%`); }
    else if (_bd <  0.2)  { score -= 0.3; add(-0.3, `迫近昨日低`); }
  }

  // P2：stale1m + POST 且 gap 不夠強（|gap|<2）時，限幅 ±1.5（屬於低信賴情境，避免 LEU 那種 -2.6 過度懲罰）
  if (stale1m && (_msNow === "POST" || _msNow === "POSTPOST") && (_gapPct == null || Math.abs(_gapPct) < 2)) {
    if (score >  1.5) { add(0, `POST 低信賴限幅 (原 ${score.toFixed(2)} → +1.5)`); score =  1.5; }
    if (score < -1.5) { add(0, `POST 低信賴限幅 (原 ${score.toFixed(2)} → -1.5)`); score = -1.5; }
  }
  // 門檻對齊主 calcSignal：±3.5 STRONG、±1.5 BUY/SELL
  let label, cls;
  ({ label, cls } = _labelByScore(score));
  // scoreRaw 保留全精度供 calcHotScore/calcColdScore 二次合成；score 為顯示用 1 位小數
  return { label, score: +score.toFixed(1), scoreRaw: score, cls, lastVolRatio, reasons, scores };
}

// 飆股潛力分：合成 score1 / score5 / 5分↑ 動能 / 5m 量爆 / RSI 過熱 / 雙向震盪
// 用於下方表格「🔥 飆股」排序與 TOP3 挑選，避免單看 score1 被瞬間噪訊干擾
function calcHotScore(r) {
  if (!r) return null;
  let s = 0;
  // 優先使用全精度 scoreRaw（miniSignal 內部未被 toFixed 截除）
  const sc1 = (typeof r.score1Raw === "number") ? r.score1Raw : r.score1;
  const sc5 = (typeof r.score5Raw === "number") ? r.score5Raw : r.score5;
  if (typeof sc1 === "number") s += sc1 * 1.0;
  if (typeof sc5 === "number") s += sc5 * 0.7;
  if (typeof r.mom5Pct === "number" && r.mom5Pct >= 0.45) s += r.mom5Pct * 1.5;
  if (typeof r.volRatio5 === "number" && r.volRatio5 >= 3) s += 1.5;
  if (typeof r.rsi5 === "number" && r.rsi5 >= 80) s -= 2;
  if (typeof r.mom5DownPct === "number" && r.mom5DownPct <= -0.6) s += r.mom5DownPct; // 下跌振幅大→負分
  return +s.toFixed(1);
}

// 超跌續弱分（飆股鏡像）：分數越高代表續跌動能越強，可作放空候選
// = -score1×1 - score5×0.7 + 5分↓ 動能×1.5 + 5m量爆+1.5 - RSI5≤20 扣2 - 上漲振幅扣分
function calcColdScore(r) {
  if (!r) return null;
  let s = 0;
  const sc1 = (typeof r.score1Raw === "number") ? r.score1Raw : r.score1;
  const sc5 = (typeof r.score5Raw === "number") ? r.score5Raw : r.score5;
  if (typeof sc1 === "number") s += -sc1 * 1.0;
  if (typeof sc5 === "number") s += -sc5 * 0.7;
  if (typeof r.mom5DownPct === "number" && r.mom5DownPct <= -0.45) s += -r.mom5DownPct * 1.5;
  if (typeof r.volRatio5 === "number" && r.volRatio5 >= 3) s += 1.5;
  if (typeof r.rsi5 === "number" && r.rsi5 <= 20) s -= 2;   // 過冷反彈風險
  if (typeof r.mom5Pct === "number" && r.mom5Pct >= 0.6) s -= r.mom5Pct;
  return +s.toFixed(1);
}

// ─── 訊號品質強化：MTF 共振 / 信心度 / 命中率 / 反向偵測 ────────────────────────
const SIG_HIST_KEY        = "dash_sig_hist_v1";
const SIG_HIST_MAX_PER_SYM = 200;            // 每檔最多保留條目
const SIG_HIST_STATS_WIN   = 30;             // 統計近 N 筆已成熟
const SIG_MATURE_MIN       = { "1m": 5, "5m": 15, "15m": 45 }; // 訊號成熟所需分鐘
const SIG_WIN_THRESHOLD    = 0.2;            // ±0.2% 才算 win
const SIG_FLIP_WINDOW_MS   = 10 * 60 * 1000; // 10 分鐘內由強多→空 視為翻轉
const SIG_SCORE_REF_MAX    = 8;              // confidence 標準化參考最大分
const SIG_LOW_CONF_TH      = 0.4;            // 低於 40% 取消 STRONG

let __sigHist = /** @type {Record<string, {entries:Array<any>, stats: any}> | null} */(null);
let __sigHistDirty = false;
async function loadSigHistory() {
  if (__sigHist) return __sigHist;
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      const o = await new Promise(res => chrome.storage.local.get([SIG_HIST_KEY], res));
      __sigHist = (o && o[SIG_HIST_KEY]) || {};
    } else { __sigHist = {}; }
  } catch { __sigHist = {}; }
  return __sigHist;
}
function flushSigHistory() {
  if (!__sigHist || !__sigHistDirty) return;
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ [SIG_HIST_KEY]: __sigHist });
    }
  } catch { /* noop */ }
  __sigHistDirty = false;
}

/** 由 bars 計算近 14 根 ATR%（給 confidence 用） */
function calcAtrPct(bars, price) {
  if (!bars || bars.length < 15 || !price) return null;
  const trs = [];
  for (let i = bars.length - 14; i < bars.length; i++) {
    const b = bars[i], pp = bars[i - 1];
    if (!b || !pp) continue;
    const bh = b.h ?? b.c, bl = b.l ?? b.c;
    trs.push(Math.max(bh - bl, Math.abs(bh - pp.c), Math.abs(bl - pp.c)));
  }
  if (!trs.length) return null;
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  return (atr / price) * 100;
}

/** sig.score → 方向 (+1/-1/0)：≥2 多、≤-2 空 */
function signalDir(sig) {
  if (!sig || typeof sig.score !== "number") return 0;
  // 閾值跟 THR.scoreBuy 連動：低於 BUY 門檻的分數不算「明確方向」
  const th = Math.max(1, +THR.scoreBuy || 1.5);
  if (sig.score >=  th) return 1;
  if (sig.score <= -th) return -1;
  return 0;
}
// 「偏向」：尚未達 BUY 門檻，但 |score| ≥ 0.5 且同符號，供弱共振使用
function signalLean(sig) {
  if (!sig || typeof sig.score !== "number") return 0;
  if (sig.score >=  0.5) return 1;
  if (sig.score <= -0.5) return -1;
  return 0;
}

/** B：Yahoo marketState 在 4:00–9:30 ET 常殘留 POST/POSTPOST/CLOSED，以 ET 時鐘訂正。 */
function _correctMarketState(raw) {
  let etMins = -1;
  try {
    const h = new Date().toLocaleString("en-US", { hour: "2-digit", hour12: false, timeZone: "America/New_York" });
    const m = new Date().toLocaleString("en-US", { minute: "2-digit", timeZone: "America/New_York" });
    etMins = parseInt(h, 10) * 60 + parseInt(m, 10);
  } catch { return raw || ""; }
  // 4:00–9:30 ET 為盤前；Yahoo 若回 POST/POSTPOST/CLOSED 是殘影，以 PRE 覆寫
  if (etMins >= 4*60 && etMins < 9*60+30) {
    if (!raw || raw === "POST" || raw === "POSTPOST" || raw === "CLOSED") return "PRE";
    return raw;
  }
  // 9:30–16:00 ET 為盤中；若 Yahoo 仍 POST/CLOSED 以 REGULAR 覆寫
  if (etMins >= 9*60+30 && etMins < 16*60) {
    if (!raw || raw === "POST" || raw === "POSTPOST" || raw === "CLOSED" || raw === "PRE") return "REGULAR";
    return raw;
  }
  // 16:00–20:00 ET 為盤後；若仍 PRE/REGULAR/CLOSED 以 POST 覆寫
  if (etMins >= 16*60 && etMins < 20*60) {
    if (!raw || raw === "PRE" || raw === "REGULAR" || raw === "CLOSED") return "POST";
    return raw;
  }
  return raw || "CLOSED";
}

/** 信心度 0–1：|scoreRaw|/8 標準化，ATR < 0.6% 衰減 */
function calcConfidence(sig, atrPct) {
  if (!sig) return 0;
  const raw = Math.abs(typeof sig.scoreRaw === "number" ? sig.scoreRaw : (sig.score || 0));
  let c = Math.min(1, raw / SIG_SCORE_REF_MAX);
  if (typeof atrPct === "number" && atrPct < 0.6) {
    c *= Math.max(0.4, atrPct / 0.6);
  }
  return Math.max(0, Math.min(1, +c.toFixed(3)));
}

/** 低信心度時把 STRONG 降級為 BUY/SELL，並在標籤後加 † 表示 */
function degradeLowConf(label, cls, conf) {
  if (conf >= SIG_LOW_CONF_TH) return { label, cls };
  if (label === "STRONG BUY")  return { label: "BUY†",  cls: "signal-buy" };
  if (label === "STRONG SELL") return { label: "SELL†", cls: "signal-sell" };
  return { label, cls };
}

/** 多時框共振：dirs 一致才算共振（任一中性不否決，但分歧扣分）。
 *  P2c：加「偏多/偏空」弱共振類別，避免一堆「—」看不出偏向。 */
function calcConfluence(sig1, sig5, sig15) {
  const d  = [signalDir(sig1),  signalDir(sig5),  signalDir(sig15)];
  const dl = [signalLean(sig1), signalLean(sig5), signalLean(sig15)];
  const ups = d.filter(x => x > 0).length;
  const dns = d.filter(x => x < 0).length;
  // C：考慮 lean（偏向）複選。若 strict + lean 同向且無反向，可升級為三共振。
  // 例：MU 4.70/3.80/1.90（THR.scoreBuy=3 時）→ strict ups=2、lean ups=3 → 三共振多
  const lups = dl.filter(x => x > 0).length;
  const ldns = dl.filter(x => x < 0).length;
  let dir = 0, count = 0, label = "—", cls = "confluence-none";
  if (ups >= 2 && dns === 0) {
    dir = 1;
    // 若三個 lean 都是多（含 strict）且無 lean 空，視為三共振
    if (lups === 3 && ldns === 0) { count = 3; label = "三共振多"; cls = "confluence-bull-strong"; }
    else                          { count = ups; label = ups === 3 ? "三共振多" : "雙共振多"; cls = ups === 3 ? "confluence-bull-strong" : "confluence-bull"; }
  } else if (dns >= 2 && ups === 0) {
    dir = -1;
    if (ldns === 3 && lups === 0) { count = 3; label = "三共振空"; cls = "confluence-bear-strong"; }
    else                          { count = dns; label = dns === 3 ? "三共振空" : "雙共振空"; cls = dns === 3 ? "confluence-bear-strong" : "confluence-bear"; }
  } else if (ups > 0 && dns > 0) {
    label = "分歧"; cls = "confluence-mixed";
  } else {
    // 沒有明確共振→看 lean：P1 三同向 lean（0 strict + 3 lean 同向 + 0 反向）→ 三偏多 / 三偏空
    //   介於「偏多 1.5」與「三共振多」之間，處理 THR.scoreBuy 拉高時 MU/STX 全 lean 不到 strict 的情況
    if (lups === 3 && ldns === 0)      { dir = 1;  count = 3;    label = "三偏多";   cls = "confluence-bull"; }
    else if (ldns === 3 && lups === 0) { dir = -1; count = 3;    label = "三偏空";   cls = "confluence-bear"; }
    else if (lups >= 2 && ldns === 0)  { dir = 1;  count = lups; label = "偏多 1.5"; cls = "confluence-bull-weak"; }
    else if (ldns >= 2 && lups === 0)  { dir = -1; count = ldns; label = "偏空 1.5"; cls = "confluence-bear-weak"; }
  }
  const f = (x) => x > 0 ? "多" : x < 0 ? "空" : "中";
  return { dir, count, label, cls, detail: `1m:${f(d[0])} / 5m:${f(d[1])} / 15m:${f(d[2])}` };
}

/** 紀錄一筆有方向的訊號 */
function recordSignal(sym, tf, dir, score, price) {
  if (!__sigHist || !sym || !dir || price == null) return;
  const slot = __sigHist[sym] || (__sigHist[sym] = { entries: [], stats: null });
  slot.entries.push({ t: Date.now(), tf, dir, score: +Number(score).toFixed(2), price: +Number(price).toFixed(4), mat: false });
  if (slot.entries.length > SIG_HIST_MAX_PER_SYM) {
    slot.entries.splice(0, slot.entries.length - SIG_HIST_MAX_PER_SYM);
  }
  __sigHistDirty = true;
}

/** 評估該 symbol 內所有未成熟條目，重算 stats */
function evaluateMatured(sym, currentPrice) {
  if (!__sigHist || !__sigHist[sym] || currentPrice == null) return;
  const slot = __sigHist[sym];
  const now = Date.now();
  let changed = false;
  for (const e of slot.entries) {
    if (e.mat) continue;
    const minMin = SIG_MATURE_MIN[e.tf] || 5;
    if ((now - e.t) / 60000 < minMin) continue;
    const retPct = e.price ? ((currentPrice - e.price) / e.price) * 100 : 0;
    e.retPct = +retPct.toFixed(2);
    e.win = (e.dir > 0 && retPct >= SIG_WIN_THRESHOLD) ||
            (e.dir < 0 && retPct <= -SIG_WIN_THRESHOLD);
    e.mat = true;
    changed = true;
  }
  if (changed) {
    const matured = slot.entries.filter(x => x.mat).slice(-SIG_HIST_STATS_WIN);
    if (matured.length) {
      const wins = matured.filter(x => x.win).length;
      const sumRet = matured.reduce((acc, x) => acc + (x.dir > 0 ? x.retPct : -x.retPct), 0);
      slot.stats = {
        n: matured.length,
        winRate: +(wins / matured.length).toFixed(3),
        avgRet:  +(sumRet / matured.length).toFixed(3),
        updated: now
      };
    }
    __sigHistDirty = true;
  }
}

function getSymbolStats(sym) {
  if (!__sigHist || !__sigHist[sym]) return null;
  return __sigHist[sym].stats || null;
}

/** 反向訊號偵測：上一輪分數→這一輪急速翻轉 */
const __lastSig = new Map();
function detectFlip(sym, score1, score5) {
  const prev = __lastSig.get(sym);
  __lastSig.set(sym, { score1, score5, t: Date.now() });
  if (!prev || (Date.now() - prev.t) > SIG_FLIP_WINDOW_MS) return null;
  const flipped = (a, b) => (a >= 3 && b <= -1) ? "bull2bear" :
                            (a <= -3 && b >= 1) ? "bear2bull" : null;
  const f1 = flipped(prev.score1, score1);
  const f5 = flipped(prev.score5, score5);
  const dir = f1 || f5;
  if (!dir) return null;
  return {
    tf:    f1 && f5 ? "1m+5m" : (f1 ? "1m" : "5m"),
    dir,
    label: dir === "bull2bear" ? "⚠多翻空" : "⚠空翻多",
    cls:   dir === "bull2bear" ? "flip-bull2bear" : "flip-bear2bull",
  };
}

// ─── 大盤 / 同類股相對強度 (RS rating) ───────────────────────────────────────
const BENCH_TTL_MS = 60_000;
const __benchCache = new Map(); // benchSym → { ts, ret5d }
function benchSymFor(sym) {
  if (/\.TW$/i.test(sym)) return "0050.TW";
  if (/\.HK$/i.test(sym)) return "2800.HK";
  return "SPY";
}
async function getBenchmarkRet5d(benchSym) {
  const c = __benchCache.get(benchSym);
  if (c && (Date.now() - c.ts) < BENCH_TTL_MS) return c.ret5d;
  try {
    const d = await fetchChartLite(benchSym, "5m", "5d");
    if (d.bars && d.bars.length >= 2 && d.bars[0].c) {
      const ret = ((d.bars[d.bars.length - 1].c - d.bars[0].c) / d.bars[0].c) * 100;
      __benchCache.set(benchSym, { ts: Date.now(), ret5d: ret });
      return ret;
    }
  } catch { /* noop */ }
  __benchCache.set(benchSym, { ts: Date.now(), ret5d: null });
  return null;
}

function updateSortIndicators() {
  document.querySelectorAll("#wlTable thead th").forEach((th) => {
    const ind = th.querySelector(".sort-ind");
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.k === wlSortKey) {
      th.classList.add(wlSortDesc ? "sort-desc" : "sort-asc");
      if (ind) ind.textContent = wlSortDesc ? "▼" : "▲";
    } else {
      if (ind) ind.textContent = "↕";
    }
  });
}

/** 將目前 wlData（依 wlSortKey/wlSortDesc 排序）輸出 TSV，方便貼給 AI 分析 */
function buildWatchlistTSV() {
  const rows = [...wlData.values()];
  if (!rows.length) return "";
  // 復用 renderWatchlist 同樣的排序邏輯（簡化版）
  const tieKey = wlSortKey === "score1" ? "score5"
              : wlSortKey === "score5" ? "score1" : null;
  const getVal = (row, key) => {
    if (key === "prePct")  return row.pre?.changePct;
    if (key === "postPct") return row.post?.changePct;
    if (key === "confluence") {
      const d = row.confluenceDir; const c = row.confluenceCount;
      return (typeof d === "number" && typeof c === "number") ? d * c : 0;
    }
    return row[key];
  };
  const cmpNum = (av, bv) => {
    av = av == null ? -Infinity : av;
    bv = bv == null ? -Infinity : bv;
    return wlSortDesc ? bv - av : av - bv;
  };
  rows.sort((a, b) => {
    let av = getVal(a, wlSortKey), bv = getVal(b, wlSortKey);
    if (typeof av === "string" || typeof bv === "string") {
      av = (av ?? ""); bv = (bv ?? "");
      return wlSortDesc ? bv.localeCompare(av) : av.localeCompare(bv);
    }
    const c = cmpNum(av, bv);
    if (c !== 0 || !tieKey) return c;
    const tav = a[tieKey] == null ? -Infinity : a[tieKey];
    const tbv = b[tieKey] == null ? -Infinity : b[tieKey];
    return tbv - tav;
  });
  const f2 = (v) => (v == null || !isFinite(v)) ? "" : (+v).toFixed(2);
  const f3 = (v) => (v == null || !isFinite(v)) ? "" : (+v).toFixed(3);
  const pctI = (v) => (v == null || !isFinite(v)) ? "" : Math.round(v * 100) + "%";
  // 時段推斷：Yahoo 有時不回 marketState，取 ET 時間 fallback（加入 PREPRE）。
  const _inferMs = () => {
    try {
      const h = new Date().toLocaleString("en-US", { hour: "2-digit", hour12: false, timeZone: "America/New_York" });
      const m = new Date().toLocaleString("en-US", { minute: "2-digit", timeZone: "America/New_York" });
      const mins = parseInt(h, 10) * 60 + parseInt(m, 10);
      if (mins >= 4*60 && mins < 9*60+30)   return "PRE";
      if (mins >= 9*60+30 && mins < 16*60)  return "REGULAR";
      if (mins >= 16*60 && mins < 20*60)    return "POST";
      return "CLOSED";
    } catch { return ""; }
  };
  const sess = (s) => {
    const ss = s || _inferMs();
    return ss === "PRE" || ss === "PREPRE" ? "盤前"
         : (ss === "POST" || ss === "POSTPOST") ? "盤後"
         : ss === "REGULAR" ? "盤中"
         : ss === "CLOSED" ? "收盤"
         : (ss || "");
  };
  const headers = [
    "代碼", "名稱", "時段", "現價", "52w位階%", "漲跌%", "盤前%", "盤後%",
    "1分訊號", "score1", "5分訊號", "score5", "15分訊號", "score15",
    "+0.3%勝率", "N030", "+0.5%勝率", "N050", "-0.5%賠率", "N050d",
    "wr來源", "wr範圍", "共振", "RS5d%", "🔥hot", "❄cold",
    "5↑盤前%", "5↑盤中%", "5↑盤後%", "5↓盤前%", "5↓盤中%", "5↓盤後%",
    "最近1mΔ%", "RSI5", "MACDh5", "勝率%(歷史)", "歷史N",
  ];
  const out = [headers.join("\t")];
  for (const r of rows) {
    out.push([
      r.sym ?? "",
      (r.name ?? "").replace(/[\t\r\n]/g, " "),
      sess(r.marketState),
      f2(r.price),
      r.pos52w == null ? "" : Math.round(r.pos52w) + "%",
      f2(r.chgPct),
      f2(r.pre?.changePct),
      f2(r.post?.changePct),
      r.label1 ?? "",
      f2(r.score1),
      r.label5 ?? "",
      f2(r.score5),
      r.label15 ?? "",
      f2(r.score15),
      pctI(r.wr030),
      r.wrN030 ?? 0,
      pctI(r.wr050),
      r.wrN050 ?? 0,
      pctI(r.wr050d),
      r.wrN050d ?? 0,
      r.wrSrc ?? "",
      r.wrScope ?? "",
      r.confluenceLabel ?? "",
      f2(r.rs5d),
      f2(r.hotScore),
      f2(r.coldScore),
      f2(r.mom5UpPre),
      f2(r.mom5UpRth),
      f2(r.mom5UpPost),
      f2(r.mom5DnPre),
      f2(r.mom5DnRth),
      f2(r.mom5DnPost),
      f2(r.last1mPct),
      f2(r.rsi5),
      f3(r.hist5),
      r.winRate != null ? Math.round(r.winRate * 100) + "%" : "",
      r.statsN ?? 0,
    ].join("\t"));
  }
  // 第一行附 context（排序鍵 / 更新時間），方便 AI 判讀
  const meta = `# Watchlist snapshot · 排序: ${wlSortKey} ${wlSortDesc ? "↓" : "↑"} · 共 ${rows.length} 檔 · ${new Date().toLocaleString()}`;
  return meta + "\n" + out.join("\n");
}

function renderWatchlist() {
  const tbody = document.querySelector("#wlTable tbody");
  if (!tbody) return;
  // 重繪會清空 tbody，原本 hover 中的元素之 mouseleave 不會觸發 → 主動清掉殘留 tooltip
  if (typeof _hideGlobalSigTip === "function") _hideGlobalSigTip();
  // 編輯區域 anchor：批次新增 / 移除時保留使用者目前的視野位置
  const anchorEl = editorAnchorActive > 0 ? $("catalogEditor") : null;
  const anchorBefore = anchorEl ? anchorEl.getBoundingClientRect().top : null;
  const rows = [...wlData.values()];
  // 主鍵按 wlSortKey；如果是 score1／5，以另一項作為同分時的 tiebreaker
  const tieKey = wlSortKey === "score1" ? "score5"
              : wlSortKey === "score5" ? "score1" : null;
  const cmpNum = (av, bv) => {
    av = av == null ? -Infinity : av;
    bv = bv == null ? -Infinity : bv;
    return wlSortDesc ? bv - av : av - bv;
  };
  const cmp = (a, b) => {
    const getVal = (row, key) => {
      if (key === "prePct")  return row.pre?.changePct;
      if (key === "postPct") return row.post?.changePct;
      if (key === "confluence") {
        // 共振強度：三共振多 +3、雙共振多 +2、中性/分歧 0、雙共振空 -2、三共振空 -3
        const d = row.confluenceDir; const c = row.confluenceCount;
        return (typeof d === "number" && typeof c === "number") ? d * c : 0;
      }
      return row[key];
    };
    let av = getVal(a, wlSortKey), bv = getVal(b, wlSortKey);
    if (typeof av === "string" || typeof bv === "string") {
      av = (av ?? ""); bv = (bv ?? "");
      return wlSortDesc ? bv.localeCompare(av) : av.localeCompare(bv);
    }
    const c = cmpNum(av, bv);
    if (c !== 0 || !tieKey) return c;
    // tiebreaker：另一個分數始終高到低
    const tav = a[tieKey] == null ? -Infinity : a[tieKey];
    const tbv = b[tieKey] == null ? -Infinity : b[tieKey];
    return tbv - tav;
  };
  rows.sort(cmp);
  // 釘選股票永遠在最上方，且依 wlPinned 的順序排列（可在 UI 上拖拉調整）。
  const _pinSet = new Set(wlPinned);
  const _pinned = [];
  for (const s of wlPinned) {
    const r = rows.find(x => x.sym === s);
    if (r) _pinned.push(r);
  }
  const _rest = rows.filter(r => !_pinSet.has(r.sym));
  const _finalRows = _pinned.concat(_rest);
  tbody.innerHTML = "";
  for (const r of _finalRows) {
    const _isPinned = _pinSet.has(r.sym);
    const chgCls = r.chgPct == null ? "flat" : r.chgPct > 0 ? "up" : r.chgPct < 0 ? "down" : "flat";
    const sign = r.chgPct != null && r.chgPct > 0 ? "+" : "";
    const ppCell = (pp) => {
      if (!pp || pp.price == null) return `<td class="num pp">--</td>`;
      const cls = pp.changePct == null ? "flat"
                : pp.changePct > 0 ? "up"
                : pp.changePct < 0 ? "down" : "flat";
      const s = pp.changePct != null && pp.changePct > 0 ? "+" : "";
      const pct = pp.changePct == null ? "" :
        ` <span class="pp-pct ${cls}">${s}${pp.changePct.toFixed(2)}%</span>`;
      return `<td class="num pp">${fmt(pp.price, 2)}${pct}</td>`;
    };
    const tr = document.createElement("tr");
    tr.dataset.sym = r.sym;
    if (_isPinned) {
      tr.classList.add("row-pinned");
      tr.draggable = true;  // 釘選列才能拖拉重排（避免誤拖排序中的列）
    }
    if (typeof r.hotScore === "number" && r.hotScore >= 6) tr.classList.add("row-hot");
    // 盤前 / 盤後 / 收盤 底色區分
    if (r.marketState === "PRE") tr.classList.add("row-pre");
    else if (r.marketState === "POST" || r.marketState === "POSTPOST") tr.classList.add("row-post");
    else if (r.marketState === "CLOSED") tr.classList.add("row-closed");
    // 將 epoch sec 轉成本地時間 HH:MM:SS，給 cell 的 title 屬性使用
    const fmtT = (t) => {
      if (t == null) return "";
      const d = new Date(t * 1000);
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    const titleT = (t) => t == null ? "" : ` title="發生時間 ${fmtT(t)}"`;
    // 單個時段 mom5 欄位：依向上/向下與門檻上色，並加 hover 提示 (時段名 + 發生時間)
    const SESS_LABEL = { pre: "盤前", rth: "盤中", post: "盤後" };
    const mom5Cell = (dir, sess, v, t) => {
      if (v == null) return `<td class="num mom5-cell" title="${SESS_LABEL[sess]} 無資料">--</td>`;
      const cls = dir === "up"
        ? (v >= 0.45 ? "up"   : "")
        : (v <= -0.45 ? "down" : "");
      const sign = v >= 0 ? "+" : "";
      const tip  = `${SESS_LABEL[sess]} 5分動能${dir === "up" ? "最大漲" : "最大跌"}幅 ${sign}${v.toFixed(2)}%${t != null ? ` · ${fmtT(t)}` : ""}`;
      return `<td class="num mom5-cell ${cls}" title="${tip}">${v.toFixed(2)}%</td>`;
    };
    const flipBadge = r.flip ? `<span class="flip-badge ${r.flip.cls}" title="${r.flip.label} (${r.flip.tf})">${r.flip.label}</span> ` : "";
    const confTitle1 = r.conf1 != null ? ` title="信心度 ${(r.conf1*100).toFixed(0)}% (scoreRaw ÷ 8 × ATR衰減)"` : "";
    const confTitle5 = r.conf5 != null ? ` title="信心度 ${(r.conf5*100).toFixed(0)}% (scoreRaw ÷ 8 × ATR衰減)"` : "";
    const lowConfCls1 = (r.conf1 != null && r.conf1 < 0.4 && Math.abs(r.score1 || 0) >= 1) ? " low-conf" : "";
    const lowConfCls5 = (r.conf5 != null && r.conf5 < 0.4 && Math.abs(r.score5 || 0) >= 1) ? " low-conf" : "";
    const confluenceCell = `<td class="confluence-cell"><span class="confluence ${r.confluenceCls || "confluence-none"}" title="${r.confluenceDetail || "尚無 15m 資料"}">${r.confluenceLabel || "—"}</span></td>`;
    // RS rating cell：個股 5d 報酬 − benchmark 5d 報酬（色帶：±10 足強勢/弱勢，±5 中等）
    const _rsClass = r.rs5d == null ? ""
                   : r.rs5d >=  10 ? "rs-strong-up"
                   : r.rs5d >=  5  ? "up"
                   : r.rs5d <= -10 ? "rs-strong-down"
                   : r.rs5d <= -5  ? "down"
                   : r.rs5d >   0  ? "up" : r.rs5d < 0 ? "down" : "flat";
    const rsCell = (r.rs5d != null)
      ? `<td class="num rs ${_rsClass}" title="個股 5d ${r.stockRet5d?.toFixed(2)}% − ${r.benchSym} ${r.benchRet5d?.toFixed(2)}% = ${r.rs5d>=0?"+":""}${r.rs5d}%。正 = 越大盤，負 = 輸大盤&#10;&#10;色帶：≥ +10% 高亮綠、≥ +5% 綠、≤ -10% 高亮紅、≤ -5% 紅">${r.rs5d>=0?"+":""}${r.rs5d.toFixed(2)}%</td>`
      : `<td class="num rs" title="無 benchmark 資料">--</td>`;
    // marketState 徽章（插在名稱前面）
    const ms = r.marketState;
    const msBadge = ms === "PRE" ? `<span class="ms-badge ms-pre" title="盤前交易中（默認低量，訊號雜訊較高）">盤前</span> `
                  : (ms === "POST" || ms === "POSTPOST") ? `<span class="ms-badge ms-post" title="盤後交易中（默認低量，訊號雜訊較高）">盤後</span> `
                  : ms === "CLOSED" ? `<span class="ms-badge ms-closed" title="市場已收盤">收盤</span> `
                  : "";
    const winRateCell = (r.winRate != null && r.statsN > 0)
      ? `<td class="num winrate ${r.winRate >= 0.55 ? "win-good" : r.winRate <= 0.45 ? "win-bad" : ""}" title="近 ${r.statsN} 筆 5m 訊號、win=±0.2% / 15分鐘後">${(r.winRate*100).toFixed(0)}% <span class="winret ${r.avgRet>=0?"up":"down"}">${r.avgRet>=0?"+":""}${r.avgRet.toFixed(2)}%</span></td>`
      : `<td class="num winrate" title="訊號尚未成熟或無方向訊號">--</td>`;
    const _pinBtn = `<span class="pin-btn${_isPinned ? " pinned" : ""}" data-pin="${r.sym}" title="${_isPinned ? "取消釘選" : "釘選到上方"}">📌</span>`;
    tr.innerHTML =
      `<td class="sym">${_pinBtn}${r.sym}</td>` +
      `<td class="name">${msBadge}${r.name}</td>` +
      `<td class="num">${fmt(r.price, 2)}${r.pos52w != null ? `<sup class="pos52w ${r.pos52w >= 80 ? "pos52w-high" : r.pos52w <= 20 ? "pos52w-low" : ""}" title="52 週位階：${r.pos52w.toFixed(1)}%【低 ${r.fwLow?.toFixed(2)} ↔ 高 ${r.fwHigh?.toFixed(2)}】&#10;≥ 80% 接近年高（追高風險）；≤ 20% 接近年低（反彈候選）">${Math.round(r.pos52w)}%</sup>` : ""}</td>` +
      `<td class="num ${chgCls}">${r.chgPct == null ? "--" : sign + r.chgPct.toFixed(2) + "%"}</td>` +
      ppCell(r.pre) +
      ppCell(r.post) +
      `<td class="sig-cell${lowConfCls1}"${confTitle1}>${flipBadge}<span class="sig ${r.cls1}">${r.label1}</span> <span class="sig-score">${fmt(r.score1, 1)}</span></td>` +
      `<td class="sig-cell${lowConfCls5}"${confTitle5}><span class="sig ${r.cls5}">${r.label5}</span> <span class="sig-score">${fmt(r.score5, 1)}</span></td>` +
      `<td class="num wr030 ${r.wr030 != null && r.wr030 >= 0.50 ? "win-good" : r.wr030 != null && r.wr030 <= 0.10 ? "win-bad" : ""}" title="「未來 10 分鐘」內最高漲幅 ≥ +0.3% 的歷史命中率。&#10;&#10;計算來源：${r.wrSrc === "5m" ? "5m K 線 × 3 根 ≈ 15 分鐘（fallback「1m bar 不足」）" : "近 10 根 1m K 線（盤中≈ 10 分鐘、盤前/後可能拉長到 20–30+ 分鐘）"}&#10;取樣範圍：${r.wrScope === "rth" ? "僅盤中 bars（已過濾盤前/後）" : "混合盤前+盤中+盤後（可勾「僅盤中」設定）"}&#10;樣本 N：${r.wrN030 ?? 0} 根${(r.wrN030 ?? 0) < 8 ? " (偏少)" : ""}">${r.wr030 == null ? "--" : Math.round(r.wr030*100) + "%"}${r.wr030 != null && r.wrSrc === "5m" ? "<sup class=\"wr-src\">5m</sup>" : ""}${r.wr030 != null && r.wrScope === "rth" ? "<sup class=\"wr-src wr-rth\">R</sup>" : ""}${r.wr030 != null && (r.wrN030 ?? 0) < 8 ? "<sup class=\"wr-src wr-warn\" title=\"樣本不足 8 根，數值參考性偏低\">⚠</sup>" : ""}</td>` +
      `<td class="num wr050 ${r.wr050 != null && r.wr050 >= 0.30 ? "win-good" : r.wr050 != null && r.wr050 <= 0.05 ? "win-bad" : ""}" title="「未來 10 分鐘」內最高漲幅 ≥ +0.5% 的歷史命中率。&#10;&#10;計算來源：${r.wrSrc === "5m" ? "5m K 線 × 3 根 ≈ 15 分鐘（fallback）" : "近 10 根 1m K 線（盤中≈ 10 分鐘）"}&#10;取樣範圍：${r.wrScope === "rth" ? "僅盤中 bars" : "混合全時段"}&#10;樣本 N：${r.wrN050 ?? 0} 根${(r.wrN050 ?? 0) < 8 ? " (偏少)" : ""}">${r.wr050 == null ? "--" : Math.round(r.wr050*100) + "%"}${r.wr050 != null && r.wrSrc === "5m" ? "<sup class=\"wr-src\">5m</sup>" : ""}${r.wr050 != null && r.wrScope === "rth" ? "<sup class=\"wr-src wr-rth\">R</sup>" : ""}${r.wr050 != null && (r.wrN050 ?? 0) < 8 ? "<sup class=\"wr-src wr-warn\" title=\"樣本不足 8 根，數值參考性偏低\">⚠</sup>" : ""}</td>` +
      `<td class="num wr050d ${r.wr050d != null && r.wr050d >= 0.30 ? "win-bad" : r.wr050d != null && r.wr050d <= 0.05 ? "win-good" : ""}" title="「未來 10 分鐘」內最低跌幅 ≤ -0.5% 的歷史發生率（賠率、越低越住）。&#10;&#10;計算來源：${r.wrSrc === "5m" ? "5m K 線 × 3 根 ≈ 15 分鐘（fallback）" : "近 10 根 1m K 線"}&#10;取樣範圍：${r.wrScope === "rth" ? "僅盤中 bars" : "混合全時段"}&#10;樣本 N：${r.wrN050d ?? 0} 根${(r.wrN050d ?? 0) < 8 ? " (偏少)" : ""}">${r.wr050d == null ? "--" : Math.round(r.wr050d*100) + "%"}${r.wr050d != null && r.wrSrc === "5m" ? "<sup class=\"wr-src\">5m</sup>" : ""}${r.wr050d != null && r.wrScope === "rth" ? "<sup class=\"wr-src wr-rth\">R</sup>" : ""}${r.wr050d != null && (r.wrN050d ?? 0) < 8 ? "<sup class=\"wr-src wr-warn\" title=\"樣本不足 8 根，數值參考性偏低\">⚠</sup>" : ""}</td>` +
      confluenceCell +
      rsCell +
      `<td class="num hot-cell ${r.hotScore == null ? "" : r.hotScore >= 6 ? "hot-strong" : r.hotScore >= 3 ? "hot-watch" : r.hotScore <= -3 ? "hot-cold" : ""}" title="飆股潛力分=score1×1+score5×0.7+5分↑×1.5+5m量爆+1.5−RSI5≥80×2−下跌振幅">${r.hotScore == null ? "--" : (r.hotScore >= 0 ? "+" : "") + r.hotScore.toFixed(1)}</td>` +
      mom5Cell("up",   "pre",  r.mom5UpPre,  r.mom5UpPreT) +
      mom5Cell("up",   "rth",  r.mom5UpRth,  r.mom5UpRthT) +
      mom5Cell("up",   "post", r.mom5UpPost, r.mom5UpPostT) +
      mom5Cell("down", "pre",  r.mom5DnPre,  r.mom5DnPreT) +
      mom5Cell("down", "rth",  r.mom5DnRth,  r.mom5DnRthT) +
      mom5Cell("down", "post", r.mom5DnPost, r.mom5DnPostT) +
      `<td class="num ${r.last1mPct == null ? "" : r.last1mPct > 0 ? "up" : r.last1mPct < 0 ? "down" : ""}"${titleT(r.last1mT)}>${r.last1mPct == null ? "--" : (r.last1mPct >= 0 ? "+" : "") + r.last1mPct.toFixed(2) + "%"}</td>` +
      `<td class="num">${r.rsi5 == null ? "--" : r.rsi5.toFixed(1)}</td>` +
      `<td class="num ${r.hist5 == null ? "" : r.hist5 > 0 ? "up" : "down"}">${fmt(r.hist5, 4)}</td>` +
      winRateCell;
    tbody.appendChild(tr);
    // 滑鼠移到 1分/5分訊號上 → 顯示細項分數浮動 tooltip（與上方卡片一致）
    const sigCells = tr.querySelectorAll(".sig");
    if (sigCells[0]) attachSignalTooltip(sigCells[0], {
      label: `1分 · ${r.label1}`, score: r.score1, cls: r.cls1,
      reasons: r.sig1Reasons || [], scores: r.sig1Scores || []
    });
    if (sigCells[1]) attachSignalTooltip(sigCells[1], {
      label: `5分 · ${r.label5}`, score: r.score5, cls: r.cls5,
      reasons: r.sig5Reasons || [], scores: r.sig5Scores || []
    });
    // 釘選 / 取消釘選
    const pinEl = tr.querySelector(".pin-btn");
    if (pinEl) {
      pinEl.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePin(pinEl.dataset.pin || r.sym);
      });
    }
    // 拖拉重排（僅在釘選列之間有效）
    if (_isPinned) {
      tr.addEventListener("dragstart", (e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/x-pin-sym", r.sym);
        tr.classList.add("dragging");
      });
      tr.addEventListener("dragend", () => {
        tr.classList.remove("dragging");
        tbody.querySelectorAll("tr.drag-over").forEach(el => el.classList.remove("drag-over"));
      });
      tr.addEventListener("dragover", (e) => {
        const src = e.dataTransfer?.types?.includes("text/x-pin-sym");
        if (!src) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        tr.classList.add("drag-over");
      });
      tr.addEventListener("dragleave", () => tr.classList.remove("drag-over"));
      tr.addEventListener("drop", (e) => {
        e.preventDefault();
        tr.classList.remove("drag-over");
        const draggedSym = e.dataTransfer.getData("text/x-pin-sym");
        if (draggedSym && draggedSym !== r.sym) reorderPin(draggedSym, r.sym);
      });
    }
  }
  if (anchorEl && anchorBefore != null) {
    const after = anchorEl.getBoundingClientRect().top;
    const delta = after - anchorBefore;
    if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
  }
}

function reasonTip(r) {
  // 依關鍵字回傳詳細說明（多行以 &#10; 分隔）
  if (/^流動性低\(HOLD\)/.test(r)) return "日均成交金額太低或今日每分鐘成交金額不足&#10;1–5 分鐘超短線下，spread+滑價會吃掉 0.25–0.5% 目標&#10;強制評為 HOLD，不推薦進場";
  if (/^波動不足/.test(r)) return "近 14 根 1 分 K 棒的 ATR < 0.3%&#10;代表現在波動不足，難以在數分鐘內取得 0.25–0.5% 獲利&#10;強制評為 HOLD";
  if (r === "價>VWAP")     return "現價 > VWAP（成交加權平均價）&#10;代表「今日資金平均成本」，超短線多者佔上風&#10;計分：+1";
  if (r === "價<VWAP")     return "現價 < VWAP（成交加權平均價）&#10;超短線買方偏套牢&#10;計分：-1";
  if (/^距VWAP/.test(r))  return "現價偏離 VWAP > 0.5%&#10;偏離過遠，短線反轉風險提高（最後 1–2 棒容易被拉回 VWAP）&#10;計分：不刻意扣分，僅標示警訊";
  if (r === "價>MA20")     return "現價 > 20 根 K 棒收盤均價（1 分線 ≈ 近 20 分鐘）&#10;短線偏多&#10;計分：+1";
  if (r === "價<MA20")     return "現價 < 20 根 K 棒收盤均價&#10;短線偏空&#10;計分：-1";
  if (r === "MACD多頭擴張") return "MACD Histogram > 0，且較上一根更大&#10;多方動能加速中&#10;計分：+0.5（scalping 已降權避免滯後）";
  if (r === "MACD多頭")     return "MACD Histogram > 0，但未進一步擴張&#10;多頭格局但動能未加速&#10;計分：+0.3";
  if (r === "MACD空頭擴張") return "MACD Histogram < 0，且較上一根更負&#10;空方動能加速中&#10;計分：-0.5";
  if (r === "MACD空頭")     return "MACD Histogram < 0，但未進一步擴張&#10;空頭格局但動能未加速&#10;計分：-0.3";
  if (r === "MACD>0軸")    return "MACD（DIF）> 0，且 Histogram > 0&#10;代表多頭位零軸之上&#10;計分：+0.2";
  if (r === "MACD<0軸")    return "MACD（DIF）< 0，且 Histogram < 0&#10;代表空頭位零軸之下&#10;計分：-0.2";
  if (/^RSI\d+超買$/.test(r)) return "RSI ≥ 80&#10;進入超買區，短線拉回風險升高&#10;計分：-0.5（1 分線門檻以 80 為準）";
  if (/^RSI\d+超賣$/.test(r)) return "RSI ≤ 20&#10;進入超賣區，短線反彈機率提高&#10;計分：+0.5";
  if (/^RSI\d+強勢$/.test(r)) return "50 < RSI < 80&#10;多頭區但未超買，動能偏強&#10;計分：+0.3";
  if (/^RSI\d+弱勢$/.test(r)) return "20 < RSI ≤ 50&#10;空頭區但未超賣，動能偏弱&#10;計分：-0.3";
  if (/^量爆/.test(r)) return "最後 1 根 bar 量能 ÷ 過往 9 根均量（倍數見標籤）&#10;scalping 看「最後一根是否爆量」比 5 根均量更重要：&#10;・ 5x：隨原訊號方向 ±2&#10;・ 3x：隨原訊號方向 ±1&#10;・ 2x（以 5 根均）：隨原訊號方向 ±0.5";
  if (/^動能加速多/.test(r)) return "最後 3 根 bar 漲幅 > 0.2%，且最後 1 根仍為正&#10;scalping 最關鍵的進場訊號：動能正在加速&#10;計分：+1.5";
  if (/^動能加速空/.test(r)) return "最後 3 根 bar 跌幅 > 0.2%，且最後 1 根仍為負&#10;動能正在加速下跌&#10;計分：-1.5";
  if (r === "動能轉折")     return "最後 3 根趨勢與最後 1 根方向不一致&#10;可能是轉折初期，訊號可靠度下降&#10;計分：反向 ±0.5";
  if (r === "突破近20高")  return "現價 > 近 20 根 bar 高點，且最後 1 根量能 ≥1.5x&#10;scalping 重要進場點：有量突破&#10;計分：+1";
  if (r === "跌破近20低")  return "現價 < 近 20 根 bar 低點，且最後 1 根量能 ≥1.5x&#10;有量跌破，見空訊號&#10;計分：-1";
  if (r === "假突破(無量)") return "價突破近 20 根高但量能不足（1.5x）&#10;多為假突破，反轉機率高&#10;計分：-0.5";
  if (r === "假跌破(無量)") return "價跌破近 20 根低但量能不足&#10;多為假跌破，反轈機率高&#10;計分：+0.5";
  if (r === "5分同向多")  return "5 分線訊號也為多（1 分 + 5 分同向多）&#10;多個時間框架同向 = 訊號較可靠&#10;計分：+0.5";
  if (r === "5分同向空")  return "5 分線訊號也為空（1 分 + 5 分同向看空）&#10;多個時間框架同向 = 訊號較可靠&#10;計分：-0.5";
  if (r === "5分逆向警訊") return "1 分訊號與 5 分訊號方向不一致&#10;可能是雜訊或轉折初期，訊號可靠度下降&#10;計分：反向調整 ±0.3";
  if (r === "大盤同向多") return "個股上漲且大盤（SPX/IXIC 平均）也上漲&#10;市場趨勢支持該股&#10;計分：+0.3";
  if (r === "大盤同向空") return "個股下跌且大盤也下跌&#10;市場趨勢不利&#10;計分：-0.3";
  if (/^相對強勢/.test(r)) return "個股漲幅 > 1%，但大盤為負&#10;逆大盤拉抬，屬強勢股型態&#10;計分：+0.7";
  if (/^相對弱勢/.test(r)) return "個股跌幅 > 1%，但大盤為正&#10;逆大盤下跌，屬弱勢股型態&#10;計分：-0.7";
  if (/^流動性中/.test(r)) return "日均成交金額中等&#10;spread/滑價仍可能侵蝕微薄利潤&#10;計分：整體得分 ×0.7";
  return "";
}

function colorReason(r) {
  // 正向（紅）：價>、MACD多頭、RSI超賣、RSI強勢、正面新聞
  // 負向（綠）：價<、MACD空頭、RSI超買、RSI弱勢、負面新聞
  // 中立（黃）：量能放大等放大類
  let color = "#ffd54f"; // 黃 - 中立
  if (/價>|MACD多頭|MACD>0軸|超賣|強勢|5分同向多|大盤同向多|動能加速多|突破近20高|假跌破/.test(r)) color = "#ef5350"; // 紅 - 正向
  else if (/價<|MACD空頭|MACD<0軸|超買|弱勢|5分同向空|大盤同向空|相對弱勢|流動性低|流動性中|動能加速空|跌破近20低|假突破|波動不足|距VWAP/.test(r)) color = "#26a69a"; // 綠 - 負向
  const tip = reasonTip(r);
  const titleAttr = tip ? ` title="${tip}"` : "";
  return `<span style="color:${color}"${titleAttr}>${r}</span>`;
}

// 主訊號獨有（表格 1分/5分 miniSignal 不會計入）的計分項目
const MAIN_ONLY_REASON = /^5分同向|^5分逆向|^流動性中|^流動性低/;
function _sigEscape(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function attachSignalTooltip(el, sig) {
  el._sig = sig;
  if (el._sigTipBound) return;
  el._sigTipBound = true;
  // 可訪問性：可 focus、提示為 tooltip
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
  el.setAttribute("role", "button");
  el.setAttribute("aria-haspopup", "true");
  el.style.cursor = "help";
  const show = () => {
    _hideGlobalSigTip();
    const s = el._sig;
    if (!s) return;
    const tip = document.createElement("div");
    tip.className = "sig-tip";
    tip.setAttribute("role", "tooltip");
    const rows = (s.reasons || []).map((r, idx) => {
      // 優先使用 sig.scores[idx]（波段訊號已提供）；其餘則從 reasonTip 文字中抽取「計分：」
      let sc = "";
      if (Array.isArray(s.scores) && typeof s.scores[idx] === "number") {
        const v = s.scores[idx];
        sc = (v >= 0 ? "+" : "") + v.toFixed(1);
      } else {
        const t = reasonTip(r) || "";
        const m = t.match(/計分[：:]\s*([^&]+?)(?:&#10;|$)/);
        sc = m ? m[1].trim() : "";
      }
      const isMainOnly = MAIN_ONLY_REASON.test(r);
      const cls = isMainOnly ? "sig-tip-row sig-tip-main" : "sig-tip-row";
      const tag = isMainOnly ? "  ★主訊號獨有" : "";
      return `<div class="${cls}">・ ${_sigEscape(r)}${sc ? "  →  " + _sigEscape(sc) : ""}${_sigEscape(tag)}</div>`;
    }).join("");
    tip.innerHTML =
      `<div class="sig-tip-h">${_sigEscape(s.label)}　總分：${s.score}</div>` +
      `<div class="sig-tip-sep"></div>` +
      (rows || `<div class="sig-tip-row">(無計分項目)</div>`) +
      `<div class="sig-tip-sep"></div>` +
      `<div class="sig-tip-foot">門檻：±${THR.scoreStrongBuy} STRONG、±${THR.scoreBuy} BUY/SELL、其他 HOLD</div>`;
    document.body.appendChild(tip);
    const r = el.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let top = r.bottom + 6;
    let left = r.left;
    if (top + tr.height > window.innerHeight) top = Math.max(4, r.top - tr.height - 6);
    if (left + tr.width > window.innerWidth) left = Math.max(4, window.innerWidth - tr.width - 8);
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
    _globalSigTip = tip;
    _globalSigTipOwner = el;
  };
  const hide = () => {
    if (_globalSigTipOwner === el) _hideGlobalSigTip();
  };
  el.addEventListener("mouseenter", show);
  el.addEventListener("mouseleave", hide);
  // 鍵盤可達性
  el.addEventListener("focus", show);
  el.addEventListener("blur", hide);
  el.addEventListener("keydown", (e) => { if (e.key === "Escape") _hideGlobalSigTip(); });
  // 觸控：點一下顯示 / 再點隱藏
  el.addEventListener("click", (e) => {
    e.preventDefault();
    if (_globalSigTipOwner === el) _hideGlobalSigTip(); else show();
  });
}

// 全域單例 sig-tip：任何 scroll / resize / 頁面隱藏 / 重繪都會清除，避免殘留
let _globalSigTip = null;
let _globalSigTipOwner = null;
function _hideGlobalSigTip() {
  if (_globalSigTip) { try { _globalSigTip.remove(); } catch {} _globalSigTip = null; }
  _globalSigTipOwner = null;
  // 防呆：清掉任何遺漏的同 class node
  document.querySelectorAll(".sig-tip").forEach(n => { try { n.remove(); } catch {} });
}
if (typeof window !== "undefined" && !window._sigTipGlobalBound) {
  window._sigTipGlobalBound = true;
  // capture=true 才能接到子捲動容器的事件（例如 watchlist tbody）
  window.addEventListener("scroll", _hideGlobalSigTip, true);
  window.addEventListener("wheel", _hideGlobalSigTip, { capture: true, passive: true });
  window.addEventListener("resize", _hideGlobalSigTip);
  document.addEventListener("visibilitychange", () => { if (document.hidden) _hideGlobalSigTip(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") _hideGlobalSigTip(); });
}

function applySignal(card, sig, intra) {
  const sigEl = card.querySelector(".signal");
  sigEl.className = "signal " + sig.cls;
  const topEl = card.querySelector(".signal-top");
  if (topEl) topEl.textContent = `${sig.label} (${sig.score})`;
  else       sigEl.textContent = `${sig.label} (${sig.score})`;
  attachSignalTooltip(sigEl, sig);
  sigEl.style.cursor = "help";
  card.querySelector(".volRatio").textContent = `x${sig.volRatio.toFixed(2)}`;
  const reasonEl = card.querySelector(".reason");
  if (reasonEl) {
    reasonEl.innerHTML = "";
    reasonEl.style.display = "none";
  }
  // ATR 停損 / 停利建議（只在有方向訊號且 ATR 可用時顯示）
  const tpslEl = card.querySelector(".tp-sl");
  if (tpslEl) {
    // D：依 THR.scoreBuy 判方向，避免使用者把門檻拉到 3 以上時 hardcoded 3 永遠不觸發
    const _bt = (typeof THR !== "undefined" && typeof THR.scoreBuy === "number") ? THR.scoreBuy : 3;
    const dir = sig.score >= _bt ? 1 : sig.score <= -_bt ? -1 : 0;
    const atrPct = sig.atrPct;
    const price = intra && intra.price;
    if (dir !== 0 && atrPct != null && atrPct > 0 && price) {
      const slMul = 1.5, tpMul = 2;
      const stop   = dir > 0 ? price * (1 - slMul * atrPct / 100) : price * (1 + slMul * atrPct / 100);
      const target = dir > 0 ? price * (1 + tpMul * atrPct / 100) : price * (1 - tpMul * atrPct / 100);
      const rr = tpMul / slMul;
      const sideTag = dir > 0 ? "多" : "空";
      tpslEl.style.display = "";
      tpslEl.className = "tp-sl " + (dir > 0 ? "tp-sl-long" : "tp-sl-short");
      tpslEl.innerHTML =
        `<span class="tp-sl-tag">${sideTag}單建議</span>` +
        `<span class="tp-sl-stop" title="停損 = 現價 ${dir>0?"−":"+"} 1.5×ATR">SL ${fmt(stop, 2)}</span>` +
        `<span class="tp-sl-take" title="停利 = 現價 ${dir>0?"+":"−"} 2×ATR">TP ${fmt(target, 2)}</span>` +
        `<span class="tp-sl-meta" title="ATR=${atrPct.toFixed(2)}% · 風報比 1:${rr.toFixed(2)}">ATR ${atrPct.toFixed(2)}% · R:R 1:${rr.toFixed(2)}</span>`;
    } else {
      tpslEl.style.display = "none";
      tpslEl.innerHTML = "";
    }
  }
  // 建議操作（訊號 + 流動性 + RSI + 上下支擐）
  const adviceEl = card.querySelector(".advice");
  if (adviceEl) {
    const liq = intra ? computeLiquidity(intra) : null;
    const lv  = intra ? computeLevels(intra) : null;
    const adv = buildAdvice(sig, liq, lv);
    // 當日動能：5 分鐘 / 1 分鐘視窗的最大漲 / 跌幅、最近 1 分鐘漲幅
    const range5 = intra ? maxRangePct(intra.bars, 300) : null;
    const range1 = intra ? maxRangePct(intra.bars, 60)  : null;
    const last1m = intra ? lastBarChangePct(intra.bars) : null;
    // 最後一根 1m bar 落在哪個美東時段（盤前/盤中/盤後/非交易）
    const _lastBarT = intra && intra.bars && intra.bars.length ? intra.bars[intra.bars.length - 1].t : null;
    const _sessNow  = _lastBarT != null ? _etSessionOfTs(_lastBarT) : null;
    const _sessTag  = { pre: "盤前", rth: "盤中", post: "盤後", closed: "非交易時段" }[_sessNow] || null;
    const MIN_MOM = 0.45;
    const fmtPct = (v) => v == null ? "--" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
    const lowMom = range5?.up != null && range5.up < MIN_MOM;
    if (lowMom) adv.cls = "advice-warn";
    adv.stats = [
      { label: "當日 5 分內最大漲跌幅 (盤前+盤中+盤後總和)", up: range5?.up, down: range5?.down, upT: range5?.upT, downT: range5?.downT, bySession: range5?.bySession },
      { label: "當日 1 分內最大漲跌幅 (盤前+盤中+盤後總和)", up: range1?.up, down: range1?.down, upT: range1?.upT, downT: range1?.downT, bySession: range1?.bySession },
      { label: _sessTag ? `近 1 分鐘 (${_sessTag})` : "近 1 分鐘", value: last1m, isRight: true },
    ];
    adv.note = lowMom ? `動能不足 (5 分視窗漲幅 < ${MIN_MOM}%)，不建議入場當沖` : "";
    adv.reasons = sig.reasons || [];
    adviceEl.className = "advice " + adv.cls;
    renderAdviceText(adviceEl.querySelector(".advice-text"), adv);
  }
}

// 波段訊號（15–60 分鐘持有）——以 15 分 K 主導、透過 heavy.bars15 計算
function calcSwingSignal(bars15, price, prevClose, sym) {
  const reasons = [];
  const scores  = [];
  const add = (delta, text) => { reasons.push(text); scores.push(delta); };
  const bars = Array.isArray(bars15) ? bars15 : [];
  const closes = bars.map(b => b.c).filter(c => c != null);
  if (closes.length < 20) {
    return { label: "—", cls: "signal-neutral", score: 0, reasons: ["資料不足"], scores: [null] };
  }
  let score = 0;

  // ∀ ATR(14) on 15m：< 0.4% → HOLD（波段需要足夠振幅才能抵補手續費）
  if (bars.length >= 15) {
    const trs = [];
    for (let i = bars.length - 14; i < bars.length; i++) {
      const b = bars[i], pp = bars[i - 1];
      if (!b || !pp) continue;
      const bh = b.h ?? b.c, bl = b.l ?? b.c;
      trs.push(Math.max(bh - bl, Math.abs(bh - pp.c), Math.abs(bl - pp.c)));
    }
    if (trs.length) {
      const atr = avg(trs);
      const atrPct = price ? (atr / price) * 100 : null;
      if (atrPct != null && atrPct < 0.4) {
        return { label: "HOLD", cls: "signal-hold", score: 0,
          reasons: [`波動不足 ATR ${atrPct.toFixed(2)}%(HOLD)`], scores: [null] };
      }
    }
  }

  // ① MA20（15m × 20 ≈ 5 小時）±1
  const ma20 = avg(closes.slice(-20));
  if (price > ma20) { score += 1; add(+1, "價>MA20(5h)"); }
  else              { score -= 1; add(-1, "價<MA20(5h)"); }

  // ② MA60（15m × 60 ≈ 15 小時）±0.5
  if (closes.length >= 60) {
    const ma60 = avg(closes.slice(-60));
    if (price > ma60) { score += 0.5; add(+0.5, "價>MA60(15h)"); }
    else              { score -= 0.5; add(-0.5, "價<MA60(15h)"); }
  }

  // ③ MACD on 15m（足權，波段適合讓 MACD 充分發揮）
  const m = calcMACD(closes);
  let macdHist = null;
  if (m && m.hist.length >= 2) {
    const i = m.hist.length - 1;
    const h = m.hist[i], hp = m.hist[i - 1];
    macdHist = h;
    if (h > 0 && h > hp)      { score += 1;   add(+1,   "MACD多頭擴張"); }
    else if (h > 0)           { score += 0.5; add(+0.5, "MACD多頭"); }
    else if (h < 0 && h < hp) { score -= 1;   add(-1,   "MACD空頭擴張"); }
    else                      { score -= 0.5; add(-0.5, "MACD空頭"); }
  }

  // ④ RSI（強趨勢過濾）：70+ 在強多頭(價>MA20+MACD>0) 時不扣分，反之 ±1
  const rsi = calcRSI(closes, 14);
  if (rsi && rsi.length) {
    const r = rsi[rsi.length - 1];
    const rn = Math.round(r);
    const trendUp   = (price > ma20) && (macdHist != null && macdHist > 0);
    const trendDown = (price < ma20) && (macdHist != null && macdHist < 0);
    if (r >= 70) {
      if (trendUp)   { score += 0.3; add(+0.3, `RSI${rn}強多延續`); }
      else           { score -= 1;   add(-1,   `RSI${rn}超買`); }
    } else if (r <= 30) {
      if (trendDown) { score -= 0.3; add(-0.3, `RSI${rn}弱空延續`); }
      else           { score += 1;   add(+1,   `RSI${rn}超賣`); }
    } else if (r > 50)  { score += 0.3; add(+0.3, `RSI${rn}強勢`); }
    else                { score -= 0.3; add(-0.3, `RSI${rn}弱勢`); }
  }

  // ⑤ 量爆：最後 1 根 ÷ 過往 19 根均量
  const vols = bars.map(b => b.v).filter(v => v != null);
  let lastVolRatio = 1;
  if (vols.length >= 20) {
    const baseN = avg(vols.slice(-20, -1));
    lastVolRatio = vols[vols.length - 1] / (baseN || 1);
    if (lastVolRatio >= 3) {
      const dir = score > 0 ? 1 : score < 0 ? -1 : 0;
      if (dir !== 0) { score += dir * 1; add(dir * 1, `量爆${lastVolRatio.toFixed(1)}x`); }
    }
  }

  // ⑥ 動能（最近 6 根 = 90 分）
  if (bars.length >= 7) {
    const c0 = bars[bars.length - 1].c;
    const c6 = bars[bars.length - 7].c;
    const m6 = c6 ? ((c0 - c6) / c6) * 100 : 0;
    if (m6 > 1.0)       { score += 1.5; add(+1.5, `動能加速多 ${m6.toFixed(1)}%`); }
    else if (m6 < -1.0) { score -= 1.5; add(-1.5, `動能加速空 ${m6.toFixed(1)}%`); }
    else if (m6 > 0.5)  { score += 0.5; add(+0.5, `動能偏多 ${m6.toFixed(1)}%`); }
    else if (m6 < -0.5) { score -= 0.5; add(-0.5, `動能偏空 ${m6.toFixed(1)}%`); }
  }

  // ⑦ 突破近 20 根（≈5 小時）高低
  const highs = bars.map(b => b.h).filter(v => v != null);
  const lows  = bars.map(b => b.l).filter(v => v != null);
  if (highs.length >= 21 && lows.length >= 21) {
    const recentHigh = Math.max(...highs.slice(-21, -1));
    const recentLow  = Math.min(...lows.slice(-21, -1));
    const burst = lastVolRatio >= 1.5;
    if (price > recentHigh) {
      if (burst) { score += 1;   add(+1,   "突破近5h高"); }
      else       { score -= 0.5; add(-0.5, "假突破(無量)"); }
    } else if (price < recentLow) {
      if (burst) { score -= 1;   add(-1,   "跌破近5h低"); }
      else       { score += 0.5; add(+0.5, "假跌破(無量)"); }
    }
  }

  // ⑧ 大盤同向 / 相對強弱
  const mktPct = marketAvgPct();
  const stockPct = (prevClose && price) ? ((price - prevClose) / prevClose) * 100 : null;
  if (mktPct != null && stockPct != null && Math.abs(mktPct) >= 0.1) {
    if (stockPct > 0 && mktPct > 0) { score += 0.3; add(+0.3, "大盤同向多"); }
    else if (stockPct < 0 && mktPct < 0) { score -= 0.3; add(-0.3, "大盤同向空"); }
    if (stockPct > 1 && mktPct < 0) { score += 0.7; add(+0.7, `相對強勢(大盤${mktPct.toFixed(2)}%)`); }
    else if (stockPct < -1 && mktPct > 0) { score -= 0.7; add(-0.7, `相對弱勢(大盤+${mktPct.toFixed(2)}%)`); }
  }

  // 門檻：±STRONG BUY/SELL 、±BUY/SELL（由 THR 控制）
  let label, cls;
  ({ label, cls } = _labelByScore(score));
  return { label, cls, score: +score.toFixed(1), scoreRaw: score, reasons, scores };
}

function applySwingSignal(card, sig) {
  const el = card.querySelector(".signal-swing");
  if (!el) return;
  el.className = "signal-swing " + sig.cls;
  el.textContent = sig.label === "—" ? "— 資料不足" : `${sig.label} (${sig.score})`;
  attachSignalTooltip(el, { ...sig, label: `波段 15–60m：${sig.label}` });
  el.style.cursor = "help";
}

// 計算 bars 中、任一 windowSec 秒視窗內的最大漲幅與最大跌幅 (%)
// 同時回傳發生時間（取視窗結尾那根 bar 的 timestamp，秒）
function maxRangePct(bars, windowSec) {
  if (!bars || bars.length < 2) return null;
  // 依美東時段分組：pre = 04:00–09:30、rth = 09:30–16:00、post = 16:00–20:00、closed = 其他
  const emptySess = () => ({ up: -Infinity, down: Infinity, upT: null, downT: null });
  const sessions = { pre: emptySess(), rth: emptySess(), post: emptySess(), closed: emptySess() };
  // 預先求每根 bar 的時段，避免在雙重迴圈內重複 Intl 計算
  const sessOf = new Array(bars.length);
  for (let k = 0; k < bars.length; k++) sessOf[k] = _etSessionOfTs(bars[k].t);
  let up = -Infinity, down = Infinity, upT = null, downT = null;
  for (let i = 0; i < bars.length; i++) {
    const tEnd = bars[i].t + windowSec;
    const base = bars[i].c;
    if (base == null) continue;
    for (let j = i + 1; j < bars.length && bars[j].t <= tEnd; j++) {
      const c = bars[j].c;
      if (c == null) continue;
      const pct = ((c - base) / base) * 100;
      if (pct > up)   { up   = pct; upT   = bars[j].t; }
      if (pct < down) { down = pct; downT = bars[j].t; }
      const s = sessions[sessOf[j]];
      if (pct > s.up)   { s.up   = pct; s.upT   = bars[j].t; }
      if (pct < s.down) { s.down = pct; s.downT = bars[j].t; }
    }
  }
  const norm = s => ({
    up:   isFinite(s.up)   ? s.up   : null,
    down: isFinite(s.down) ? s.down : null,
    upT: s.upT, downT: s.downT,
  });
  return {
    up:    isFinite(up)   ? up   : null,
    down:  isFinite(down) ? down : null,
    upT, downT,
    bySession: { pre: norm(sessions.pre), rth: norm(sessions.rth), post: norm(sessions.post), closed: norm(sessions.closed) },
  };
}

// 模組層快取：Intl 格式器建立成本高，並提供以「分鐘」為鍵的譯型 LRU
const _ET_PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});
const _etSessionCache = new Map(); // key: floor(tsSec/60)、val: 'pre'|'rth'|'post'|'closed'
// 將 bar.t (epoch sec) 映射到美東交易時段：pre（盤前 04:00–09:30）、rth（盤中 09:30–16:00）、post（盤後 16:00–20:00）、closed（其他時段或週末）
function _etSessionOfTs(tsSec) {
  if (tsSec == null) return 'closed';
  const key = Math.floor(tsSec / 60);
  const hit = _etSessionCache.get(key);
  if (hit !== undefined) return hit;
  let result = 'closed';
  try {
    const parts = _ET_PARTS_FMT.formatToParts(new Date(tsSec * 1000));
    const wd = parts.find(p => p.type === 'weekday')?.value;
    const hh = +parts.find(p => p.type === 'hour')?.value;
    const mm = +parts.find(p => p.type === 'minute')?.value;
    if (wd !== 'Sat' && wd !== 'Sun') {
      const m = hh * 60 + mm;
      if (m >= 9 * 60 + 30 && m < 16 * 60)        result = 'rth';
      else if (m >= 4 * 60 && m <  9 * 60 + 30)    result = 'pre';
      else if (m >= 16 * 60 && m < 20 * 60)        result = 'post';
    }
  } catch (_) { /* keep 'closed' */ }
  // 限制快取大小（避免長期運行記憶體際限增長）
  if (_etSessionCache.size > 5000) _etSessionCache.clear();
  _etSessionCache.set(key, result);
  return result;
}

// 最近一根 bar 收盤相對前一根收盤的變動 %
function lastBarChangePct(bars) {
  if (!bars || bars.length < 2) return null;
  const a = bars[bars.length - 2]?.c;
  const b = bars[bars.length - 1]?.c;
  if (a == null || b == null || !a) return null;
  return ((b - a) / a) * 100;
}

// 計算近 60 根 bars 中、任一 windowSec 秒視窗內的最大漲幅 (%)
function maxUpsidePct(bars, windowSec) {
  if (!bars || bars.length < 2) return null;
  const recent = bars.slice(-60);
  let maxPct = -Infinity;
  for (let i = 0; i < recent.length; i++) {
    const tEnd = recent[i].t + windowSec;
    const base = recent[i].c;
    if (base == null) continue;
    for (let j = i + 1; j < recent.length && recent[j].t <= tEnd; j++) {
      const c = recent[j].c;
      if (c == null) continue;
      const pct = ((c - base) / base) * 100;
      if (pct > maxPct) maxPct = pct;
    }
  }
  return isFinite(maxPct) ? maxPct : null;
}

// 將結構化的 advice 渲染為：動作文字 + 停損 / 目標 chip
function renderAdviceText(host, adv) {
  if (!host) return;
  host.innerHTML = "";
  const actLine = document.createElement("div");
  actLine.className = "advice-action";
  actLine.textContent = adv.action;
  host.appendChild(actLine);
  if (adv.reasons && adv.reasons.length) {
    const rWrap = document.createElement("div");
    rWrap.className = "advice-reasons";
    rWrap.innerHTML = adv.reasons.map(colorReason).join("");
    host.appendChild(rWrap);
  }
  if (adv.stop || adv.target) {
    const row = document.createElement("div");
    row.className = "advice-row";
    if (adv.stop) {
      row.appendChild(makeChip("停損", adv.stop, "chip-stop"));
    }
    if (adv.target) {
      row.appendChild(makeChip("目標", adv.target, "chip-target"));
    }
    if (adv.target2) {
      row.appendChild(makeChip("次目標", adv.target2, "chip-target chip-target2"));
    }
    host.appendChild(row);
  }
  if (adv.stats && adv.stats.length) {
    const fmtPct = (v) => v == null ? "--" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
    const clsOf = (v) => v == null ? "" : v > 0 ? " up" : v < 0 ? " down" : "";
    const fmtTime = (t) => {
      if (t == null) return "";
      const d = new Date(t * 1000);
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    const titleAttr = (t) => t == null ? "" : ` title="發生時間 ${fmtTime(t)}"`;
    const stats = document.createElement("div");
    stats.className = "advice-stats";
    for (const s of adv.stats) {
      const chip = document.createElement("span");
      chip.className = "stat-chip";
      if (s.isRight) chip.classList.add("stat-right");
      if (s.up !== undefined || s.down !== undefined) {
        // 如果有 bySession，組裝多行 tooltip：讓使用者可看出「目前總值來自哪個時段」
        const _sLabel = { pre: "盤前", rth: "盤中", post: "盤後", closed: "非交易時段" };
        let _sessTip = "";
        if (s.bySession) {
          const _line = (k) => {
            const seg = s.bySession[k] || {};
            if (seg.up == null && seg.down == null) return null;
            return `${_sLabel[k]}：↑ ${fmtPct(seg.up)}${seg.upT?` @ ${fmtTime(seg.upT)}`:""}\u3000↓ ${fmtPct(seg.down)}${seg.downT?` @ ${fmtTime(seg.downT)}`:""}`;
          };
          const arr = ["pre","rth","post","closed"].map(_line).filter(Boolean);
          if (arr.length) _sessTip = `\n── 依美東時段拆解 ──\n${arr.join("\n")}`;
        }
        const _chipTitle = `「±${(s.label.includes("5 分"))?"5":"1"} 分鐘」滑動視窗內，今日所有 1m K 棒中最大漲幅與最大跌幅。\n計算含盤前 (04:00–09:30 ET)、盤中 (09:30–16:00 ET) 、盤後 (16:00–20:00 ET)。${_sessTip}`;
        chip.setAttribute("title", _chipTitle);
        chip.innerHTML = `<span class="stat-label">${s.label}</span>` +
                         `<span class="stat-up${clsOf(s.up)}"${titleAttr(s.upT)}>↑ ${fmtPct(s.up)}</span>` +
                         `<span class="stat-down${clsOf(s.down)}"${titleAttr(s.downT)}>↓ ${fmtPct(s.down)}</span>`;
      } else {
        chip.innerHTML = `<span class="stat-label">${s.label}</span>` +
                         `<span class="stat-val${clsOf(s.value)}"><span class="delta-sym">Δ:</span> ${fmtPct(s.value)}</span>`;
        if (s.value != null) {
          const tone = Math.min(1, Math.abs(s.value) / 1.0);
          const ramp = s.value >= 0
            ? ["#ffcdd2","#ef9a9a","#ef5350","#e53935","#b71c1c"]
            : ["#b2dfdb","#80cbc4","#26a69a","#00897b","#004d40"];
          const idx = Math.min(ramp.length - 1, Math.floor(tone * ramp.length));
          const valEl = chip.querySelector(".stat-val");
          if (valEl) valEl.style.color = ramp[idx];
        }
      }
      stats.appendChild(chip);
    }
    host.appendChild(stats);
  }
  if (adv.note) {
    const note = document.createElement("div");
    note.className = "advice-note";
    note.textContent = adv.note;
    host.appendChild(note);
  }
}
function makeChip(label, value, cls) {
  const el = document.createElement("span");
  el.className = "advice-chip " + cls;
  // value 格式："117.71 (+0.86%)"，拆出主体 + 百分比
  const m = /^(.+?)\s*\((.+?)\)\s*$/.exec(value);
  if (m) {
    el.innerHTML = `<span class="chip-label">${label}</span>` +
                   `<span class="chip-val">${m[1].trim()}</span>` +
                   `<span class="chip-pct">${m[2].trim()}</span>`;
  } else {
    el.innerHTML = `<span class="chip-label">${label}</span><span class="chip-val">${value}</span>`;
  }
  return el;
}

// 從 bars / snap 推算近期上下支擐點（取適合作為停損 / 目標的真實價位）
function computeLevels(intra) {
  if (!intra) return null;
  const price = intra.price;
  if (price == null) return null;
  const bars = intra.bars || [];
  // 取近 30 / 60 根 K 線的高低点作為近期 swing
  const recent30 = bars.slice(-30);
  const recent60 = bars.slice(-60);
  const hi30 = recent30.map(b => b.h).filter(v => v != null);
  const lo30 = recent30.map(b => b.l).filter(v => v != null);
  const hi60 = recent60.map(b => b.h).filter(v => v != null);
  const lo60 = recent60.map(b => b.l).filter(v => v != null);
  const recHigh30 = hi30.length ? Math.max(...hi30) : null;
  const recLow30  = lo30.length ? Math.min(...lo30) : null;
  const recHigh60 = hi60.length ? Math.max(...hi60) : null;
  const recLow60  = lo60.length ? Math.min(...lo60) : null;
  // 支擐候選：所有 < price 的候選中取最大（最貼近價）
  const supCands = [intra.todayLow, recLow30, intra.prevLow, intra.prevClose]
    .filter(v => v != null && v < price);
  const resCands = [intra.todayHigh, recHigh30, intra.prevHigh]
    .filter(v => v != null && v > price);
  const support    = supCands.length ? Math.max(...supCands) : null;
  const resistance = resCands.length ? Math.min(...resCands) : null;
  // 次層：較遠的支擐 / 阻力（作為 trailing 目標）
  const sup2Cands = [recLow60, intra.prevLow, intra.prevClose]
    .filter(v => v != null && v < (support ?? price) - 1e-6);
  const res2Cands = [recHigh60, intra.prevHigh]
    .filter(v => v != null && v > (resistance ?? price) + 1e-6);
  return {
    price,
    support, resistance,
    support2:    sup2Cands.length ? Math.max(...sup2Cands) : null,
    resistance2: res2Cands.length ? Math.min(...res2Cands) : null,
  };
}

// 格式化價位："123.45 (−0.82%)"
function fmtLv(price, level) {
  if (level == null || price == null) return null;
  const pct  = ((level - price) / price) * 100;
  const sign = pct >= 0 ? "+" : "−";
  return `${level.toFixed(2)} (${sign}${Math.abs(pct).toFixed(2)}%)`;
}

// 依訊號、流動性、RSI、上下支擐組出建議操作（結構化）
function buildAdvice(sig, liq, lv) {
  const tier = liq?.tier; // high / mid / low
  if (tier === "low") {
    return { cls: "advice-warn", action: "量能不足 · 不建議短線當沖", note: "進出場滑價風險高" };
  }
  const r = sig.rsi;
  const overbought = r != null && r >= 75;
  const oversold   = r != null && r <= 25;
  const px   = lv?.price;
  const sup  = fmtLv(px, lv?.support);
  const res  = fmtLv(px, lv?.resistance);
  const sup2 = fmtLv(px, lv?.support2);
  const res2 = fmtLv(px, lv?.resistance2);
  switch (sig.label) {
    case "STRONG BUY":
      if (overbought) return { cls: "advice-buy",       action: "動能強但 RSI 偏高 · 追入守紧", stop: sup, target: res, note: "拉回不破再加碼" };
      return                   { cls: "advice-strongbuy", action: "多方齊發 · 可分批進場", stop: sup, target: res, target2: res2, note: "突破順勢往上推停損" };
    case "BUY":
      if (overbought) return { cls: "advice-hold",     action: "偏多但 RSI 偏高 · 試單謹慎", stop: sup, target: res, note: "拉回躏上小部位加碼" };
      return                 { cls: "advice-buy",      action: "偏多操作 · 現貨偏多", stop: sup, target: res, target2: res2, note: "突破近期高點再加碼" };
    case "HOLD":
      if (oversold)   return { cls: "advice-watch",    action: "中性但 RSI 偏低 · 試單多", stop: sup, target: res, note: "身段宜輕" };
      if (overbought) return { cls: "advice-watch",    action: "反彈動能趨緩 · 可兒現 (1/3~1/2)", target: res, stop: sup, note: "等回測重新評估" };
      return                 { cls: "advice-watch",    action: "訊號中性 · 觀望為主", stop: sup, target: res, note: "等突破 / 跌破再進場" };
    case "SELL":
      if (oversold)   return { cls: "advice-hold",     action: "偏空但 RSI 偏低 · 試空謹慎", stop: res, target: sup, note: "反彈不過再加碼" };
      return                 { cls: "advice-sell",     action: "偏空操作 · 現貨減碼 / 反彈試空", stop: res, target: sup, target2: sup2 };
    case "STRONG SELL":
      if (oversold)   return { cls: "advice-sell",     action: "偏空但超賣 · 避免追空", note: "等反彈到阻力再試空", stop: res };
      return                 { cls: "advice-strongsell", action: "空方齊發 · 現貨避開 / 試空", stop: res, target: sup, target2: sup2, note: "跌破順勢往下推停損" };
    default:
      return { cls: "advice-hold", action: "資訊不足 · 等待訊號" };
  }
}

// ─── 支撐 / 阻力 標籤 hover 浮動視窗 ─────────────────────────────
const LV_DESC = {
  res: {
    name: "近壓 R1（最貼近現價的上方阻力）",
    formula: "min{ 今日高、近 30 根 K 高、昨日高 } 中 > 現價 的最小值",
    use: "短線多單第一目標 / 空單停損參考；若帶量突破往往續強。"
  },
  res2: {
    name: "次壓 R2（更上一層阻力 / trailing 目標）",
    formula: "max{ 近 60 根 K 高、昨日高 } 中 > R1 的最小值",
    use: "突破 R1 後的次目標；可作為移動停利推升的下一個關卡。"
  },
  sup: {
    name: "近撐 S1（最貼近現價的下方支撐）",
    formula: "max{ 今日低、近 30 根 K 低、昨日低、昨收 } 中 < 現價 的最大值",
    use: "短線多單停損 / 空單第一目標；跌破往往加速下殺。"
  },
  sup2: {
    name: "次撐 S2（更下一層支撐 / trailing 目標）",
    formula: "max{ 近 60 根 K 低、昨日低、昨收 } 中 < S1 的最大值",
    use: "跌破 S1 後的下檔目標；可作為空單移動停利的下一關卡。"
  },
};

function ensureLvTip() {
  let tip = document.getElementById("lvTip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "lvTip";
    tip.className = "lv-tip";
    tip.style.display = "none";
    document.body.appendChild(tip);
  }
  return tip;
}

function showLvTip(box, ev) {
  const tip = ensureLvTip();
  const d = LV_DESC[box.level.cls] || {};
  const v = box.level.v;
  const ref = box.refPrice;
  const distPct = (ref != null && v != null) ? ((v - ref) / ref * 100) : null;
  const distAbs = (ref != null && v != null) ? (v - ref) : null;
  const distCls = distPct == null ? "" : (distPct > 0 ? "up" : distPct < 0 ? "down" : "flat");
  const sign = distPct == null ? "" : (distPct > 0 ? "+" : "");
  const distHtml = distPct != null
    ? `<div class="lv-tip-row">距現價：<b class="${distCls}">${sign}${distAbs.toFixed(2)} (${sign}${distPct.toFixed(2)}%)</b></div>`
    : "";
  const colorMap = { sup: "#26a69a", sup2: "#80cbc4", res: "#ef5350", res2: "#ffab91" };
  const c = colorMap[box.level.cls] || "#dfe3e8";
  tip.innerHTML =
    `<div class="lv-tip-h" style="color:${c}">${box.level.label}：${v.toFixed(2)}</div>` +
    `<div class="lv-tip-name">${d.name || ""}</div>` +
    distHtml +
    `<div class="lv-tip-sep"></div>` +
    `<div class="lv-tip-row"><span class="lv-tip-lbl">計算：</span>${d.formula || ""}</div>` +
    `<div class="lv-tip-row"><span class="lv-tip-lbl">用途：</span>${d.use || ""}</div>`;
  tip.style.display = "block";
  // 定位（避免超出視窗）
  const pad = 12;
  let x = ev.clientX + 14;
  let y = ev.clientY + 14;
  const rect = tip.getBoundingClientRect();
  if (x + rect.width + pad > window.innerWidth)  x = ev.clientX - rect.width - 14;
  if (y + rect.height + pad > window.innerHeight) y = ev.clientY - rect.height - 14;
  tip.style.left = Math.max(pad, x) + "px";
  tip.style.top  = Math.max(pad, y) + "px";
}
function hideLvTip() {
  const tip = document.getElementById("lvTip");
  if (tip) tip.style.display = "none";
}

function bindLevelHover(canvas) {
  if (canvas.dataset.lvHoverBound) return;
  canvas.dataset.lvHoverBound = "1";
  canvas.addEventListener("mousemove", (e) => {
    const boxes = canvas._lvBoxes || [];
    if (!boxes.length) { hideLvTip(); canvas.style.cursor = ""; return; }
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width  / r.width;
    const sy = canvas.height / r.height;
    const px = (e.clientX - r.left) * sx;
    const py = (e.clientY - r.top)  * sy;
    const hit = boxes.find(b => px >= b.bx && px <= b.bx + b.boxW && py >= b.by && py <= b.by + b.boxH);
    if (hit) {
      canvas.style.cursor = "help";
      showLvTip(hit, e);
    } else {
      canvas.style.cursor = "";
      hideLvTip();
    }
  });
  canvas.addEventListener("mouseleave", () => { hideLvTip(); canvas.style.cursor = ""; });
}

function winRatePct(bars, target, K = 10, WIN = 20) {
  if (!bars || bars.length < 2) return null;
  const tail = [];
  const start = Math.max(0, bars.length - WIN - K);
  for (let i = start; i + K < bars.length; i++) {
    const entry = bars[i].c;
    if (!entry) continue;
    let m = -Infinity;
    for (let j = i + 1; j <= i + K; j++) {
      const h = bars[j].h ?? bars[j].c;
      if (h != null) m = Math.max(m, (h - entry) / entry);
    }
    if (isFinite(m)) tail.push(m);
  }
  if (!tail.length) return null;
  return tail.filter(v => v >= target).length / tail.length;
}

function winRateDownPct(bars, target, K = 10, WIN = 20) {
  if (!bars || bars.length < 2) return null;
  const tail = [];
  const start = Math.max(0, bars.length - WIN - K);
  for (let i = start; i + K < bars.length; i++) {
    const entry = bars[i].c;
    if (!entry) continue;
    let m = Infinity;
    for (let j = i + 1; j <= i + K; j++) {
      const l = bars[j].l ?? bars[j].c;
      if (l != null) m = Math.min(m, (l - entry) / entry);
    }
    if (isFinite(m)) tail.push(m);
  }
  if (!tail.length) return null;
  return tail.filter(v => v <= -target).length / tail.length;
}

function drawWinRate(card, bars) {
  // C：與下方 watchlist 表格統一參數
  //   ‧ 目標前瞻時間視窗：10 分鐘
  //   ‧ K = round(10 / intervalMin)；intervalMin 依 UI timeframe 決定（1m→K=10、5m→K=2、15m→K=1）
  //   ‧ WIN = 20 entries
  //   ‧ simCfg.wrRthOnly=on 時只取 09:30–16:00 ET 的 bars（與表格一致）
  const _tf = (typeof timeframe === "string") ? timeframe : "1m";
  const _ivMin = (() => {
    const m = /^(\d+)m$/.exec(_tf);
    return m ? parseInt(m[1], 10) : 1;
  })();
  const FWD_MIN = 10;
  const K = Math.max(1, Math.round(FWD_MIN / _ivMin));
  const WIN = 20;
  const rthOnly = !!(typeof simCfg !== "undefined" && simCfg && simCfg.wrRthOnly);
  const useBars = (rthOnly && Array.isArray(bars))
    ? bars.filter(b => b && b.t && (typeof _usSessionOfTs === "function") && _usSessionOfTs(b.t * 1000) === "rth")
    : (bars || []);
  // 實際取樣 N（給 tooltip 顯示樣本可信度）
  const N = Math.max(0, Math.min(WIN, useBars.length - K));
  const fwdMin = K * _ivMin;
  const scopeTxt = rthOnly ? "僅 RTH (09:30–16:00 ET)" : "含盤前+盤中+盤後";
  const tipBase = `卡片勝率（已與下方表格一致）：\n` +
                  `‧ bar 間隔：${_ivMin}m（依 UI 時間框架）\n` +
                  `‧ 前瞻視窗：K=${K} 根 ≈ ${fwdMin} 分鐘\n` +
                  `‧ 取樣窗：最近 ${WIN} 個進場點（實際 N=${N}）\n` +
                  `‧ 時段範圍：${scopeTxt}\n` +
                  `‧ 計算：從每個進場點往後 K 根 K 棒，取最高(漲)/最低(跌)，計算超過目標%的比例`;
  // 黑膊囊配色：紅 / 紅 / 綠，越高越濃、越低越淡
  const RED  = ["#ffebee","#ffcdd2","#ef9a9a","#ef5350","#ff5252"];
  const GRN  = ["#e0f2f1","#b2dfdb","#80cbc4","#4db6ac","#26c6a0"];
  const tint = (ramp, pct) => {
    const i = Math.min(ramp.length - 1, Math.max(0, Math.floor(pct * ramp.length)));
    return ramp[i];
  };
  const setPct = (sel, pct, ramp, targetLabel) => {
    const el = card.querySelector(sel);
    if (!el) return;
    const tip = `${targetLabel}\n\n${tipBase}`;
    if (pct == null) { el.textContent = "--"; el.classList.add("wr-dim"); el.style.color = ""; el.setAttribute("title", tip); return; }
    el.textContent = `${Math.round(pct * 100)}%`;
    el.classList.toggle("wr-dim", pct < 0.05);
    el.style.color = tint(ramp, pct);
    el.setAttribute("title", tip);
  };
  setPct(".wr-v-030",  winRatePct(useBars, 0.003, K, WIN),     RED, `+0.3% 勝率：${fwdMin} 分鐘內漲幅 ≥ 0.3% 的歷史比例`);
  setPct(".wr-v-050",  winRatePct(useBars, 0.005, K, WIN),     RED, `+0.5% 勝率：${fwdMin} 分鐘內漲幅 ≥ 0.5% 的歷史比例`);
  setPct(".wr-v-050d", winRateDownPct(useBars, 0.005, K, WIN), GRN, `-0.5% 賠率：${fwdMin} 分鐘內跌幅 ≥ 0.5% 的歷史比例`);
  // 在 % 下方列出對應的目標股價（優先以卡片上的即時報價為基準，否則退回 bars 最後收盤）
  const priceEl = card.querySelector(".price");
  const livePx = parseFloat((priceEl?.textContent || "").replace(/[^0-9.\-]/g, ""));
  const ref = (isFinite(livePx) && livePx > 0)
    ? livePx
    : (bars && bars.length ? bars[bars.length - 1].c : null);
  const setPx = (sel, mult) => {
    const el = card.querySelector(sel);
    if (!el) return;
    if (!isFinite(ref) || ref <= 0) { el.textContent = "--"; return; }
    const px = ref * mult;
    el.textContent = px >= 1 ? px.toFixed(2) : px.toFixed(4);
  };
  setPx(".wr-px-030",  1.003);
  setPx(".wr-px-050",  1.005);
  setPx(".wr-px-050d", 0.995);
}

function drawSpark(canvas, bars, refClose, levels) {
  if (!canvas || !bars.length) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const AXIS_H = 14;            // 底部保留給時間刻度
  const AXIS_W = 44;            // 右側保留給價格刻度
  const PW = W - AXIS_W;        // 畫圖區寬度
  const PH = H - AXIS_H;        // 畫圖區高度
  ctx.clearRect(0, 0, W, H);
  const closes = bars.map(b => b.c);
  let max = Math.max(...closes), min = Math.min(...closes);
  // 將支擐 / 阻力納入 y 軌範圍（限制在±10%內避免被楫到出去）
  const lvList = [];
  if (levels) {
    const ref = levels.price ?? closes[closes.length - 1];
    const inBand = v => v != null && Math.abs((v - ref) / ref) <= 0.10;
    if (inBand(levels.support))     lvList.push({ v: levels.support,     label: "支",  cls: "sup"  });
    if (inBand(levels.support2))    lvList.push({ v: levels.support2,    label: "支2", cls: "sup2" });
    if (inBand(levels.resistance))  lvList.push({ v: levels.resistance,  label: "阻",  cls: "res"  });
    if (inBand(levels.resistance2)) lvList.push({ v: levels.resistance2, label: "阻2", cls: "res2" });
    for (const l of lvList) {
      if (l.v > max) max = l.v;
      if (l.v < min) min = l.v;
    }
  }
  const range = max - min || 1;
  const dx = PW / (closes.length - 1 || 1);
  const y = v => PH - ((v - min) / range) * (PH - 4) - 2;

  // 色調：以「昨收」為基準。若未提供 refClose，退回舊連窯內首尾比較
  const last = closes[closes.length - 1];
  const base = (refClose != null) ? refClose : closes[0];
  const up = last >= base;
  const color = up ? "#ef5350" : "#26a69a";
  const grad = ctx.createLinearGradient(0, 0, 0, PH);
  grad.addColorStop(0, color + "55");
  grad.addColorStop(1, color + "00");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, PH);
  closes.forEach((v, i) => ctx.lineTo(i * dx, y(v)));
  ctx.lineTo(PW, PH);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  closes.forEach((v, i) => {
    const x = i * dx, yy = y(v);
    if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
  });
  ctx.stroke();

  // 畫出支擐 / 阻力水平線
  canvas._lvBoxes = [];
  if (lvList.length) {
    const colorMap = {
      sup:  "#26a69a", sup2: "#26a69a99",
      res:  "#ef5350", res2: "#ef535099",
    };
    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = "bold 13px system-ui, -apple-system, 'Microsoft JhengHei', sans-serif";
    ctx.textBaseline = "middle";
    // 先畫所有水平線
    for (const l of lvList) {
      const yy = y(l.v);
      const c  = colorMap[l.cls] || "#888";
      ctx.strokeStyle = c;
      ctx.setLineDash(l.cls.endsWith("2") ? [2, 4] : [4, 3]);
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(PW, yy);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // 再放標籤：以線為中心，遇到垂直重疊就往右挪一格，避免文字疊在一起
    const boxes = lvList.map(l => {
      const text = `${l.label}：${l.v.toFixed(2)}`;
      const padX = 6, padY = 3, tw = ctx.measureText(text).width, th = 13;
      return {
        l, text,
        boxW: tw + padX * 2,
        boxH: th + padY * 2,
        cy: y(l.v),
      };
    });
    boxes.sort((a, b) => a.cy - b.cy);
    const placed = [];
    for (const b of boxes) {
      let by = b.cy - b.boxH / 2;
      // 夾回畫布
      by = Math.max(1, Math.min(PH - b.boxH - 1, by));
      // 同列偵測：若與已放置的標籤垂直區間重疊，往右排
      let bx = 2;
      const verticallyOverlaps = (p) =>
        !(by + b.boxH <= p.by || by >= p.by + p.boxH);
      let tries = 0;
      while (tries < 8) {
        const conflict = placed.find(p => verticallyOverlaps(p) && bx < p.bx + p.boxW + 4 && bx + b.boxW > p.bx - 4);
        if (!conflict) break;
        bx = conflict.bx + conflict.boxW + 4;
        tries++;
      }
      // 超出右邊（避免壓到右側價格軸），改為強制換行向上/向下推
      if (bx + b.boxW > PW - 4) {
        bx = 2;
        // 嘗試上方
        const aboveY = b.cy - b.boxH - 2;
        const belowY = b.cy + 2;
        const candidates = [aboveY, belowY]
          .map(v => Math.max(1, Math.min(PH - b.boxH - 1, v)))
          .filter(v => !placed.some(p =>
            !(v + b.boxH <= p.by || v >= p.by + p.boxH) &&
            !(bx + b.boxW <= p.bx || bx >= p.bx + p.boxW)
          ));
        if (candidates.length) by = candidates[0];
      }
      const c = colorMap[b.l.cls] || "#888";
      ctx.fillStyle = "#0f1115e6";
      ctx.strokeStyle = c;
      ctx.lineWidth = 1.2;
      roundRect(ctx, bx, by, b.boxW, b.boxH, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = c;
      ctx.fillText(b.text, bx + 6, by + b.boxH / 2);
      placed.push({ bx, by, boxW: b.boxW, boxH: b.boxH });
      canvas._lvBoxes.push({ bx, by, boxW: b.boxW, boxH: b.boxH, level: b.l, refPrice: levels?.price });
    }
    ctx.restore();
    bindLevelHover(canvas);
  } else {
    bindLevelHover(canvas);
  }

  drawTimeAxis(ctx, bars, PW, H, PH);
  drawPriceAxis(ctx, min, max, PW, W, PH, last, color);
}

const $ = id => document.getElementById(id);
const cardOf = sym => document.querySelector(`.card[data-symbol="${sym}"]`);
function fmt(v, d = 2) {
  if (v == null || isNaN(v)) return "--";
  return Number(v).toFixed(d);
}

function drawMACD(canvas, m, bars, n) {
  if (!canvas || !m) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const AXIS_H = 14;
  const AXIS_W = 44;
  const PW = W - AXIS_W;
  const PH = H - AXIS_H;
  ctx.clearRect(0, 0, W, H);

  const macd = m.macd.slice(-n);
  const sig  = m.sig.slice(-n);
  const hist = m.hist.slice(-n);
  if (!macd.length) return;

  // 線（MACD / Signal）與柱（Histogram）分開縮放：避免 hist 值小被線拉到看不見
  const lineMax  = Math.max(...macd.concat(sig).map(Math.abs));
  const histMax  = Math.max(...hist.map(Math.abs));
  const lineHalf = lineMax || 1;
  const histHalf = histMax || 1;
  const mid = PH / 2;
  const PAD = 4;
  // 線使用實際刻度（軸與此一致）；柱獨立縮放至最大可視（佔 90% 半窗）
  const yLine = v => mid - (v / lineHalf) * (PH / 2 - PAD);
  const yHist = v => mid - (v / histHalf) * (PH / 2 - PAD) * 0.90;
  const cw = PW / macd.length;

  // 0 軸
  ctx.strokeStyle = "#3a3f48";
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(PW, mid); ctx.stroke();

  // Histogram（獨立縮放，讓細微變化可見）
  for (let i = 0; i < hist.length; i++) {
    const x = i * cw;
    const h = hist[i];
    const yh = yHist(h);
    ctx.fillStyle = h >= 0 ? "rgba(239,83,80,0.75)" : "rgba(38,166,154,0.75)";
    ctx.fillRect(x + 1, Math.min(mid, yh), Math.max(1, cw - 2), Math.abs(yh - mid));
  }
  // MACD line
  ctx.strokeStyle = "#4fc3f7"; ctx.lineWidth = 1.4;
  ctx.beginPath();
  macd.forEach((v, i) => {
    const x = i * cw + cw / 2, yy = yLine(v);
    if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
  });
  ctx.stroke();
  // Signal line
  ctx.strokeStyle = "#ffb74d";
  ctx.beginPath();
  sig.forEach((v, i) => {
    const x = i * cw + cw / 2, yy = yLine(v);
    if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
  });
  ctx.stroke();

  // 時間軸（與 K 線圖共用的同一段 bars）
  if (bars && bars.length) {
    const sliced = bars.slice(-macd.length);
    drawTimeAxis(ctx, sliced, PW, H, PH);
  }
  // 值軸（對稱、線的實際刻度）；右下角加註 hist 峰值
  drawValueAxis(ctx, -lineHalf, lineHalf, PW, W, PH, macd[macd.length - 1]);
  ctx.save();
  ctx.font = "9px 'Segoe UI', sans-serif";
  ctx.fillStyle = "#9aa0a6";
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(`H±${histHalf.toFixed(3)}`, PW - 2, PH - 2);
  ctx.restore();
}

// 右側價格軸
function drawPriceAxis(ctx, min, max, PW, W, plotH, lastVal, lastColor) {
  const TICKS = 5;
  const range = max - min || 1;
  const decimals = range >= 100 ? 0 : range >= 10 ? 1 : 2;
  ctx.save();
  ctx.font = "10px 'Segoe UI', sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "rgba(154,160,166,0.10)";
  ctx.fillStyle = "#9aa0a6";

  for (let i = 0; i < TICKS; i++) {
    const t = i / (TICKS - 1);
    const v = max - t * range;
    const yy = (plotH - 4) * t + 2;
    const yyText = Math.max(7, Math.min(plotH - 3, yy)); // 防止頂 / 底文字被裁切
    ctx.beginPath();
    ctx.setLineDash([2, 3]);
    ctx.moveTo(0, yy); ctx.lineTo(PW, yy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText(v.toFixed(decimals), PW + 3, yyText);
  }
  // 最新價高亮標示
  if (lastVal != null) {
    const yLast = plotH - ((lastVal - min) / range) * (plotH - 4) - 2;
    ctx.fillStyle = lastColor;
    ctx.fillRect(PW + 1, yLast - 7, W - PW - 2, 14);
    ctx.fillStyle = "#0f1115";
    ctx.font = "bold 10px 'Segoe UI', sans-serif";
    ctx.fillText(lastVal.toFixed(decimals), PW + 3, yLast);
  }
  ctx.restore();
}

// MACD 右側值軸
function drawValueAxis(ctx, vmin, vmax, PW, W, plotH, lastVal) {
  const TICKS = 5;
  const range = vmax - vmin || 1;
  const decimals = Math.abs(vmax) >= 10 ? 2 : Math.abs(vmax) >= 1 ? 3 : 3;
  ctx.save();
  ctx.font = "10px 'Segoe UI', sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#9aa0a6";
  for (let i = 0; i < TICKS; i++) {
    const t = i / (TICKS - 1);
    const v = vmax - t * range;
    const yy = (plotH - 4) * t + 2;
    const yyText = Math.max(7, Math.min(plotH - 3, yy));
    ctx.fillText(v.toFixed(decimals), PW + 3, yyText);
  }
  if (lastVal != null) {
    const yLast = plotH / 2 - (lastVal / Math.max(Math.abs(vmin), Math.abs(vmax))) * (plotH / 2 - 4);
    ctx.fillStyle = "#4fc3f7";
    ctx.fillRect(PW + 1, yLast - 7, W - PW - 2, 14);
    ctx.fillStyle = "#0f1115";
    ctx.font = "bold 10px 'Segoe UI', sans-serif";
    ctx.fillText(lastVal.toFixed(decimals), PW + 3, yLast);
  }
  ctx.restore();
}

// 簡易圓角矩形 path（不依賴瀏覽器內建 ctx.roundRect）
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

// 在 canvas 底部畫出時間刻度與對應的垂直虛線
function drawTimeAxis(ctx, bars, W, H, plotH) {
  if (!bars || !bars.length) return;
  const TICKS = 5;
  const tf = TIMEFRAMES[timeframe] || TIMEFRAMES["1m"];
  const longTf = (timeframe === "60m" || timeframe === "30m");

  ctx.save();
  ctx.font = "10px 'Segoe UI', sans-serif";
  ctx.fillStyle = "#9aa0a6";
  ctx.strokeStyle = "rgba(154,160,166,0.15)";
  ctx.lineWidth = 1;

  for (let i = 0; i < TICKS; i++) {
    const idx = Math.round((bars.length - 1) * (i / (TICKS - 1)));
    const b = bars[idx];
    if (!b || !b.t) continue;
    const x = (idx / Math.max(1, bars.length - 1)) * W;

    // 垂直虛線
    ctx.beginPath();
    ctx.setLineDash([2, 3]);
    ctx.moveTo(x, 0); ctx.lineTo(x, plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    // 時間文字
    const d = new Date(b.t * 1000);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const md = `${d.getMonth() + 1}/${d.getDate()}`;
    const text = longTf ? `${md} ${hh}:${mm}` : `${hh}:${mm}`;

    let tx = x;
    const tw = ctx.measureText(text).width;
    if (i === 0) ctx.textAlign = "left";
    else if (i === TICKS - 1) { ctx.textAlign = "right"; }
    else ctx.textAlign = "center";
    ctx.fillText(text, tx, H - 3);
  }
  ctx.restore();
}

// ─── 備選清單代碼 hover 浮層：套用至 dashboard 1/2/3 ───
let _wlSymPop = null;
let _wlSymPopHideTimer = null;

function _ensureWlSymPopover() {
  if (_wlSymPop) return _wlSymPop;
  const el = document.createElement("div");
  el.className = "wl-sym-popover hidden";
  el.innerHTML =
    `<div class="wlsp-title">套用 <b class="wlsp-sym">--</b> 至 <span class="wlsp-panel">[--]</span> dashboard</div>` +
    `<div class="wlsp-row"></div>`;
  document.body.appendChild(el);
  el.addEventListener("mouseenter", () => {
    if (_wlSymPopHideTimer) { clearTimeout(_wlSymPopHideTimer); _wlSymPopHideTimer = null; }
  });
  el.addEventListener("mouseleave", () => _scheduleHideWlSymPop());
  el.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    const sym = el.dataset.sym;
    if (!sym) return;
    let next = [...symbols];
    if (act === "append") {
      if (next.length >= SYMBOL_COUNT) return;
      if (next.includes(sym)) return;
      next.push(sym);
    } else if (act === "replace") {
      const slot = parseInt(btn.dataset.slot, 10);
      if (isNaN(slot) || slot < 0 || slot >= next.length) return;
      // 若 sym 已在另一個 slot，與目標 slot 交換；否則直接覆寫
      const existIdx = next.findIndex(s => (s || "").toUpperCase() === sym.toUpperCase());
      if (existIdx >= 0 && existIdx !== slot) {
        const tmp = next[slot]; next[slot] = next[existIdx]; next[existIdx] = tmp;
      } else {
        next[slot] = sym;
      }
    } else {
      return;
    }
    _hideWlSymPop(true);
    await applySymbolsAndReload(next.slice(0, SYMBOL_COUNT));
  });
  _wlSymPop = el;
  return el;
}

function _showWlSymPopFor(td) {
  const el = _ensureWlSymPopover();
  const tr = td.closest("tr");
  const sym = (tr?.dataset.sym || td.textContent || "").trim().toUpperCase();
  if (!sym) return;
  el.dataset.sym = sym;
  el.querySelector(".wlsp-sym").textContent = sym;
  const def = PANEL_DEFS.find(d => d.id === activePanelId);
  el.querySelector(".wlsp-panel").textContent = `[${def?.name || activePanelId}]`;
  // 動態 render 按鈕：依目前 symbols 長度
  const row = el.querySelector(".wlsp-row");
  const parts = [];
  for (let i = 0; i < symbols.length; i++) {
    const cur = symbols[i] === sym;
    parts.push(`<button data-act="replace" data-slot="${i}" class="${cur ? "cur" : ""}" ${cur ? "disabled" : ""}>${cur ? `✓ 已在 ${i + 1}` : `→ ${i + 1}`}</button>`);
  }
  if (symbols.length < SYMBOL_COUNT && !symbols.includes(sym)) {
    parts.push(`<button data-act="append" class="append">+ 新增 (${symbols.length + 1})</button>`);
  }
  if (parts.length === 0) {
    parts.push(`<span class="wlsp-empty">已在清單中</span>`);
  }
  row.innerHTML = parts.join("");
  // 定位：cell 右下方
  const r = td.getBoundingClientRect();
  el.classList.remove("hidden");
  const pw = el.offsetWidth, ph = el.offsetHeight;
  let x = r.right + 6, y = r.top;
  if (x + pw > window.innerWidth - 8) x = r.left - pw - 6;
  if (y + ph > window.innerHeight - 8) y = window.innerHeight - ph - 8;
  if (x < 4) x = 4;
  if (y < 4) y = 4;
  el.style.left = x + "px";
  el.style.top  = y + "px";
}

function _scheduleHideWlSymPop() {
  if (_wlSymPopHideTimer) clearTimeout(_wlSymPopHideTimer);
  _wlSymPopHideTimer = setTimeout(() => _hideWlSymPop(), 180);
}
function _hideWlSymPop(immediate) {
  if (immediate && _wlSymPopHideTimer) { clearTimeout(_wlSymPopHideTimer); _wlSymPopHideTimer = null; }
  if (_wlSymPop) _wlSymPop.classList.add("hidden");
}

function bindWlSymPopover() {
  const tbody = document.querySelector("#wlTable tbody");
  if (!tbody || tbody.dataset.popBound === "1") return;
  tbody.dataset.popBound = "1";
  tbody.addEventListener("mouseover", (e) => {
    const td = e.target.closest("td.sym");
    if (!td) return;
    if (_wlSymPopHideTimer) { clearTimeout(_wlSymPopHideTimer); _wlSymPopHideTimer = null; }
    _showWlSymPopFor(td);
  });
  tbody.addEventListener("mouseout", (e) => {
    const td = e.target.closest("td.sym");
    if (!td) return;
    // 如果 mouse 移到 popover 上，由 popover 自己 cancel
    const to = e.relatedTarget;
    if (to && _wlSymPop && _wlSymPop.contains(to)) return;
    _scheduleHideWlSymPop();
  });
  // 視窗捲動或大小變更時隱藏，避免位置錯位
  window.addEventListener("scroll", () => _hideWlSymPop(true), true);
  window.addEventListener("resize", () => _hideWlSymPop(true));
}

// ─── 備選清單名稱 hover 浮層：個股詳細資訊 ───
let _wlNamePop = null;
let _wlNamePopHideTimer = null;
let _wlNamePopCurrentSym = null;
const _nameDetailCache = new Map(); // sym -> { ts, data }
const NAME_DETAIL_TTL = 10 * 60 * 1000;
let _yahooCrumb = null;

async function _getYahooCrumb() {
  if (_yahooCrumb) return _yahooCrumb;
  try {
    await fetch("https://fc.yahoo.com/", { credentials: "include" }).catch(() => {});
    const r = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { credentials: "include" });
    if (r.ok) {
      const t = (await r.text()).trim();
      if (t && t.length < 64) _yahooCrumb = t;
    }
  } catch {}
  return _yahooCrumb;
}

async function _fetchNameDetail(sym) {
  const cached = _nameDetailCache.get(sym);
  if (cached && Date.now() - cached.ts < NAME_DETAIL_TTL) return cached.data;
  const crumb = await _getYahooCrumb();
  // 1) v7/quote 取 EPS / PE / 配息 / 下次財報（Yahoo 已要求 crumb）
  let q = null;
  try {
    const qsParam = crumb ? `&crumb=${encodeURIComponent(crumb)}` : "";
    const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}${qsParam}`, { credentials: "include" });
    if (r.ok) {
      const j = await r.json();
      q = j.quoteResponse?.result?.[0] || null;
    }
  } catch {}
  // 2) chart 2y 日線 + 事件
  let chart = null;
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=2y&interval=1d&events=earn,div`);
    if (r.ok) {
      const j = await r.json();
      chart = j.chart?.result?.[0] || null;
    }
  } catch {}
  // 3) quoteSummary：補 EPS/PE（若 v7 失敗）+ 補 earningsHistory（若 chart events 沒給）+ ex-div
  let exDivTs = null;
  let qsEpsHistory = [];   // [{date(ms), epsActual}]
  let qsPe = null, qsEps = null, qsName = null;
  try {
    if (crumb) {
      const r = await fetch(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}` +
        `?modules=calendarEvents,earningsHistory,defaultKeyStatistics,price,summaryDetail&crumb=${encodeURIComponent(crumb)}`,
        { credentials: "include" });
      if (r.ok) {
        const j = await r.json();
        const res = j.quoteSummary?.result?.[0] || {};
        const ce = res.calendarEvents || {};
        const v = ce.exDividendDate;
        exDivTs = v?.raw ? v.raw * 1000 : (typeof v === "number" ? v * 1000 : null);
        const eh = res.earningsHistory?.history || [];
        qsEpsHistory = eh.map(x => ({
          date: (x.quarter?.raw ? x.quarter.raw * 1000 : null),
          epsActual: x.epsActual?.raw,
        })).filter(e => e.date);
        qsPe  = res.summaryDetail?.trailingPE?.raw ?? res.defaultKeyStatistics?.trailingPE?.raw ?? null;
        qsEps = res.defaultKeyStatistics?.trailingEps?.raw ?? null;
        qsName = res.price?.shortName || res.price?.longName || null;
      }
    }
  } catch {}

  const ts = chart?.timestamp || [];
  const o  = chart?.indicators?.quote?.[0]?.open  || [];
  const h  = chart?.indicators?.quote?.[0]?.high  || [];
  const l  = chart?.indicators?.quote?.[0]?.low   || [];
  const c  = chart?.indicators?.quote?.[0]?.close || [];
  const evDiv = chart?.events?.dividends || {};
  const evEarn = chart?.events?.earnings || {};

  const findIdx = (eTs) => {
    for (let i = 0; i < ts.length; i++) if (ts[i] >= eTs - 12 * 3600) return i;
    return -1;
  };

  // 配息歷史
  const divs = Object.values(evDiv).map(d => ({
    date: d.date * 1000, amount: d.amount,
  })).sort((a, b) => b.date - a.date);
  const now = Date.now();
  const divPast = divs.filter(d => d.date <= now).slice(0, 3);
  const divFuture = divs.find(d => d.date > now);
  const nextDivAmt = divFuture?.amount ?? q?.dividendRate ?? q?.trailingAnnualDividendRate ?? null;
  const nextDivPay = q?.dividendDate ? q.dividendDate * 1000 : (divFuture?.date ?? null);

  // 財報歷史：先 chart events，若空則 fallback 到 quoteSummary.earningsHistory
  let earns = Object.values(evEarn).map(e => ({ date: e.date * 1000, ts: e.date }));
  if (!earns.length && qsEpsHistory.length) {
    earns = qsEpsHistory.map(x => ({ date: x.date, ts: Math.floor(x.date / 1000), epsActual: x.epsActual }));
  }
  // 將 qsEpsHistory 的 epsActual 依日期就近 merge 進來（±45 天）
  if (qsEpsHistory.length) {
    earns = earns.map(e => {
      if (e.epsActual != null) return e;
      const m = qsEpsHistory.find(x => Math.abs(x.date - e.date) < 45 * 86400000);
      return m ? { ...e, epsActual: m.epsActual } : e;
    });
  }
  earns.sort((a, b) => b.date - a.date);
  // YoY: 與 4 季前同期比較
  for (let i = 0; i < earns.length; i++) {
    const cur = earns[i].epsActual;
    const yoy = earns[i + 4]?.epsActual;
    if (cur != null && yoy != null && yoy !== 0) {
      earns[i].yoyPct = ((cur - yoy) / Math.abs(yoy)) * 100;
    }
  }
  const earnPast = earns.filter(e => e.date <= now).slice(0, 8);
  const earnFutureFromChart = earns.find(e => e.date > now);
  const nextEarnTs = earnFutureFromChart?.date || (q?.earningsTimestamp ? q.earningsTimestamp * 1000 : null);
  const enrich = (e) => {
    const idx = findIdx(e.ts);
    if (idx < 0) return { ...e, bars: null };
    const slots = [idx - 7, idx - 6, idx - 5, idx - 4, idx - 3, idx - 2, idx - 1, idx, idx + 1, idx + 2, idx + 3, idx + 4, idx + 5];
    const bars = slots.map(si => {
      if (si < 0 || si >= ts.length) return null;
      if (c[si] == null) return null;
      const prev = si > 0 ? c[si - 1] : null;
      const pct = (prev != null) ? ((c[si] - prev) / prev) * 100 : null;
      return { o: o[si], h: h[si], l: l[si], c: c[si], pct, t: ts[si] };
    });
    return { ...e, bars };
  };
  const earnPastEnriched = earnPast.map(enrich);
  const earnNextEnriched = nextEarnTs ? enrich({ date: nextEarnTs, ts: Math.floor(nextEarnTs / 1000) }) : { date: nextEarnTs, bars: null };

  const data = {
    sym,
    name: q?.shortName || q?.longName || qsName || sym,
    eps: q?.epsTrailingTwelveMonths ?? qsEps ?? null,
    pe:  q?.trailingPE
         ?? qsPe
         ?? (q?.regularMarketPrice && q?.epsTrailingTwelveMonths ? q.regularMarketPrice / q.epsTrailingTwelveMonths : null),
    divPast,
    nextDivAmt, nextDivPay, exDivTs,
    earnPast: earnPastEnriched,
    nextEarn: earnNextEnriched,
  };
  _nameDetailCache.set(sym, { ts: Date.now(), data });
  return data;
}

function _ensureWlNamePop() {
  if (_wlNamePop) return _wlNamePop;
  const el = document.createElement("div");
  el.className = "wl-name-popover hidden";
  document.body.appendChild(el);
  // 點擊外部 / ESC 關閉
  document.addEventListener("mousedown", (e) => {
    if (!_wlNamePop || _wlNamePop.classList.contains("hidden")) return;
    if (_wlNamePop.contains(e.target)) return;
    if (e.target.closest && e.target.closest("#wlTable td.name")) return;
    _hideWlNamePop(true);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") _hideWlNamePop(true);
  });
  // popover 內部 X 關閉
  el.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".wlnp-close")) {
      _hideWlNamePop(true);
    }
  });
  _wlNamePop = el;
  return el;
}

function _fmtPctSpan(v, withSign = true) {
  if (v == null || !isFinite(v)) return `<span class="miss">—</span>`;
  const cls = v > 0 ? "up" : v < 0 ? "down" : "flat";
  const sign = withSign && v > 0 ? "+" : "";
  return `<span class="${cls}">${sign}${v.toFixed(2)}%</span>`;
}
function _fmtDateShort(ts) {
  if (!ts) return `<span class="miss">—</span>`;
  const d = new Date(ts);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}
function _fmtMoney(v) {
  if (v == null || !isFinite(v) || v <= 0) return `<span class="miss">—</span>`;
  return `$${v.toFixed(2)}`;
}
function _fmtNum(v, dp = 2) {
  if (v == null || !isFinite(v)) return `<span class="miss">—</span>`;
  return v.toFixed(dp);
}

// 在小 canvas 上畫 OHLC 蠟燭，dIndex 為 D 當日位置（黃色高亮）
function _drawMiniCandles(canvas, bars, dIndex = 8) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  const pad = 4;
  const slotW = (W - 2 * pad) / bars.length;
  // D 當日高亮底（淡）
  if (dIndex >= 0 && dIndex < bars.length) {
    const x = pad + slotW * dIndex;
    ctx.fillStyle = "rgba(255, 213, 79, 0.10)";
    ctx.fillRect(x, 0, slotW, H);
    ctx.strokeStyle = "rgba(255, 213, 79, 0.55)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, 0.5, slotW - 1, H - 1);
  }
  const valid = bars.filter(b => b);
  if (!valid.length) {
    ctx.fillStyle = "#4a4f57"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("無資料", W / 2, H / 2 + 3);
    return;
  }
  const allH = valid.flatMap(b => [b.h, b.l]);
  let hi = Math.max(...allH), lo = Math.min(...allH);
  if (hi === lo) { hi += 0.5; lo -= 0.5; }
  const yScale = (v) => H - pad - ((v - lo) / (hi - lo)) * (H - 2 * pad);
  bars.forEach((b, i) => {
    if (!b) return;
    const cx = pad + slotW * (i + 0.5);
    const yH = yScale(b.h), yL = yScale(b.l);
    const yO = yScale(b.o), yC = yScale(b.c);
    // 顏色依 close-to-close pct（與 % 欄一致）；無 pct 時 fallback 用 O vs C
    const up = (b.pct != null) ? b.pct >= 0 : b.c >= b.o;
    ctx.strokeStyle = up ? "#ef5350" : "#26a69a";
    ctx.fillStyle   = up ? "#ef5350" : "#26a69a";
    ctx.lineWidth = 1;
    // wick
    ctx.beginPath(); ctx.moveTo(cx, yH); ctx.lineTo(cx, yL); ctx.stroke();
    // body
    const bw = Math.max(4, slotW * 0.55);
    const top = Math.min(yO, yC), bh = Math.max(2, Math.abs(yC - yO));
    ctx.fillRect(cx - bw / 2, top, bw, bh);
  });
  // 右上角標示 "D"
  if (dIndex >= 0 && dIndex < bars.length) {
    const x = pad + slotW * (dIndex + 0.5);
    ctx.fillStyle = "rgba(255, 213, 79, 0.75)";
    ctx.font = "bold 8px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("D+1", x, 1);
  }
}

function _renderWlNamePop(data, loading) {
  const el = _ensureWlNamePop();
  const closeBtn = `<button class="wlnp-close" type="button" title="關閉 (Esc)" aria-label="關閉">×</button>`;
  if (loading && !data) {
    el.innerHTML =
      `<div class="wlnp-head"><span class="wlnp-sym">${loading.sym}</span>` +
      `<span class="wlnp-name">${loading.name || ""}</span>` +
      `<span class="wlnp-loading">載入中…</span>${closeBtn}</div>`;
    return;
  }
  if (!data) return;
  const divRows = [];
  if (data.nextDivPay) {
    divRows.push(`<tr class="future"><td>下次</td><td>${_fmtDateShort(data.nextDivPay)}</td><td class="num">${_fmtMoney(data.nextDivAmt)}</td><td>${data.exDivTs ? "除息 " + _fmtDateShort(data.exDivTs) : ""}</td></tr>`);
  }
  for (const d of data.divPast) {
    divRows.push(`<tr><td>—</td><td>${_fmtDateShort(d.date)}</td><td class="num">${_fmtMoney(d.amount)}</td><td></td></tr>`);
  }
  if (!divRows.length) divRows.push(`<tr><td colspan="4" class="miss">無配息資料</td></tr>`);

  // 財報表
  const earnRows = [];
  const dayLabels = ["D-7","D-6","D-5","D-4","D-3","D-2","D-1","D","D+1","D+2","D+3","D+4","D+5"];
  if (data.nextEarn?.date) {
    const nb = data.nextEarn.bars || new Array(13).fill(null);
    const isPast = data.nextEarn.date <= Date.now();
    const lbl = isPast ? "最近" : "下次";
    const cells = nb.map((b, i) => `<td class="num${dayLabels[i] === "D+1" ? " dday" : ""}">${_fmtPctSpan(b?.pct)}</td>`).join("");
    earnRows.push(
      `<tr class="future"><td>${lbl}</td><td>${_fmtDateShort(data.nextEarn.date)}</td>` +
      `<td class="num">${_fmtNum(data.nextEarn.epsActual)}</td>` +
      `<td class="num">${_fmtPctSpan(data.nextEarn.yoyPct)}</td>` +
      cells +
      `<td><canvas class="minik" width="260" height="64" data-future="1"></canvas></td></tr>`
    );
  }
  for (const e of data.earnPast) {
    const b = e.bars || new Array(13).fill(null);
    const idx = `e_${e.ts}`;
    const cells = b.map((x, i) => `<td class="num${dayLabels[i] === "D+1" ? " dday" : ""}">${_fmtPctSpan(x?.pct)}</td>`).join("");
    earnRows.push(
      `<tr><td>—</td><td>${_fmtDateShort(e.date)}</td>` +
      `<td class="num">${_fmtNum(e.epsActual)}</td>` +
      `<td class="num">${_fmtPctSpan(e.yoyPct)}</td>` +
      cells +
      `<td><canvas class="minik" width="260" height="64" data-eidx="${idx}"></canvas></td></tr>`
    );
  }
  if (!earnRows.length) earnRows.push(`<tr><td colspan="18" class="miss">無財報資料</td></tr>`);

  el.innerHTML = `
    <div class="wlnp-head">
      <span class="wlnp-sym">${data.sym}</span>
      <span class="wlnp-name">${data.name}</span>
      <button class="wlnp-close" type="button" title="關閉 (Esc)" aria-label="關閉">×</button>
    </div>
    <div class="wlnp-section">
      <div class="wlnp-grid2">
        <div class="wlnp-kv"><span class="k">EPS (TTM)</span><span class="v">${_fmtNum(data.eps)}</span><span class="k" style="font-size:10px;color:#9aa0a6;margin-left:4px">最近 4 季加總</span></div>
        <div class="wlnp-kv"><span class="k">本益比</span><span class="v">${_fmtNum(data.pe, 1)}</span></div>
      </div>
    </div>
    <div class="wlnp-section">
      <div class="wlnp-stitle">配息</div>
      <table class="wlnp-tbl">
        <thead><tr><th></th><th>日期</th><th class="num">金額</th><th>備註</th></tr></thead>
        <tbody>${divRows.join("")}</tbody>
      </table>
      <div class="wlnp-note">「下次」日期 = Yahoo dividendDate（配息入帳日）；除息日另列。</div>
    </div>
    <div class="wlnp-section">
      <div class="wlnp-stitle">財報（D-7 … D … D+5 收盤漲跌% + K 線）</div>
      <table class="wlnp-tbl">
        <thead><tr><th></th><th>日期</th><th class="num">單季 EPS</th><th class="num">獲利YoY%</th>${dayLabels.map(d => `<th class="num${d === "D+1" ? " dday" : ""}">${d}</th>`).join("")}<th>K</th></tr></thead>
        <tbody>${earnRows.join("")}</tbody>
      </table>
    </div>
  `;
  // 繪 K 線
  for (const e of data.earnPast) {
    const idx = `e_${e.ts}`;
    const cv = el.querySelector(`canvas.minik[data-eidx="${idx}"]`);
    if (cv && e.bars) _drawMiniCandles(cv, e.bars);
  }
  const futCv = el.querySelector(`canvas.minik[data-future="1"]`);
  if (futCv) _drawMiniCandles(futCv, data.nextEarn?.bars || new Array(13).fill(null));
}

function _positionWlNamePop(td) {
  const el = _wlNamePop;
  if (!el) return;
  const r = td.getBoundingClientRect();
  const pw = el.offsetWidth, ph = el.offsetHeight;
  let x = r.right + 6, y = r.top;
  if (x + pw > window.innerWidth - 8) x = r.left - pw - 6;
  if (x < 4) x = 4;
  if (y + ph > window.innerHeight - 8) y = window.innerHeight - ph - 8;
  if (y < 4) y = 4;
  el.style.left = x + "px";
  el.style.top  = y + "px";
}

async function _showWlNamePopFor(td) {
  const tr = td.closest("tr");
  const sym = (tr?.dataset.sym || "").trim().toUpperCase();
  if (!sym) return;
  const name = tr?.querySelector("td.name")?.textContent?.trim() || "";
  _wlNamePopCurrentSym = sym;
  const el = _ensureWlNamePop();
  // cache hit → 立即渲染
  const cached = _nameDetailCache.get(sym);
  if (cached && Date.now() - cached.ts < NAME_DETAIL_TTL) {
    _renderWlNamePop(cached.data);
  } else {
    _renderWlNamePop(null, { sym, name });
  }
  el.classList.remove("hidden");
  _positionWlNamePop(td);
  if (!cached || Date.now() - cached.ts >= NAME_DETAIL_TTL) {
    try {
      const data = await _fetchNameDetail(sym);
      if (_wlNamePopCurrentSym !== sym) return; // 使用者已 hover 別檔
      _renderWlNamePop(data);
      _positionWlNamePop(td);
    } catch (e) {
      if (_wlNamePopCurrentSym !== sym) return;
      el.innerHTML = `<div class="wlnp-head"><span class="wlnp-sym">${sym}</span><span class="wlnp-name miss">資料載入失敗</span></div>`;
    }
  }
}

function _scheduleHideWlNamePop() {
  if (_wlNamePopHideTimer) clearTimeout(_wlNamePopHideTimer);
  _wlNamePopHideTimer = setTimeout(() => _hideWlNamePop(), 220);
}
function _hideWlNamePop(immediate) {
  if (immediate && _wlNamePopHideTimer) { clearTimeout(_wlNamePopHideTimer); _wlNamePopHideTimer = null; }
  if (_wlNamePop) _wlNamePop.classList.add("hidden");
  _wlNamePopCurrentSym = null;
}

function bindWlNamePopover() {
  const tbody = document.querySelector("#wlTable tbody");
  if (!tbody || tbody.dataset.namePopBound === "1") return;
  tbody.dataset.namePopBound = "1";
  tbody.addEventListener("click", (e) => {
    const td = e.target.closest("td.name");
    if (!td) return;
    e.preventDefault();
    if (_wlNamePopHideTimer) { clearTimeout(_wlNamePopHideTimer); _wlNamePopHideTimer = null; }
    const tr = td.closest("tr");
    const sym = (tr?.dataset.sym || "").trim().toUpperCase();
    // 同一 cell 再點 → 切換關閉
    if (_wlNamePop && !_wlNamePop.classList.contains("hidden") && _wlNamePopCurrentSym === sym) {
      _hideWlNamePop(true);
      return;
    }
    _showWlNamePopFor(td);
  });
  window.addEventListener("scroll", (e) => {
    if (_wlNamePop && _wlNamePop.contains(e.target)) return;
    _hideWlNamePop(true);
  }, true);
  window.addEventListener("resize", () => _hideWlNamePop(true));
}
// ─── 門檻面板 UI ────────────────────────────────────────────────────────
function bindThresholdPanel() {
  const btn = document.getElementById("thresholdBtn");
  const panel = document.getElementById("thresholdPanel");
  if (!btn || !panel) return;
  btn.addEventListener("click", () => {
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) renderThresholdPanel();
  });
  panel.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const preset = t.dataset.preset;
    if (preset && PRESETS_THR[preset]) {
      // 切換到該 preset → 載入該 preset 已儲存的覆寫值
      CURRENT_PRESET = preset;
      Object.assign(THR, DEFAULT_THR, PRESET_OVERRIDES[preset]);
      saveThresholds();
      renderThresholdPanel();
      applyThresholdsRuntime();
    }
    if (t.dataset.act === "close") panel.classList.add("hidden");
    if (t.dataset.act === "reset-current") {
      const p = CURRENT_PRESET;
      if (PRESETS_THR[p]) {
        PRESET_OVERRIDES[p] = { ...PRESETS_THR[p] };
        Object.assign(THR, DEFAULT_THR, PRESETS_THR[p]);
        saveThresholds();
        renderThresholdPanel();
        applyThresholdsRuntime();
      }
    }
  });
  panel.addEventListener("input", (e) => {
    const inp = e.target;
    if (!(inp instanceof HTMLInputElement) || !inp.dataset.thr) return;
    const k = inp.dataset.thr;
    const v = parseFloat(inp.value);
    if (Number.isFinite(v)) {
      THR[k] = v;
      const out = panel.querySelector(`[data-thr-out="${k}"]`);
      if (out) out.textContent = String(v);
      saveThresholds();
      applyThresholdsRuntime();
    }
  });
}
function renderThresholdPanel() {
  const panel = document.getElementById("thresholdPanel");
  if (!panel) return;
  const currentPreset = CURRENT_PRESET;
  panel.querySelectorAll("[data-preset]").forEach(b => {
    if (b.dataset.act === "reset-preset") return; // 「回XX預設」按鈕不參與 active 指示
    b.classList.toggle("active", b.getAttribute("data-preset") === currentPreset);
  });
  panel.querySelectorAll("input[data-thr]").forEach((inp) => {
    if (!(inp instanceof HTMLInputElement)) return;
    inp.value = String(THR[inp.dataset.thr]);
    const out = panel.querySelector(`[data-thr-out="${inp.dataset.thr}"]`);
    if (out) out.textContent = String(THR[inp.dataset.thr]);
  });
  const cur = panel.querySelector("[data-preset-current]");
  if (cur) cur.textContent = currentPreset === "conservative" ? "保守"
                            : currentPreset === "aggressive" ? "激進" : "標準";
}
function applyThresholdsRuntime() {
  const newMs = Math.max(1000, Math.round(THR.refreshSec * 1000));
  if (typeof quoteRefreshMs !== "undefined" && newMs !== quoteRefreshMs) {
    quoteRefreshMs = newMs;
    try { startTimers(); } catch {}
  }
  if (typeof renderWatchlist === "function") {
    [...wlData.values()].forEach(r => {
      if (typeof r.score1 === "number") { const o = _labelByScore(r.score1); r.label1 = o.label; r.cls1 = o.cls; }
      if (typeof r.score5 === "number") { const o = _labelByScore(r.score5); r.label5 = o.label; r.cls5 = o.cls; }
    });
    renderWatchlist();
  }
}

// =====================================================================
// 模擬交易（點擊勝率膠囊 → 模擬買入，simCfg.windowMs 內若達標即勝；否則敗）
// =====================================================================
const SIM_KEY = "simTrades";
const SIM_CFG_KEY = "simConfig";
const SIM_FILL_DELAY_MS = 3000; // 下單後至少等 3 秒才開始檢查是否成交
// 熱路徑 console 去重：同一 (key, bucketMs) 內僅輸出一次，避免 auto-scan 每 5 秒重複刷屏
const _logDedup = new Map(); // key -> lastTs
function _logOnce(key, bucketMs, fn) {
  const now = Date.now();
  const last = _logDedup.get(key) || 0;
  if (now - last < bucketMs) return;
  _logDedup.set(key, now);
  // 防止 Map 無限成長：超過 500 筆時清掉過期項
  if (_logDedup.size > 500) {
    for (const [k, t] of _logDedup) {
      if (now - t > bucketMs * 2) _logDedup.delete(k);
    }
  }
  try { fn(); } catch {}
}
const SIM_DEFAULT_CFG = {
  concurrency: 1,        // 1-256 同時持單上限
  targetPct: 0.004,      // 0.0001 - 0.012 目標漲幅
  windowMs: 90 * 60 * 1000, // 1 - 390 分鐘（預設 1h30m）
  wrMin: 0.60,           // wr030 勝率門檻
  wrMin050: 0.30,        // wr050 勝率門檻
  perSymMax: 1,          // 1 = 單一股票不連續下單；>=2 則允許同標的多筆同時持單
  scanIntervalSec: 2,    // 1-60 自動掃描間隔秒數
  gradientLevel: 3,      // 保護等級 0=不保護 1=wr050≥wr050d 2=wr030≥wr050d 3=wr030≥wr050≥wr050d（預設最保守）
  entryMode: 4,          // 買入價格策略：0=目前價 1=中間值 2=建議價 3=追價(起始=建議價) 4=追價(起始=中間值，預設) 5=追價(起始=目前價)
  // 追價模式 (mode 3) 參數：起始為建議價（無則目前價），每 chaseBumpSec 秒未成交就加價，上限為當下市價；總時限 chaseMaxSec 仍未成交則刪單(unfilled)
  chaseBumpSec: 0.1,     // 0.01-60 加價間隔（秒）
  chaseBumpPct: 0.01,    // 0.01-25 每次加價幅度，% of 下單時市價
  chaseMaxSec: 120,      // 10-1000 追價總時限（秒）
  // ===== 出場策略：對應的「賣出追價」（殺低賣出） =====
  exitMode: 1,           // 0=市價立刻成交、1=追價（起始=當下市價，每 N 秒 -step%，慢慢殺低吃對手 bid）
  exitChaseBumpSec: 0.1, // 0.01-60 賣出加價（往下）間隔
  exitChaseBumpPct: 0.01,// 0.01-25 每次降價幅度 % of 觸發出場當下市價
  // ===== 賣出追低：狂跌加速出場—股價頻跳跳下時動態放大出場步幅 =====
  exitChasePanicGapPct: 0.5,  // 0=關閉；「sellLimit vs 市價」下方價差達 X% 視為狂跌，跳過 bump 節流並拿 step × mul
  exitChasePanicMul: 10,      // 1-50 狂跌時的步幅倍數（另會保證限價跳到「市價 - 1 tick」以下）
  // ===== 買進追價：狂飄加速追擊——股價頻跳時動態放大追價步幅 =====
  chasePanicGapPct: 0.5,   // 0=關閉；「市價 vs 限價」價差達 X% 視為狂飄，跳過 bump 節流並拿 step × mul
  chasePanicMul: 10,       // 1-50 狂飄時的步幅倒數倍數（另會保證限價跳到「市價 + 1 tick」以上）
  // ===== 美股手續費 / 風控 / 成交模型 =====
  amountPerTradeUsd: 3500,  // 每筆下單金額（USD），股數 = floor(金額 / 限價)；每 500 一個級距
  feeBuyUsd: 1.0,           // 買進手續費 USD/筆（平盤）
  feeBuyPct: 0,             // 買進手續費 % (0~0.015) - 依買進金額按比例扣
  feeSellUsd: 0,            // 賣出手續費 USD/筆（平盤）
  feeSellPct: 0.0015,       // 賣出手續費 %（0.0015 = 0.15%）
  stopLossPct: 0.035,       // 停損混%（0 = 不啟用、>0 為混損幅門檻；預設 0.035 = 3.5%）
  trailingStopPct: 0,       // 移動停利%（0 = 不啟用；進入獲利區後峰值回撚 X% 即出場；步距 0.01%）
  dailyMaxLossUsd: 0,       // 今日最大容忍償損 USD（0 = 不啟用；超過則自動關閉 auto）
  minPriceUsd: 6,           // 最小股價過濾 USD（0 = 不過濾；建議 5~10 避免 penny stock）
  maxFeePctOfAmount: 0.002, // 手續費上限：預估來回手續費 ÷ 下單金額 > 此值則跳過（0 = 不限；預設 0.002 = 0.20%，範圍 0~1%）
  fxUsdTwd: 31.5,           // 匯率 1 USD = ? TWD（0.1~500，預設 31.5）；用於台幣換算顯示
  fillMode: 'strict',       // 'optimistic'（細 last≤limit 即成交@last）、'strict'（last<limit 才成交@limit，讀 NBBO 之前的保守估計）
  // 交易時段：rth = 僅盤中(09:30-16:00 ET) / rthPre = 含盤前 / rthPost = 含盤後 / all = 全時段
  sessionMode: "rth",
  // 盤前/盤後額外手續費（分數形式，0.0005 = 0.05%），預設 0 = 不加（避免默默吞掉 1/3 目標獲利）
  extendedFeePct: 0,
  // 勝率計算只取 RTH bars。預設 false：混合所有 bars，避免盤前看 RTH 歷史失真
  wrRthOnly: false,
  // 執行模式：0 = 本地模擬（1 = WS 實交
  executionMode: 0,
  wsUrl: "ws://127.0.0.1:1088/",
  autoEnabled: false,
  // 一次性預設 migration 版本：當載入的舊 cfg cfgMigV < 此值時，會強制套用「新預設」到指定欄位並升位。
  // v2 (2026-05-19): wrRthOnly→false, extendedFeePct→0
  cfgMigV: 2,
};
let simTrades = [];
let simCfg = { ...SIM_DEFAULT_CFG };
let _simAutoTimer = null;
let _simAutoStopTimer = null;  // 測試時長到期前 1 秒自動關閉 auto
let _simAutoStopAt = 0;        // 預定停止時間 (ms epoch)
let _simAutoCountdownTimer = null;  // 按鈕倒數 1s tick
let _simLastScan = null;  // { time, wlSize, candidates, placed, reason }

function _fmtHMS(ms) {
  if (!isFinite(ms) || ms <= 0) return "00:00:00";
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
function _tickAutoBtnCountdown() {
  const btn = document.getElementById("simAutoBtn");
  if (!btn) return;
  if (!simCfg.autoEnabled) {
    btn.textContent = "▶ 啟用自動買入";
    btn.classList.remove("danger");
    return;
  }
  const remain = _simAutoStopAt ? Math.max(0, _simAutoStopAt - Date.now()) : 0;
  const label = remain > 0 ? `■ 停止自動買入  ${_fmtHMS(remain)}` : "■ 停止自動買入";
  if (btn.textContent !== label) btn.textContent = label;
  btn.classList.add("danger");
}

function loadSimTrades() {
  return new Promise(resolve => {
    chrome.storage?.local.get([SIM_KEY, SIM_CFG_KEY], (r) => {
      simTrades = Array.isArray(r?.[SIM_KEY]) ? r[SIM_KEY] : [];
      const c = r?.[SIM_CFG_KEY];
      if (c && typeof c === "object") {
        simCfg = { ...SIM_DEFAULT_CFG, ...c };
        // 舊版相容：requireGradient(bool) → gradientLevel(0/3)
        if (typeof c.gradientLevel !== "number" && "requireGradient" in c) {
          simCfg.gradientLevel = c.requireGradient ? 3 : 0;
        }
        simCfg.gradientLevel = Math.max(0, Math.min(3, simCfg.gradientLevel | 0));
        delete simCfg.requireGradient;
        // 舊版相容：rthOnly(bool) → sessionMode ("rth" | "all")
        if (typeof c.sessionMode !== "string" && "rthOnly" in c) {
          simCfg.sessionMode = c.rthOnly ? "rth" : "all";
        }
        if (!["rth","rthPre","rthPost","all"].includes(simCfg.sessionMode)) simCfg.sessionMode = "rth";
        delete simCfg.rthOnly;
        // 限制 extendedFeePct 範圍與 wrRthOnly 是 bool
        simCfg.extendedFeePct = Math.max(0, Math.min(0.01, +simCfg.extendedFeePct || 0));
        simCfg.wrRthOnly = !!simCfg.wrRthOnly;
        // 一次性預設 migration：舊 cfg 未跟上新版預設 → 強制套用並存回
        const _curMigV = +simCfg.cfgMigV || 0;
        const _newMigV = +SIM_DEFAULT_CFG.cfgMigV || 0;
        if (_curMigV < _newMigV) {
          // v2: 「勝率只用盤中」關閉、「盤前/後手續費加成」歸零
          if (_curMigV < 2) {
            simCfg.wrRthOnly = false;
            simCfg.extendedFeePct = 0;
          }
          simCfg.cfgMigV = _newMigV;
          // 在 loadSimTrades 完成後的 setTimeout 不來得及，下一次 saveSimCfg 會寫回。為穩鬼主動寫回。
          try { chrome.storage?.local.set({ [SIM_CFG_KEY]: simCfg }); } catch {}
          try { console.info(`[sim] cfg migrated → v${_newMigV} (wrRthOnly=false, extendedFeePct=0)`); } catch {}
        }
      }
      // 安全：自動買入「不」跨 session 記憶，每次開 popup 都必須手動啟用
      simCfg.autoEnabled = false;
      resolve();
    });
  });
}
let _simStorageWarnedAt = 0;
function saveSimTrades() {
  try {
    // 監測序列化大小：chrome.storage.local 單 key 上限 ~10MB，但持續累積會拖慢 set/get。
    // > 1MB 每 5 分鐘警告一次；> 5MB 強制裁切至最近 500 筆。
    const json = JSON.stringify(simTrades);
    const size = json.length;
    if (size > 5 * 1024 * 1024 && simTrades.length > 500) {
      const before = simTrades.length;
      simTrades.length = 500; // unshift 後較新者在前，保留前 500 筆
      try { console.warn(`[sim] simTrades 已超過 5MB（${(size/1024/1024).toFixed(2)}MB / ${before} 筆），自動裁切為 500 筆`); } catch {}
    } else if (size > 1024 * 1024 && Date.now() - _simStorageWarnedAt > 5 * 60 * 1000) {
      _simStorageWarnedAt = Date.now();
      try { console.warn(`[sim] simTrades 序列化大小 ${(size/1024).toFixed(0)}KB / ${simTrades.length} 筆，建議定期清理`); } catch {}
    }
  } catch {}
  chrome.storage?.local.set({ [SIM_KEY]: simTrades });
}
function saveSimCfg() {
  // 安全：autoEnabled 不寫入 storage，避免重新開啟 popup 就自動下單
  const { autoEnabled, ...persist } = simCfg;
  chrome.storage?.local.set({ [SIM_CFG_KEY]: persist });
}

// 啟動時線上查一次 USD→TWD 匯率（free, no key）。verbose=true 時按鈕點擊會閃動回饋。
let _fxFetchInflight = false;
async function _fetchFxOnline(verbose) {
  if (_fxFetchInflight) return;
  _fxFetchInflight = true;
  const btn = document.getElementById("simFxRefreshBtn");
  if (btn) btn.classList.add("fx-loading");
  // 兩個免費 endpoint，第一個失敗就 fallback
  const urls = [
    "https://open.er-api.com/v6/latest/USD",
    "https://api.exchangerate-api.com/v4/latest/USD"
  ];
  let rate = null;
  for (const u of urls) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(u, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(tid);
      if (!r.ok) continue;
      const j = await r.json();
      const v = +(j?.rates?.TWD);
      if (isFinite(v) && v >= 20 && v <= 50) { rate = v; break; }
    } catch (_) { /* try next */ }
  }
  _fxFetchInflight = false;
  if (btn) btn.classList.remove("fx-loading");
  if (rate == null) {
    if (verbose && btn) { btn.classList.add("fx-fail"); setTimeout(() => btn.classList.remove("fx-fail"), 1200); }
    console.warn("[FX] online lookup failed, keep local", simCfg.fxUsdTwd);
    return;
  }
  const r2 = Math.round(rate * 10) / 10; // 1 decimal
  if (r2 === simCfg.fxUsdTwd) {
    if (verbose && btn) { btn.classList.add("fx-ok"); setTimeout(() => btn.classList.remove("fx-ok"), 1200); }
    return;
  }
  simCfg.fxUsdTwd = r2;
  const fxr = document.getElementById("simCfgFxUsdTwd");
  if (fxr) fxr.value = r2.toFixed(1);
  saveSimCfg();
  try { _renderSimCfgLabels(); } catch (_) {}
  try { renderSimPanel(); } catch (_) {}
  if (btn) { btn.classList.add("fx-ok"); setTimeout(() => btn.classList.remove("fx-ok"), 1200); }
  console.log("[FX] updated USD→TWD =", r2);
}

// 依照 entryMode 計算「限價進場價」。返回 null 表示無法決定（遺失關鍵資料）。
// mode: 0=目前價 1=中間值 2=建議價 3=追價(起始=建議價) 4=追價(起始=中間值) 5=追價(起始=目前價)
// 無建議價時退回目前價（避免阻斷交易）。
function _computeEntryLimit(curPrice, suggestPx, mode) {
  if (!isFinite(curPrice) || curPrice <= 0) return null;
  const m = Math.max(0, Math.min(5, mode | 0));
  if (m === 0 || m === 5) return curPrice;
  if (suggestPx == null || !isFinite(suggestPx) || suggestPx <= 0) return curPrice;
  if (m === 2 || m === 3) return suggestPx; // mode 3 追價起始用建議價
  // mode 1 / 4：中間值（mode 4 也是中間值起始後追價）
  return (curPrice + suggestPx) / 2;
}
function _simEntryModeLabel(m) {
  const v = Math.max(0, Math.min(5, m | 0));
  if (v === 0) return "0 目前價";
  if (v === 1) return "1 中間值";
  if (v === 2) return "2 建議價";
  if (v === 3) return "3 追價·建議";
  if (v === 4) return "4 追價·中間";
  return "5 追價·目前";
}

// ===== 美股輔助 =====
// 匯價進位：股價 ≥ $1 → $0.01；< $1 → $0.0001 (Reg NMS 612)
function _tickRound(px) {
  if (!isFinite(px) || px <= 0) return px;
  const inc = px >= 1 ? 0.01 : 0.0001;
  return Math.round(px / inc) * inc;
}
// 是否在美股連續競價時段（ET 09:30-16:00，週一至五）
function _inUsRth(ts) {
  const d = new Date(ts || Date.now());
  // 轉為 ET 的年月日時分（深入處理 DST）
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d);
  const wd = parts.find(p => p.type === 'weekday')?.value;
  const hh = +parts.find(p => p.type === 'hour')?.value;
  const mm = +parts.find(p => p.type === 'minute')?.value;
  if (wd === 'Sat' || wd === 'Sun') return false;
  const minutes = hh * 60 + mm;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

// 返回當下美股 session: "pre" | "rth" | "post" | "closed"。
function _usSessionOfTs(ts) {
  const d = new Date(ts || Date.now());
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d);
  const wd = parts.find(p => p.type === 'weekday')?.value;
  if (wd === 'Sat' || wd === 'Sun') return "closed";
  const hh = +parts.find(p => p.type === 'hour')?.value;
  const mm = +parts.find(p => p.type === 'minute')?.value;
  const min = hh * 60 + mm;
  if (min >=  4*60        && min <  9*60 + 30) return "pre";
  if (min >=  9*60 + 30   && min < 16*60)      return "rth";
  if (min >= 16*60        && min < 20*60)      return "post";
  return "closed";
}

// 依 sessionMode 判斷當下是否可下單。
function _canTradeNow(sessionMode, ts) {
  const s = _usSessionOfTs(ts);
  if (s === "closed") return false;
  switch (sessionMode) {
    case "rth":     return s === "rth";
    case "rthPre":  return s === "rth" || s === "pre";
    case "rthPost": return s === "rth" || s === "post";
    case "all":     return s !== "closed";
    default:        return s === "rth";
  }
}
function _sessionLabel(s) {
  return s === "pre" ? "盤前" : s === "rth" ? "盤中" : s === "post" ? "盤後" : "休市";
}
function _sessionEmoji(s) {
  return s === "pre" ? "🌅" : s === "rth" ? "☀️" : s === "post" ? "🌆" : "🌙";
}
// 加成手續費：不是 rth 就附加 extendedFeePct
function _feeMultExtended(ts) {
  const ext = Math.max(0, +simCfg.extendedFeePct || 0);
  if (ext <= 0) return 0;
  return _usSessionOfTs(ts) === "rth" ? 0 : ext;
}
// 從 fetchIntraday 結果挑「時間戳最新」的價，避免盤後 regularMarketPrice 凍結造成
// 結算價 / 股價欄停在 4pm 收盤。回傳 { price, ts, src: "pre"|"post"|"reg" }。
// 若全部都沒拿到，回傳 { price: intra.price ?? null, ts: 0, src: "reg" }。
function _pickFreshIntraPrice(intra) {
  if (!intra) return { price: null, ts: 0, src: "reg" };
  const cands = [];
  if (isFinite(intra.preMarketPrice)  && intra.preMarketTime)  cands.push({ price: intra.preMarketPrice,  ts: +intra.preMarketTime,  src: "pre"  });
  if (isFinite(intra.postMarketPrice) && intra.postMarketTime) cands.push({ price: intra.postMarketPrice, ts: +intra.postMarketTime, src: "post" });
  if (isFinite(intra.price)) {
    const regTs = +(intra.meta?.regularMarketTime || 0);
    cands.push({ price: intra.price, ts: regTs, src: "reg" });
  }
  if (!cands.length) return { price: intra.price ?? null, ts: 0, src: "reg" };
  cands.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return cands[0];
}
// 取得目前美東 (ET) 時鍾狀態：HH:MM、EDT/EST、盤前/盤中/盤後/週末、距開盤或收盤的分鐘數
function _getEtClockInfo(ts) {
  const d = new Date(ts || Date.now());
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    timeZoneName: 'short'
  });
  const parts = fmt.formatToParts(d);
  const wd = parts.find(p => p.type === 'weekday')?.value;
  const hh = +parts.find(p => p.type === 'hour')?.value;
  const mm = +parts.find(p => p.type === 'minute')?.value;
  const tz = parts.find(p => p.type === 'timeZoneName')?.value || ''; // EDT or EST
  const isDst = tz === 'EDT';
  const isWeekend = (wd === 'Sat' || wd === 'Sun');
  const mins = hh * 60 + mm;
  const openMin = 9 * 60 + 30, closeMin = 16 * 60, preOpen = 4 * 60, afterClose = 20 * 60;
  let phase, phaseIcon;
  if (isWeekend) { phase = '週末休市'; phaseIcon = '🔴'; }
  else if (mins < preOpen)    { phase = '夜間休市'; phaseIcon = '🌙'; }
  else if (mins < openMin)    { phase = '盤前';     phaseIcon = '🟡'; }
  else if (mins < closeMin)   { phase = '盤中 RTH'; phaseIcon = '🟢'; }
  else if (mins < afterClose) { phase = '盤後';     phaseIcon = '🟡'; }
  else                        { phase = '夜間休市'; phaseIcon = '🌙'; }
  const isRth = !isWeekend && mins >= openMin && mins < closeMin;
  // 距開/收盤
  let nextLabel = '', nextMin = 0;
  if (isRth) { nextLabel = '距收盤'; nextMin = closeMin - mins; }
  else if (!isWeekend && mins < openMin) { nextLabel = '距開盤'; nextMin = openMin - mins; }
  const fmtDur = m => m >= 60 ? `${(m/60|0)}h${m%60}m` : `${m}m`;
  const etStr = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
  // 本地時間 + 時區
  const localHh = String(d.getHours()).padStart(2, '0');
  const localMm = String(d.getMinutes()).padStart(2, '0');
  const localStr = `${localHh}:${localMm}`;
  let localTz = '';
  try {
    const lp = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(d);
    localTz = lp.find(p => p.type === 'timeZoneName')?.value || '';
  } catch (_) {}
  if (!localTz) {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const ah = Math.floor(Math.abs(off) / 60);
    const am = Math.abs(off) % 60;
    localTz = `UTC${sign}${ah}${am ? ':' + String(am).padStart(2,'0') : ''}`;
  }
  let localTzName = '';
  try { localTzName = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}
  return { etStr, tz, isDst, isWeekend, isRth, phase, phaseIcon, nextLabel, nextMin: nextMin > 0 ? fmtDur(nextMin) : '', localStr, localTz, localTzName };
}
// 依頭尾 fee snapshot 計算偶成交後的混損益與 net %。返回 { gross, fee, net, netPct, costBasis }。
// shares/buyFee/sellFeePct 都以 t.* 為準（在下單當下凍結，避免中途調設定影響已開單）
function _simTodayNetPnl() {
  const ds = new Date(); ds.setHours(0,0,0,0);
  const dayStart = ds.getTime();
  let total = 0;
  for (const t of simTrades) {
    if ((t.exitTime || 0) < dayStart) continue;
    if (t.buyPrice == null || t.exitPrice == null) continue;
    const np = _netPnl(t, t.exitPrice);
    if (np) total += np.net;
  }
  return total;
}
function _netPnl(t, exitPx) {
  if (!t || t.buyPrice == null || !isFinite(exitPx)) return null;
  const sh = Math.max(1, t.shares | 0 || 100);
  const buyFee = +t.feeBuyUsd || 0;
  const sellFeePct = +t.feeSellPct || 0;
  const grossDir = t.side === 'up' ? (exitPx - t.buyPrice) : (t.buyPrice - exitPx);
  const gross = grossDir * sh;
  const sellFee = exitPx * sh * sellFeePct + (+t.feeSellUsd || 0);
  const fee = buyFee + sellFee;
  const net = gross - fee;
  const costBasis = t.buyPrice * sh + buyFee;
  const netPct = costBasis > 0 ? net / costBasis : 0;
  return { gross, fee, net, netPct, costBasis };
}

function addSimTrade(sym, targetPct, marketPrice, opts) {
  const _src = (opts && opts.testSource) || ((opts && opts.auto) ? "auto" : "manual");
  if (!sym || !isFinite(marketPrice) || marketPrice <= 0) {
    _logSim("reject", sym || "?", "無效股票代碼或價格", { price: marketPrice, src: _src });
    return null;
  }
  const now = Date.now();
  // 交易時段閘關（取代舊 rthOnly）
  if (!_canTradeNow(simCfg.sessionMode, now)) {
    const lbl = _sessionLabel(_usSessionOfTs(now));
    _logSim("reject", sym, `當下 ${lbl} 不在允許交易時段（sessionMode=${simCfg.sessionMode}）`, { src: _src });
    return null;
  }
  const windowMs = (opts && opts.windowMs) || simCfg.windowMs;
  const auto = !!(opts && opts.auto);
  const suggestPx = (opts && typeof opts.suggestPx === "number") ? opts.suggestPx : null;
  // 限價：依 entryMode 計算。無法計算則退回目前價。計完 snap 到合法 tick。
  let limitPrice = _computeEntryLimit(marketPrice, suggestPx, simCfg.entryMode);
  if (limitPrice == null || !isFinite(limitPrice) || limitPrice <= 0) {
    _logSim("reject", sym, "無法計算限價（_computeEntryLimit 回傳無效）", { price: marketPrice, mode: simCfg.entryMode, src: _src });
    return null;
  }
  limitPrice = _tickRound(limitPrice);
  // 限制：同一 symbol 同時 pending+open 不超過 perSymMax
  const activeSameSym = simTrades.filter(t =>
    (t.status === "open" || t.status === "pending" || t.status === "selling") && t.sym === sym
  ).length;
  if (activeSameSym >= Math.max(1, simCfg.perSymMax | 0)) {
    _logSim("reject", sym, `超過每股上限 perSymMax=${simCfg.perSymMax|0}（目前 active=${activeSameSym}）`, { src: _src });
    return null;
  }
  // 頭尾防呆：同方向同目標 3 秒內重複請求略過
  const dup = simTrades.find(t =>
    (t.status === "pending" || t.status === "open") && t.sym === sym &&
    Math.sign(t.targetPct) === Math.sign(targetPct) &&
    Math.abs(t.targetPct) === Math.abs(targetPct) &&
    (now - (t.placedTime || t.buyTime || 0)) < 3 * 1000
  );
  if (dup) {
    _logSim("reject", sym, `3 秒內重複請求 target=${(targetPct*100).toFixed(2)}%`, { src: _src });
    return null;
  }
  // 金額 = 0 → 不下單（僅做訊號統計）
  if ((+simCfg.amountPerTradeUsd || 0) <= 0) {
    _logSim("reject", sym, "每單金額 = $0（請到規則設定 → 倒金子 調高金額）", { src: _src });
    return null;
  }
  // 手續費上限：預估「來回手續費 ÷ 實際成交金額」超過門檻就跳過
  //   ₣ 分母用「實際成交」而非「預算」：高價股被除不盡有大奇零頭時，分母變小會讓手續費比例反映真實抽成
  const _maxFeePct = Math.max(0, Math.min(1, +simCfg.maxFeePctOfAmount || 0));
  if (_maxFeePct > 0) {
    const _amt = +simCfg.amountPerTradeUsd || 0;
    const _estShares = Math.max(1, Math.floor(_amt / Math.max(0.0001, limitPrice)) || 1);
    const _estCost = _estShares * limitPrice;
    const _estFee = (+simCfg.feeBuyUsd || 0) + _estCost * (+simCfg.feeBuyPct || 0)
                  + (+simCfg.feeSellUsd || 0) + _estCost * (+simCfg.feeSellPct || 0);
    const _feeRatio = _estFee / Math.max(0.0001, _estCost);
    if (_feeRatio > _maxFeePct) {
      // 同一 sym + ratio bucket 每 60 秒最多輸出一次（auto-scan 每 5 秒會反覆觸發同樣的拒絕）
      _logOnce(`fee-skip:${sym}:${(_feeRatio*100).toFixed(2)}`, 60_000, () => console.log(`[sim] 跳過 ${sym}: 預估手續費 $${_estFee.toFixed(2)} / 成交 $${_estCost.toFixed(2)} = ${(_feeRatio*100).toFixed(3)}% > 上限 ${(_maxFeePct*100).toFixed(2)}%（${_estShares} 股 @ $${limitPrice.toFixed(2)}）`));
      _logSim("reject", sym, `手續費比例 ${(_feeRatio*100).toFixed(2)}% > 上限 ${(_maxFeePct*100).toFixed(2)}%`, { fee: _estFee.toFixed(2), cost: _estCost.toFixed(2), src: _src });
      return null;
    }
  }
  const isChase = (simCfg.entryMode | 0) >= 3;
  const chaseMaxMs = Math.max(10, Math.min(1000, simCfg.chaseMaxSec | 0 || 120)) * 1000;
  const chaseBumpMs = Math.max(10, Math.round(Math.min(60, Math.max(0.01, +simCfg.chaseBumpSec || 0.1)) * 1000));
  // 加價步幅：以下單時市價 * pct%。最少 1 tick ($0.01 / $0.0001)。
  const tickInc = marketPrice >= 1 ? 0.01 : 0.0001;
  const chaseStepPx = Math.max(tickInc, marketPrice * (Math.max(0.01, Math.min(25, +simCfg.chaseBumpPct || 0.01)) / 100));
  const panicGapPct = Math.max(0, Math.min(5, +simCfg.chasePanicGapPct || 0)) / 100; // 0 = 關閉
  const panicMul    = Math.max(1, Math.min(50, +simCfg.chasePanicMul | 0 || 10));
  const t = {
    id: now + "-" + Math.random().toString(36).slice(2, 7),
    sym, side: targetPct >= 0 ? "up" : "down",
    targetPct,
    // 生命週期：pending → open → win/loss；或 pending → unfilled
    status: "pending",
    placedTime: now,        // 下單時間
    entrySession: _usSessionOfTs(now),  // 下單當下 session 標記：pre/rth/post
    placedPrice: marketPrice, // 下單當下市價（供參考）
    limitPrice,             // 限價：需 intra.price ≤ limitPrice 才成交（追價模式下會隨 tick 上調）
    entryModeAt: simCfg.entryMode | 0, // 下單時的買入策略；mode 0 = 市價單、3s 後以市價成交
    // 追價(mode 3)專用欄位
    chaseBumpMs:  isChase ? chaseBumpMs : null,
    chaseStepPx:  isChase ? chaseStepPx : null,
    chasePanicGapPct: isChase ? panicGapPct : null,
    chasePanicMul:    isChase ? panicMul    : null,
    panicBumpCount:   isChase ? 0 : null,
    lastBumpTime: isChase ? now : null,
    bumpCount:    isChase ? 0 : null,
    initLimit:    isChase ? limitPrice : null, // 起始限價（供顯示）
    buyTime: null,          // 成交時間
    buyPrice: null,         // 成交價（成交時記錄 intra.price）
    exitTime: null, exitPrice: null,
    // 下單時的美東 session（pre / rth / post / closed），方便事後辨識為何此單在某時段成交
    entrySession: _usSessionOfTs(now),
    peakPct: 0,
    // 「追價時限」只控制 pending 階段（未成交 → unfilled 的時限）
    // 「測試時長」(windowMs) 一律用使用者設定，控制 open → loss 強平
    fillTimeoutMs: isChase ? chaseMaxMs : windowMs,
    windowMs,
    auto,
    wr030At: (opts && typeof opts.wr030 === "number") ? opts.wr030 : null,
    wr050At: (opts && typeof opts.wr050 === "number") ? opts.wr050 : null,
    wr050dAt: (opts && typeof opts.wr050d === "number") ? opts.wr050d : null,
    suggestPxAt: suggestPx,
    low10: null, low30: null, low60: null, lowAll: null,
    // ===== 手續費 / 風控 snapshot（下單時凍結）=====
    amountUsd:   Math.max(0, +simCfg.amountPerTradeUsd || 0),
    shares:      Math.max(1, Math.floor((Math.max(0, +simCfg.amountPerTradeUsd || 0)) / Math.max(0.0001, limitPrice)) || 1),
    feeBuyUsd:   (+simCfg.feeBuyUsd || 0) + (Math.max(0, +simCfg.amountPerTradeUsd || 0) * ((+simCfg.feeBuyPct || 0) + _feeMultExtended(now))),
    feeBuyFlatUsd: +simCfg.feeBuyUsd || 0,
    feeBuyPct:   (+simCfg.feeBuyPct || 0) + _feeMultExtended(now),
    feeSellPct:  (+simCfg.feeSellPct || 0) + _feeMultExtended(now),
    feeSellUsd:  +simCfg.feeSellUsd || 0,
    extendedFeePctAt: _feeMultExtended(now), // 已加成的 ext fee ％（0 = 未加成）
    stopLossPct: Math.max(0, +simCfg.stopLossPct || 0),
    trailingStopPct: Math.max(0, +simCfg.trailingStopPct || 0),
    fillModeAt:  (simCfg.fillMode === 'optimistic') ? 'optimistic' : 'strict',
  };
  simTrades.unshift(t);
  if (simTrades.length > 200) simTrades.length = 200;

  // 記錄手動測試來源（以便日誌 / 過濾）
  if (opts && opts.testSource) t.testSource = String(opts.testSource);

  // 執行模式判定：opts.executionMode 可強制覆寫全域設定
  //   'local' = 本機模擬； 'ws' = WS 實交；undefined = 依 simCfg.executionMode
  let useWs;
  if (opts && opts.executionMode === 'ws') useWs = true;
  else if (opts && opts.executionMode === 'local') useWs = false;
  else useWs = ((simCfg.executionMode | 0) === 1);

  // 若啟用 WS 真實下單，透過 TradingService 開單；本地 trade record 只作鏡像
  if (useWs && window.tradingClient && window.tradingClient.connected) {
    t.source = "ws";
    t.wsId = null;
    const wsQty = Math.max(1, +t.shares || 1);
    _logSim("ws-sent", sym, `送出 WS openTrade (${wsQty} 股 @ $${limitPrice.toFixed(2)}, target=${(targetPct*100).toFixed(2)}%)`, { src: (opts && opts.testSource) || "auto" });
    window.tradingClient
      .openTrade(sym, wsQty, +limitPrice.toFixed(4), Math.abs(targetPct))
      .then(data => {
        if (data && data.id) {
          t.wsId = data.id;
          _applyWsTradeUpdate(t, data);
          saveSimTrades();
          renderSimPanel();
        }
      })
      .catch(err => {
        console.warn("[ws] openTrade failed", err);
        t.status = "unfilled";
        t.exitTime = Date.now();
        t.lastError = String((err && err.message) || err);
        _logSim("ws-error", sym, `WS openTrade 失敗：${t.lastError}`, null);
        saveSimTrades();
        renderSimPanel();
      });
  } else {
    t.source = "local";
    if (useWs) {
      // 使用者選 WS 但未連線 → 退回本機並記錄
      _logSim("reject", sym, "指定走 WS 但 TradingService 未連線，已退回本機模擬", { src: (opts && opts.testSource) || "manual" });
    }
    _logSim("accept", sym, `建立${useWs ? "本機(退回)" : "本機模擬"}單：${t.shares} 股 @ $${limitPrice.toFixed(2)}，target=${(targetPct*100).toFixed(2)}%`, { src: (opts && opts.testSource) || (auto ? "auto" : "manual") });
  }

  saveSimTrades();
  renderSimPanel();
  return t;
}

// 將 TradingService trade_update 套用到本地 t（依 server state mapping）
function _applyWsTradeUpdate(t, d) {
  if (!t || !d) return;
  const state = String(d.state || "");
  // 嚴格驗證 WS 回傳的成交價：必須為有限正數，否則忽略並警告（避免 NaN 汙染 PnL）
  const _safePx = (v) => { const p = +v; return (isFinite(p) && p > 0) ? p : null; };
  if (d.buy_filled_price != null && t.buyPrice == null) {
    const bp = _safePx(d.buy_filled_price);
    if (bp == null) {
      _logOnce(`ws-bad-buy:${t.sym}`, 30_000, () => console.warn("[ws] ignored invalid buy_filled_price:", d.buy_filled_price, "for", t.sym, t.wsId));
    } else {
      t.buyPrice = bp;
      t.buyTime = d.buy_filled_utc ? (Date.parse(d.buy_filled_utc) || Date.now()) : Date.now();
      t.low10 = t.buyPrice; t.low30 = t.buyPrice; t.low60 = t.buyPrice; t.lowAll = t.buyPrice;
    }
  }
  if (d.sell_filled_price != null) {
    const sp = _safePx(d.sell_filled_price);
    if (sp == null) {
      _logOnce(`ws-bad-sell:${t.sym}`, 30_000, () => console.warn("[ws] ignored invalid sell_filled_price:", d.sell_filled_price, "for", t.sym, t.wsId));
    } else {
      t.exitPrice = sp;
      t.exitTime = d.sell_filled_utc ? (Date.parse(d.sell_filled_utc) || Date.now()) : Date.now();
    }
  }
  switch (state) {
    case "New":
    case "BuyPending":
    case "BuyCancelling":
      t.status = "pending"; break;
    case "BuyFilled":
    case "SellPending":
      t.status = "open"; break;
    case "SellFilled":
      t.status = "win"; break;
    case "BuyCanceled":
    case "BuyRejected":
    case "Expired":
      t.status = "unfilled"; if (!t.exitTime) t.exitTime = Date.now(); break;
    case "Failed":
    case "SellCanceled":
      t.status = t.buyPrice != null ? "loss" : "unfilled";
      if (!t.exitTime) t.exitTime = Date.now();
      break;
  }
  if (d.last_error) t.lastError = d.last_error;
}

// WS server push 進入點
function _onTradeUpdate(data) {
  if (!data || !data.id) return;
  const t = simTrades.find(x => x.wsId === data.id);
  if (!t) return;
  _applyWsTradeUpdate(t, data);
  saveSimTrades();
  renderSimPanel();
}

// 連線狀態小指示器
function _renderWsStatus() {
  const el = document.getElementById("simWsStatus");
  if (!el) return;
  const tc = window.tradingClient;
  const on = (simCfg.executionMode | 0) === 1;
  if (!on) { el.textContent = "本機模擬"; el.className = "sim-pill"; return; }
  if (tc && tc.connected) { el.textContent = "WS 已連線"; el.className = "sim-pill sim-pill-win"; }
  else { el.textContent = "WS 連線中…"; el.className = "sim-pill sim-pill-unfilled"; }
}

function initTradingClient() {
  const tc = window.tradingClient;
  if (!tc) { console.warn("tradingClient.js not loaded"); return; }
  tc.on("open",  () => _renderWsStatus());
  tc.on("close", () => _renderWsStatus());
  tc.on("error", () => _renderWsStatus());
  tc.on("trade_update", _onTradeUpdate);
  if ((simCfg.executionMode | 0) === 1) tc.connect(simCfg.wsUrl || tc.DEFAULT_URL);
  _renderWsStatus();
}

// 出場觸發共用：
//   target  → 一律「立刻以目標價限價成交」（買入後即視為已掛在目標價的賣單，price 達標就 fill）
//   stop/trail/timeout → 依 exitMode 立刻市價或進入 selling（追低）狀態
function _triggerExit(t, reason, marketPrice, now) {
  // 達標：不走追價，不受 exitMode 影響——買入瞬間就有一張賣在 target 的限價單在等
  if (reason === "target") {
    // 成交價：strict = 恢偍按 target 限價成交（buyPrice × (1+|targetPct|)）；optimistic = 使用市價 spike（高於 target）
    const targetLimitPx = (t.buyPrice != null && t.targetPct != null)
      ? _tickRound(t.buyPrice * (1 + Math.abs(t.targetPct)))
      : marketPrice;
    const fillPx = (t.fillModeAt === 'optimistic')
      ? Math.max(marketPrice, targetLimitPx)
      : targetLimitPx;
    t.status = "win";
    t.exitTime = now;
    t.exitPrice = fillPx;
    t.exitReason = "target";
    // strict 限價已先成交 → peakPct 不應高於 fill 的 net%（避免盤後補 tick 把 peak 衝到不切實際的高位）
    const npAtFill = _netPnl(t, fillPx);
    if (npAtFill && isFinite(npAtFill.netPct)) {
      if (t.peakPct == null || t.peakPct > npAtFill.netPct) {
        t.peakPct = npAtFill.netPct;
      }
    }
    return;
  }
  const exitMode = (+simCfg.exitMode | 0);
  if (exitMode === 0) {
    // 0 = 市價立刻成交（僅 stop/trail/timeout 適用）
    if (reason === "stop") { t.status = "loss"; t.stopHit = true; }
    else if (reason === "trail") {
      const np = _netPnl(t, marketPrice);
      t.status = (np && np.netPct > 0) ? "win" : "loss";
      t.trailHit = true;
    } else { t.status = "loss"; } // timeout
    t.exitTime = now; t.exitPrice = marketPrice; t.exitReason = reason;
    return;
  }
  // 1 = 追價賣出：進入 selling 狀態，由 settle 迴圈每 tick 往下調 sellLimit（直到成交為止，不設時限）
  const bumpMs = Math.max(10, Math.round(Math.min(60, Math.max(0.01, +simCfg.exitChaseBumpSec || 0.1)) * 1000));
  const tickInc = marketPrice >= 1 ? 0.01 : 0.0001;
  const stepPx = Math.max(tickInc, marketPrice * (Math.max(0.01, Math.min(25, +simCfg.exitChaseBumpPct || 0.01)) / 100));
  t.status = "selling";
  t.exitReason = reason;
  t.exitModeAt = exitMode;
  t.sellLimit = _tickRound(marketPrice);
  t.sellInitLimit = t.sellLimit;
  t.sellPlacedTime = now;
  t.sellLastBumpTime = now;
  t.sellBumpCount = 0;
  t.sellPanicBumpCount = 0;
  t.exitChaseBumpMs = bumpMs;
  t.exitChaseStepPx = stepPx;
  // 凍結狂跌設定（下單當下快照，不受中途設定變動影響）
  t.exitChasePanicGapPct = Math.max(0, Math.min(5, +simCfg.exitChasePanicGapPct || 0)) / 100;
  t.exitChasePanicMul    = Math.max(1, Math.min(50, +simCfg.exitChasePanicMul | 0 || 10));
}

function settleSimTradesForSymbol(sym, intra) {
  if (!intra || !isFinite(intra.price)) return;
  const now = Date.now();
  let changed = false;
  for (const t of simTrades) {
    if (t.sym !== sym) continue;
    // 不論狀態 / 來源都更新「最近一次看到的市價」，給 UI 顯示「目前股價」用
    if (t.lastPrice !== intra.price) { t.lastPrice = intra.price; t.lastPriceTime = now; changed = true; }
    if (t.source === "ws") continue; // WS 模式由 TradingService 主導，本地不結算

    // pending → open：至少等 3 秒，且 intra.price ≤ limitPrice 才算成交
    if (t.status === "pending") {
      const waited = now - (t.placedTime || now);
      // 未成交逾時：追價模式用 fillTimeoutMs，其他模式 fallback 到 windowMs
      const pendingLimit = t.fillTimeoutMs || t.windowMs;
      if (waited >= pendingLimit) {
        t.status = "unfilled"; t.exitTime = now; changed = true;
        continue;
      }
      if (waited < SIM_FILL_DELAY_MS) continue; // 未到最小延遲
      const modeAt = (t.entryModeAt | 0);
      // mode 0 視為「市價單」：3 秒後直接以市價成交，不用限價卡關
      const isMarketOrder = modeAt === 0;
      // mode 3/4/5 追價：未成交且滿足加價間隔→上調限價
      // 注意：限價必須能「高於」當下市價，否則 strict 模式（intra.price < limit 才成交）永遠不會成交。
      // 若市價跌回限價之下，仍維持原 limit（不主動降價）。
      if (modeAt >= 3 && !isMarketOrder && intra.price >= t.limitPrice) {
        const bumpMs = t.chaseBumpMs || 10000;
        const baseStep = t.chaseStepPx || 0.01;
        // 狂飄判定：「市價 - 限價」 / 限價 ≥ panicGapPct。觸發則跳過 bumpMs 節流、step × mul、並強制限價跳到市價 + tick
        const panicGap = +t.chasePanicGapPct || 0;
        const panicMul = +t.chasePanicMul    || 1;
        const gapRatio = (intra.price - t.limitPrice) / Math.max(0.0001, t.limitPrice);
        const isPanic  = (panicGap > 0) && (gapRatio >= panicGap);
        const canBump  = isPanic || (t.lastBumpTime != null && (now - t.lastBumpTime) >= bumpMs);
        if (canBump) {
          const step = isPanic ? (baseStep * panicMul) : baseStep;
          // 一般：limit + step。狂飄：max(limit + step×mul, intra.price + 1 tick)——一路跳到超過市價以上
          const tickInc = intra.price >= 1 ? 0.01 : 0.0001;
          const raw = isPanic
            ? Math.max(t.limitPrice + step, intra.price + tickInc)
            : (t.limitPrice + step);
          const newLimit = _tickRound(raw); // snap 到合法 tick
          if (newLimit > t.limitPrice + 1e-9) {
            t.limitPrice = newLimit;
            t.lastBumpTime = now;
            t.bumpCount = (t.bumpCount | 0) + 1;
            if (isPanic) t.panicBumpCount = (t.panicBumpCount | 0) + 1;
            // 追價推升限價後，依固定預算重算股數，避免成交後超出原始下單金額
            if (t.amountUsd != null && t.amountUsd > 0) {
              const newShares = Math.max(1, Math.floor(t.amountUsd / Math.max(0.0001, newLimit)) || 1);
              if (newShares !== t.shares) t.shares = newShares;
            }
            changed = true;
          }
        }
      }
      // 成交判定：依 fillMode
      //   strict (保守)：需 last 嚴格 < limit、成交價 = limit（模擬「只吃到 limit」）
      //   optimistic：   需 last ≤ limit、成交價 = last（可能比 limit 更低，偏樂觀）
      const fm = t.fillModeAt || 'strict';
      let filled = false, buyPx = null;
      if (isMarketOrder) { filled = true; buyPx = intra.price; }
      else if (fm === 'optimistic' && intra.price <= t.limitPrice) { filled = true; buyPx = intra.price; }
      else if (fm === 'strict' && intra.price < t.limitPrice) { filled = true; buyPx = t.limitPrice; }
      if (filled) {
        t.status = "open";
        t.buyTime = now;
        t.buyPrice = buyPx;
        t.low10 = buyPx; t.low30 = buyPx; t.low60 = buyPx; t.lowAll = buyPx;
        changed = true;
      }
      // 未成交仍保持 pending，等後續 tick
      continue;
    }

    if (t.status !== "open" && t.status !== "selling") continue;
    // selling 狀態：執行賣出追價（每 N 秒往下調 sellLimit，達 intra.price >= sellLimit 即成交）
    if (t.status === "selling") {
      // 成交判定：mode 0 = 市價（立刻填）；mode 1 = strict: intra.price >= sellLimit
      let filled = false, sellPx = null;
      if ((t.exitModeAt | 0) === 0) {
        filled = true; sellPx = intra.price;
      } else if (intra.price >= t.sellLimit) {
        filled = true;
        // fillMode 同買進邏輯：strict=sellLimit、optimistic=intra.price（賣方拿更好 = 更高價）
        sellPx = (t.fillModeAt === 'optimistic') ? intra.price : t.sellLimit;
      } else {
        // 未成交：判斷是否該往下 bump（無時限：持續往下追到成交為止）
        const bumpMs = t.exitChaseBumpMs || 10000;
        const baseStep = t.exitChaseStepPx || 0.01;
        // 狂跌判定：「sellLimit - 市價」 / sellLimit ≥ panicGapPct。觸發則跳過 bumpMs 節流、step × mul、並強制限價跳到市價 - tick 以下
        const panicGap = +t.exitChasePanicGapPct || 0;
        const panicMul = +t.exitChasePanicMul    || 1;
        const gapRatio = (t.sellLimit - intra.price) / Math.max(0.0001, t.sellLimit);
        const isPanic  = (panicGap > 0) && (gapRatio >= panicGap);
        const canBump  = isPanic || (t.sellLastBumpTime != null && (now - t.sellLastBumpTime) >= bumpMs);
        if (canBump) {
          const step = isPanic ? (baseStep * panicMul) : baseStep;
          // 一般：sellLimit - step。狂跌：min(sellLimit - step×mul, intra.price - 1 tick)—一路殺到市價以下吃對手 bid
          const tickInc = intra.price >= 1 ? 0.01 : 0.0001;
          const raw = isPanic
            ? Math.min(t.sellLimit - step, intra.price - tickInc)
            : (t.sellLimit - step);
          const newLimit = _tickRound(raw);
          if (newLimit < t.sellLimit - 1e-9 && newLimit > 0) {
            t.sellLimit = newLimit;
            t.sellLastBumpTime = now;
            t.sellBumpCount = (t.sellBumpCount | 0) + 1;
            if (isPanic) t.sellPanicBumpCount = (t.sellPanicBumpCount | 0) + 1;
            changed = true;
          }
        }
      }
      if (filled) {
        const npAtFill = _netPnl(t, sellPx);
        const npctFill = npAtFill ? npAtFill.netPct : 0;
        // 依「離場原因」決定 win/loss + 屬性
        const reason = t.exitReason || "timeout";
        if (reason === "target") { t.status = "win"; }
        else if (reason === "stop") { t.status = "loss"; t.stopHit = true; }
        else if (reason === "trail") { t.status = (npctFill > 0) ? "win" : "loss"; t.trailHit = true; }
        else { t.status = "loss"; } // timeout
        t.exitTime = now; t.exitPrice = sellPx; changed = true;
      }
      continue;
    }
    // open: 記錄 10/30/60 秒內最低價（以「成交後」為起點）
    const elapsed = now - t.buyTime;
    if (elapsed <= 10 * 1000 && (t.low10 == null || intra.price < t.low10)) { t.low10 = intra.price; changed = true; }
    if (elapsed <= 30 * 1000 && (t.low30 == null || intra.price < t.low30)) { t.low30 = intra.price; changed = true; }
    if (elapsed <= 60 * 1000 && (t.low60 == null || intra.price < t.low60)) { t.low60 = intra.price; changed = true; }
    if (t.lowAll == null || intra.price < t.lowAll) { t.lowAll = intra.price; changed = true; }
    // ===== 以「混 PnL %（含手續費）」判定達標/停損 =====
    const np = _netPnl(t, intra.price);
    const npct = np ? np.netPct : 0;
    if (npct > (t.peakPct || -Infinity)) { t.peakPct = npct; changed = true; }
    const target = Math.abs(t.targetPct);
    const trailOn = (t.trailingStopPct || 0) > 0;
    // 移動停利啟動旗標：當 trailing 啟用、且本筆峰值曾達 target → 進入「鎖獲利」狀態
    if (trailOn && !t.trailArmed && (t.peakPct || 0) >= target) {
      t.trailArmed = true; changed = true;
    }
    // 出場觸發 → 透過 _triggerExit() 走「立刻」或「追價」
    let exitReason = null;
    if (trailOn && t.trailArmed && ((t.peakPct || 0) - npct) >= t.trailingStopPct) {
      exitReason = "trail";
    } else if (!t.trailArmed && npct >= target) {
      exitReason = "target";
    } else if (t.stopLossPct > 0 && npct <= -t.stopLossPct) {
      exitReason = "stop";
    } else if (now - t.buyTime >= t.windowMs) {
      exitReason = "timeout";
    }
    if (exitReason) {
      _triggerExit(t, exitReason, intra.price, now);
      changed = true;
    }
  }
  if (changed) { saveSimTrades(); renderSimPanel(); }
}

function expireOldSimTrades() {
  const now = Date.now();
  let changed = false;
  for (const t of simTrades) {
    if (t.source === "ws") continue; // WS 模式由 TradingService 控制過期
    const pendingLimit = t.fillTimeoutMs || t.windowMs;
    if (t.status === "pending" && now - (t.placedTime || now) >= pendingLimit) {
      t.status = "unfilled"; t.exitTime = now; changed = true;
    } else if (t.status === "open" && now - t.buyTime >= t.windowMs) {
      t.status = "loss"; t.exitTime = now; t.exitPrice = t.exitPrice ?? null; changed = true;
    }
  }
  if (changed) { saveSimTrades(); renderSimPanel(); }
}

function clearSettledSimTrades() {
  simTrades = simTrades.filter(t => t.status === "open" || t.status === "pending" || t.status === "selling");
  saveSimTrades(); renderSimPanel();
}
function clearAllSimTrades() {
  if (!confirm("確定清除所有模擬交易紀錄？")) return;
  simTrades = []; saveSimTrades(); renderSimPanel();
}
// 刪除單一筆模擬交易（供右鍵選單使用）
function removeSimTradeById(id) {
  if (id == null) return false;
  const idx = simTrades.findIndex(x => String(x.id) === String(id));
  if (idx < 0) return false;
  simTrades.splice(idx, 1);
  saveSimTrades(); renderSimPanel();
  return true;
}

function _simFmtClock(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ===== 模擬下單嘗試紀錄（含被規則 block 的原因）=====
const _simLog = [];   // 最近 80 筆，新的在前
function _logSim(action, sym, reason, detail) {
  try {
    _simLog.unshift({
      t: Date.now(),
      action,                          // "accept" / "reject" / "ws-sent" / "ws-error"
      sym: String(sym || "?"),
      reason: String(reason || ""),
      detail: detail || null,
    });
    if (_simLog.length > 80) _simLog.length = 80;
    _renderSimLog();
  } catch (_) {}
}
function _renderSimLog() {
  const el = document.getElementById("simLogList");
  if (!el) return;
  if (!_simLog.length) {
    el.innerHTML = `<div class="sim-log-empty">尚無紀錄。當你按下機率膠囊 / 📡 WS 試單時，這裡會顯示被接受或被規則阻擋的原因。</div>`;
    return;
  }
  const iconMap = {
    "accept":   { ic: "✅", cls: "sim-log-ok" },
    "ws-sent":  { ic: "📡", cls: "sim-log-ws" },
    "reject":   { ic: "⛔", cls: "sim-log-bad" },
    "ws-error": { ic: "⚠️", cls: "sim-log-bad" },
  };
  // 防 XSS：reason / sym / detail 任一欄將來可能含外部資料（WS server、API 字串），
  // 一律用 textContent / createElement 組裝 DOM，不用 innerHTML 拼字串。
  const frag = document.createDocumentFragment();
  for (const e of _simLog) {
    const meta = iconMap[e.action] || { ic: "·", cls: "" };
    const row = document.createElement("div");
    row.className = `sim-log-row ${meta.cls}`;
    const span = (cls, text) => {
      const s = document.createElement("span");
      s.className = cls;
      s.textContent = text;
      return s;
    };
    row.appendChild(span("sim-log-time", _simFmtClock(e.t)));
    row.appendChild(span("sim-log-ic", meta.ic));
    row.appendChild(span("sim-log-sym", e.sym));
    row.appendChild(span("sim-log-reason", e.reason));
    if (e.detail && typeof e.detail === "object") {
      const parts = [];
      for (const k of Object.keys(e.detail)) {
        const v = e.detail[k];
        if (v == null || v === "") continue;
        parts.push(`${k}=${v}`);
      }
      if (parts.length) {
        const detSpan = span("sim-log-det", ` [${parts.join(" · ")}]`);
        row.appendChild(detSpan);
      }
    }
    frag.appendChild(row);
  }
  el.replaceChildren(frag);
}
function _simFmtDur(ms) {
  if (ms == null || !isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s/60)}m${String(s%60).padStart(2,"0")}s`;
}
// WS 模式專用：對仍可取消的 trade（pending / open 且有 wsId）顯示「✕」按鈕
function _wsCancelBtn(t) {
  if (!t || t.source !== "ws" || !t.wsId) return "";
  if (t.status !== "pending" && t.status !== "open") return "";
  if (t.cancelRequested) {
    return ` <span class="sim-ws-cancelling" title="已送出刪單，等待 TradingService 確認…">⏳取消中</span>`;
  }
  const label = t.status === "open" ? "✕ 平倉" : "✕ 刪單";
  const tip = t.status === "open"
    ? `送出「賣出指令」給 TradingService（id=${t.wsId}）；實際結果以 server 推回的 SellPending/SellFilled 為準`
    : `送出「取消買單」給 TradingService（id=${t.wsId}）；實際結果以 server 推回的 BuyCancelling/BuyCanceled 為準`;
  return ` <button type="button" class="sim-ws-cancel" data-trade-id="${t.id || ''}" data-ws-id="${t.wsId}" title="${tip}">${label}</button>`;
}

function renderSimPanel() {
  const tbody = document.getElementById("simTbody");
  const statsEl = document.getElementById("simStats");
  if (!tbody) return;
  const settled = simTrades.filter(t => t.status === "win" || t.status === "loss" || t.status === "unfilled");
  const wins = settled.filter(t => t.status === "win").length;
  const filledSettled = settled.filter(t => t.status === "win" || t.status === "loss");
  const losses = filledSettled.length - wins;
  const stopHits = filledSettled.filter(t => t.status === "loss" && t.stopHit).length;
  const timeouts = losses - stopHits;
  const unfilled = settled.filter(t => t.status === "unfilled").length;
  const wr = filledSettled.length ? Math.round(wins / filledSettled.length * 100) + "%" : "--";
  const open = simTrades.filter(t => t.status === "open" || t.status === "selling").length;
  const pending = simTrades.filter(t => t.status === "pending").length;
  // 平均持有時間：所有已成交並離場的平均（不只看 win）
  const allDurs = filledSettled.filter(t => t.exitTime && t.buyTime).map(t => t.exitTime - t.buyTime);
  const avgDur = allDurs.length ? allDurs.reduce((a,b)=>a+b,0) / allDurs.length : null;
  // 含手續費的累計淨損益 + 平均淨 %
  let netSum = 0, netCount = 0, netSumPct = 0;
  for (const t of filledSettled) {
    if (t.buyPrice == null || t.exitPrice == null) continue;
    const np = _netPnl(t, t.exitPrice);
    if (np) { netSum += np.net; netSumPct += np.netPct; netCount++; }
  }
  const netAvgPct = netCount ? (netSumPct / netCount) : null;
  const netSumStr = netCount ? (netSum >= 0 ? "+$" + netSum.toFixed(2) : "-$" + Math.abs(netSum).toFixed(2)) : "$0.00";
  const netAvgPctStr = netAvgPct == null ? "--" : ((netAvgPct >= 0 ? "+" : "") + (netAvgPct * 100).toFixed(3) + "%");
  const netCls = netSum > 0 ? "sim-pill-win" : (netSum < 0 ? "sim-pill-loss" : "");
  // 未實現損益：持有中 (open / selling) 以 lastPrice 估算的 live PnL 累計
  let unrealNet = 0, unrealCount = 0;
  for (const t of simTrades) {
    if ((t.status !== "open" && t.status !== "selling") || t.buyPrice == null || t.lastPrice == null) continue;
    const np = _netPnl(t, t.lastPrice);
    if (np) { unrealNet += np.net; unrealCount++; }
  }
  const unrealStr = unrealCount ? (unrealNet >= 0 ? "+$" + unrealNet.toFixed(2) : "-$" + Math.abs(unrealNet).toFixed(2)) : "—";
  const unrealCls = unrealCount === 0 ? "" : (unrealNet > 0 ? "sim-pill-win" : (unrealNet < 0 ? "sim-pill-loss" : ""));
  // ===== 今日統計：以本地今日 0:00 為界（依據 exitTime，未離場不計）=====
  const _dayStart = new Date(); _dayStart.setHours(0,0,0,0);
  const dayStartMs = _dayStart.getTime();
  const todayFilledSettled = filledSettled.filter(t => (t.exitTime || 0) >= dayStartMs);
  const todayWins = todayFilledSettled.filter(t => t.status === "win").length;
  const todayWr = todayFilledSettled.length ? Math.round(todayWins / todayFilledSettled.length * 100) + "%" : "--";
  let todayNet = 0, todayNetCount = 0;
  for (const t of todayFilledSettled) {
    if (t.buyPrice == null || t.exitPrice == null) continue;
    const np = _netPnl(t, t.exitPrice);
    if (np) { todayNet += np.net; todayNetCount++; }
  }
  const todayDurs = todayFilledSettled.filter(t => t.buyTime && t.exitTime).map(t => t.exitTime - t.buyTime);
  const todayAvgDur = todayDurs.length ? todayDurs.reduce((a,b)=>a+b,0) / todayDurs.length : null;
  const todayNetStr = todayNetCount ? (todayNet >= 0 ? "+$" + todayNet.toFixed(2) : "-$" + Math.abs(todayNet).toFixed(2)) : "$0.00";
  const todayNetCls = todayNet > 0 ? "sim-pill-win" : (todayNet < 0 ? "sim-pill-loss" : "");
  if (statsEl) {
    statsEl.innerHTML =
      // —— 現場狀態 ——
      `<span class="sim-stats-label">現場</span>` +
      `<span class="sim-pill">挂單 <b>${pending}</b></span>` +
      `<span class="sim-pill">持有中 <b>${open}</b>/<b>${simCfg.concurrency}</b></span>` +
      `<span class="sim-pill">已結算 <b>${filledSettled.length}</b></span>` +
      `<span class="sim-pill-divider">|</span>` +
      // —— 離場原因拆解 ——
      `<span class="sim-stats-label">結果</span>` +
      `<span class="sim-pill sim-pill-win" title="達標離場">達標 <b>${wins}</b></span>` +
      `<span class="sim-pill sim-pill-loss" title="觸發停損">停損 <b>${stopHits}</b></span>` +
      `<span class="sim-pill sim-pill-loss" title="超過 windowMs 仍未達標">逾時 <b>${timeouts}</b></span>` +
      `<span class="sim-pill sim-pill-unfilled" title="掛單期間未成交">未成交 <b>${unfilled}</b></span>` +
      `<span class="sim-pill-divider">|</span>` +
      // —— 總計 ——
      `<span class="sim-stats-label">總計</span>` +
      `<span class="sim-pill"><span>勝率</span> <b>${wr}</b></span>` +
      `<span class="sim-pill" title="已離場平均持有時間（含賠單）"><span>平均持有</span> <b>${_simFmtDur(avgDur)}</b></span>` +
      `<span class="sim-pill ${netCls}" title="含手續費的累計淨損益（只計 win/loss）">淨損益 <b>${netSumStr}</b></span>` +
      `<span class="sim-pill ${unrealCls}" title="未實現損益：持有中 (open/selling) ${unrealCount} 筆以目前市價估算的浮動淨 PnL，含手續費">未實現 <b>${unrealStr}</b></span>` +
      `<span class="sim-pill" title="已離場算出的平均淨 %">平均淨% <b>${netAvgPctStr}</b></span>` +
      `<span class="sim-pill-divider" title="以今日 0:00 為界">|</span>` +
      // —— 今日 ——
      `<span class="sim-stats-label sim-stats-label-today">今日</span>` +
      `<span class="sim-pill sim-pill-today ${todayNetCls}" title="今日已離場合計淨損益">淨 <b>${todayNetStr}</b></span>` +
      `<span class="sim-pill sim-pill-today" title="今日 win/(win+loss)">勝率 <b>${todayWr}</b> <span class="sim-pill-sub">(${todayWins}/${todayFilledSettled.length})</span></span>` +
      `<span class="sim-pill sim-pill-today" title="今日平均持有時長">平均 <b>${_simFmtDur(todayAvgDur)}</b></span>`;
  }
  const rows = simTrades.slice(0, 80);
  tbody.innerHTML = rows.map(t => {
    const dirLabel = t.targetPct > 0 ? `+${(t.targetPct*100).toFixed(1)}%↑` : `${(t.targetPct*100).toFixed(1)}%↓`;
    const dirCls = t.side === "up" ? "sim-up" : "sim-down";
    const statusCls =
      t.status === "win"      ? "sim-win" :
      t.status === "loss"     ? "sim-loss" :
      t.status === "unfilled" ? "sim-unfilled" :
      t.status === "pending"  ? "sim-pending" :
      t.status === "selling"  ? "sim-pending" : "sim-open";
    const statusText =
      t.status === "win"      ? "🎯 達標" :
      t.status === "loss"     ? "✗ 未達" :
      t.status === "unfilled" ? "🚫 未成交" :
      t.status === "pending"  ? "⏳ 掛單中" :
      t.status === "selling"  ? "📤 出場中" : "⌛ 持有中";
    const exitStr = _simFmtClock(t.exitTime);
    // 「結算價」欄：
    //   已離場 → 正常顯示 exitPrice
    //   未離場（open / pending）且有最近 tick → 顯示「目前股價」（淺色 + LIVE 指示）
    const exitPxRaw = t.exitPrice != null ? t.exitPrice : null;
    const livePxRaw = (exitPxRaw == null && (t.status === "open" || t.status === "pending" || t.status === "selling") && t.lastPrice != null) ? t.lastPrice : null;
    const exitPx = exitPxRaw != null
      ? exitPxRaw.toFixed(2)
      : (t.status === "selling" && t.sellLimit != null
          ? (() => {
              const px = t.sellLimit;
              const pxStr = px >= 1 ? px.toFixed(2) : px.toFixed(4);
              const bumps = t.sellBumpCount | 0;
              const badge = bumps > 0 ? ` <span class="sim-chase-bump">↓${bumps}</span>` : "";
              const livePart = livePxRaw != null ? `（市 ${livePxRaw.toFixed(2)}）` : "";
              return `<span class="sim-pending-px" title="出場追擊：sellLimit=$${pxStr}　已降 ${bumps} 次　${livePart}">📤 ${pxStr}${badge}</span>`;
            })()
          : (livePxRaw != null
              ? `<span class="sim-live-px" title="目前市價（未離場）">${livePxRaw.toFixed(2)}<span class="sim-live-dot"></span></span>`
              : "—"));
    // 「峰」欄：已離場顯示「離場混%」；仍持有顯示「累積混%峰值」
    const peakStr = (t.buyPrice != null) ? ((t.peakPct || 0) * 100).toFixed(2) + "%" : "—";
    const peakCls = (t.buyPrice != null && (t.peakPct || 0) >= Math.abs(t.targetPct)) ? "sim-peak-hit" : "";
    let exitNetTitle = "";
    if (t.buyPrice != null && t.exitPrice != null) {
      const np = _netPnl(t, t.exitPrice);
      if (np) exitNetTitle = `title="混 PnL=${np.net>=0?'+':''}$${np.net.toFixed(2)} (${(np.netPct*100).toFixed(3)}%)、手續費 $${np.fee.toFixed(2)}"`;
    }
    const isFilled = t.buyPrice != null;
    const buyTimeStr = isFilled
      ? `${_simFmtClock(t.buyTime)} <span class="sim-time-px" title="成交當下價格">@${t.buyPrice.toFixed(2)}</span>`
      : `<span class="sim-pending-time" title="下單時間 ${_simFmtClock(t.placedTime)}；下單時市價 ${(t.placedPrice ?? 0).toFixed(2)}">📤 ${_simFmtClock(t.placedTime)} <span class="sim-time-px">@${(t.placedPrice ?? 0).toFixed(2)}</span></span>`;
    const buyPriceStr = isFilled
      ? t.buyPrice.toFixed(2)
      : (() => {
          const lp = t.limitPrice;
          const pp = t.placedPrice;
          if (lp == null) return "—";
          const modeAt = (t.entryModeAt | 0);
          if (modeAt === 0) {
            return `<span class="sim-pending-px" title="市價單：3 秒延遲後以當下市價成交（下單時市價 ${(pp ?? 0).toFixed(2)}）">市 ${(pp ?? lp).toFixed(2)}</span>`;
          }
          if (modeAt >= 3) {
            const bumps = t.bumpCount | 0;
            const init  = (t.initLimit != null) ? t.initLimit.toFixed(2) : "—";
            const step  = (t.chaseStepPx != null) ? t.chaseStepPx.toFixed(2) : "—";
            const intv  = (t.chaseBumpMs != null) ? Math.round(t.chaseBumpMs/1000) + "s" : "—";
            const tip = `追價模式：目前限價 ${lp.toFixed(2)}（起始 ${init}）\n每 ${intv} 未成交加價 ${step}（上限為當下市價）\n已加價 ${bumps} 次`;
            const badge = bumps > 0 ? ` <span class="sim-chase-bump">↑${bumps}</span>` : "";
            return `<span class="sim-pending-px" title="${tip}">追 ${lp.toFixed(2)}${badge}</span>`;
          }
          const gap = (pp != null) ? ((pp - lp) / lp * 100) : null;
          const gapStr = (gap != null) ? `\n下單時市價 ${pp.toFixed(2)}，需再跌 ${gap.toFixed(2)}% 才會成交` : "";
          const tip = `限價 ${lp.toFixed(2)}；市價 ≤ ${lp.toFixed(2)} 才成交${gapStr}`;
          return `<span class="sim-pending-px" title="${tip}">限 ${lp.toFixed(2)}</span>`;
        })();
    const targetPxStr = isFilled
      ? (t.buyPrice * (1 + t.targetPct)).toFixed(2)
      : (t.limitPrice != null ? `<span class="sim-target-projected" title="以限價估算的目標價">${(t.limitPrice * (1 + t.targetPct)).toFixed(2)}</span>` : "—");
    const _wrCell = (v, kind) => {
      if (v == null || !isFinite(v)) return `<td class="num">—</td>`;
      const pct = Math.round(v * 100);
      let cls = "";
      if (kind === "up") cls = v >= 0.50 ? "sim-wr-good" : v <= 0.10 ? "sim-wr-bad" : "";
      else if (kind === "mid") cls = v >= 0.30 ? "sim-wr-good" : v <= 0.05 ? "sim-wr-bad" : "";
      else if (kind === "down") cls = v >= 0.30 ? "sim-wr-bad" : v <= 0.05 ? "sim-wr-good" : "";
      return `<td class="num ${cls}">${pct}%</td>`;
    };
    // 進場快照（3 個勝率合 1 格）：+0.3% / +0.5% / -0.5%
    const _entrySnapshotCell = (() => {
      const wu = t.wr030At, wm = t.wr050At, wd = t.wr050dAt;
      if (wu == null && wm == null && wd == null) return `<td class="num">—</td>`;
      const fmt = (v, kind) => {
        if (v == null || !isFinite(v)) return `<span class="sim-wr-mute">—</span>`;
        const pct = Math.round(v * 100);
        let cls = "";
        if (kind === "up")   cls = v >= 0.50 ? "sim-wr-good" : v <= 0.10 ? "sim-wr-bad" : "";
        else if (kind === "mid")  cls = v >= 0.30 ? "sim-wr-good" : v <= 0.05 ? "sim-wr-bad" : "";
        else if (kind === "down") cls = v >= 0.30 ? "sim-wr-bad" : v <= 0.05 ? "sim-wr-good" : "";
        return `<span class="${cls}">${pct}</span>`;
      };
      const tip = `下單當下勝率快照：+0.3% = ${(wu==null?'—':Math.round(wu*100)+'%')}　+0.5% = ${(wm==null?'—':Math.round(wm*100)+'%')}　-0.5% = ${(wd==null?'—':Math.round(wd*100)+'%')}`;
      return `<td class="num sim-snapshot" title="${tip}">${fmt(wu,"up")}<span class="sim-snap-sep">/</span>${fmt(wm,"mid")}<span class="sim-snap-sep">/</span>${fmt(wd,"down")}</td>`;
    })();
    // MAE：最大不利（買入後跌幅最深）；hover tooltip 顯示 10s/30s/60s 細節
    const _maeCell = (() => {
      const buy = t.buyPrice;
      if (buy == null) return `<td class="num">—</td>`;
      const lows = [t.low10, t.low30, t.low60, t.lowAll].filter(v => v != null && isFinite(v));
      if (!lows.length) return `<td class="num">—</td>`;
      const lo = Math.min(...lows);
      const diff = (lo - buy) / buy * 100;
      const cls = diff <= -0.3 ? "sim-wr-bad" : diff >= 0 ? "sim-wr-good" : "sim-wr-warn";
      const sign = diff > 0 ? "+" : "";
      const fmt = v => v == null || !isFinite(v) ? "—" : `${v.toFixed(2)} (${((v-buy)/buy*100).toFixed(2)}%)`;
      const tip = `MAE 最大不利 = ${lo.toFixed(2)} (${sign}${diff.toFixed(2)}%)\n10s: ${fmt(t.low10)}\n30s: ${fmt(t.low30)}\n60s: ${fmt(t.low60)}\n全期: ${fmt(t.lowAll)}`;
      return `<td class="num ${cls}" title="${tip}">${sign}${diff.toFixed(2)}%</td>`;
    })();
    // 停損價
    const _stopPxCell = (() => {
      const sl = +t.stopLossPct || +simCfg.stopLossPct || 0;
      if (sl <= 0) return `<td class="num"><span class="sim-wr-mute">關閉</span></td>`;
      const base = t.buyPrice != null ? t.buyPrice : t.limitPrice;
      if (base == null) return `<td class="num">—</td>`;
      const stopPx = base * (1 - sl);
      const isProjected = t.buyPrice == null;
      const tip = `停損 ${(sl*100).toFixed(2)}%　跌至 $${stopPx.toFixed(2)} 觸發${isProjected ? "（以限價估算）" : ""}`;
      const cls = isProjected ? "sim-target-projected" : "";
      return `<td class="num" title="${tip}"><span class="${cls}">${stopPx.toFixed(2)}</span></td>`;
    })();
    // 移動停利狀態
    const _trailCell = (() => {
      const tsl = +t.trailingStopPct || +simCfg.trailingStopPct || 0;
      if (tsl <= 0) return `<td class="num"><span class="sim-wr-mute">未啟用</span></td>`;
      if (t.buyPrice == null) return `<td class="num"><span class="sim-wr-mute">—</span></td>`;
      const tgtAbs = Math.abs(t.targetPct || 0);
      const peak = +t.peakPct || 0;
      if (peak < tgtAbs) {
        // 尚未達標 → 未鎖
        const remain = (tgtAbs - peak) * 100;
        const tip = `尚未達標 → 未鎖獲利\n目標 +${(tgtAbs*100).toFixed(2)}% 距 +${remain.toFixed(2)}%\nTrail 設定 ${(tsl*100).toFixed(2)}%`;
        return `<td class="num" title="${tip}"><span class="sim-wr-mute">⏳ 等達標</span></td>`;
      }
      // 已鎖獲利
      const trigger = (peak - tsl) * 100;
      const tip = `已鎖獲利：peak = +${(peak*100).toFixed(2)}%\n回撚 ${(tsl*100).toFixed(2)}% 觸發 → 賣在 ≈ +${trigger.toFixed(2)}%`;
      return `<td class="num sim-trail-locked" title="${tip}">🔒 +${(peak*100).toFixed(2)}%<span class="sim-trail-sub">/▼${(tsl*100).toFixed(2)}</span></td>`;
    })();
    const _lowCell = (low, buy) => {
      if (low == null || !isFinite(low) || buy == null) return `<td class="num">—</td>`;
      const diff = (low - buy) / buy;
      const cls = diff <= -0.001 ? "sim-wr-bad" : diff >= 0 ? "sim-wr-good" : "";
      const sign = diff > 0 ? "+" : "";
      return `<td class="num ${cls}" title="買入價 ${buy.toFixed(2)} → 最低 ${low.toFixed(2)} (${sign}${(diff*100).toFixed(2)}%)">${low.toFixed(2)}</td>`;
    };
    const _suggestCell = (sg, buy) => {
      if (sg == null || !isFinite(sg)) return `<td class="num">—</td>`;
      // 未成交時，顯示建議價原值，不做偏差評估
      if (buy == null) return `<td class="num" title="建議進場 ${sg.toFixed(2)}">${sg.toFixed(2)}</td>`;
      const diff = (buy - sg) / sg; // 正 = 買貴了
      const cls = diff <= 0 ? "sim-wr-good" : diff >= 0.002 ? "sim-wr-bad" : "";
      const sign = diff > 0 ? "+" : "";
      return `<td class="num ${cls}" title="建議進場 ${sg.toFixed(2)}；你買在 ${buy.toFixed(2)} (偏差 ${sign}${(diff*100).toFixed(2)}%)">${sg.toFixed(2)}</td>`;
    };
    // 達成建議價買入：pending 顯示「等待中」；unfilled 仍可看說「未跌到限價」
    const _reachSuggestCell = (tr) => {
      const sg = tr.suggestPxAt;
      if (sg == null || !isFinite(sg)) return `<td>—</td>`;
      if (tr.status === "pending") {
        return `<td class="sim-pending" title="挂單中；待市價 ≤ 限價 ${tr.limitPrice?.toFixed(2)} 才成交">⏳ 等待</td>`;
      }
      if (tr.status === "unfilled") {
        return `<td class="sim-wr-bad" title="未成交：限價期間市價未跌到 ${tr.limitPrice?.toFixed(2)}">🚫 未成</td>`;
      }
      if (tr.buyPrice != null && tr.buyPrice <= sg) {
        return `<td class="sim-wr-good" title="買入價 ${tr.buyPrice.toFixed(2)} ≤ 建議 ${sg.toFixed(2)}">✓ 達成</td>`;
      }
      const lows = [tr.lowAll, tr.low60, tr.low30, tr.low10].filter(v => v != null && isFinite(v));
      if (!lows.length) return `<td>—</td>`;
      const lo = Math.min(...lows);
      if (lo <= sg) {
        const diff = ((lo - sg) / sg) * 100;
        return `<td class="sim-wr-good" title="最低 ${lo.toFixed(2)} ≤ 建議 ${sg.toFixed(2)} (${diff.toFixed(2)}%)">✓ 達成</td>`;
      }
      const gap = ((lo - sg) / sg) * 100;
      return `<td class="sim-wr-bad" title="最低 ${lo.toFixed(2)}，仍高於建議 ${sg.toFixed(2)} (+${gap.toFixed(2)}%)">✗ 未達</td>`;
    };
    const autoBadge = t.auto ? `<span class="sim-auto-badge" title="自動下單">A</span>` : "";
    // 股數×金額欄：顯示 snapshot 的股數、下單金額（可能在追價後重計）
    const _sizeCell = (() => {
      const sh = t.shares | 0;
      if (!sh) return `<td class="num">—</td>`;
      const fillPx = t.buyPrice != null ? t.buyPrice : t.limitPrice;
      const actualCost = fillPx ? (fillPx * sh) : null;
      const budget = t.amountUsd != null ? +t.amountUsd : null;
      // 顯示「實際下單金額 = 股數 × 價」；若還沒掛單價，退而顯示預算
      const showAmt = actualCost != null ? actualCost : budget;
      const amtStr = showAmt != null ? "$" + Math.round(showAmt).toLocaleString("en-US") : "—";
      const tip = actualCost != null
        ? `實際金額 ≈ $${actualCost.toFixed(2)} = ${sh} 股 × ${fillPx.toFixed(2)}` +
          (budget != null ? `（預算 $${Math.round(budget).toLocaleString("en-US")}，餘 $${(budget - actualCost).toFixed(2)}）` : "")
        : `下單預算 ${amtStr} / ${sh} 股`;
      return `<td class="num" title="${tip}"><span class="sim-size-sh">${sh}</span><span class="sim-size-sep">×</span><span class="sim-size-amt">${amtStr}</span></td>`;
    })();
    // 淨損益欄：已離場 → 最終值；持有中 + 有 lastPrice → 顯示 Live 混 PnL
    const _netCell = (() => {
      const fxRate = Math.max(0.1, Math.min(500, +simCfg.fxUsdTwd || 31.5));
      const _twdStr = (usd) => {
        const twd = usd * fxRate;
        const sign = twd >= 0 ? "+" : "-";
        return `${sign}NT$${Math.round(Math.abs(twd)).toLocaleString("en-US")}`;
      };
      const _grossPct = (exitPx) => {
        if (t.buyPrice == null || !isFinite(exitPx) || t.buyPrice <= 0) return null;
        const dir = t.side === 'up' ? (exitPx - t.buyPrice) : (t.buyPrice - exitPx);
        return (dir / t.buyPrice) * 100;
      };
      const _pctRow = (gPct, nPct, prefix) => {
        const gSign = gPct >= 0 ? "+" : "";
        const nSign = nPct >= 0 ? "+" : "";
        const gCls = gPct > 0 ? "sim-wr-good" : gPct < 0 ? "sim-wr-bad" : "";
        const nCls = nPct > 0 ? "sim-wr-good" : nPct < 0 ? "sim-wr-bad" : "";
        const feePct = gPct - nPct; // 費用吃掉的 %
        return `<div class="sim-net-grid">` +
                 `<span class="sim-net-lbl">毛</span><span class="sim-net-v ${gCls}">${prefix}${gSign}${gPct.toFixed(3)}%</span>` +
                 `<span class="sim-net-lbl">淨</span><span class="sim-net-v ${nCls}">${prefix}${nSign}${nPct.toFixed(3)}%</span>` +
               `</div>` +
               `<div class="sim-net-fee" title="來回手續費吃掉 ${feePct.toFixed(3)}%">費 −${feePct.toFixed(3)}%</div>`;
      };
      if (t.buyPrice == null || t.exitPrice == null) {
        if (t.status === "open" && t.buyPrice != null && t.lastPrice != null) {
          const np = _netPnl(t, t.lastPrice);
          const gPct = _grossPct(t.lastPrice);
          if (np && gPct != null) {
            const usd = np.net;
            const nPct = np.netPct * 100;
            const cls = usd > 0 ? "sim-wr-good" : usd < 0 ? "sim-wr-bad" : "";
            const sign = usd >= 0 ? "+" : "-";
            const tip = `Live（未離場）：毛=$${np.gross.toFixed(2)} (${gPct >= 0 ? "+" : ""}${gPct.toFixed(3)}%) − 費=$${np.fee.toFixed(2)} = 淨 $${np.net.toFixed(2)} (${nPct >= 0 ? "+" : ""}${nPct.toFixed(3)}%)（匯率 1 USD ≈ ${fxRate.toFixed(2)} TWD）`;
            return `<td class="num sim-net-cell ${cls}" title="${tip}">` +
                     `<div class="sim-net-main">` +
                       `<span class="sim-net-usd">~${sign}$${Math.abs(usd).toFixed(2)}</span>` +
                       `<span class="sim-net-twd">~${_twdStr(usd)}</span>` +
                     `</div>` +
                     _pctRow(gPct, nPct, "~") +
                   `</td>`;
          }
        }
        if (t.status === "open" && t.buyPrice != null) {
          // 沒有 lastPrice fallback：以 peakPct 顯示
          const pct = (t.peakPct || 0) * 100;
          const cls = pct >= 0 ? "sim-wr-good" : "sim-wr-bad";
          return `<td class="num ${cls}" title="未離場；顯示持有中的淨 % peak">~${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%</td>`;
        }
        return `<td class="num">—</td>`;
      }
      const np = _netPnl(t, t.exitPrice);
      const gPct = _grossPct(t.exitPrice);
      if (!np || gPct == null) return `<td class="num">—</td>`;
      const usd = np.net;
      const nPct = np.netPct * 100;
      const cls = usd > 0 ? "sim-wr-good" : usd < 0 ? "sim-wr-bad" : "";
      const sign = usd >= 0 ? "+" : "-";
      const tip = `毛=$${(np.gross).toFixed(2)} (${gPct >= 0 ? "+" : ""}${gPct.toFixed(3)}%) − 費=$${np.fee.toFixed(2)} = 淨 $${np.net.toFixed(2)} (${nPct >= 0 ? "+" : ""}${nPct.toFixed(3)}%)（匯率 1 USD ≈ ${fxRate.toFixed(2)} TWD）`;
      return `<td class="num sim-net-cell ${cls}" title="${tip}">` +
               `<div class="sim-net-main">` +
                 `<span class="sim-net-usd">${sign}$${Math.abs(usd).toFixed(2)}</span>` +
                 `<span class="sim-net-twd">${_twdStr(usd)}</span>` +
               `</div>` +
               _pctRow(gPct, nPct, "") +
             `</td>`;
    })();
    // 離場原因：以 pill 顯示（含 icon）
    const _reasonCell = (() => {
      let label = "—", cls = "", tip = "", icon = "";
      if (t.status === "pending") { icon = "⏳"; label = "掛單中"; cls = "sim-pending"; tip = `待市價 ≤ ${t.limitPrice?.toFixed(2)} 才成交`; }
      else if (t.status === "open") { icon = "⌛"; label = "持有中"; cls = ""; tip = `達標/停損/逾時 三者之一觸發才離場`; }
      else if (t.status === "selling") {
        const reasonMap = { target: "🎯 達標賣出", stop: "🛡️ 停損賣出", trail: "🔒 移動停利賣出", timeout: "⏰ 逾時賣出" };
        label = `出場中·${reasonMap[t.exitReason] || t.exitReason || ""}`;
        cls = "sim-pending";
        icon = "📤";
        const px = (t.sellLimit || 0);
        const pxStr = px >= 1 ? px.toFixed(2) : px.toFixed(4);
        tip = `追價賣出：sellLimit=$${pxStr} · 已降 ${t.sellBumpCount||0} 次；持續往下追到 intra.price ≥ sellLimit 成交為止`;
      }
      else if (t.status === "unfilled") { icon = "🚫"; label = "未成交"; cls = "sim-unfilled"; tip = `掛單期間市價未跌到限價`; }
      else if (t.status === "win") { icon = "🎯"; label = "達標"; cls = "sim-wr-good"; tip = `淨 % ≥ 目標 ${(Math.abs(t.targetPct)*100).toFixed(2)}%`; }
      else if (t.status === "loss") {
        if (t.stopHit) { icon = "🛡️"; label = "停損"; cls = "sim-wr-bad"; tip = `淨 % ≤ -${((t.stopLossPct||0)*100).toFixed(1)}%`; }
        else { icon = "⏰"; label = "逾時"; cls = "sim-wr-bad"; tip = `超過測試時長仍未達標並平倉`; }
      }
      return `<td title="${tip}"><span class="sim-reason ${cls}">${icon ? icon + " " : ""}${label}</span></td>`;
    })();
    // 持有時間欄：pending=掛單存續、open=現在-buyTime、settled=exit-buy
    const _holdCell = (() => {
      let ms = null, prefix = "";
      if (t.status === "pending") { ms = Date.now() - (t.placedTime || Date.now()); prefix = "掛 "; }
      else if ((t.status === "open" || t.status === "selling") && t.buyTime) { ms = Date.now() - t.buyTime; prefix = "持 "; }
      else if (t.buyTime && t.exitTime) { ms = t.exitTime - t.buyTime; }
      else if (t.status === "unfilled" && t.placedTime && t.exitTime) { ms = t.exitTime - t.placedTime; prefix = "掛 "; }
      if (ms == null) return `<td class="num">—</td>`;
      return `<td class="num" title="${prefix}${ms} ms">${prefix}${_simFmtDur(ms)}</td>`;
    })();
    return `<tr class="${statusCls}" data-trade-id="${t.id || ''}">` +
      `<td><span class="sim-status">${statusText}</span>${autoBadge}${_wsCancelBtn(t)}</td>` +
      `<td class="sim-sym">${t.sym}${t.entrySession ? ` <span class="sim-sess sim-sess-${t.entrySession}" title="下單時為 ${_sessionLabel(t.entrySession)}（ET）${t.extendedFeePctAt ? ' · 手續費已加成 ' + (t.extendedFeePctAt*100).toFixed(3) + '%' : ''}">${_sessionEmoji(t.entrySession)}</span>` : ""}</td>` +
      `<td class="${dirCls}">${dirLabel}</td>` +
      `<td>${buyTimeStr}</td>` +
      `<td class="num sim-buy-px">${buyPriceStr}</td>` +
      _sizeCell +
      _suggestCell(t.suggestPxAt, t.buyPrice) +
      _reachSuggestCell(t) +
      `<td class="num">${(Math.abs(t.targetPct)*100).toFixed(1)}%</td>` +
      `<td class="num sim-target-px">${targetPxStr}</td>` +
      _stopPxCell +
      _entrySnapshotCell +
      _maeCell +
      _trailCell +
      `<td>${exitStr}</td>` +
      `<td class="num" ${exitNetTitle}>${exitPx}</td>` +
      _netCell +
      _reasonCell +
      _holdCell +
      `<td class="num ${peakCls}">${peakStr}</td>` +
    `</tr>`;
  }).join("");
}

// 共用：建構 CSV 字串（withBom=true 時加 UTF-8 BOM 給 Excel）。
function _buildSimTradesCsv(opts) {
  const withBom = !opts || opts.withBom !== false;
  const headers = [
    "id","status","exitReason","sym","side","targetPct","auto","source",
    "placedTime","placedPrice","limitPrice","entryModeAt",
    "buyTime","buyPrice","exitTime","exitPrice",
    "amountUsd","shares","actualCost",
    "feeBuyUsd","feeBuyFlatUsd","feeBuyPct","feeSellPct","feeSellUsd","stopLossPct","trailingStopPct","fillModeAt",
    "grossPnl","feePaid","netPnl","netPct","peakPct",
    "holdMs","windowMs",
    "suggestPx","low10","low30","low60","lowAll",
    "wr030At","wr050At","wr050dAt",
    "bumpCount","chaseStepPx","chaseBumpMs"
  ];
  const _iso = ts => ts ? new Date(ts).toISOString() : "";
  const _exitReason = (t) =>
    t.status === "win"      ? "達標" :
    t.status === "loss"     ? (t.trailHit ? "移停利" : (t.stopHit ? "停損" : "逾時")) :
    t.status === "unfilled" ? "未成交" :
    t.status === "open"     ? "持有中" :
    t.status === "selling"  ? "出場中" :
    t.status === "pending"  ? "掛單中" : t.status || "";
  const _num = v => (v == null || !isFinite(v)) ? "" : String(v);
  const _esc = v => {
    if (v == null) return "";
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = simTrades.map(t => {
    const np = (t.buyPrice != null && t.exitPrice != null) ? _netPnl(t, t.exitPrice) : null;
    const holdMs = (t.buyTime && t.exitTime) ? (t.exitTime - t.buyTime)
                  : (t.placedTime && t.exitTime ? (t.exitTime - t.placedTime) : "");
    const sh = t.shares | 0;
    const fillPx = t.buyPrice != null ? t.buyPrice : t.limitPrice;
    const actualCost = (fillPx && sh) ? +(fillPx * sh).toFixed(2) : "";
    const row = {
      id: t.id, status: t.status, exitReason: _exitReason(t),
      sym: t.sym, side: t.side, targetPct: _num(t.targetPct),
      auto: t.auto ? 1 : 0, source: t.source || "local",
      placedTime: _iso(t.placedTime), placedPrice: _num(t.placedPrice),
      limitPrice: _num(t.limitPrice), entryModeAt: _num(t.entryModeAt),
      buyTime: _iso(t.buyTime), buyPrice: _num(t.buyPrice),
      exitTime: _iso(t.exitTime), exitPrice: _num(t.exitPrice),
      amountUsd: _num(t.amountUsd), shares: sh || "", actualCost,
      feeBuyUsd: _num(t.feeBuyUsd), feeBuyFlatUsd: _num(t.feeBuyFlatUsd), feeBuyPct: _num(t.feeBuyPct), feeSellPct: _num(t.feeSellPct), feeSellUsd: _num(t.feeSellUsd),
      stopLossPct: _num(t.stopLossPct), trailingStopPct: _num(t.trailingStopPct), fillModeAt: t.fillModeAt || "",
      grossPnl: np ? np.gross.toFixed(4) : "",
      feePaid:  np ? np.fee.toFixed(4)   : "",
      netPnl:   np ? np.net.toFixed(4)   : "",
      netPct:   np ? np.netPct.toFixed(6) : "",
      peakPct:  _num(t.peakPct),
      holdMs: _num(holdMs), windowMs: _num(t.windowMs),
      suggestPx: _num(t.suggestPxAt),
      low10: _num(t.low10), low30: _num(t.low30), low60: _num(t.low60), lowAll: _num(t.lowAll),
      wr030At: _num(t.wr030At), wr050At: _num(t.wr050At), wr050dAt: _num(t.wr050dAt),
      bumpCount: _num(t.bumpCount), chaseStepPx: _num(t.chaseStepPx), chaseBumpMs: _num(t.chaseBumpMs),
    };
    return headers.map(h => _esc(row[h])).join(",");
  });
  return (withBom ? "\ufeff" : "") + headers.join(",") + "\r\n" + rows.join("\r\n") + "\r\n";
}

// 匯出模擬交易為 CSV 檔案（UTF-8 BOM，Excel 直接可開）。
function exportSimTradesCsv() {
  if (!simTrades || !simTrades.length) {
    alert("沒有任何模擬交易紀錄可匯出。");
    return;
  }
  const csv = _buildSimTradesCsv({ withBom: true });
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `sim-trades-${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

// 複製目前清單為 CSV 到剪貼簿（不含 BOM；可直接貼到 Excel / Sheets / AI 對話框）
async function copySimTradesCsv() {
  const btn = document.getElementById("simCopyBtn");
  const _flash = (text, ok) => {
    if (!btn) return;
    const prev = btn.textContent;
    btn.textContent = text;
    btn.style.borderColor = ok ? "#26c6a0" : "#ef5350";
    btn.style.color = ok ? "#26c6a0" : "#ef5350";
    setTimeout(() => {
      btn.textContent = prev;
      btn.style.borderColor = "";
      btn.style.color = "";
    }, 1400);
  };
  if (!simTrades || !simTrades.length) {
    alert("沒有任何模擬交易紀錄可複製。");
    return;
  }
  const csv = _buildSimTradesCsv({ withBom: false });
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(csv);
    } else {
      const ta = document.createElement("textarea");
      ta.value = csv;
      ta.style.position = "fixed"; ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    _flash(`✓ 已複製 ${simTrades.length} 筆`, true);
  } catch (e) {
    console.warn("[sim] copy CSV failed", e);
    _flash("✗ 複製失敗", false);
  }
}

function bindSimPanel() {
  document.getElementById("simClearBtn")?.addEventListener("click", clearSettledSimTrades);
  document.getElementById("simLogClearBtn")?.addEventListener("click", () => {
    _simLog.length = 0;
    _renderSimLog();
  });
  _renderSimLog();
  document.getElementById("simClearAllBtn")?.addEventListener("click", clearAllSimTrades);
  document.getElementById("simExportCsvBtn")?.addEventListener("click", exportSimTradesCsv);
  document.getElementById("simCopyBtn")?.addEventListener("click", copySimTradesCsv);
  document.getElementById("simToggleBtn")?.addEventListener("click", (e) => {
    e.stopPropagation(); // 不要連帶觸發 rule-header 收合
    const panel = document.getElementById("simPanel");
    if (!panel) return;
    const collapsed = panel.classList.toggle("collapsed");
    const btn = e.currentTarget;
    btn.innerHTML = `⚙`;
    try { localStorage.setItem("simPanelCollapsed", collapsed ? "1" : "0"); } catch (_) {}
  });
  // 規則摘要 header（簡介列）→ 收合/展開 rule-line（不影響 rule-groups）
  document.getElementById("simRuleHeader")?.addEventListener("click", (e) => {
    // 點到右側的「⚙ 規則設定」按鈕時不要觸發收合
    if (e.target.closest('#simToggleBtn')) return;
    const target = document.getElementById("simRuleSummary");
    if (!target) return;
    const collapsed = target.classList.toggle("collapsed");
    // 同步切換三角 icon：展開 ▼ / 收合 ▶
    const chev = document.querySelector('#simRuleHeader .rule-chevron');
    if (chev) chev.textContent = collapsed ? '▶' : '▼';
    try { localStorage.setItem("simRuleCollapsed", collapsed ? "1" : "0"); } catch (_) {}
  });
  // 回復上次收合狀態
  try {
    if (localStorage.getItem("simPanelCollapsed") === "1") {
      const panel = document.getElementById("simPanel");
      const btn = document.getElementById("simToggleBtn");
      if (panel) panel.classList.add("collapsed");
      if (btn) btn.innerHTML = `⚙`;
    }
  } catch (_) {}
  bindSimControls();
  // 不論是否啟用自動買入，只要有 pending/open 訂單就需要持續 tick 來檢查成交
  _startSimTickTimer();
  // ET 時鐘 badge 每 30s 刷新一次（自動處理 DST / 開盤收盤切換）
  if (!window._simEtClockTimer) {
    window._simEtClockTimer = setInterval(() => {
      const rthV = document.getElementById("simCfgRthOnlyVal");
      const smV  = document.getElementById("simCfgSessionModeVal");
      if (!rthV && !smV) return;
      const ci = _getEtClockInfo();
      const smode = simCfg.sessionMode || "rth";
      const smTxt = ({rth:"僅 RTH", rthPre:"RTH + 盤前", rthPost:"RTH + 盤後", all:"全時段"})[smode] || "僅 RTH";
      const main = smode === "rth"
        ? `<span class="v-pill v-ok">是 · 僅盤中</span>`
        : `<span class="v-pill v-warn">否 · ${smTxt}</span>`;
      const nextStr = ci.nextMin ? `（${ci.nextLabel} ${ci.nextMin}）` : '';
      const tip = `當地 ${ci.localStr} ${ci.localTz}${ci.localTzName ? ' (' + ci.localTzName + ')' : ''}&#10;美東 ${ci.etStr} ${ci.tz}（${ci.isDst ? '夏令 EDT, UTC-4' : '冬令 EST, UTC-5'}）&#10;盤前 04:00 / RTH 09:30-16:00 / 盤後 16:00-20:00 ET&#10;會自動處理 DST 換時`;
      const clockHtml = ` <span class="sim-ctrl-sub" title="${tip}">${ci.phaseIcon} ET ${ci.etStr} ${ci.tz} · ${ci.phase}${nextStr} <span class="sim-ctrl-sub-local">· 本地 ${ci.localStr} ${ci.localTz}</span></span>`;
      if (rthV) rthV.innerHTML = main + clockHtml;
    }, 30000);
  }
}

function _startSimTickTimer() {
  if (_simTickTimer) return;
  _simTickTimer = setInterval(_tickActiveSimSymbols, 2000);
}

function bindSimControls() {
  const conc = document.getElementById("simCfgConc");
  const tgt  = document.getElementById("simCfgTarget");
  const win  = document.getElementById("simCfgWindow");
  const wrm  = document.getElementById("simCfgWrMin");
  const wrm5 = document.getElementById("simCfgWrMin050");
  const psm  = document.getElementById("simCfgPerSym");
  const ssec = document.getElementById("simCfgScanSec");
  const gl   = document.getElementById("simCfgGradLv");
  const em   = document.getElementById("simCfgEntryMode");
  const xm   = document.getElementById("simCfgExecMode");
  const sh   = document.getElementById("simCfgAmount");
  const fb   = document.getElementById("simCfgFeeBuy");
  const fbp  = document.getElementById("simCfgFeeBuyPct");
  const fs   = document.getElementById("simCfgFeeSell");
  const fsu  = document.getElementById("simCfgFeeSellUsd");
  const sl   = document.getElementById("simCfgStopLoss");
  const tsl  = document.getElementById("simCfgTrailStop");
  const dks  = document.getElementById("simCfgDailyKill");
  const mpr  = document.getElementById("simCfgMinPrice");
  const mfp  = document.getElementById("simCfgMaxFeePct");
  const fxr  = document.getElementById("simCfgFxUsdTwd");
  const fm   = document.getElementById("simCfgFillMode");
  const sm   = document.getElementById("simCfgSessionMode");   // 取代 rthOnly
  const wro  = document.getElementById("simCfgWrRthOnly");     // 勝率只用盤中
  const ext  = document.getElementById("simCfgExtFee");        // 盤前/後加成 (slider: 0~50 → 0~0.50%)
  const rth  = document.getElementById("simCfgRthOnly");       // 舊欄位若還在 DOM 也讀（向後相容）
  const cbs  = document.getElementById("simCfgChaseBumpSec");
  const cbp  = document.getElementById("simCfgChaseBumpPct");
  const cms  = document.getElementById("simCfgChaseMaxSec");
  const cpg  = document.getElementById("simCfgChasePanicPct");
  const cpm  = document.getElementById("simCfgChasePanicMul");
  const xem  = document.getElementById("simCfgExitMode");
  const xcbs = document.getElementById("simCfgExitChaseBumpSec");
  const xcbp = document.getElementById("simCfgExitChaseBumpPct");
  const xcpg = document.getElementById("simCfgExitChasePanicPct");
  const xcpm = document.getElementById("simCfgExitChasePanicMul");
  const concV = document.getElementById("simCfgConcVal");
  const tgtV  = document.getElementById("simCfgTargetVal");
  const winV  = document.getElementById("simCfgWindowVal");
  const wrmV  = document.getElementById("simCfgWrMinVal");
  const wrm5V = document.getElementById("simCfgWrMin050Val");
  const psmV  = document.getElementById("simCfgPerSymVal");
  const ssecV = document.getElementById("simCfgScanSecVal");
  const glV   = document.getElementById("simCfgGradLvVal");
  const emV   = document.getElementById("simCfgEntryModeVal");
  const xmV   = document.getElementById("simCfgExecModeVal");
  const shV   = document.getElementById("simCfgAmountVal");
  const fbV   = document.getElementById("simCfgFeeBuyVal");
  const fbpV  = document.getElementById("simCfgFeeBuyPctVal");
  const fsV   = document.getElementById("simCfgFeeSellVal");
  const fsuV  = document.getElementById("simCfgFeeSellUsdVal");
  const slV   = document.getElementById("simCfgStopLossVal");
  const tslV  = document.getElementById("simCfgTrailStopVal");
  const dksV  = document.getElementById("simCfgDailyKillVal");
  const mprV  = document.getElementById("simCfgMinPriceVal");
  const mfpV  = document.getElementById("simCfgMaxFeePctVal");
  const fxrV  = document.getElementById("simCfgFxUsdTwdVal");
  const fmV   = document.getElementById("simCfgFillModeVal");
  const smV   = document.getElementById("simCfgSessionModeVal");
  const wroV  = document.getElementById("simCfgWrRthOnlyVal");
  const extV  = document.getElementById("simCfgExtFeeVal");
  const rthV  = document.getElementById("simCfgRthOnlyVal");
  const cbsV  = document.getElementById("simCfgChaseBumpSecVal");
  const cbpV  = document.getElementById("simCfgChaseBumpPctVal");
  const cmsV  = document.getElementById("simCfgChaseMaxSecVal");
  const cpgV  = document.getElementById("simCfgChasePanicPctVal");
  const cpmV  = document.getElementById("simCfgChasePanicMulVal");
  const xemV  = document.getElementById("simCfgExitModeVal");
  const xcbsV = document.getElementById("simCfgExitChaseBumpSecVal");
  const xcbpV = document.getElementById("simCfgExitChaseBumpPctVal");
  const xcpgV = document.getElementById("simCfgExitChasePanicPctVal");
  const xcpmV = document.getElementById("simCfgExitChasePanicMulVal");
  const autoBtn = document.getElementById("simAutoBtn");
  const autoSt  = document.getElementById("simAutoStatus");

  // 套用儲存值
  if (conc) conc.value = String(simCfg.concurrency);
  if (tgt)  tgt.value  = String(Math.round(simCfg.targetPct * 10000));
  if (win)  win.value  = String(Math.round(simCfg.windowMs / 60000));
  if (wrm)  wrm.value  = String(Math.round(simCfg.wrMin * 100));
  if (wrm5) wrm5.value = String(Math.round(simCfg.wrMin050 * 100));
  if (psm)  psm.value  = String(simCfg.perSymMax);
  if (ssec) ssec.value = String(simCfg.scanIntervalSec);
  if (gl)   gl.value   = String(simCfg.gradientLevel);
  if (em)   em.value   = String(simCfg.entryMode);
  if (xm)   xm.checked = ((simCfg.executionMode | 0) === 1);
if (sh)   sh.value   = String(simCfg.amountPerTradeUsd);
  if (fb)   fb.value   = String(Math.round(simCfg.feeBuyUsd));
  if (fbp)  fbp.value  = String(Math.round((+simCfg.feeBuyPct || 0) * 10000));
  if (fs)   fs.value   = String(Math.round(simCfg.feeSellPct * 10000));
  if (fsu)  fsu.value  = String(Math.round(+simCfg.feeSellUsd || 0));
  if (sl)   sl.value   = String(Math.round(simCfg.stopLossPct * 1000));
  if (tsl)  tsl.value  = String(Math.round((+simCfg.trailingStopPct || 0) * 10000));
  if (dks)  dks.value  = String(Math.round(+simCfg.dailyMaxLossUsd || 0));
  if (mpr)  mpr.value  = String(Math.round(+simCfg.minPriceUsd || 0));
  if (mfp)  mfp.value  = String(Math.round((+simCfg.maxFeePctOfAmount || 0) * 10000));
  if (fxr)  fxr.value  = (+simCfg.fxUsdTwd || 31.5).toFixed(1);
  if (fm)   fm.checked = (simCfg.fillMode === 'optimistic');
  if (sm)   sm.value = (simCfg.sessionMode || "rth");
  if (wro)  wro.checked = !!simCfg.wrRthOnly;
  if (ext)  ext.value  = String(Math.round((+simCfg.extendedFeePct || 0) * 10000)); // 0~0.01 → 0~100
  if (rth)  rth.checked = !!simCfg.rthOnly;
  if (cbs)  cbs.value  = String(simCfg.chaseBumpSec);
  if (cbp)  cbp.value  = String(simCfg.chaseBumpPct);
  if (cms)  cms.value  = String(simCfg.chaseMaxSec);
  if (xem)  xem.checked = ((simCfg.exitMode | 0) === 1);
  if (xcbs) xcbs.value = String(simCfg.exitChaseBumpSec);
  if (xcbp) xcbp.value = String(simCfg.exitChaseBumpPct);
  _renderSimCfgLabels();

  conc?.addEventListener("input", () => {
    simCfg.concurrency = Math.max(1, Math.min(256, +conc.value || 1));
    _renderSimCfgLabels(); saveSimCfg(); renderSimPanel();
  });
  tgt?.addEventListener("input", () => {
    simCfg.targetPct = Math.max(0.0001, Math.min(0.012, (+tgt.value || 1) / 10000));
    _renderSimCfgLabels(); saveSimCfg();
  });
  win?.addEventListener("input", () => {
    simCfg.windowMs = Math.max(1, Math.min(390, +win.value || 1)) * 60 * 1000;
    _renderSimCfgLabels(); saveSimCfg();
    // 自動買入若正在運作，重排倒數 timer 使新 windowMs 即時生效
    if (simCfg.autoEnabled) { try { _startSimAutoTimer(); } catch {} }
  });
  wrm?.addEventListener("input", () => {
    simCfg.wrMin = Math.max(0.05, Math.min(1.00, (+wrm.value || 60) / 100));
    _renderSimCfgLabels(); saveSimCfg();
  });
  wrm5?.addEventListener("input", () => {
    simCfg.wrMin050 = Math.max(0.05, Math.min(1.00, (+wrm5.value || 30) / 100));
    _renderSimCfgLabels(); saveSimCfg();
  });
  psm?.addEventListener("input", () => {
    simCfg.perSymMax = Math.max(1, Math.min(10, +psm.value || 1));
    _renderSimCfgLabels(); saveSimCfg();
  });
  ssec?.addEventListener("input", () => {
    simCfg.scanIntervalSec = Math.max(1, Math.min(60, +ssec.value || 5));
    _renderSimCfgLabels(); saveSimCfg();
    if (simCfg.autoEnabled) _startSimAutoTimer();
  });
  gl?.addEventListener("input", () => {
    simCfg.gradientLevel = Math.max(0, Math.min(3, +gl.value | 0));
    _renderSimCfgLabels(); saveSimCfg();
    if (simCfg.autoEnabled) runSimAutoScan();
  });
  em?.addEventListener("input", () => {
    simCfg.entryMode = Math.max(0, Math.min(5, +em.value | 0));
    _renderSimCfgLabels(); saveSimCfg();
    if (simCfg.autoEnabled) runSimAutoScan();
  });
  xm?.addEventListener("change", () => {
    simCfg.executionMode = xm.checked ? 1 : 0;
    _renderSimCfgLabels(); saveSimCfg();
    const tc = window.tradingClient;
    if (tc) {
      if (simCfg.executionMode === 1) tc.connect(simCfg.wsUrl || tc.DEFAULT_URL);
      else tc.disconnect();
    }
    _renderWsStatus();
  });
  sh?.addEventListener("input", () => {
    simCfg.amountPerTradeUsd = Math.max(0, Math.min(150000, +sh.value | 0 || 0));
    _renderSimCfgLabels(); saveSimCfg();
  });
  fb?.addEventListener("input", () => {
    simCfg.feeBuyUsd = Math.max(0, Math.min(20, +fb.value || 0));
    _renderSimCfgLabels(); saveSimCfg();
  });
  fbp?.addEventListener("input", () => {
    simCfg.feeBuyPct = Math.max(0, Math.min(0.015, (+fbp.value || 0) / 10000));
    _renderSimCfgLabels(); saveSimCfg();
  });
  fs?.addEventListener("input", () => {
    simCfg.feeSellPct = Math.max(0, Math.min(0.005, (+fs.value || 0) / 10000));
    _renderSimCfgLabels(); saveSimCfg();
  });
  fsu?.addEventListener("input", () => {
    simCfg.feeSellUsd = Math.max(0, Math.min(20, +fsu.value || 0));
    _renderSimCfgLabels(); saveSimCfg();
  });
  sl?.addEventListener("input", () => {
    simCfg.stopLossPct = Math.max(0, Math.min(0.05, (+sl.value || 0) / 1000));
    _renderSimCfgLabels(); saveSimCfg();
  });
  tsl?.addEventListener("input", () => {
    simCfg.trailingStopPct = Math.max(0, Math.min(0.03, (+tsl.value || 0) / 10000));
    _renderSimCfgLabels(); saveSimCfg();
  });
  dks?.addEventListener("input", () => {
    simCfg.dailyMaxLossUsd = Math.max(0, Math.min(5000, +dks.value | 0));
    _renderSimCfgLabels(); saveSimCfg();
  });
  mpr?.addEventListener("input", () => {
    simCfg.minPriceUsd = Math.max(0, Math.min(50, +mpr.value | 0));
    _renderSimCfgLabels(); saveSimCfg();
  });
  mfp?.addEventListener("input", () => {
    // slider 存「% × 10000」整數，範圍 0~1%（0~100），步距 0.01%
    simCfg.maxFeePctOfAmount = Math.max(0, Math.min(0.01, (+mfp.value || 0) / 10000));
    _renderSimCfgLabels(); saveSimCfg();
  });
  fxr?.addEventListener("input", () => {
    // 上方欄位使用 number input，直接讀 float；範圍 0.1 ~ 500
    const raw = +fxr.value;
    if (!isFinite(raw)) return;
    simCfg.fxUsdTwd = Math.max(0.1, Math.min(500, raw));
    _renderSimCfgLabels(); saveSimCfg(); renderSimPanel();
  });
  fm?.addEventListener("change", () => {
    simCfg.fillMode = fm.checked ? 'optimistic' : 'strict';
    _renderSimCfgLabels(); saveSimCfg();
  });
  rth?.addEventListener("change", () => {
    simCfg.rthOnly = !!rth.checked;
    // 同步到新的 sessionMode。勾選 = rth；未勾選 = all
    simCfg.sessionMode = rth.checked ? "rth" : "all";
    if (sm) sm.value = simCfg.sessionMode;
    _renderSimCfgLabels(); saveSimCfg();
  });
  sm?.addEventListener("change", () => {
    const v = sm.value;
    simCfg.sessionMode = ["rth","rthPre","rthPost","all"].includes(v) ? v : "rth";
    // 反向同步舊 checkbox
    simCfg.rthOnly = simCfg.sessionMode === "rth";
    if (rth) rth.checked = simCfg.rthOnly;
    _renderSimCfgLabels(); saveSimCfg();
    try { _renderSimRule(); } catch (_) {}
  });
  wro?.addEventListener("change", () => {
    simCfg.wrRthOnly = !!wro.checked;
    _renderSimCfgLabels(); saveSimCfg();
    try { _renderSimRule(); } catch (_) {}
    // 讓下一輪掃描重計勝率（不主動躏 resort）
  });
  ext?.addEventListener("input", () => {
    // slider 0~50 → 0~0.005 (0～0.50%)；個位頫限 0.01
    simCfg.extendedFeePct = Math.max(0, Math.min(0.01, (+ext.value || 0) / 10000));
    _renderSimCfgLabels(); saveSimCfg();
    try { _renderSimRule(); } catch (_) {}
  });
  cbs?.addEventListener("input", () => {
    simCfg.chaseBumpSec = Math.max(0.01, Math.min(60, +cbs.value || 0.1));
    _renderSimCfgLabels(); saveSimCfg();
  });
  cbp?.addEventListener("input", () => {
    simCfg.chaseBumpPct = Math.max(0.01, Math.min(25, +cbp.value || 0.01));
    _renderSimCfgLabels(); saveSimCfg();
  });
  cms?.addEventListener("input", () => {
    simCfg.chaseMaxSec = Math.max(10, Math.min(1000, +cms.value | 0 || 120));
    _renderSimCfgLabels(); saveSimCfg();
  });
  cpg?.addEventListener("input", () => {
    simCfg.chasePanicGapPct = Math.max(0, Math.min(5, +cpg.value || 0));
    _renderSimCfgLabels(); saveSimCfg();
  });
  cpm?.addEventListener("input", () => {
    simCfg.chasePanicMul = Math.max(1, Math.min(50, +cpm.value | 0 || 10));
    _renderSimCfgLabels(); saveSimCfg();
  });
  xem?.addEventListener("change", () => {
    simCfg.exitMode = xem.checked ? 1 : 0;
    _renderSimCfgLabels(); saveSimCfg();
  });
  xcbs?.addEventListener("input", () => {
    simCfg.exitChaseBumpSec = Math.max(0.01, Math.min(60, +xcbs.value || 0.1));
    _renderSimCfgLabels(); saveSimCfg();
  });
  xcbp?.addEventListener("input", () => {
    simCfg.exitChaseBumpPct = Math.max(0.01, Math.min(25, +xcbp.value || 0.01));
    _renderSimCfgLabels(); saveSimCfg();
  });
  xcpg?.addEventListener("input", () => {
    simCfg.exitChasePanicGapPct = Math.max(0, Math.min(5, +xcpg.value || 0));
    _renderSimCfgLabels(); saveSimCfg();
  });
  xcpm?.addEventListener("input", () => {
    simCfg.exitChasePanicMul = Math.max(1, Math.min(50, +xcpm.value | 0 || 10));
    _renderSimCfgLabels(); saveSimCfg();
  });

  autoBtn?.addEventListener("click", () => {
    simCfg.autoEnabled = !simCfg.autoEnabled;
    saveSimCfg();
    _renderSimAutoState();
    if (simCfg.autoEnabled) { runSimAutoScan(); _startSimAutoTimer(); }
    else { _stopSimAutoTimer(); }
  });

  document.getElementById("simScanNowBtn")?.addEventListener("click", () => { runSimAutoScan(true); });

  // 匯率手動重查按鈕
  document.getElementById("simFxRefreshBtn")?.addEventListener("click", () => { _fetchFxOnline(true); });
  // 啟動時自動線上查一次匯率（靜默；失敗則沿用本地值）
  _fetchFxOnline(false);

  // ===== 右鍵選單：刪除單一筆模擬交易 =====
  document.getElementById("simTbody")?.addEventListener("contextmenu", (ev) => {
    const tr = ev.target.closest("tr[data-trade-id]");
    if (!tr) return;
    const tradeId = tr.dataset.tradeId;
    if (!tradeId) return;
    ev.preventDefault();
    const t = simTrades.find(x => String(x.id) === String(tradeId));
    if (!t) return;
    const isWsActive = t.source === "ws" && (t.status === "pending" || t.status === "open" || t.status === "selling");
    const warn = isWsActive
      ? `\n\n⚠️ 此筆為 WS 實交中的單（status=${t.status}\uff09。\n只刪除本機記錄，不會朝 TradingService 送取消訂單。\n若需取消訂單，請先按「✕ 刪單」或「✕ 平倉」。`
      : "";
    if (!confirm(`刪除這筆記錄？\n${t.sym}  ${(t.targetPct*100).toFixed(2)}%  ${t.status}${warn}`)) return;
    removeSimTradeById(tradeId);
  });

  // ===== WS 手動刪單：透過 tradingClient.abortTrade(wsId)，狀態以 server push 確認 =====
  document.getElementById("simTbody")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".sim-ws-cancel");
    if (!btn) return;
    ev.preventDefault();
    const tradeId = btn.dataset.tradeId;
    const wsId    = btn.dataset.wsId;
    if (!tradeId || !wsId) return;
    const t = simTrades.find(x => String(x.id) === String(tradeId));
    if (!t) return;
    if (!window.tradingClient || !window.tradingClient.connected) {
      alert("WS 未連線，無法送出刪單。");
      return;
    }
    if (!confirm(`要對 ${t.sym} (id=${wsId}) 送出刪單嗎？\n實際狀態以 TradingService 回報為準。`)) return;
    btn.disabled = true;
    btn.textContent = "…";
    // 樂觀標記：等 server push 回 BuyCancelling/BuyCanceled 才會真的改 status
    t.cancelRequested = true;
    t.cancelRequestedTime = Date.now();
    window.tradingClient.abortTrade(wsId)
      .then(data => {
        // 回 ack 即可，真正狀態變更由 trade_update 推送處理
        if (data) _applyWsTradeUpdate(t, data);
        saveSimTrades(); renderSimPanel();
      })
      .catch(err => {
        console.warn("[ws] abortTrade failed", err);
        t.cancelRequested = false;
        t.lastError = String((err && err.message) || err);
        saveSimTrades(); renderSimPanel();
        alert("刪單失敗：" + t.lastError);
      });
  });

  // ===== 分組「↶ 預設」按鈕：只重設該類別的欄位 =====
  const GROUP_KEYS = {
    entry:    ["concurrency", "targetPct", "trailingStopPct", "windowMs", "wrMin", "wrMin050", "perSymMax", "gradientLevel"],
    strategy: ["entryMode", "chaseBumpSec", "chaseBumpPct", "chaseMaxSec", "chasePanicGapPct", "chasePanicMul"],
    exit:     ["exitMode", "exitChaseBumpSec", "exitChaseBumpPct", "exitChasePanicGapPct", "exitChasePanicMul"],
    risk:     ["amountPerTradeUsd", "feeBuyUsd", "feeBuyPct", "feeSellPct", "feeSellUsd", "stopLossPct", "dailyMaxLossUsd", "minPriceUsd", "maxFeePctOfAmount", "fxUsdTwd"],
    exec:     ["executionMode", "sessionMode", "wrRthOnly", "extendedFeePct", "fillMode", "scanIntervalSec"],
  };
  function _pushCfgToControls() {
    if (conc) conc.value = String(simCfg.concurrency);
    if (tgt)  tgt.value  = String(Math.round(simCfg.targetPct * 10000));
    if (win)  win.value  = String(Math.round(simCfg.windowMs / 60000));
    if (wrm)  wrm.value  = String(Math.round(simCfg.wrMin * 100));
    if (wrm5) wrm5.value = String(Math.round(simCfg.wrMin050 * 100));
    if (psm)  psm.value  = String(simCfg.perSymMax);
    if (ssec) ssec.value = String(simCfg.scanIntervalSec);
    if (gl)   gl.value   = String(simCfg.gradientLevel);
    if (em)   em.value   = String(simCfg.entryMode);
    if (xm)   xm.checked = ((simCfg.executionMode | 0) === 1);
    if (sh)   sh.value   = String(simCfg.amountPerTradeUsd);
    if (fb)   fb.value   = String(Math.round(simCfg.feeBuyUsd));
    if (fbp)  fbp.value  = String(Math.round((+simCfg.feeBuyPct || 0) * 10000));
    if (fs)   fs.value   = String(Math.round(simCfg.feeSellPct * 10000));
    if (fsu)  fsu.value  = String(Math.round(+simCfg.feeSellUsd || 0));
    if (sl)   sl.value   = String(Math.round(simCfg.stopLossPct * 1000));
    if (tsl)  tsl.value  = String(Math.round((+simCfg.trailingStopPct || 0) * 10000));
    if (dks)  dks.value  = String(Math.round(+simCfg.dailyMaxLossUsd || 0));
    if (mpr)  mpr.value  = String(Math.round(+simCfg.minPriceUsd || 0));
    if (mfp)  mfp.value  = String(Math.round((+simCfg.maxFeePctOfAmount || 0) * 10000));
    if (fxr)  fxr.value  = (+simCfg.fxUsdTwd || 31.5).toFixed(1);
    if (fm)   fm.checked = (simCfg.fillMode === 'optimistic');
    if (sm)   sm.value = (simCfg.sessionMode || "rth");
    if (wro)  wro.checked = !!simCfg.wrRthOnly;
    if (ext)  ext.value  = String(Math.round((+simCfg.extendedFeePct || 0) * 10000));
    if (rth)  rth.checked = !!simCfg.rthOnly;
    if (cbs)  cbs.value  = String(simCfg.chaseBumpSec);
    if (cbp)  cbp.value  = String(simCfg.chaseBumpPct);
    if (cms)  cms.value  = String(simCfg.chaseMaxSec);
    if (cpg)  cpg.value  = String(simCfg.chasePanicGapPct);
    if (cpm)  cpm.value  = String(simCfg.chasePanicMul);
    if (xem)  xem.checked = ((simCfg.exitMode | 0) === 1);
    if (xcbs) xcbs.value = String(simCfg.exitChaseBumpSec);
    if (xcbp) xcbp.value = String(simCfg.exitChaseBumpPct);
    if (xcpg) xcpg.value = String(simCfg.exitChasePanicGapPct);
    if (xcpm) xcpm.value = String(simCfg.exitChasePanicMul);
  }
  document.querySelectorAll(".sim-group-reset").forEach(btn => {
    btn.addEventListener("click", () => {
      const grp = btn.dataset.resetgroup;
      const keys = GROUP_KEYS[grp];
      if (!keys) return;
      for (const k of keys) {
        if (k in SIM_DEFAULT_CFG) simCfg[k] = SIM_DEFAULT_CFG[k];
      }
      _pushCfgToControls();
      _renderSimCfgLabels();
      saveSimCfg();
      renderSimPanel();
      if (grp === "exec" && simCfg.autoEnabled) _startSimAutoTimer();
    });
  });
  // 「套用全部預設」按鈕已移除：新版預設改由 loadSimTrades() 的一次性 migration 自動套用到舊設定。

  _renderSimAutoState();
  if (simCfg.autoEnabled) { _startSimAutoTimer(); runSimAutoScan(); }

  function _renderSimCfgLabels() {
    // 共用：依「數值 vs 門檻」決定色階（向上越高越積極 → warn/bad）
    const tier = (v, warnAt, badAt) => v >= badAt ? "v-bad" : (v >= warnAt ? "v-warn" : "v-ok");
    // 反向：值越大越保守
    const tierLow = (v, warnAt, badAt) => v <= badAt ? "v-bad" : (v <= warnAt ? "v-warn" : "v-ok");
    const num  = (txt, cls = "v-num") => `<span class="${cls}">${txt}</span>`;
    const unit = (u) => `<span class="v-unit">${u}</span>`;
    const pill = (txt, cls) => `<span class="v-pill ${cls}">${txt}</span>`;

    if (concV) {
      // 同時持單：1=安全 / 2-3=注意 / ≥4=風險
      const v = simCfg.concurrency;
      concV.innerHTML = num(v, tier(v, 2, 4)) + unit("筆");
    }
    if (tgtV) {
      // 目標漲幅：<0.4%=保守 / 0.4-0.8%=正常 / >0.8%=偏高
      const p = simCfg.targetPct * 100;
      const cls = p < 0.4 ? "v-ok" : (p > 0.8 ? "v-warn" : "v-num");
      // 額外提示：目前手續費結構下的「來回回本門檻 %」 — 真正獲利需要目標 > 此值
      const amt = Math.max(0, +simCfg.amountPerTradeUsd || 0);
      let beHtml = "";
      if (amt > 0) {
        const px = 100;
        const sh = Math.max(1, Math.floor(amt / px) || 1);
        const buyFee = (+simCfg.feeBuyUsd || 0) + (amt * (+simCfg.feeBuyPct || 0));
        const notional = sh * px;
        const sellFee = notional * (+simCfg.feeSellPct || 0) + (+simCfg.feeSellUsd || 0);
        const breakeven = notional > 0 ? ((buyFee + sellFee) / notional) * 100 : 0;
        const netPct = p - breakeven; // 預估每筆淨獲利 %
        const beCls = breakeven >= p ? "v-bad" : (breakeven >= p * 0.6 ? "v-warn" : "v-ok");
        const netCls = netPct >= 0.2 ? "v-bad" : (netPct > 0 ? "v-warn" : "v-ok");
        const netSign = netPct >= 0 ? "+" : "";
        // 預估每筆「淨獲利」實際金額：USD = 名目 × 淨利%；TWD ≈ USD × 匯率
        const fxRate = Math.max(0.1, Math.min(500, +simCfg.fxUsdTwd || 31.5));
        const netUsd = notional * netPct / 100;
        const netTwd = netUsd * fxRate;
        const moneyWord = netUsd >= 0 ? "賺" : "虧";
        const usdStr = `USD $${Math.abs(netUsd).toFixed(2)}`;
        const twdAbs = Math.abs(netTwd);
        const twdStr = twdAbs >= 1000
          ? `(NT$${(twdAbs / 1000).toFixed(2)}k)`
          : `(NT$${twdAbs.toFixed(0)})`;
        beHtml =
          `<div class="sim-tgt-stack">` +
            `<div class="sim-tgt-row" title="含來回手續費的「回本門檻」；目標漲幅須 &gt; 此值才能獲利">` +
              `<span class="sim-tgt-op">−</span><span class="sim-tgt-tag">成本</span>` +
              `<span class="${beCls} sim-tgt-glow sim-tgt-num">${breakeven.toFixed(3)}%</span>` +
            `</div>` +
            `<div class="sim-tgt-row" title="預估每筆淨獲利 % = 目標漲幅 − 來回手續費">` +
              `<span class="sim-tgt-op">=</span><span class="sim-tgt-tag">獲利</span>` +
              `<span class="${netCls} sim-tgt-glow sim-tgt-num">${netSign}${netPct.toFixed(3)}%</span>` +
            `</div>` +
            `<div class="sim-tgt-row sim-tgt-money" title="以 1 USD ≈ ${fxRate.toFixed(1)} TWD 估算的每筆淨獲利金額">` +
              `<span class="sim-tgt-op"></span><span class="sim-tgt-tag">${moneyWord}</span>` +
              `<span class="${netCls} sim-tgt-num sim-tgt-fx">${usdStr} ${twdStr}</span>` +
            `</div>` +
          `</div>`;
      }
      tgtV.innerHTML = num("+" + p.toFixed(2), cls + " sim-tgt-main") + `<span class="v-unit sim-tgt-main-unit">%</span>` + beHtml;
    }
    if (winV) {
      const m = Math.round(simCfg.windowMs / 60000);
      const txt = m >= 60 ? `${Math.floor(m/60)}h${m%60 ? (m%60)+"m" : ""}` : `${m}`;
      winV.innerHTML = num(txt, "v-num") + (m >= 60 ? "" : unit("分"));
    }
    if (wrmV)  {
      const p = Math.round(simCfg.wrMin * 100);
      wrmV.innerHTML = num(p, tierLow(p, 55, 45)) + unit("%");
    }
    if (wrm5V) {
      const p = Math.round(simCfg.wrMin050 * 100);
      wrm5V.innerHTML = num(p, tierLow(p, 60, 50)) + unit("%");
    }
    if (psmV) {
      const v = simCfg.perSymMax;
      psmV.innerHTML = v <= 1
        ? num("1", "v-ok") + unit("單") + ` <span class="v-sub">(不連續)</span>`
        : num(v, tier(v, 2, 4)) + unit("單") + ` <span class="v-sub">(同時持有)</span>`;
    }
    if (ssecV) ssecV.innerHTML = num(simCfg.scanIntervalSec, "v-num") + unit("秒");
    if (glV)   {
      // 保護等級：0=關 / 1-2=正常 / ≥3=嚴格
      const lv = simCfg.gradientLevel | 0;
      const label = _simGradLvLabel(lv);
      const cls = lv === 0 ? "v-off" : (lv >= 3 ? "v-ok" : "v-num");
      glV.innerHTML = `<span class="${cls}">${label}</span>`;
    }
    if (emV) {
      const mode = simCfg.entryMode | 0;
      const label = _simEntryModeLabel(mode);
      // 0 市價 / 5 追價·目前 = 最積極，警告；3/4 追價 = 警告；1/2 = 保守
      const cls = (mode === 0 || mode >= 3) ? "v-warn" : "v-ok";
      emV.innerHTML = pill(label, cls);
    }
    if (xmV) {
      const isWs = (simCfg.executionMode | 0) === 1;
      xmV.innerHTML = isWs
        ? pill("1 · WS 實交", "v-bad")
        : pill("0 · 本機模擬", "v-ok");
    }
    if (shV)   {
      const amt = +simCfg.amountPerTradeUsd || 0;
      if (amt <= 0) {
        shV.innerHTML = `<span class="v-pill v-off">不下單</span>`;
      } else {
        // 金額分級：< $1000 = 試水(綠) / $1000-$10000 = 一般(青) / > $10000 = 大單(警告)
        const cls = amt < 1000 ? "v-ok" : (amt > 10000 ? "v-warn" : "v-money");
        const fmt = amt.toLocaleString("en-US");
        // 台幣估算（匯率 ~31.5 TWD/USD），以「萬」為單位
        const fxRate = Math.max(0.1, Math.min(500, +simCfg.fxUsdTwd || 31.5));
        const twdWan = (amt * fxRate) / 10000;
        const twdStr = twdWan >= 10
          ? twdWan.toFixed(0)
          : (twdWan >= 1 ? twdWan.toFixed(1) : twdWan.toFixed(2));
        shV.innerHTML = `<span class="${cls}">USD $${fmt}</span>` +
          `<span class="v-sub" title="以 1 USD ≈ ${fxRate.toFixed(1)} TWD 估算（可在『匯率』設定調整）"> ≈ 約 ${twdStr} 萬台幣</span>`;
      }
    }
    const amtForFee = +simCfg.amountPerTradeUsd || 0;
    if (fbV)   {
      const usd = +simCfg.feeBuyUsd || 0;
      let html = `<span class="v-money">USD $${usd.toFixed(2)}</span>`;
      if (amtForFee > 0) {
        const pct = (usd / amtForFee) * 100;
        html += `<span class="v-sub" title="相對於每筆金額 $${amtForFee.toLocaleString("en-US")}"> ≈ ${pct.toFixed(3)}%</span>`;
      }
      fbV.innerHTML = html;
    }
    if (fbpV)  {
      const pct = (+simCfg.feeBuyPct || 0) * 100;
      let html;
      if (pct <= 0) {
        html = `<span class="v-pill v-off">關閉</span>`;
      } else {
        html = num(pct.toFixed(2), "v-money") + unit("%");
        if (amtForFee > 0) {
          const usd = amtForFee * (+simCfg.feeBuyPct || 0);
          html += `<span class="v-sub" title="相對於每筆金額 $${amtForFee.toLocaleString("en-US")}"> ≈ USD $${usd.toFixed(2)}</span>`;
        }
      }
      fbpV.innerHTML = html;
    }
    if (fsV)   {
      const p = simCfg.feeSellPct * 100;
      let html = num(p.toFixed(3), "v-money") + unit("%");
      if (amtForFee > 0) {
        const usd = amtForFee * simCfg.feeSellPct;
        html += `<span class="v-sub" title="相對於每筆金額 $${amtForFee.toLocaleString("en-US")}"> ≈ USD $${usd.toFixed(2)}</span>`;
      }
      fsV.innerHTML = html;
    }
    if (fsuV)  {
      const usd = +simCfg.feeSellUsd || 0;
      let html;
      if (usd <= 0) {
        html = `<span class="v-pill v-off">關閉</span>`;
      } else {
        html = `<span class="v-money">USD $${usd.toFixed(2)}</span>`;
        if (amtForFee > 0) {
          const pct = (usd / amtForFee) * 100;
          html += `<span class="v-sub" title="相對於每筆金額 $${amtForFee.toLocaleString("en-US")}"> ≈ ${pct.toFixed(3)}%</span>`;
        }
      }
      fsuV.innerHTML = html;
    }
    if (slV)   {
      if (simCfg.stopLossPct > 0) {
        const p = simCfg.stopLossPct * 100;
        // 停損：<1%=過緊(警告) / 1-3%=合理 / >3%=寬鬆(警告)
        const cls = (p < 1 || p > 3) ? "v-warn" : "v-ok";
        slV.innerHTML = num("-" + p.toFixed(1), cls) + unit("%");
      } else {
        slV.innerHTML = pill("關閉", "v-bad");
      }
    }
    if (tslV)  {
      const p = (+simCfg.trailingStopPct || 0) * 100;
      if (p > 0) {
        // 移動停利：0.2~0.5% 合理、其他警告
        const cls = (p < 0.2 || p > 0.5) ? "v-warn" : "v-ok";
        tslV.innerHTML = num("▼" + p.toFixed(2), cls) + unit("%");
      } else {
        tslV.innerHTML = pill("關閉", "v-off");
      }
    }
    // 移動停利啟用時：把『目標漲幅』的 label 加上「→ 鎖獲利啟動門檻」的提示，讓使用者知道賣出規則變了
    const tgtLabelEl = document.getElementById("simCfgTargetLabel");
    if (tgtLabelEl) {
      const trailOn = (+simCfg.trailingStopPct || 0) > 0;
      tgtLabelEl.innerHTML = trailOn
        ? `目標漲幅 <span class="sim-trail-hint" title="移動停利啟用中：達到此 % 不立刻賣，改進入鎖獲利狀態，等峰值回撚 ${((+simCfg.trailingStopPct||0)*100).toFixed(2)}% 才賣">→ 鎖獲利啟動門檻</span>`
        : `目標漲幅`;
    }
    if (dksV)  {
      const v = +simCfg.dailyMaxLossUsd || 0;
      if (v > 0) {
        dksV.innerHTML = `<span class="v-money">-$${v.toLocaleString("en-US")}</span>`;
      } else {
        dksV.innerHTML = pill("關閉", "v-off");
      }
    }
    if (mprV)  {
      const v = +simCfg.minPriceUsd || 0;
      if (v > 0) {
        const cls = v < 5 ? "v-warn" : "v-ok";
        mprV.innerHTML = `<span class="${cls}">≥ USD $${v}</span>`;
      } else {
        mprV.innerHTML = pill("不過濾", "v-off");
      }
    }
    if (mfpV)  {
      const v = +simCfg.maxFeePctOfAmount || 0;
      if (v > 0) {
        const pctNum = v * 100;
        // ≤ 0.20% 綠；0.20~0.50% 黃；> 0.50% 紅
        const cls = pctNum <= 0.20 ? "v-ok" : (pctNum <= 0.50 ? "v-warn" : "v-bad");
        mfpV.innerHTML = `<span class="${cls}">≤ ${pctNum.toFixed(2)}%</span>`;
      } else {
        mfpV.innerHTML = pill("不限", "v-off");
      }
    }
    if (fxrV)  {
      const fx = Math.max(0.1, Math.min(500, +simCfg.fxUsdTwd || 31.5));
      // 30~33 = 近期合理區間（綠）；偏離 ±10% 黃；極端值警示
      const cls = (fx >= 28 && fx <= 34) ? "v-ok" : ((fx >= 24 && fx <= 40) ? "v-warn" : "v-bad");
      fxrV.innerHTML = `<span class="${cls}">${fx.toFixed(1)}</span><span class="v-unit">TWD</span>`;
    }
    if (fmV)   {
      const opt = simCfg.fillMode === 'optimistic';
      fmV.innerHTML = opt
        ? pill("optimistic · 樂觀", "v-warn")
        : pill("strict · 保守", "v-ok");
    }
    if (rthV)  {
      const ci = _getEtClockInfo();
      const smode = simCfg.sessionMode || "rth";
      const smTxt = ({rth:"僅 RTH", rthPre:"RTH + 盤前", rthPost:"RTH + 盤後", all:"全時段"})[smode] || "僅 RTH";
      const main = smode === "rth"
        ? pill("是 · 僅盤中", "v-ok")
        : pill("否 · " + smTxt, "v-warn");
      const nextStr = ci.nextMin ? `（${ci.nextLabel} ${ci.nextMin}）` : '';
      const tip = `當地 ${ci.localStr} ${ci.localTz}${ci.localTzName ? ' (' + ci.localTzName + ')' : ''}&#10;美東 ${ci.etStr} ${ci.tz}（${ci.isDst ? '夏令 EDT, UTC-4' : '冬令 EST, UTC-5'}）&#10;盤前 04:00 / RTH 09:30-16:00 / 盤後 16:00-20:00 ET&#10;會自動處理 DST 換時`;
      const clock = ` <span class="sim-ctrl-sub" title="${tip}">${ci.phaseIcon} ET ${ci.etStr} ${ci.tz} · ${ci.phase}${nextStr} <span class="sim-ctrl-sub-local">· 本地 ${ci.localStr} ${ci.localTz}</span></span>`;
      rthV.innerHTML = main + clock;
    }
    if (smV)   {
      const smode = simCfg.sessionMode || "rth";
      const map = {rth:["僅 RTH","v-ok"], rthPre:["RTH + 盤前","v-warn"], rthPost:["RTH + 盤後","v-warn"], all:["全時段","v-warn"]};
      const [t, c] = map[smode] || map.rth;
      smV.innerHTML = pill(t, c);
    }
    if (wroV)  {
      wroV.innerHTML = simCfg.wrRthOnly
        ? pill("是 · 僅盤中 bars", "v-ok")
        : pill("否 · 混合全時段", "v-warn");
    }
    if (extV)  {
      const p = (+simCfg.extendedFeePct || 0) * 100; // 顯示為 %
      extV.innerHTML = (p <= 0)
        ? pill("關閉", "v-warn")
        : num(p.toFixed(3), "v-num") + unit("%");
    }
    if (cbsV)  cbsV.innerHTML = num((+simCfg.chaseBumpSec).toFixed(2), "v-num") + unit("秒");
    if (cbpV)  cbpV.innerHTML = num((simCfg.chaseBumpPct).toFixed(2), "v-num") + unit("%");
    if (cmsV)  cmsV.innerHTML = num(simCfg.chaseMaxSec, "v-num") + unit("秒");
    if (cpgV)  {
      const v = +simCfg.chasePanicGapPct || 0;
      cpgV.innerHTML = (v === 0)
        ? pill("關閉", "v-warn")
        : num(v.toFixed(2), "v-num") + unit("%");
    }
    if (cpmV)  cpmV.innerHTML = num("×" + (simCfg.chasePanicMul | 0), "v-num");
    if (xemV)  {
      const m = (+simCfg.exitMode | 0);
      xemV.innerHTML = (m === 0)
        ? pill("0 市價立刻", "v-warn")
        : pill("1 追價賣出", "v-ok");
    }
    if (xcbsV) xcbsV.innerHTML = num((+simCfg.exitChaseBumpSec).toFixed(2), "v-num") + unit("秒");
    if (xcbpV) xcbpV.innerHTML = num((+simCfg.exitChaseBumpPct).toFixed(2), "v-num") + unit("%");
    if (xcpgV) {
      const v = +simCfg.exitChasePanicGapPct || 0;
      xcpgV.innerHTML = (v === 0)
        ? pill("關閉", "v-warn")
        : num(v.toFixed(2), "v-num") + unit("%");
    }
    if (xcpmV) xcpmV.innerHTML = num("×" + (simCfg.exitChasePanicMul | 0), "v-num");
    // 只有追價模式（entryMode ≥ 3）才顯示追價間隔 / 步幅 / 時限 三張卡片
    const isChaseMode = (simCfg.entryMode | 0) >= 3;
    document.querySelectorAll(".sim-chase-only").forEach(el => {
      el.style.display = isChaseMode ? "" : "none";
    });
    // 出場追價：exitMode === 1 才顯示三張子卡
    const isExitChase = (+simCfg.exitMode | 0) === 1;
    document.querySelectorAll(".sim-exit-chase-only").forEach(el => {
      el.style.display = isExitChase ? "" : "none";
    });
    // 預估成本（每筆）：以「實際下單金額 + 假設股價 $100」估算手續費佔比與最低淨回本門檻
    const estEl = document.getElementById("simFeeEstVal");
    if (estEl) {
      const amt = Math.max(0, +simCfg.amountPerTradeUsd || 0);
      const px = 100; // 假設每股 $100，僅供示意股數
      const sh = Math.max(1, Math.floor(amt / px) || 1);
      const buyFee = (+simCfg.feeBuyUsd || 0) + (amt * (+simCfg.feeBuyPct || 0));
      const notional = sh * px; // = amt（近似）
      const sellFee = notional * (+simCfg.feeSellPct || 0) + (+simCfg.feeSellUsd || 0);
      const totalFee = buyFee + sellFee;
      const breakeven = notional > 0 ? (totalFee / notional) * 100 : 0;
      // 與 targetPct 對比：回本門檻 >= 目標 → 紅警告；接近 → 黃
      const tgt = (simCfg.targetPct || 0) * 100;
      const beCls = amt <= 0 ? "v-off"
                  : (breakeven >= tgt ? "v-bad" : (breakeven >= tgt * 0.6 ? "v-warn" : "v-ok"));
      if (amt <= 0) {
        estEl.innerHTML = `<span class="v-off">未啟用下單</span>`;
      } else {
        estEl.innerHTML =
          `<span title="買 $${buyFee.toFixed(2)} + 賣 $${sellFee.toFixed(2)}（假設 $${px}/股、約 ${sh} 股）">` +
          `來回 <span class="v-money">$${totalFee.toFixed(2)}</span></span><br>` +
          `<span title="達到淨利為 0 需要的毛漲幅；目標漲幅須 &gt; 此值才能獲利">` +
          `回本門檻 ≈ <span class="${beCls} sim-breakeven-big">${breakeven.toFixed(3)}%</span></span>`;
      }
    }
    _renderSimRule();
  }
  function _renderSimAutoState() {
    if (autoBtn) {
      autoBtn.classList.toggle("danger", simCfg.autoEnabled);
    }
    _tickAutoBtnCountdown();
    _renderSimAutoStatusLive();
  }
}

function _startSimAutoTimer() {
  _stopSimAutoTimer();
  const sec = Math.max(1, Math.min(60, simCfg.scanIntervalSec | 0 || 5));
  _simAutoTimer = setInterval(runSimAutoScan, sec * 1000);
  // tick timer 不論自動是否啟用都會跑（bindSimPanel 初始化）；這裡確保至少存在
  _startSimTickTimer();
  // 「測試時長到期前 1 秒」自動關閉 auto；windowMs 為單筆持單時長，這裡借用為本次 auto session 的總長度
  const win = +simCfg.windowMs || 0;
  const lead = 1000; // 提早 1 秒
  if (win > lead) {
    _simAutoStopAt = Date.now() + (win - lead);
    _simAutoStopTimer = setTimeout(_doAutoStop, win - lead);
    // 背景分頁 setTimeout 會被節流到 ≥1 分鐘；chrome.alarms 則維持原排程精度。
    // 兩者擇先觸發，重複呼叫由 _doAutoStop 內部判斷 autoEnabled 防止重入。
    try {
      chrome.alarms?.create("simAutoStop", { when: _simAutoStopAt });
    } catch {}
  } else {
    _simAutoStopAt = 0;
  }
  // 按鈕文字每秒倒數一次
  if (_simAutoCountdownTimer) { clearInterval(_simAutoCountdownTimer); }
  _tickAutoBtnCountdown();
  _simAutoCountdownTimer = setInterval(_tickAutoBtnCountdown, 1000);
}
function _doAutoStop() {
  _simAutoStopTimer = null;
  const winMs = +simCfg.windowMs || 0;
  _simAutoStopAt = 0;
  if (!simCfg.autoEnabled) return;
  simCfg.autoEnabled = false;
  try { saveSimCfg(); } catch {}
  if (_simAutoTimer) { clearInterval(_simAutoTimer); _simAutoTimer = null; }
  if (_simAutoCountdownTimer) { clearInterval(_simAutoCountdownTimer); _simAutoCountdownTimer = null; }
  try { chrome.alarms?.clear("simAutoStop"); } catch {}
  try { _logSim("reject", "AUTO", `測試時長到期前 1 秒自動停止自動買入（windowMs=${(winMs/60000).toFixed(1)}m）`, { src: "auto-stop" }); } catch {}
  try {
    const _btn = document.getElementById("simAutoBtn");
    if (_btn) {
      _btn.textContent = "▶ 啟用自動買入";
      _btn.classList.remove("danger");
    }
  } catch {}
  try { _renderSimAutoStatusLive && _renderSimAutoStatusLive(); } catch {}
}
// chrome.alarms 監聽（背景分頁 setTimeout 被節流時的備援）
try {
  chrome.alarms?.onAlarm?.addListener((alarm) => {
    if (alarm?.name === "simAutoStop") _doAutoStop();
  });
} catch {}
function _stopSimAutoTimer() {
  if (_simAutoTimer) { clearInterval(_simAutoTimer); _simAutoTimer = null; }
  if (_simAutoStopTimer) { clearTimeout(_simAutoStopTimer); _simAutoStopTimer = null; }
  if (_simAutoCountdownTimer) { clearInterval(_simAutoCountdownTimer); _simAutoCountdownTimer = null; }
  try { chrome.alarms?.clear("simAutoStop"); } catch {}
  _simAutoStopAt = 0;
  // tick timer 保持運作：使用者可能手動下單，仍需 settle
  // 停止後順手將按鈕語意復原
  try { _tickAutoBtnCountdown(); } catch {}
}

// 對所有有 pending / open 訂單的股票，主動 fetch 最新 intra 並呼叫 settle。
// 確保即使該股票卡片沒刷新，pending 也能在 3 秒延遲後正確成交、open 也能即時結算。
let _simTickTimer = null;
let _simTickInflight = false;
async function _tickActiveSimSymbols() {
  if (_simTickInflight) return;
  const syms = [...new Set(
    simTrades.filter(t => t.status === "pending" || t.status === "open" || t.status === "selling").map(t => t.sym)
  )];
  if (!syms.length) return;
  _simTickInflight = true;
  try {
    // 也先用 expireOldSimTrades 把 windowMs 過久的清掉
    expireOldSimTrades();
    await Promise.all(syms.map(async sym => {
      try {
        const intra = await fetchIntraday(sym);
        if (!intra) return;
        // 盤前 / 盤後：Yahoo 的 regularMarketPrice 在非正規時段會凍結在前一段交易時段收盤，
        // 結算價看起來「不動」。改採「時間戳最新者」（與大盤上方「盤前 / 盤後」欄顯示一致）。
        const fp = _pickFreshIntraPrice(intra);
        const livePx = (fp.price != null) ? fp.price : intra.price;
        if (isFinite(livePx)) {
          // 將「session 化價」覆蓋到 intra.price，settleSimTradesForSymbol 沿用該欄位判定達標/停損
          settleSimTradesForSymbol(sym, { ...intra, price: livePx });
        }
      } catch {}
    }));
  } finally {
    _simTickInflight = false;
  }
}

// 自動買入：掃描 wlData，依條件 wr030 >= wr050 >= wr050d 過濾，
// 取 wr030 最高者依序買入，直到觸頂 simCfg.concurrency 同時持單上限
async function runSimAutoScan(force) {
  if (!force && !simCfg.autoEnabled) return;
  // 每日 Kill Switch：今日已結算償損益 ≤ -門檻 → 自動關閉 auto
  const killLimit = +simCfg.dailyMaxLossUsd || 0;
  if (killLimit > 0) {
    const todayNet = _simTodayNetPnl();
    if (todayNet <= -killLimit) {
      if (simCfg.autoEnabled) {
        simCfg.autoEnabled = false;
        saveSimCfg(); _stopSimAutoTimer(); _renderSimAutoState();
        try { console.warn(`[sim] Daily kill switch triggered: today net = $${todayNet.toFixed(2)} ≤ -$${killLimit}。已自動停用。`); } catch {}
      }
      _simLastScan = { time: Date.now(), wlSize: 0, candidates: 0, placed: 0, reason: `🚫 今日已償損 $${(-todayNet).toFixed(2)} ≥ kill switch $${killLimit} → 自動關閉` };
      _renderSimAutoStatusLive(); return;
    }
  }
  // 先 tick 所有 pending/open 訂單的股票，確保即使該股卡片沒刷新，settle 也會跑
  await _tickActiveSimSymbols();
  if (typeof wlData === "undefined" || !wlData) {
    _simLastScan = { time: Date.now(), wlSize: 0, candidates: 0, placed: 0, reason: "wlData 未就緒" };
    _renderSimAutoStatusLive(); return;
  }

  // 計入「同時持單」的狀態：
  //   pending  = 已送出尚未成交（限價單等待中、追價中）
  //   open     = 已成交持有中
  //   selling  = 持有中正在送出賣單
  // 之前只算 open/selling，造成 pending 階段被視為 0 倉位，導致同一輪 / 緊鄰下一輪自動再下另一檔，
  // 突破 simCfg.concurrency 上限。
  const ACTIVE_STATUSES = new Set(["pending", "open", "selling"]);
  const openCount = simTrades.filter(t => ACTIVE_STATUSES.has(t.status)).length;
  let slots = simCfg.concurrency - openCount;
  if (slots <= 0) {
    _simLastScan = { time: Date.now(), wlSize: wlData.size, candidates: 0, placed: 0, reason: "持單已滿" };
    _renderSimAutoStatusLive(); return;
  }

  // 計算每股現有持單數（同樣納入 pending，避免同一檔在限價排隊時又被重複追單）
  const openBySym = new Map();
  for (const t of simTrades) {
    if (!ACTIVE_STATUSES.has(t.status)) continue;
    openBySym.set(t.sym, (openBySym.get(t.sym) || 0) + 1);
  }
  const perSymMax = Math.max(1, simCfg.perSymMax | 0);

  const rows = [...wlData.values()];
  const candidates = rows.filter(r => {
    if (!r || typeof r.wr030 !== "number" || typeof r.wr050 !== "number" || typeof r.wr050d !== "number") return false;
    if (r.wr030 < simCfg.wrMin) return false;
    if (r.wr050 < simCfg.wrMin050) return false;
    // 最小股價過濾：避免 penny stock / sub-penny tick
    if ((+simCfg.minPriceUsd || 0) > 0) {
      const px = (typeof r.price === "number" && r.price > 0) ? r.price : null;
      if (px !== null && px < simCfg.minPriceUsd) return false;
    }
    const lv = Math.max(0, Math.min(3, simCfg.gradientLevel | 0));
    if (lv === 1 && !(r.wr050 >= r.wr050d)) return false;
    if (lv === 2 && !(r.wr030 >= r.wr050d)) return false;
    if (lv === 3 && !(r.wr030 >= r.wr050 && r.wr050 >= r.wr050d)) return false;
    if ((openBySym.get(r.sym) || 0) >= perSymMax) return false;
    return true;
  });
  candidates.sort((a, b) => (b.wr030 - a.wr030) || (b.wr050 - a.wr050));

  let placed = 0;
  for (const r of candidates) {
    if (slots <= 0) break;
    const have = openBySym.get(r.sym) || 0;
    let canAddForSym = Math.max(0, perSymMax - have);
    if (canAddForSym <= 0) continue;
    let price = (typeof r.price === "number" && r.price > 0) ? r.price : null;
    if (!price) {
      try {
        const intra = await fetchIntraday(r.sym);
        if (intra && isFinite(intra.price) && intra.price > 0) price = intra.price;
      } catch {}
    }
    if (!price) continue;
    // 一次掃描內，同一個股可連續下單至 perSymMax，不用等下一輪
    while (canAddForSym > 0 && slots > 0) {
      // 不再依 limit 決定是否下單；addSimTrade 內部會建立 pending 訂單，
      // 依限價 + 3 秒延遲決定是否成交。未成交會以 unfilled 顯示。
      const t = addSimTrade(r.sym, simCfg.targetPct, price, {
        auto: true,
        wr030: r.wr030, wr050: r.wr050, wr050d: r.wr050d,
        suggestPx: r.suggestPx,
      });
      if (!t) break;
      slots--; placed++; canAddForSym--;
      openBySym.set(r.sym, (openBySym.get(r.sym) || 0) + 1);
    }
  }

  _simLastScan = {
    time: Date.now(),
    wlSize: rows.length,
    candidates: candidates.length,
    placed,
    reason: candidates.length === 0 ? "無符合條件個股" : (placed > 0 ? `下單 ${placed} 筆（限價挂單，待成交）` : "有候選但無可用價")
  };
  _renderSimAutoStatusLive();
  // 每 30 秒輸出一次 top 候選（每次 scan 都印太吵）
  _logOnce("auto-scan-top", 30_000, () => console.log("[sim auto]", _simLastScan, "top:", candidates.slice(0, 3).map(r => `${r.sym} wr030=${(r.wr030*100|0)}% wr050=${(r.wr050*100|0)}% wr050d=${(r.wr050d*100|0)}%`)));
}

function _renderSimRule() {
  const el = document.getElementById("simRuleSummary") || document.getElementById("simRule");
  if (!el) return;

  // ===== 取值（含安全 fallback / 換算） =====
  const tgt   = (simCfg.targetPct * 100).toFixed(2);
  const mins  = Math.round(simCfg.windowMs / 60000);
  const winLbl = mins >= 60 ? `${Math.floor(mins/60)}h${mins%60 ? (mins%60)+"m" : ""}` : `${mins} 分`;
  const w030  = Math.round(simCfg.wrMin * 100);
  const w050  = Math.round(simCfg.wrMin050 * 100);
  const conc  = simCfg.concurrency;
  const psm   = simCfg.perSymMax;
  const sec   = simCfg.scanIntervalSec;
  const lv    = Math.max(0, Math.min(3, simCfg.gradientLevel | 0));
  const mode  = Math.max(0, Math.min(5, simCfg.entryMode | 0));
  const isChase = mode >= 3;
  const cbs   = +simCfg.chaseBumpSec || 0.1;
  const cbp   = +simCfg.chaseBumpPct || 0.01;
  const cms   = +simCfg.chaseMaxSec || 120;
  const amt   = Math.max(0, +simCfg.amountPerTradeUsd || 0);
  const fxRate = Math.max(0.1, Math.min(500, +simCfg.fxUsdTwd || 31.5));
  const amtTwdWan = (amt * fxRate) / 10000;
  const amtTwdStr = amtTwdWan >= 10 ? amtTwdWan.toFixed(0)
                  : (amtTwdWan >= 1 ? amtTwdWan.toFixed(1) : amtTwdWan.toFixed(2));
  const fbUsd = +simCfg.feeBuyUsd || 0;
  const fbPct = (+simCfg.feeBuyPct || 0) * 100;
  const fsUsd = +simCfg.feeSellUsd || 0;
  const fsPct = (+simCfg.feeSellPct || 0) * 100;
  const sl    = (+simCfg.stopLossPct || 0) * 100;
  const tsl   = (+simCfg.trailingStopPct || 0) * 100;
  const dks   = +simCfg.dailyMaxLossUsd || 0;
  const mpr   = +simCfg.minPriceUsd || 0;
  const isWs  = (simCfg.executionMode | 0) === 1;
  const isOpt = simCfg.fillMode === 'optimistic';
  const smode = simCfg.sessionMode || "rth";
  const smLabel = ({rth:"僅 RTH", rthPre:"RTH + 盤前", rthPost:"RTH + 盤後", all:"全時段"})[smode] || "僅 RTH";
  const smCls   = smode === "rth" ? "rule-up" : "rule-down";
  const wrRth   = !!simCfg.wrRthOnly;
  const extPct  = (+simCfg.extendedFeePct || 0) * 100;

  // 回本門檻（與目標卡同算法）
  let beStr = "—";
  if (amt > 0) {
    const px = 100;
    const sh = Math.max(1, Math.floor(amt / px) || 1);
    const buyFee = fbUsd + (amt * (+simCfg.feeBuyPct || 0));
    const notional = sh * px;
    const sellFee = notional * (+simCfg.feeSellPct || 0) + fsUsd;
    const be = notional > 0 ? ((buyFee + sellFee) / notional) * 100 : 0;
    beStr = `${be.toFixed(3)}%`;
  }

  const gradMap = {
    0: `<b class="rule-down">不保護</b>（不管下跌風險，<span style="color:#ef9a9a">最積極</span>）`,
    1: `<b class="rule-up">漲 0.5% 機率 ≥ 跌 0.5% 機率</b>（<span style="color:#ffd180">輕度</span>）`,
    2: `<b class="rule-up">漲 0.3% 機率 ≥ 跌 0.5% 機率</b>（<span style="color:#ffd180">中度</span>）`,
    3: `<b class="rule-up">漲 0.3% ≥ 漲 0.5% ≥ 跌 0.5% 機率</b>（<span style="color:#80cbc4">最保守</span>）`,
  };
  const psmStr = psm <= 1
    ? `每股 <b class="rule-key">1</b> 單（不連續）`
    : `每股最多 <b class="rule-key">${psm}</b> 單（同時持有）`;

  const cat = (icon, name, body) =>
    `<div class="rule-line">` +
      `<span class="rule-cat"><span class="rule-cat-icon">${icon}</span>${name}</span>` +
      `<span class="rule-body">${body}</span>` +
    `</div>`;

  // ===== 各分類內容 =====
  const lineScan =
    `每 <b class="rule-key">${sec}s</b> 掃描備選清單，同時滿足：` +
    `① <b class="rule-key">漲 0.3% 機率 ≥ ${w030}%</b>` +
    `<span class="rule-sep">且</span>② <b class="rule-key">漲 0.5% 機率 ≥ ${w050}%</b>` +
    `<span class="rule-sep">且</span>③ 保護等級 <b class="rule-key">L${lv}</b> → ${gradMap[lv]}` +
    (mpr > 0 ? `<span class="rule-sep">且</span>④ 股價 <b class="rule-key">≥ $${mpr}</b>` : "") +
    `；通過者依 <b class="rule-up">漲 0.3% 機率高→低</b> 排序。`;

  const lineTarget =
    `目標漲幅 <b class="rule-key">+${tgt}%</b>` +
    `<span class="rule-sep">·</span>持單時限 <b class="rule-key">${winLbl}</b>` +
    `<span class="rule-sep">·</span>回本門檻 <b class="rule-key">${beStr}</b>` +
    `（含來回手續費，目標須 &gt; 此值才獲利）`;

  const lineSize =
    `同時持單上限 <b class="rule-key">${conc}</b> 單` +
    `<span class="rule-sep">·</span>${psmStr}` +
    `<span class="rule-sep">·</span>` +
    (amt > 0
      ? `每筆 <b class="rule-key">USD $${amt.toLocaleString("en-US")}</b> <span class="rule-mute">(≈ NT$ ${amtTwdStr} 萬 @ ${fxRate.toFixed(1)})</span>`
      : `<b class="rule-down">不下單</b>（金額 = $0，僅統計）`);

  const exitParts = [];
  exitParts.push(sl > 0
    ? `停損 <b class="rule-down">-${sl.toFixed(2)}%</b>`
    : `停損 <span class="rule-mute">關閉</span>`);
  exitParts.push(tsl > 0
    ? `移動停利 <b class="rule-up">${tsl.toFixed(2)}%</b>`
    : `移動停利 <span class="rule-mute">關閉</span>`);
  exitParts.push(dks > 0
    ? `今日 Kill <b class="rule-down">-$${dks.toLocaleString("en-US")}</b>`
    : `今日 Kill <span class="rule-mute">關閉</span>`);
  const lineExit = exitParts.join(`<span class="rule-sep">·</span>`);

  const lineCost =
    `買進 <b class="rule-key">$${fbUsd.toFixed(2)}</b>` +
    (fbPct > 0 ? ` + <b class="rule-key">${fbPct.toFixed(3)}%</b>` : "") +
    `<span class="rule-sep">·</span>賣出 <b class="rule-key">$${fsUsd.toFixed(2)}</b>` +
    (fsPct > 0 ? ` + <b class="rule-key">${fsPct.toFixed(3)}%</b>` : "") +
    `<span class="rule-sep">·</span>匯率 <b class="rule-key">1 USD = ${fxRate.toFixed(1)} TWD</b>`;

  const execBits = [];
  execBits.push(isWs
    ? `<b class="rule-down">WS 實交</b>（ws://127.0.0.1:1088/）`
    : `<b class="rule-up">本機模擬</b>`);
  execBits.push(`進場模式 <b class="rule-key">${_simEntryModeLabel(mode)}</b>`);
  if (isChase) {
    execBits.push(`追價 每 <b class="rule-key">${cbs}s</b> 加 <b class="rule-key">${cbp}%</b>，最久 <b class="rule-key">${cms}s</b>`);
  }
  execBits.push(`交易時段 <b class="${smCls}">${smLabel}</b>`);
  if (extPct > 0 && smode !== "rth") {
    execBits.push(`盤前/後手續費加成 <b class="rule-key">+${extPct.toFixed(3)}%</b>`);
  }
  execBits.push(wrRth ? `勝率源 <b class="rule-up">僅盤中 bars</b>` : `勝率源 <b class="rule-down">混合全時段</b>`);
  execBits.push(isOpt ? `<b class="rule-down">optimistic 樂觀</b>` : `<b class="rule-up">strict 保守</b>`);
  const lineExec = execBits.join(`<span class="rule-sep">·</span>`);

  el.innerHTML =
    cat("🔍", "進場", lineScan) +
    cat("🎯", "目標", lineTarget) +
    cat("📊", "倉位", lineSize) +
    cat("🛡️", "出場", lineExit) +
    cat("💰", "成本", lineCost) +
    cat("⚙️", "執行", lineExec);

  // ===== 右側 KPI 卡片：最重要的 4 個設定 =====
  const kpiEl = document.getElementById("simRuleKpis");
  if (kpiEl) {
    const psmTxt = psm <= 1 ? "1 (不連續)" : `${psm}`;
    const kpi = (cls, lbl, val, sub) =>
      `<div class="sim-kpi sim-kpi-${cls}">` +
        `<div class="sim-kpi-lbl">${lbl}</div>` +
        `<div class="sim-kpi-val">${val}${sub ? `<span class="sim-kpi-sub">${sub}</span>` : ""}</div>` +
      `</div>`;
    kpiEl.innerHTML =
      kpi("amt",  "每單",       `$${amt.toLocaleString("en-US")}`,            `<span class="sim-kpi-unit">USD</span>`) +
      kpi("conc", "同時持單上限", `${conc}`,                                    `<span class="sim-kpi-unit">單</span>`) +
      kpi("psm",  "每股最多持單", `${psmTxt}`,                                  psm <= 1 ? "" : `<span class="sim-kpi-unit">單</span>`) +
      kpi("tgt",  "目標漲幅",     `<span class="sim-kpi-num">+${tgt}</span>`,   `<span class="sim-kpi-unit">%</span>`) +
      kpi(isWs ? "exec-ws" : "exec-sim", "執行環境",
          isWs ? "WS 實交" : "本機模擬",
          `<span class="sim-kpi-unit">${isOpt ? "樂觀" : "保守"}</span>`);
  }
  // 回復收合狀態（僅首次 render）
  if (!el.dataset.collapsedInit) {
    el.dataset.collapsedInit = "1";
    try {
      const isCollapsed = localStorage.getItem("simRuleCollapsed") === "1";
      if (isCollapsed) el.classList.add("collapsed");
      // 同步起始的三角 icon
      const chev = document.querySelector('#simRuleHeader .rule-chevron');
      if (chev) chev.textContent = isCollapsed ? '▶' : '▼';
    } catch (_) {}
  }
}

function _simGradLvLabel(lv) {
  lv = Math.max(0, Math.min(3, lv | 0));
  return ({
    0: "0 不保護",
    1: "1 輕度",
    2: "2 中度",
    3: "3 保守",
  })[lv];
}

function _renderSimAutoStatusLive() {
  const autoSt = document.getElementById("simAutoStatus");
  if (!autoSt) return;
  const dot = `<span class="sim-auto-dot"></span>`;
  if (!simCfg.autoEnabled) {
    autoSt.innerHTML = `${dot}自動：關閉`;
    autoSt.classList.remove("on");
    autoSt.title = "未啟用自動掃描下單";
    return;
  }
  autoSt.classList.add("on");
  if (_simLastScan) {
    const d = new Date(_simLastScan.time);
    const t = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
    autoSt.innerHTML = `${dot}自動：${t} 掃 ${_simLastScan.wlSize}、候選 ${_simLastScan.candidates}、下單 ${_simLastScan.placed}`;
    autoSt.title = _simLastScan.reason;
  } else {
    autoSt.innerHTML = `${dot}自動：執行中…`;
    autoSt.title = "等待第一次掃描結果";
  }
}

// 點擊 .wr-mini 膠囊 → 以當前價建立「本機模擬」單（不受全域執行模式影響）
function bindWrMiniClicks(card, sym) {
  if (card._wrBound) return;
  card._wrBound = true;
  card.querySelectorAll(".signal-wr .wr-mini").forEach(el => {
    el.style.cursor = "pointer";
    // 計算膠囊內建目標（與 click handler 邏輯一致）
    let intrinsic = 0;
    if (el.querySelector(".wr-v-030"))      intrinsic =  0.003;
    else if (el.querySelector(".wr-v-050")) intrinsic =  0.005;
    else if (el.querySelector(".wr-v-050d")) intrinsic = -0.005;
    el.dataset.intrinsicTarget = String(intrinsic);
    const baseTitleStem = (el.title || "") + "（點擊：建立「本機模擬」試單，到期自動結算；不會送出 WS 實交）";
    // windowMs 並非常量（規則設定可調 1–390 分鐘），每次 hover 重算
    const _fmtWin = () => {
      const m = Math.max(1, Math.round((+simCfg.windowMs || 0) / 60000));
      return m >= 60 ? `${Math.floor(m/60)}h${m%60 ? (m%60)+"m" : ""}` : `${m}m`;
    };
    el.title = baseTitleStem.replace("到期自動結算", `${_fmtWin()} 後自動結算`);
    // 動態提示：規則設定的 targetPct / windowMs 變更後，hover 即時揭露實際使用值
    el.addEventListener("mouseenter", () => {
      const cfgT = +simCfg.targetPct || 0;
      let extra = "";
      if (intrinsic > 0 && cfgT > 0 && intrinsic < cfgT) {
        extra = `\n\n⚠️ 實際使用目標 +${(cfgT*100).toFixed(2)}%（規則設定的 targetPct 已覆寫膠囊內建 +${(intrinsic*100).toFixed(2)}%）`;
      }
      el.title = baseTitleStem.replace("到期自動結算", `${_fmtWin()} 後自動結算`) + extra;
    });
    el.addEventListener("click", () => {
      const priceEl = card.querySelector(".price");
      const price = parseFloat((priceEl?.textContent || "").replace(/[^0-9.\-]/g, ""));
      if (!isFinite(price) || price <= 0) { alert("尚未取得即時價，請稍候再試"); return; }
      let target = 0;
      if (el.querySelector(".wr-v-030"))      target =  0.003;
      else if (el.querySelector(".wr-v-050")) target =  0.005;
      else if (el.querySelector(".wr-v-050d")) target = -0.005;
      if (!target) return;
      // 買入膠囊：若膠囊內建目標 < 規則設定的 simCfg.targetPct，改用使用者設定的較高目標
      const cfgTarget = +simCfg.targetPct || 0;
      if (target > 0 && cfgTarget > 0 && target < cfgTarget) {
        target = cfgTarget;
      }
      const snap = (typeof wlData !== "undefined" && wlData) ? wlData.get(sym) : null;
      // 強制本機模擬、不走 WS
      const t = addSimTrade(sym, target, price, Object.assign({
        executionMode: 'local',
        testSource: 'manual-local',
      }, snap ? {
        wr030: snap.wr030, wr050: snap.wr050, wr050d: snap.wr050d,
        suggestPx: snap.suggestPx,
      } : {}));
      if (t) {
        el.classList.add("wr-flash");
        setTimeout(() => el.classList.remove("wr-flash"), 500);
      }
    });
  });
}

// 點擊 📡 WS 測試按鈕 → 強制透過 TradingService 送出實交單
// 注意：每張卡片本來各自 setInterval(_syncState, 3000)，卡片重渲時舊 timer 永不釋放會洩漏。
// 改為一個模組層的 interval，每 3 秒掃描 DOM 中所有 .ws-test-btn 統一刷新狀態。
function _syncAllWsTestButtons() {
  const btns = document.querySelectorAll(".ws-test-btn");
  if (!btns.length) return;
  const connected = !!(window.tradingClient && window.tradingClient.connected);
  const amt = +simCfg.amountPerTradeUsd || 0;
  const rthBlocked = !_canTradeNow(simCfg.sessionMode, Date.now());
  let blockReason = "";
  if (!connected) blockReason = "WS 未連線（ws://127.0.0.1:1088）\n請先啟動 TradingService，或確認 background.js 已成功連線";
  else if (amt <= 0)  blockReason = "每單金額 = $0，無法 WS 下單\n請到「規則設定 → 倒金子」調高金額";
  else if (rthBlocked) blockReason = `當下 ${_sessionLabel(_usSessionOfTs(Date.now()))} 不在允許交易時段\n請等待許可時段，或調整「⚙️ 時段設定 → 交易時段」`;
  for (const btn of btns) {
    btn.classList.toggle("ws-test-off", !!blockReason);
    btn.dataset.blockReason = blockReason;
    btn.title = "送出一筆測試單給 TradingService（WS 實交）。\n" +
      "・ 不受全域『執行環境』切換影響\n" +
      `・ target = simCfg.targetPct（目前 +${(simCfg.targetPct*100).toFixed(2)}%）\n` +
      "・ 限價 / 股數 / 手續費並同一般下單邏輯\n" +
      "・ 首次點擊會要求二次確認" +
      (blockReason ? ("\n\n⚠️ 目前無法使用：\n" + blockReason) : "");
  }
}
let _wsBtnGlobalSyncTimer = null;
function _ensureWsBtnSyncTimer() {
  if (_wsBtnGlobalSyncTimer) return;
  _wsBtnGlobalSyncTimer = setInterval(_syncAllWsTestButtons, 3000);
}

function bindWsTestButton(card, sym) {
  if (card._wsBtnBound) return;
  const btn = card.querySelector(".ws-test-btn");
  if (!btn) return;
  card._wsBtnBound = true;
  _ensureWsBtnSyncTimer();
  _syncAllWsTestButtons();

  btn.addEventListener("click", () => {
    _syncAllWsTestButtons();
    const _blockReason = btn.dataset.blockReason || "";
    if (_blockReason) {
      alert("📡 WS 測試單目前無法送出：\n\n" + _blockReason);
      return;
    }
    const priceEl = card.querySelector(".price");
    const price = parseFloat((priceEl?.textContent || "").replace(/[^0-9.\-]/g, ""));
    if (!isFinite(price) || price <= 0) { alert("尚未取得即時價，請稍候再試"); return; }
    const target = +simCfg.targetPct || 0.005;
    const amt = +simCfg.amountPerTradeUsd || 0;
    const estShares = Math.max(1, Math.floor(amt / Math.max(0.0001, price)) || 1);
    // 首次二次確認（本 session）
    if (!window._wsTestAcked) {
      const msg = `要送出 WS 實交測試單嗎？\n\n` +
        `股票：${sym}\n當前價：$${price.toFixed(2)}\n目標：+${(target*100).toFixed(2)}%\n` +
        `預估股數：${estShares}\n預估金額：$${(estShares * price).toFixed(2)}\n\n` +
        `→ 會透過 TradingService (ws://127.0.0.1:1088) 下真單。`;
      if (!confirm(msg)) return;
      window._wsTestAcked = true;
    }
    const snap = (typeof wlData !== "undefined" && wlData) ? wlData.get(sym) : null;
    const t = addSimTrade(sym, target, price, Object.assign({
      executionMode: 'ws',
      testSource: 'manual-ws',
    }, snap ? {
      wr030: snap.wr030, wr050: snap.wr050, wr050d: snap.wr050d,
      suggestPx: snap.suggestPx,
    } : {}));
    if (t) {
      btn.classList.add("ws-test-flash");
      setTimeout(() => btn.classList.remove("ws-test-flash"), 500);
    } else {
      alert("下單被 addSimTrade 拒絕（可能原因：perSymMax / 重複报單 / 手續費上限），請看 console");
    }
  });
}

/* ────────────────────────────────────────────────────────────
 * 線上更版橫幅：讀取 background 寫入的 dash_update_info，
 * 若 latestVer 比目前 manifest version 大，顯示右下浮動橫幅。
 * 使用者按「下次再說」會記住已忽略的版號，下次該版本不再提示。
 * ──────────────────────────────────────────────────────────── */
const UPDATE_INFO_KEY_PAGE = "dash_update_info";
const UPDATE_DISMISS_KEY = "dash_update_dismissed_ver";

function _curVer() { try { return chrome.runtime.getManifest().version; } catch { return "0"; } }

function _cmpVer(a, b) {
  const pa = String(a || "").split(".").map(n => parseInt(n, 10) || 0);
  const pb = String(b || "").split(".").map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

async function initUpdateBanner() {
  // 立即先請 background 跑一次（剛開 dashboard 時可能還沒有 storage 結果）
  try { chrome.runtime?.sendMessage?.({ type: "checkUpdateNow" }, () => { /* ignore */ }); } catch {}
  // 讀目前 storage，先嘗試畫一次
  await _renderUpdateBannerFromStorage();
  // 監聽 storage 變化（background 完成檢查後立即更新）
  try {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[UPDATE_INFO_KEY_PAGE]) _renderUpdateBannerFromStorage();
    });
  } catch {}
  // 綁定 header「⬆」按鈕：永遠開啟更新狀態彈窗（即使沒有新版也能看到設定與目前狀態）
  document.getElementById("updateBtn")?.addEventListener("click", openUpdateStatusPopover);
}

/** 開啟「更新狀態」彈窗：顯示目前版本/最新版/repo 設定/手動檢查。 */
async function openUpdateStatusPopover() {
  const existing = document.getElementById("updateStatusPop");
  if (existing) { existing.remove(); return; }
  const r = await new Promise(res => chrome.storage.local.get(["dash_update_repo", UPDATE_INFO_KEY_PAGE], res));
  const repo = (r?.["dash_update_repo"] || "").trim();
  const info = r?.[UPDATE_INFO_KEY_PAGE] || null;
  const cur = _curVer();
  const pop = document.createElement("div");
  pop.id = "updateStatusPop";
  pop.className = "update-banner";
  pop.style.bottom = "auto";
  pop.style.top = "60px";
  const status = !repo
    ? `<span style="color:#ff9800">⚠ 尚未設定 GitHub repo，無法檢查更新</span>`
    : !info
      ? `<span style="color:#8a93a0">尚未檢查過（按下方「立即檢查」即可）</span>`
      : info.isNewer
        ? `<span style="color:#6ee79b">✓ 有新版 v${info.latestVer}（目前 v${cur}）</span>`
        : `<span style="color:#8a93a0">已是最新版（v${cur}）</span>`;
  const last = info?.checkedAt ? new Date(info.checkedAt).toLocaleString() : "—";
  pop.innerHTML = `
    <div class="ub-head">
      <span class="ub-icon">⬆</span>
      <span class="ub-title">線上更新檢查</span>
      <button type="button" class="ub-close" title="關閉">✕</button>
    </div>
    <div class="ub-notes" style="max-height:none;">
      <div style="margin-bottom:6px;">${status}</div>
      <div style="color:#8a93a0;">目前版本：<b style="color:#e6e6e6;">v${cur}</b>　最近檢查：${last}</div>
      <div style="margin-top:10px;">
        <label style="display:block;color:#aab1bb;margin-bottom:4px;">GitHub repo（格式：<code>owner/repo</code>）</label>
        <input id="updRepoInput" type="text" value="${repo.replace(/"/g, "&quot;")}" placeholder="例：zenyo/shortterm-stock-dashboard"
               style="width:100%;padding:6px 8px;background:#0f1217;color:#e6e6e6;border:1px solid #3a3d44;border-radius:4px;font-family:ui-monospace,Consolas,monospace;font-size:12px;">
        <div style="color:#8a93a0;font-size:11px;margin-top:4px;">空白＝停用檢查。設定後按「儲存並檢查」立即生效。</div>
      </div>
    </div>
    <div class="ub-actions">
      <button type="button" class="ub-btn ub-secondary" data-act="check">🔄 立即檢查</button>
      <button type="button" class="ub-btn ub-primary" data-act="save">💾 儲存並檢查</button>
    </div>
  `;
  document.body.appendChild(pop);
  pop.querySelector(".ub-close")?.addEventListener("click", () => pop.remove());
  pop.querySelector("[data-act=save]")?.addEventListener("click", () => {
    const v = (pop.querySelector("#updRepoInput")?.value || "").trim();
    chrome.storage.local.set({ dash_update_repo: v, [UPDATE_DISMISS_KEY]: null }, () => {
      chrome.runtime.sendMessage({ type: "checkUpdateNow" }, (resp) => {
        pop.remove();
        setTimeout(openUpdateStatusPopover, 600); // 重開彈窗顯示最新狀態
      });
    });
  });
  pop.querySelector("[data-act=check]")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "checkUpdateNow" }, () => {
      pop.remove();
      setTimeout(openUpdateStatusPopover, 600);
    });
  });
}

async function _renderUpdateBannerFromStorage() {
  try {
    const r = await new Promise(res => chrome.storage.local.get([UPDATE_INFO_KEY_PAGE, UPDATE_DISMISS_KEY], res));
    const info = r?.[UPDATE_INFO_KEY_PAGE];
    const dismissed = r?.[UPDATE_DISMISS_KEY];
    if (!info || !info.latestVer) return;
    const cur = _curVer();
    if (_cmpVer(info.latestVer, cur) <= 0) { _removeUpdateBanner(); return; }
    if (dismissed && dismissed === info.latestVer) { _removeUpdateBanner(); return; }
    _showUpdateBanner(info);
  } catch (e) {
    try { console.warn("[update] render failed:", e); } catch {}
  }
}

function _removeUpdateBanner() {
  const el = document.getElementById("updateBanner");
  if (el) el.remove();
}

function _showUpdateBanner(info) {
  _removeUpdateBanner();
  const cur = _curVer();
  const el = document.createElement("div");
  el.id = "updateBanner";
  el.className = "update-banner";
  const safeNotes = (info.notes || "").slice(0, 400).replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  el.innerHTML = `
    <div class="ub-head">
      <span class="ub-icon">⬆</span>
      <span class="ub-title">有新版可下載：<b>v${info.latestVer}</b> <span class="ub-cur">（目前 v${cur}）</span></span>
      <button type="button" class="ub-close" title="暫時關閉（下次重新檢查時還會出現）">✕</button>
    </div>
    ${safeNotes ? `<div class="ub-notes" title="GitHub Release notes">${safeNotes.replace(/\n/g, "<br>")}</div>` : ""}
    <div class="ub-actions">
      <a class="ub-btn ub-primary" href="${info.assetUrl || info.htmlUrl}" target="_blank" rel="noopener">${info.assetUrl ? "⬇ 下載新版" : "🔗 開啟 Release 頁面"}</a>
      <button type="button" class="ub-btn ub-secondary" data-act="dismiss" title="忽略此版本（v${info.latestVer} 之後不再顯示，直到有更新版）">下次再說</button>
    </div>
  `;
  document.body.appendChild(el);
  el.querySelector(".ub-close")?.addEventListener("click", () => el.remove());
  el.querySelector("[data-act=dismiss]")?.addEventListener("click", () => {
    try { chrome.storage.local.set({ [UPDATE_DISMISS_KEY]: info.latestVer }); } catch {}
    el.remove();
  });
}
