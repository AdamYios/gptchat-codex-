const LEGACY_LOG_KEY = "bridgePendingEvents";
const LOG_LIMIT = 1000;
const DETACHED_LOG_PREFIX = "bridgePendingEvents_tab_";
const REPORT_WAKE_ALARM = "bridge-report-ready-wake";
const REPORT_WAKE_PERIOD_MINUTES = 0.5;
const LOG_FIELDS = new Set([
  "phase", "round", "reportId", "assistantMessages", "userMessages", "conversationTurns",
  "articles", "copyButtons", "stopButtons", "mainFound", "composerFound", "composerTag",
  "composerLength", "sendButtonFound", "sendButtonDisabled", "cardChoices", "strictChoiceCount",
  "manualCandidateCount", "relaxedChoiceCount", "fallbackCandidateCount", "latestOnly", "instructionLength",
  "reportLength", "filledLength", "latestCardLength", "confirmed", "reason", "method",
  "baselineAvailable", "visibleDelta", "domDelta", "mode", "errorType", "status"
]);
let logQueue = Promise.resolve();
let reportPollPromise = null;

function connectionMap(config) {
  const map = config.connections && typeof config.connections === "object" ? config.connections : {};
  if (config.tabId && config.port && config.token && !map[String(config.tabId)]) {
    map[String(config.tabId)] = {tabId: Number(config.tabId), port: config.port, token: config.token,
      title: config.title || "", card: config.card || "", id: "legacy"};
  }
  return map;
}

async function getConnection(tabId) {
  if (!Number.isInteger(Number(tabId))) return null;
  const config = await chrome.storage.local.get([
    "connections", "tabId", "port", "token", "title", "card"
  ]);
  const connection = connectionMap(config)[String(tabId)];
  return connection ? {...connection, tabId: Number(connection.tabId ?? tabId)} : null;
}

async function ensureReportWakeAlarm() {
  if (!chrome.alarms?.get || !chrome.alarms?.create || !chrome.alarms?.clear) return;
  try {
    const [alarm, config] = await Promise.all([
      chrome.alarms.get(REPORT_WAKE_ALARM),
      chrome.storage.local.get(["connections", "tabId", "port", "token", "title", "card"])
    ]);
    const hasBoundTask = Object.values(connectionMap(config))
      .some(connection => connection?.port && connection?.token);
    if (hasBoundTask && !alarm) await chrome.alarms.create(REPORT_WAKE_ALARM,
      {periodInMinutes: REPORT_WAKE_PERIOD_MINUTES});
    else if (!hasBoundTask && alarm) await chrome.alarms.clear(REPORT_WAKE_ALARM);
  } catch { /* The regular content-script bridge remains available if alarms fail. */ }
}

function pollPendingReports() {
  if (reportPollPromise) return reportPollPromise;
  reportPollPromise = (async () => {
    const config = await chrome.storage.local.get([
      "connections", "tabId", "port", "token", "title", "card"
    ]);
    const connections = Object.values(connectionMap(config));
    await Promise.all(connections.map(async connection => {
      const tabId = Number(connection.tabId);
      if (!Number.isInteger(tabId) || !connection.port || !connection.token) return;
      try {
        const response = await fetch(`http://127.0.0.1:${connection.port}/state`, {
          headers: {"X-Bridge-Token": connection.token}, signal: AbortSignal.timeout(4000)
        });
        if (!response.ok) return;
        const state = await response.json();
        const reportId = Number(state.reportId);
        if (state.phase !== "report_ready" || !Number.isSafeInteger(reportId) || reportId <= 0) return;

        // A tab can be rebound while a poll is in flight. Only wake it if the
        // same task still owns this binding; sending a message never activates it.
        const current = await getConnection(tabId);
        if (!current || current.id !== connection.id || current.port !== connection.port ||
            current.token !== connection.token) return;
        await chrome.tabs.sendMessage(tabId, {type: "bridgeReportReady", reportId});
      } catch { /* The next alarm retries if the bridge or tab is temporarily unavailable. */ }
    }));
  })().catch(() => {}).finally(() => { reportPollPromise = null; });
  return reportPollPromise;
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === REPORT_WAKE_ALARM) return pollPendingReports();
  });
  const ensureAlarm = () => { void ensureReportWakeAlarm(); };
  chrome.runtime.onStartup?.addListener(ensureAlarm);
  chrome.runtime.onInstalled?.addListener(ensureAlarm);
  // Alarms may be cleared between browser sessions. Recreate the important
  // alarm whenever the MV3 service worker starts, without resetting an existing one.
  ensureAlarm();
}

function connectionLogKey(connection) {
  return `bridgePendingEvents_${connection.id || `${connection.tabId}_${connection.port}`}`;
}

function detachedLogKey(tabId) {
  return `${DETACHED_LOG_PREFIX}${tabId}`;
}

