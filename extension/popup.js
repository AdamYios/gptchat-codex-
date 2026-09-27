const $ = id => document.getElementById(id);
const PHASE_HELP = {
  setup: "服务已连接，等待你选择起点 A 或 B",
  await_instruction: "等待 ChatGPT 页面识别下一张“给 Codex 的指令”卡片",
  codex_running: "指令已发送给 Codex，正在等待 Codex 完成",
  report_ready: "Codex 最终报告已准备好，等待发送回 ChatGPT",
  stopped: "桥接已停止，需要检查下方原因或重新选择起点",
};
function phaseLabel(state) {
  const help = PHASE_HELP[state.phase] || "未知状态，请检查桥接器输出";
  const round = state.phase === "await_instruction" && state.round === 0
    ? "尚未投递第一条指令"
    : `第 ${state.round} 轮`;
  return `桥接状态：${state.phase}\n${help}\n${round}${state.detail ? `\n原因：${state.detail}` : ""}`;
}
async function show() {
  const c = await chrome.storage.local.get(["port", "token", "title", "card", "tabId"]);
  for (const key of ["port", "token", "title", "card"]) if (c[key] !== undefined) $(key).value = c[key];
  $("status").textContent = c.tabId ? `已绑定标签页 ${c.tabId}` : "尚未绑定";
  if (c.tabId && c.token && c.port) {
    try {
      const state = await bridgeApi("/state");
      $("status").textContent += `\n${phaseLabel(state)}`;
    } catch (error) { $("status").textContent += `\n${error}`; }
  }
}
async function bridgeApi(path, method = "GET", body) {
  const c = await chrome.storage.local.get(["port", "token"]);
  if (!c.port || !c.token) throw new Error("请先填写令牌并绑定标签页");
  const response = await fetch(`http://127.0.0.1:${c.port}${path}`, {
    method, headers: {"Content-Type": "application/json", "X-Bridge-Token": c.token},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 404 && path === "/start")
      throw new Error("当前 PowerShell 仍运行旧版 bridge.py；重启桥接器后即可用 A/B 按钮");
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}
function missingReceiver(error) {
  return /Receiving end does not exist|Could not establish connection/i.test(String(error));
}
async function ensureContent(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || ""))
    throw new Error("绑定的标签页已不是 ChatGPT 页面；请重新绑定");
  try {
    await chrome.tabs.sendMessage(tabId, {type: "bridgePing"});
  } catch (error) {
    if (!missingReceiver(error)) throw error;
    const [probe] = await chrome.scripting.executeScript({target: {tabId},
      func: () => !!document.getElementById("codex-bridge-status")});
    if (probe?.result)
      throw new Error("此 ChatGPT 标签页仍有已失效的旧扩展脚本；请刷新标签页后重新绑定");
    await chrome.scripting.executeScript({target: {tabId}, files: ["content.js"]});
    await chrome.tabs.sendMessage(tabId, {type: "bridgePing"});
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
function recordPopup(event, data = {}) {
  void chrome.runtime.sendMessage({type: "bridgeLog", event, data}).catch(() => {});
}
const OPERATION_NAMES = {
  startA: "选择 A 起点", startB: "选择 B 起点", view_cards: "查看指令卡片",
  choose_card: "发送所选指令卡片", view_log: "查看操作记录",
  recheck: "重新检查报告", confirmSent: "确认报告已发送", retrySend: "重新发送报告"
};
async function notifyPage(text, error = false, tabId = null, phase = "") {
  try {
    const boundId = tabId || (await chrome.storage.local.get("tabId")).tabId;
    if (boundId) await chrome.tabs.sendMessage(boundId, {type: "bridgeUiAction", text, error, phase});
  } catch { /* The popup still shows the action result if the page receiver is unavailable. */ }
}
async function act(callback, operation = "action") {
  const label = OPERATION_NAMES[operation] || "操作";
  $("status").textContent = `${label}：正在处理…`;
  await notifyPage(`${label}：正在处理…`);
  try { const message = await callback(); await show();
    recordPopup(`${operation}_ok`);
    await notifyPage(`${label}：已完成`);
    if (message) $("status").textContent = `${message}\n${$("status").textContent}`; }
  catch (error) {
    recordPopup(`${operation}_error`, {reason: popupErrorReason(error)});
    await notifyPage(`${label}：失败，请查看扩展弹窗`, true);
    $("status").textContent = String(error);
  }
}
$("bind").onclick = async () => {
  recordPopup("bind_attempt");
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || "")) {
    recordPopup("bind_error", {reason: "invalid_tab"});
    $("status").textContent = "请先打开目标 ChatGPT 会话标签页"; return;
  }
  const port = Number($("port").value);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !$("token").value) {
    recordPopup("bind_error", {reason: "invalid_config"});
    $("status").textContent = "端口或令牌无效"; return;
  }
  try { new RegExp($("title").value, "i"); } catch {
    recordPopup("bind_error", {reason: "invalid_title"});
    $("status").textContent = "标题正则无效"; return;
  }
  try {
    await ensureContent(tab.id);
    await chrome.storage.local.set({tabId: tab.id, port, token: $("token").value,
      title: $("title").value, card: $("card").value});
    recordPopup("bind_ok");
    await notifyPage("绑定 ChatGPT 标签页：已完成", false, tab.id);
    $("status").textContent = `已绑定标签页 ${tab.id}。保持此页打开。`;
  } catch (error) {
    recordPopup("bind_error", {reason: popupErrorReason(error)});
    $("status").textContent = String(error);
  }
};
$("unbind").onclick = async () => {
  await notifyPage("已解除绑定；自动桥接已停止", false, null, "unbound");
  recordPopup("unbind");
  await chrome.storage.local.remove("tabId");
  await show();
};
$("viewLog").onclick = () => act(async () => {
  await chrome.runtime.sendMessage({type: "bridgeLog", event: "view_log"});
  const result = await bridgeApi("/log");
  $("operationLog").textContent = result.records.map(entry => JSON.stringify(entry)).join("\n");
  return `最近 ${result.records.length} 条操作记录，文件：${result.path}`;
}, "view_log");
for (const [id, mode] of [["startA", "A"], ["startB", "B"]]) {
  $(id).onclick = () => act(async () => {
    const c = await chrome.storage.local.get("tabId");
    if (!c.tabId) throw new Error("请先绑定目标 ChatGPT 标签页");
    await ensureContent(c.tabId);
    await bridgeApi("/start", "POST", {mode});
  }, id);
}
$("viewCards").onclick = () => act(async () => {
  const c = await chrome.storage.local.get("tabId");
  if (!c.tabId) throw new Error("请先绑定目标 ChatGPT 标签页");
  await ensureContent(c.tabId);
  const reply = await chrome.tabs.sendMessage(c.tabId, {type: "bridgeCardChoices"});
  if (!reply?.ok) throw new Error(reply?.error || "无法读取指令卡片");
  const container = $("cardChoices");
  container.replaceChildren();
  for (const choice of reply.data) {
    const button = document.createElement("button");
    button.className = "wide";
    button.textContent = `发送第 ${choice.index + 1} 张${choice.relaxed ? "（宽松匹配，请确认）" : ""}：${choice.preview}`;
    button.onclick = () => act(async () => {
      const result = await chrome.tabs.sendMessage(c.tabId,
        {type: "bridgeChooseCard", index: choice.index, key: choice.key});
      if (!result?.ok) throw new Error(result?.error || "无法发送所选卡片");
      container.replaceChildren();
      return result.data;
    }, "choose_card");
    container.appendChild(button);
  }
  if (!reply.data.length) return "当前没有可识别或可供人工确认的指令卡片。";
  const relaxed = reply.data.filter(choice => choice.relaxed).length;
  return relaxed
    ? `严格规则未找到卡片，已显示 ${relaxed} 张宽松匹配；请确认后再发送。`
    : reply.data.some(choice => choice.latestOnly)
      ? "页面未提供消息边界；为避开历史卡片，仅显示最新的一张严格匹配卡片，请核对后发送。"
      : `找到 ${reply.data.length} 张可识别卡片，请核对文字后选择。`;
}, "view_cards");
for (const [id, action] of [["recheck", "recheck"], ["confirmSent", "confirmSent"], ["retrySend", "retrySend"]]) {
  $(id).onclick = () => act(async () => {
    const c = await chrome.storage.local.get("tabId");
    if (!c.tabId) throw new Error("请先绑定目标 ChatGPT 标签页");
    await ensureContent(c.tabId);
    let reply;
    try { reply = await chrome.tabs.sendMessage(c.tabId, {type: "bridgeRecover", action}); }
    catch (error) {
      if (!missingReceiver(error)) throw error;
      await ensureContent(c.tabId);
      reply = await chrome.tabs.sendMessage(c.tabId, {type: "bridgeRecover", action});
    }
    if (!reply?.ok) throw new Error(reply?.error || "页面没有响应；请刷新 ChatGPT 标签页后再试");
    return reply.message;
  }, id);
}
show();
