// 點擴充功能圖示時，在新分頁開啟儀表板
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("dashboard.html");
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

/* ────────────────────────────────────────────────────────────
 * 線上更版檢查（方法 3：抓 GitHub Releases / Latest）
 *   - 不會自動安裝 .crx（MV3 限制），只負責把「最新版資訊」寫入 chrome.storage.local
 *   - dashboard.js 載入時讀取並顯示「有新版」橫幅
 *
 * 設定 repo 的兩種方式：
 *   1) 在 chrome.storage.local 設 "dash_update_repo": "owner/repo"
 *      （dashboard 設定面板會有 UI；也可在 DevTools console 直接設定）
 *   2) 改下面 DEFAULT_REPO 常數
 * 若 repo 為空字串，整個檢查會被略過（不會打到 GitHub）。
 * ──────────────────────────────────────────────────────────── */
const DEFAULT_REPO = "chihshen0825/US-STOCKS"; // GitHub Releases 來源
const UPDATE_INFO_KEY = "dash_update_info";
const UPDATE_REPO_KEY = "dash_update_repo";
const UPDATE_ENABLED_KEY = "dash_update_enabled"; // 使用者可停用自動檢查（undefined / true = 啟用；false = 停用）
const UPDATE_ALARM_NAME = "dashUpdateCheck";
const UPDATE_PERIOD_MIN = 360; // 6 小時

async function isUpdateEnabled() {
  try {
    const r = await chrome.storage.local.get([UPDATE_ENABLED_KEY]);
    // 預設為停用；使用者需明確勾選【啟用】才會自動檢查。
    return r?.[UPDATE_ENABLED_KEY] === true;
  } catch { return false; }
}

/** 比較語意化版號 "1.2026.5.19" vs "1.2026.5.20" → 1 / 0 / -1 */
function cmpVer(a, b) {
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

async function getRepo() {
  try {
    const r = await chrome.storage.local.get([UPDATE_REPO_KEY]);
    return (r?.[UPDATE_REPO_KEY] || DEFAULT_REPO || "").trim();
  } catch { return DEFAULT_REPO; }
}

async function checkLatestRelease(opts) {
  if (!opts?.force && !(await isUpdateEnabled())) return; // 使用者停用（force=true 時跳過此檢查，給手動檢查用）
  const repo = await getRepo();
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return; // 沒設定就略過
  const currentVer = chrome.runtime.getManifest().version;
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  try {
    const resp = await fetch(apiUrl, {
      headers: { "Accept": "application/vnd.github+json" },
      cache: "no-store",
    });
    if (!resp.ok) {
      // 404 表示還沒發 release、403 表示 rate limit；都不視為錯
      return;
    }
    const data = await resp.json();
    // tag_name 通常是 "v1.2026.5.20" 或 "1.2026.5.20"
    const tag = String(data.tag_name || data.name || "").trim();
    const latestVer = tag.replace(/^v/i, "");
    if (!latestVer) return;
    const isNewer = cmpVer(latestVer, currentVer) > 0;
    const info = {
      repo,
      currentVer,
      latestVer,
      isNewer,
      tag,
      htmlUrl: data.html_url || `https://github.com/${repo}/releases/latest`,
      publishedAt: data.published_at || null,
      checkedAt: Date.now(),
      // 第一個 .crx / .zip 資產（若有）
      assetUrl: (data.assets || []).find(a => /\.(crx|zip)$/i.test(a?.name || ""))?.browser_download_url || null,
      notes: data.body || "",
    };
    await chrome.storage.local.set({ [UPDATE_INFO_KEY]: info });
    try {
      console.info(`[update] checked: current=${currentVer}, latest=${latestVer}, newer=${isNewer}`);
    } catch {}
  } catch (err) {
    try { console.warn("[update] check failed:", err?.message || err); } catch {}
  }
}

/** 安裝 / 啟動時設定 alarm（idempotent），並立即跑一次。停用時則清掉 alarm。 */
async function ensureUpdateAlarm() {
  try {
    const enabled = await isUpdateEnabled();
    if (!enabled) {
      try { await chrome.alarms.clear(UPDATE_ALARM_NAME); } catch {}
      return;
    }
    const existed = await chrome.alarms.get(UPDATE_ALARM_NAME);
    if (!existed) {
      chrome.alarms.create(UPDATE_ALARM_NAME, {
        delayInMinutes: 1,                 // 啟動後 1 分鐘先跑一次（避免和首畫面爭資源）
        periodInMinutes: UPDATE_PERIOD_MIN,
      });
    }
  } catch (e) {
    try { console.warn("[update] alarms.create failed:", e?.message || e); } catch {}
  }
}

// 使用者切換啟用/停用時，立即套用（重新排程或清掉 alarm）
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[UPDATE_ENABLED_KEY]) {
    ensureUpdateAlarm();
    if (changes[UPDATE_ENABLED_KEY].newValue !== false) checkLatestRelease();
  }
});

chrome.runtime.onInstalled.addListener(() => { ensureUpdateAlarm(); checkLatestRelease(); });
chrome.runtime.onStartup.addListener(() => { ensureUpdateAlarm(); checkLatestRelease(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === UPDATE_ALARM_NAME) checkLatestRelease();
});

// 允許 dashboard 主動觸發手動檢查
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "checkUpdateNow") {
    checkLatestRelease({ force: !!msg.force }).then(() => {
      chrome.storage.local.get([UPDATE_INFO_KEY], (r) => sendResponse(r?.[UPDATE_INFO_KEY] || null));
    });
    return true; // async sendResponse
  }
});