function safeEvent(message, source, connection = null) {
  const data = {};
  for (const [key, value] of Object.entries(message.data || {})) {
    if (!LOG_FIELDS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) data[key] = value;
    else if (typeof value === "boolean") data[key] = value;
    else if (typeof value === "string" &&
             /^(phase|composerTag|reason|method|mode|errorType|status)$/.test(key))
      data[key] = value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 50);
  }
  const taskId = String(connection?.threadId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
  return {time: new Date().toISOString(), source, event: String(message.event || "unknown")
    .replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 50), ...(taskId ? {taskId} : {}), data};
}

async function saveConnectionMap(config, connections) {
  await chrome.storage.local.set({connections});
  await chrome.storage.local.remove(["tabId", "port", "token", "title", "card"]);
  await ensureReportWakeAlarm();
}

function boundTab(sender, connection) {
  if (!sender.tab || sender.tab.id !== connection?.tabId) return false;
  try { return ["chatgpt.com", "chat.openai.com"].includes(new URL(sender.tab.url).hostname); }
  catch { return false; }
}

async function flushPending(tabId) {
  const connection = await getConnection(Number(tabId));
  if (!connection?.port || !connection?.token) return;
  const key = connectionLogKey(connection);
  const stored = await chrome.storage.local.get([key, LEGACY_LOG_KEY]);
  let pending = Array.isArray(stored[key]) ? stored[key] : [];
  if (String(connection.id).startsWith("legacy") && Array.isArray(stored[LEGACY_LOG_KEY]) &&
      stored[LEGACY_LOG_KEY].length) {
    pending = [...stored[LEGACY_LOG_KEY], ...pending];
    await chrome.storage.local.set({[key]: pending, [LEGACY_LOG_KEY]: []});
  }
  try {
    while (pending.length) {
      const batch = pending.slice(0, 100);
      const response = await fetch(`http://127.0.0.1:${connection.port}/events`, {
        method: "POST", headers: {"Content-Type": "application/json", "X-Bridge-Token": connection.token},
        body: JSON.stringify({events: batch}), signal: AbortSignal.timeout(3000)
      });
      if (!response.ok) return;
      pending = pending.slice(batch.length);
      await chrome.storage.local.set({[key]: pending});
    }
  } catch { /* Keep this connection's bounded queue until its bridge is reachable. */ }
}

function scheduleLog(task) {
  logQueue = logQueue.catch(() => {}).then(task);
  return logQueue;
}

async function unbindConnection(tabId, fallbackTaskId = "", source = "popup") {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("无效的标签页编号");
  const config = await chrome.storage.local.get([
    "connections", "tabId", "port", "token", "title", "card"
  ]);
  const connection = connectionMap(config)[String(tabId)];
  if (!connection) return false;
  const taskId = String(connection.threadId || fallbackTaskId || "")
    .replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
  const taskConnection = {...connection, threadId: taskId};
  const key = connectionLogKey(connection);
  const detachedKey = detachedLogKey(tabId);
  const stored = await chrome.storage.local.get([key, detachedKey]);
  const pending = Array.isArray(stored[key]) ? stored[key] : [];
  const taskScopedPending = pending.map(entry =>
    entry.taskId || !taskId ? entry : {...entry, taskId});
  taskScopedPending.push(safeEvent({event: "unbind"}, source, taskConnection));
  await chrome.storage.local.set({[key]: taskScopedPending.slice(-LOG_LIMIT)});
  // Flush while the connection is still present. If it is offline, retain
  // the remaining events by tab so the next binding can deliver them.
  await flushPending(tabId);
  const afterFlush = await chrome.storage.local.get([key, detachedKey]);
  const retained = [
    ...(Array.isArray(afterFlush[detachedKey]) ? afterFlush[detachedKey] : []),
    ...(Array.isArray(afterFlush[key]) ? afterFlush[key] : [])
  ].slice(-LOG_LIMIT);
  if (retained.length) await chrome.storage.local.set({[detachedKey]: retained});
  else await chrome.storage.local.remove(detachedKey);
  await chrome.storage.local.remove(key);
  const connections = {...connectionMap(config)};
  delete connections[String(tabId)];
  await saveConnectionMap(config, connections);
  return true;
}

