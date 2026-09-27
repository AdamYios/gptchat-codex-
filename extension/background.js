const LOG_KEY = "bridgePendingEvents";
const LOG_LIMIT = 1000;
const LOG_FIELDS = new Set([
  "phase", "round", "reportId", "assistantMessages", "userMessages", "conversationTurns",
  "articles", "copyButtons", "stopButtons", "mainFound", "composerFound", "composerTag",
  "composerLength", "sendButtonFound", "sendButtonDisabled", "cardChoices", "instructionLength",
  "reportLength", "filledLength", "latestCardLength", "confirmed", "reason", "method",
  "baselineAvailable", "visibleDelta", "domDelta", "mode", "errorType", "status"
]);
let logQueue = Promise.resolve();

function safeEvent(message, source) {
  const data = {};
  for (const [key, value] of Object.entries(message.data || {})) {
    if (!LOG_FIELDS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) data[key] = value;
    else if (typeof value === "boolean") data[key] = value;
    else if (typeof value === "string" &&
             /^(phase|composerTag|reason|method|mode|errorType|status)$/.test(key))
      data[key] = value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 50);
  }
  return {time: new Date().toISOString(), source, event: String(message.event || "unknown")
    .replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 50), data};
}

function boundTab(sender, config) {
  if (!sender.tab || sender.tab.id !== config.tabId) return false;
  try { return ["chatgpt.com", "chat.openai.com"].includes(new URL(sender.tab.url).hostname); }
  catch { return false; }
}

async function flushPending() {
  const config = await chrome.storage.local.get([LOG_KEY, "port", "token"]);
  let pending = Array.isArray(config[LOG_KEY]) ? config[LOG_KEY] : [];
  if (!pending.length || !config.port || !config.token) return;
  try {
    while (pending.length) {
      const batch = pending.slice(0, 100);
      const response = await fetch(`http://127.0.0.1:${config.port}/events`, {
        method: "POST", headers: {"Content-Type": "application/json", "X-Bridge-Token": config.token},
        body: JSON.stringify({events: batch}), signal: AbortSignal.timeout(3000)
      });
      if (!response.ok) return;
      pending = pending.slice(batch.length);
      await chrome.storage.local.set({[LOG_KEY]: pending});
    }
  } catch { /* Keep the bounded queue until the bridge is reachable. */ }
}

function scheduleLog(task) {
  logQueue = logQueue.catch(() => {}).then(task);
  return logQueue;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === "bridgeIsBound") {
    chrome.storage.local.get("tabId").then(config =>
      respond({ok: true, bound: boundTab(sender, config)}),
      error => respond({ok: false, error: String(error)}));
    return true;
  }
  if (message.type === "bridgeLog") {
    scheduleLog(async () => {
      const config = await chrome.storage.local.get(["tabId", LOG_KEY]);
      if (sender.tab && !boundTab(sender, config)) return;
      const source = sender.tab ? "content" : "popup";
      const pending = Array.isArray(config[LOG_KEY]) ? config[LOG_KEY] : [];
      pending.push(safeEvent(message, source));
      await chrome.storage.local.set({[LOG_KEY]: pending.slice(-LOG_LIMIT)});
      await flushPending();
    }).then(() => respond({ok: true}), error => respond({ok: false, error: String(error)}));
    return true;
  }
  if (message.type !== "bridgeRequest") return false;
  (async () => {
    const config = await chrome.storage.local.get(["tabId", "port", "token"]);
    if (!boundTab(sender, config)) throw new Error("当前标签页未绑定");
    if (!config.token || !config.port) throw new Error("尚未配置本地桥接");
    const response = await fetch(`http://127.0.0.1:${config.port}${message.path}`, {
      method: message.method || "GET",
      headers: {"Content-Type": "application/json", "X-Bridge-Token": config.token},
      body: message.body ? JSON.stringify(message.body) : undefined
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    void scheduleLog(flushPending);
    return data;
  })().then(data => respond({ok: true, data}), error => respond({ok: false, error: String(error)}));
  return true;
});
