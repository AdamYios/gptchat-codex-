const $ = id => document.getElementById(id);
const PHASE_HELP = {
  setup: "服务已连接，等待你选择起点 A 或 B",
  await_instruction: "等待 ChatGPT 页面识别下一张指令卡片",
  codex_running: "Codex 正在处理当前指令",
  report_ready: "Codex 最终报告已准备好，等待发送回 ChatGPT",
  stopped: "桥接已停止，可检查原因或重新选择起点",
};
const CHAT_URL = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//;

function phaseLabel(state) {
  const help = PHASE_HELP[state.phase] || "未知状态，请检查桥接器输出";
  const round = state.phase === "await_instruction" && state.round === 0
    ? "尚未投递第一条指令" : `第 ${state.round} 轮`;
  return `${state.phase} · ${round}${state.detail ? ` · ${state.detail}` : ""} · ${help}`;
}

async function activeChatTab() {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  return tab && CHAT_URL.test(tab.url || "") ? tab : null;
}

async function readConnections() {
  const config = await chrome.storage.local.get([
    "connections", "tabId", "port", "token", "title", "card"
  ]);
  const connections = config.connections && typeof config.connections === "object"
    ? {...config.connections} : {};
  if (config.tabId && config.port && config.token && !connections[String(config.tabId)]) {
    connections[String(config.tabId)] = {id: `legacy_${config.tabId}`, tabId: Number(config.tabId),
      port: config.port, token: config.token, title: config.title || "", card: config.card || ""};
  }
  return connections;
}

async function connectionFor(tabId) {
  if (!Number.isInteger(Number(tabId))) return null;
  const all = await readConnections();
  return all[String(tabId)] || null;
}