chrome.tabs?.onRemoved?.addListener(tabId => {
  const cleanup = scheduleLog(async () => {
    await unbindConnection(tabId, "", "tab_closed");
  });
  void cleanup.catch(() => {});
  return cleanup;
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === "bridgeIsBound" || message.type === "bridgeGetConfig") {
    getConnection(sender.tab?.id).then(connection => {
      const bound = boundTab(sender, connection);
      respond({ok: true, bound, ...(message.type === "bridgeGetConfig" && bound
        ? {title: connection.title || "", card: connection.card || ""} : {})});
    }, error => respond({ok: false, error: String(error)}));
    return true;
  }
  if (message.type === "bridgeLog") {
    scheduleLog(async () => {
      const tabId = sender.tab ? sender.tab.id : Number(message.tabId);
      const connection = await getConnection(tabId);
      if (!connection || (sender.tab && !boundTab(sender, connection))) return;
      const key = connectionLogKey(connection);
      const stored = await chrome.storage.local.get(key);
      const pending = Array.isArray(stored[key]) ? stored[key] : [];
      pending.push(safeEvent(message, sender.tab ? "content" : "popup", connection));
      await chrome.storage.local.set({[key]: pending.slice(-LOG_LIMIT)});
      await flushPending(tabId);
    }).then(() => respond({ok: true}), error => respond({ok: false, error: String(error)}));
    return true;
  }
  if (message.type === "bridgeBind") {
    scheduleLog(async () => {
      const connection = message.connection;
      const tabId = Number(connection?.tabId);
      if (!Number.isInteger(tabId) || tabId < 0 || !connection?.port || !connection?.token)
        throw new Error("无效的桥接连接配置");
      const config = await chrome.storage.local.get([
        "connections", "tabId", "port", "token", "title", "card"
      ]);
      const connections = connectionMap(config);
      const key = connectionLogKey(connection);
      const detachedKey = detachedLogKey(tabId);
      const singletonTabId = Number(config.tabId);
      const hasSingleton = Number.isInteger(singletonTabId) && config.port && config.token &&
        !(config.connections && config.connections[String(singletonTabId)]);
      const singletonConnection = hasSingleton ? connections[String(singletonTabId)] : null;
      const previousLegacy = singletonConnection && singletonTabId !== tabId ? singletonConnection : null;
      const replacedLegacy = singletonConnection && singletonTabId === tabId ? singletonConnection : null;
      const previousLegacyKey = (previousLegacy || replacedLegacy)
        ? connectionLogKey(previousLegacy || replacedLegacy) : null;
      const keys = [key, detachedKey, LEGACY_LOG_KEY];
      if (previousLegacyKey) keys.push(previousLegacyKey);
      const stored = await chrome.storage.local.get(keys);
      const detached = Array.isArray(stored[detachedKey]) ? stored[detachedKey] : [];
      const detachedForTask = connection.threadId
        ? detached.filter(entry => entry.taskId === connection.threadId) : [];
      const detachedForOtherTasks = detached.filter(entry => !detachedForTask.includes(entry));
      const legacyPending = [
        ...(Number(config.tabId) === tabId && Array.isArray(stored[LEGACY_LOG_KEY])
          ? stored[LEGACY_LOG_KEY] : []),
        ...(Number(config.tabId) === tabId && previousLegacyKey && Array.isArray(stored[previousLegacyKey])
          ? stored[previousLegacyKey] : [])
      ].map(entry => entry.taskId || !connection.threadId ? entry : {...entry, taskId: connection.threadId});
      const pending = [
        ...detachedForTask,
        ...legacyPending,
        ...(Array.isArray(stored[key]) ? stored[key] : [])
      ].slice(-LOG_LIMIT);
      if (Number(config.tabId) && Number(config.tabId) !== tabId &&
          Array.isArray(stored[LEGACY_LOG_KEY]) && previousLegacyKey) {
        await chrome.storage.local.set({[previousLegacyKey]: [
          ...(Array.isArray(stored[previousLegacyKey]) ? stored[previousLegacyKey] : []),
          ...stored[LEGACY_LOG_KEY]
        ].slice(-LOG_LIMIT)});
      }
      if (pending.length) await chrome.storage.local.set({[key]: pending});
      if (detachedForOtherTasks.length) await chrome.storage.local.set({[detachedKey]: detachedForOtherTasks});
      else await chrome.storage.local.remove(detachedKey);
      if (Array.isArray(stored[LEGACY_LOG_KEY])) await chrome.storage.local.remove(LEGACY_LOG_KEY);
      if (replacedLegacy && previousLegacyKey) await chrome.storage.local.remove(previousLegacyKey);
      connections[String(tabId)] = connection;
      await saveConnectionMap(config, connections);
    }).then(() => respond({ok: true}), error => respond({ok: false, error: String(error)}));
    return true;
  }
  if (message.type === "bridgeUnbind") {
    scheduleLog(async () => {
      const tabId = Number(message.tabId);
      const removed = await unbindConnection(tabId, message.taskId, "popup");
      if (!removed) throw new Error("当前标签页没有绑定桥接任务");
    }).then(() => respond({ok: true}), error => respond({ok: false, error: String(error)}));
    return true;
  }
  if (message.type !== "bridgeRequest") return false;
  (async () => {
    const connection = await getConnection(sender.tab?.id);
    if (!boundTab(sender, connection)) throw new Error("当前标签页未绑定桥接任务");
    if (!connection.token || !connection.port) throw new Error("绑定的桥接配置无效");
    const response = await fetch(`http://127.0.0.1:${connection.port}${message.path}`, {
      method: message.method || "GET",
      headers: {"Content-Type": "application/json", "X-Bridge-Token": connection.token},
      body: message.body ? JSON.stringify(message.body) : undefined
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    void scheduleLog(() => flushPending(sender.tab.id));
    return data;
  })().then(data => respond({ok: true, data}), error => respond({ok: false, error: String(error)}));
  return true;
});