async function bridgeApi(path, method = "GET", body, connection) {
  if (!connection?.port || !connection?.token) throw new Error("当前标签页尚未绑定桥接任务");
  const response = await fetch(`http://127.0.0.1:${connection.port}${path}`, {
    method, headers: {"Content-Type": "application/json", "X-Bridge-Token": connection.token},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 404 && path === "/start")
      throw new Error("当前 PowerShell 仍运行旧版 bridge.py；请重启对应桥接器");
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function missingReceiver(error) {
  return /Receiving end does not exist|Could not establish connection/i.test(String(error));
}

async function ensureContent(tabId) {
  const tab = await chrome.tabs.get(Number(tabId));
  if (!CHAT_URL.test(tab.url || "")) throw new Error("绑定的标签页已不是 ChatGPT 页面；请重新绑定");
  try { await chrome.tabs.sendMessage(Number(tabId), {type: "bridgePing"}); }
  catch (error) {
    if (!missingReceiver(error)) throw error;
    const [probe] = await chrome.scripting.executeScript({target: {tabId: Number(tabId)},
      func: () => !!document.getElementById("codex-bridge-status")});
    if (probe?.result) throw new Error("此 ChatGPT 标签页仍有已失效的旧扩展脚本；请刷新标签页后重新绑定");
    await chrome.scripting.executeScript({target: {tabId: Number(tabId)}, files: ["content.js"]});
    await chrome.tabs.sendMessage(Number(tabId), {type: "bridgePing"});
  }
}

function popupErrorReason(error) {
  const message = String(error);
  if (/Receiving end does not exist|Could not establish connection/i.test(message)) return "receiver_missing";
  if (/Failed to fetch|NetworkError|fetch/i.test(message)) return "network";
  if (/令牌|token|403/i.test(message)) return "auth";
  if (/找不到|not found|404/i.test(message)) return "not_found";
  return "other";
}

function recordPopup(event, data = {}, tabId = null) {
  void chrome.runtime.sendMessage({type: "bridgeLog", event, data, tabId}).catch(() => {});
}

const OPERATION_NAMES = {
  startA: "选择 A 起点", startB: "选择 B 起点", view_cards: "查看指令卡片",
  choose_card: "发送所选指令卡片", view_log: "查看操作记录",
  recheck: "重新检查报告", confirmSent: "确认报告已发送", retrySend: "重新发送报告"
};

async function notifyPage(text, error = false, tabId = null, phase = "") {
  if (tabId === null || tabId === undefined) return;
  try { await chrome.tabs.sendMessage(Number(tabId), {type: "bridgeUiAction", text, error, phase}); }
  catch { /* The popup still shows the result if the page receiver is unavailable. */ }
}

async function act(callback, operation = "action", requestedTabId = null) {
  const label = OPERATION_NAMES[operation] || "操作";
  let tabId = requestedTabId;
  try {
    const tab = requestedTabId === null ? await activeChatTab() : await chrome.tabs.get(Number(requestedTabId));
    tabId = tab?.id ?? null;
    $("status").textContent = `${label}：正在处理…`;
    recordPopup(`${operation}_attempt`, {}, tabId);
    await notifyPage(`${label}：正在处理…`, false, tabId);
    const message = await callback(tabId);
    recordPopup(`${operation}_ok`, {}, tabId);
    await notifyPage(`${label}：已完成`, false, tabId);
    await show();
    if (message) $("status").textContent = `${message}\n${$("status").textContent}`;
  } catch (error) {
    recordPopup(`${operation}_error`, {reason: popupErrorReason(error)}, tabId);
    await notifyPage(`${label}：失败，请查看扩展弹窗`, true, tabId);
    $("status").textContent = String(error);
  }
}

function makeConnectionRow(tabId, connection, title, stateLabel) {
  const row = document.createElement("div");
  row.className = "connection";
  const label = document.createElement("div");
  label.textContent = `${title} · Codex ${connection.threadId || "任务"} · 端口 ${connection.port}\n${stateLabel}`;
  const focus = document.createElement("button");
  focus.textContent = "切换到此标签页";
  focus.onclick = () => chrome.tabs.update(Number(tabId), {active: true});
  const unbind = document.createElement("button");
  unbind.textContent = "解除绑定";
  unbind.onclick = async () => {
    try { await unbindTab(Number(tabId)); await show(); }
    catch (error) { $("status").textContent = String(error); }
  };
  row.append(label, focus, unbind);
  return row;
}

async function show() {
  const connections = await readConnections();
  const tab = await activeChatTab();
  const activeConnection = tab ? connections[String(tab.id)] : null;
  if (!tab) $("status").textContent = "请切换到需要操作的 ChatGPT 标签页";
  else if (!activeConnection) $("status").textContent = `当前标签页 ${tab.id} 尚未绑定桥接任务`;
  else {
    try { $("status").textContent = `当前标签页 ${tab.id} 已绑定（Codex 任务 ${activeConnection.threadId || "未知"}，端口 ${activeConnection.port}）\n${phaseLabel(await bridgeApi("/state", "GET", undefined, activeConnection))}`; }
    catch (error) { $("status").textContent = `当前标签页 ${tab.id} 已绑定（端口 ${activeConnection.port}）\n${error}`; }
  }

  const list = $("connections");
  list.replaceChildren();
  const entries = Object.entries(connections);
  const rows = await Promise.all(entries.map(async ([tabId, connection]) => {
    let title = `标签页 ${tabId}`;
    try { title = (await chrome.tabs.get(Number(tabId))).title || title; } catch { title += "（已关闭）"; }
    let stateLabel = "桥接无响应";
    try { stateLabel = phaseLabel(await bridgeApi("/state", "GET", undefined, connection)); }
    catch (error) { stateLabel = String(error); }
    return makeConnectionRow(tabId, connection, title, stateLabel);
  }));
  for (const row of rows) list.appendChild(row);
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "尚无连接。每个任务在独立终端启动 bridge.py，再把该终端的连接信息绑定到 ChatGPT 标签页。";
    list.appendChild(empty);
  }
}

function parseConnectionCode(value) {
  const match = String(value || "").trim().match(/^(?:127\.0\.0\.1:)?(\d{1,5})\|([A-Za-z0-9_-]{20,})$/);
  if (!match) throw new Error("连接信息格式无效；请从对应终端复制“端口|令牌”整行");
  const port = Number(match[1]);
  if (port < 1 || port > 65535) throw new Error("连接信息中的端口无效");
  return {port, token: match[2]};
}

function connectionId(port, token) {
  let hash = 0xcbf29ce484222325n;
  for (const character of token)
    hash = ((hash ^ BigInt(character.charCodeAt(0))) * 0x100000001b3n) & 0xffffffffffffffffn;
  return `p${port}_${hash.toString(16)}`;
}

async function unbindTab(tabId) {
  const connections = await readConnections();
  const key = String(tabId);
  if (!connections[key]) throw new Error("当前标签页没有绑定桥接任务");
  let taskId = connections[key].threadId || "";
  if (!taskId) {
    try { taskId = (await bridgeApi("/state", "GET", undefined, connections[key])).threadId || ""; }
    catch { /* Keep old offline events detached if their task cannot be identified. */ }
  }
  await notifyPage("已解除绑定；自动桥接已停止", false, Number(tabId), "unbound");
  const result = await chrome.runtime.sendMessage({type: "bridgeUnbind", tabId: Number(tabId), taskId});
  if (!result?.ok) throw new Error(result?.error || "解除绑定失败");
  $("status").textContent = `已解除标签页 ${tabId} 的绑定`;
}

$("bind").onclick = async () => {
  const tab = await activeChatTab();
  if (!tab) { $("status").textContent = "请先切换到目标 ChatGPT 会话标签页"; return; }
  let endpoint;
  try { endpoint = parseConnectionCode($("connectionCode").value); }
  catch (error) { $("status").textContent = String(error); return; }
  try { new RegExp($("title").value, "i"); }
  catch { $("status").textContent = "指令卡片标题正则无效"; return; }
  const connections = await readConnections();
  const existing = connections[String(tab.id)];
  if (existing && (existing.port !== endpoint.port || existing.token !== endpoint.token)) {
    $("status").textContent = "此标签页已绑定另一项任务；请先解除当前绑定，再绑定新任务"; return;
  }
  const duplicate = Object.entries(connections).find(([id, connection]) =>
    id !== String(tab.id) && connection.port === endpoint.port && connection.token === endpoint.token);
  if (duplicate) {
    $("status").textContent = `这条桥接已绑定标签页 ${duplicate[0]}；每条桥接请使用独立 ChatGPT 标签页`;
    return;
  }
  try {
    const state = await bridgeApi("/state", "GET", undefined, endpoint);
    const duplicateTask = Object.entries(connections).find(([id, connection]) =>
      id !== String(tab.id) && state.threadId && connection.threadId === state.threadId);
    if (duplicateTask)
      throw new Error(`Codex 任务 ${state.threadId} 已绑定到标签页 ${duplicateTask[0]}；每个任务请使用独立 Codex 任务`);
    await ensureContent(tab.id);
    const connection = {id: connectionId(endpoint.port, endpoint.token),
      tabId: tab.id, port: endpoint.port, token: endpoint.token,
      threadId: state.threadId || "", title: $("title").value, card: $("card").value,
      boundAt: new Date().toISOString()};
    const result = await chrome.runtime.sendMessage({type: "bridgeBind", connection});
    if (!result?.ok) throw new Error(result?.error || "保存桥接绑定失败");
    recordPopup("bind_ok", {phase: state.phase}, tab.id);
    await notifyPage("绑定 ChatGPT 标签页：已完成", false, tab.id);
    $("connectionCode").value = "";
    await show();
  } catch (error) {
    recordPopup("bind_error", {reason: popupErrorReason(error)}, tab.id);
    $("status").textContent = String(error);
  }
};

$("unbind").onclick = async () => {
  const tab = await activeChatTab();
  if (!tab) { $("status").textContent = "请切换到目标 ChatGPT 标签页"; return; }
  try { await unbindTab(tab.id); await show(); }
  catch (error) { $("status").textContent = String(error); }
};

$("viewLog").onclick = () => act(async tabId => {
  const connection = await connectionFor(tabId);
  const result = await bridgeApi("/log", "GET", undefined, connection);
  $("operationLog").textContent = result.records.map(entry => JSON.stringify(entry)).join("\n");
  return `最近 ${result.records.length} 条操作记录，文件：${result.path}`;
}, "view_log");

for (const [id, mode] of [["startA", "A"], ["startB", "B"]]) {
  $(id).onclick = () => act(async tabId => {
    const connection = await connectionFor(tabId);
    if (!connection) throw new Error("当前标签页尚未绑定桥接任务");
    await ensureContent(tabId);
    await bridgeApi("/start", "POST", {mode}, connection);
  }, id);
}

$("viewCards").onclick = () => act(async tabId => {
  const connection = await connectionFor(tabId);
  if (!connection) throw new Error("当前标签页尚未绑定桥接任务");
  await ensureContent(tabId);
  const reply = await chrome.tabs.sendMessage(tabId, {type: "bridgeCardChoices"});
  if (!reply?.ok) throw new Error(reply?.error || "无法读取指令卡片");
  const container = $("cardChoices");
  container.replaceChildren();
  for (const choice of reply.data) {
    const button = document.createElement("button");
    button.className = "wide";
    button.textContent = `发送第 ${choice.index + 1} 张${choice.relaxed ? "（宽松匹配，请确认）" : ""}：${choice.preview}`;
    button.onclick = () => act(async currentTabId => {
      const result = await chrome.tabs.sendMessage(currentTabId,
        {type: "bridgeChooseCard", index: choice.index, key: choice.key});
      if (!result?.ok) throw new Error(result?.error || "无法发送所选卡片");
      container.replaceChildren();
      return result.data;
    }, "choose_card", tabId);
    container.appendChild(button);
  }
  if (!reply.data.length) return "当前没有可识别或可供人工确认的指令卡片。";
  const relaxed = reply.data.filter(choice => choice.relaxed).length;
    return relaxed
      ? reply.data.some(choice => choice.latestOnly)
        ? `严格规则未找到卡片；页面未提供消息边界，仅显示最新的一张宽松候选，请确认后再发送。`
        : `严格规则未找到卡片，已显示 ${relaxed} 张宽松匹配；请确认后再发送。`
    : reply.data.some(choice => choice.latestOnly)
      ? "页面未提供消息边界；为避开历史卡片，仅显示最新的一张严格匹配卡片，请核对后发送。"
      : `找到 ${reply.data.length} 张可识别卡片，请核对文字后选择。`;
}, "view_cards");

for (const [id, action] of [["recheck", "recheck"], ["confirmSent", "confirmSent"], ["retrySend", "retrySend"]]) {
  $(id).onclick = () => act(async tabId => {
    const connection = await connectionFor(tabId);
    if (!connection) throw new Error("当前标签页尚未绑定桥接任务");
    await ensureContent(tabId);
    let reply;
    try { reply = await chrome.tabs.sendMessage(tabId, {type: "bridgeRecover", action}); }
    catch (error) {
      if (!missingReceiver(error)) throw error;
      await ensureContent(tabId);
      reply = await chrome.tabs.sendMessage(tabId, {type: "bridgeRecover", action});
    }
    if (!reply?.ok) throw new Error(reply?.error || "页面没有响应；请刷新 ChatGPT 标签页后再试");
    return reply.message;
  }, id);
}

show();
