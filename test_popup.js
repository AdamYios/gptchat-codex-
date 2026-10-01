const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

async function main() {
  const elements = new Map();
  for (const id of ["connectionCode", "status", "connectionConfigSection", "startSection",
    "startConnectionStatus", "startTaskPhase", "currentTaskSection", "connectionStatus", "currentTaskName", "taskPhase",
    "endFlow", "bind", "startMode", "startSelected", "reportRecoveryActions", "moreActions",
    "viewCards", "cardChoices", "connections", "recheck", "confirmSent", "retrySend", "viewLog", "operationLog",
    "optimizerEnabled", "optimizerKeepRounds", "optimizerLiveWindow", "optimizerRenderOptimize", "optimizerApply", "optimizerStatus"])
    elements.set(id, {value: "", checked: false, disabled: false, textContent: "", onclick: null, children: [], listeners: {},
      addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); },
      replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); },
      append(...children) { this.children.push(...children); }});
  const popupHtml = fs.readFileSync(path.join(__dirname, "extension", "popup.html"), "utf8");
  assert.match(popupHtml, /href="popup\.css"/);
  assert.match(popupHtml, /当前任务/);
  assert.match(popupHtml, /长对话加速/);
  assert.match(popupHtml, /<summary>更多操作<\/summary>/);
  assert.ok(popupHtml.indexOf('id="connectionConfigSection"') < popupHtml.indexOf('id="startSection"'));
  assert.ok(popupHtml.indexOf('id="startSection"') < popupHtml.indexOf('id="currentTaskSection"'));
  const currentTaskMarkup = popupHtml.slice(popupHtml.indexOf('id="currentTaskSection"'), popupHtml.indexOf("</section>", popupHtml.indexOf('id="currentTaskSection"')));
  assert.equal((currentTaskMarkup.match(/<button\b/g) || []).length, 1,
    "the current task card has only the end-flow action");
  assert.doesNotMatch(popupHtml, /id="unbind"|id="startA"|id="startB"/);
  assert.match(popupHtml, /id="endFlow"[^>]*>结束当前流程/);
  assert.doesNotMatch(popupHtml, /autoPaused|暂停自动传递|恢复自动传递|autoTransfer/);
  assert.doesNotMatch(popupHtml, /id="(?:title|card)"/,
    "connection setup only asks for the bridge port and token");
  for (const id of ["optimizerEnabled", "optimizerKeepRounds", "optimizerLiveWindow", "optimizerRenderOptimize", "optimizerApply", "optimizerStatus"])
    assert.match(popupHtml, new RegExp(`id="${id}"`));
  assert.match(popupHtml, /应用并刷新/);
  const state = {
    connections: undefined,
    tabId: 7, port: 8765, token: "abcdefghijklmnopqrstuvwxyz123456", title: "旧标题覆盖项", card: ".legacy-card",
    "optimizer.enabled": true, "optimizer.keepRounds": 18,
    "optimizer.renderOptimize": false, "optimizer.liveWindow": true
  };
  const tabStates = new Map([[7, {url: "https://chatgpt.com/c/a", title: "Chat A"}],
    [8, {url: "https://chatgpt.com/c/b", title: "Chat B"}]]);
  const injected = new Set();
  let staleBar = false;
  let recoveryCalls = 0;
  let selectedKey = "";
  const starts = [];
  const pageNotifications = [];
  const optimizerMessages = [];
  const lifecycleMessages = [];
  const reloadedTabs = [];
  let activeId = 7;
  const intervals = [];
  const codexInProgressByPort = new Map([[8765, false], [8766, false]]);
  const phaseByPort = new Map([[8765, "report_ready"], [8766, "setup"]]);
  const chrome = {
    runtime: {sendMessage: async message => {
      if (["bridgeTaskStarted", "bridgeTaskStopped"].includes(message.type))
        lifecycleMessages.push({type: message.type, tabId: message.tabId});
      if (message.type === "bridgeBind") {
        const connections = {...(state.connections || {})};
        if (state.tabId && state.port && state.token && !connections[String(state.tabId)])
          connections[String(state.tabId)] = {id: `legacy_${state.tabId}`, tabId: state.tabId,
            port: state.port, token: state.token, title: state.title, card: state.card};
        connections[String(message.connection.tabId)] = message.connection;
        state.connections = connections;
        for (const key of ["tabId", "port", "token", "title", "card"]) delete state[key];
      }
      if (message.type === "bridgeUnbind") delete state.connections[String(message.tabId)];
      return {ok: true};
    }},
    storage: {local: {
      get: async keys => {
        const result = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) result[key] = state[key];
        return result;
      },
      set: async value => Object.assign(state, value),
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key]; }
    }},
    tabs: {
      get: async id => ({id, ...(tabStates.get(id) || {url: "", title: "Closed tab"})}),
      query: async () => [{id: activeId, ...(tabStates.get(activeId) || {})}],
      update: async (id, options) => { if (options.active) activeId = id; },
      reload: async id => { reloadedTabs.push(id); },
      sendMessage: async (id, message) => {
        if (message.type === "bridgeFlowStarted") lifecycleMessages.push({type: message.type, tabId: id});
        if (message.type.startsWith("OPTIMIZER_")) {
          optimizerMessages.push({tabId: id, type: message.type, settings: message.settings});
          if (message.type === "OPTIMIZER_STATUS") return {ok: true,
            mainStatus: {liveDiagnostic: {userUnits: 4, hiddenUnits: 6}}};
          return {ok: true};
        }
        if (message.type === "bridgePing") {
          if (!injected.has(id)) throw new Error("Could not establish connection. Receiving end does not exist.");
          return {ok: true};
        }
        if (message.type === "bridgeCardChoices")
          return {ok: true, data: [
            {index: 0, key: "first", preview: "第一条"},
            {index: 1, key: "second", preview: "第二条"},
            {index: 2, key: "manual", preview: "最新格式候选", relaxed: true, latestOnly: true}
          ]};
        if (message.type === "bridgeChooseCard") {
          selectedKey = message.key;
          return {ok: true, data: `已发送第 ${message.index + 1} 张`};
        }
        if (message.type === "bridgeUiAction") {
          pageNotifications.push(message.text);
          return {ok: true};
        }
        if (message.type === "bridgeRecover") {
          recoveryCalls += 1;
          return {ok: true, message: "恢复成功"};
        }
        return {ok: true};
      }
    },
    scripting: {executeScript: async ({target, files, func}) => {
      assert.ok([7, 8].includes(target.tabId));
      if (func) return [{result: staleBar}];
      assert.deepEqual(Array.from(files), ["content.js"]);
      injected.add(target.tabId);
    }}
  };
  const routed = [];
  const stopRequests = [];
  const fetch = async (url, options = {}) => {
    const endpoint = new URL(url);
    routed.push({port: Number(endpoint.port), path: endpoint.pathname, method: options.method || "GET"});
    if (endpoint.pathname === "/log") return {ok: true, json: async () => ({path: "logs/bridge.jsonl",
      records: [{time: "2026-09-26T00:00:00Z", source: "bridge", event: "start", data: {mode: "A"}}]})};
    if (endpoint.pathname === "/start") {
      const mode = JSON.parse(options.body).mode;
      starts.push({port: Number(endpoint.port), mode});
      phaseByPort.set(Number(endpoint.port), mode === "A" ? "await_instruction" : "report_ready");
      codexInProgressByPort.set(Number(endpoint.port), false);
    }
    if (endpoint.pathname === "/stop") {
      stopRequests.push({port: Number(endpoint.port), body: JSON.parse(options.body)});
      phaseByPort.set(Number(endpoint.port), "stopped");
    }
    return {ok: true, status: 200, json: async () => ({threadId: `task-${endpoint.port}`, runId: "run",
      phase: phaseByPort.get(Number(endpoint.port)), round: 1,
      reportId: phaseByPort.get(Number(endpoint.port)) === "report_ready" ? 1 : 0,
      detail: phaseByPort.get(Number(endpoint.port)) === "stopped" ? "用户结束当前流程" : "",
      codexInProgress: codexInProgressByPort.get(Number(endpoint.port)) || false})};
  };
  const source = fs.readFileSync(path.join(__dirname, "extension", "popup.js"), "utf8");
  const document = {getElementById: id => elements.get(id), createElement: () => ({
    className: "", textContent: "", onclick: null, children: [],
    append(...children) { this.children.push(...children); }
  })};
  vm.runInNewContext(source, {chrome, fetch, document, console, URL, Date, Math, Number, String, Object, RegExp,
    setInterval: (callback, delay) => { intervals.push({callback, delay}); return intervals.length; }});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(elements.get("optimizerEnabled").checked, true);
  assert.equal(elements.get("optimizerKeepRounds").value, 18);
  assert.equal(elements.get("optimizerRenderOptimize").checked, false);
  assert.equal(elements.get("optimizerLiveWindow").checked, true);
  assert.match(elements.get("optimizerStatus").textContent, /页面脚本已连接/);
  assert.ok(optimizerMessages.some(message => message.type === "OPTIMIZER_STATUS"));
  assert.equal(elements.get("connectionConfigSection").hidden, true);
  assert.equal(elements.get("startSection").hidden, true);
  assert.equal(elements.get("currentTaskSection").hidden, false);
  assert.equal(elements.get("reportRecoveryActions").hidden, false,
    "report recovery is available only for a report_ready task");
  assert.match(elements.get("connectionStatus").textContent, /已连接/);
  assert.match(elements.get("taskPhase").textContent, /report_ready/);
  await elements.get("recheck").onclick();
  assert.equal(injected.has(7), true);
  assert.equal(recoveryCalls, 1);
  assert.match(elements.get("status").textContent, /恢复成功/);
  assert.ok(pageNotifications.some(text => text.includes("重新检查报告：已完成")));
  await elements.get("viewCards").onclick();
  assert.equal(elements.get("cardChoices").children.length, 3);
  assert.match(elements.get("status").textContent, /最新的一张宽松候选/);
  assert.match(elements.get("cardChoices").children[2].textContent, /宽松匹配，请确认/);
  await elements.get("cardChoices").children[2].onclick();
  assert.equal(selectedKey, "manual");
  assert.match(elements.get("status").textContent, /已发送第 3 张/);
  assert.ok(pageNotifications.some(text => text.includes("发送所选指令卡片：已完成")));
  await elements.get("viewLog").onclick();
  assert.match(elements.get("operationLog").textContent, /"event":"start"/);
  elements.get("connectionCode").value = "8765|abcdefghijklmnopqrstuvwxyz123456";
  await elements.get("bind").onclick();
  assert.equal(state.connections["7"].title, "旧标题覆盖项",
    "re-binding the same legacy connection preserves its card title override");
  assert.equal(state.connections["7"].card, ".legacy-card",
    "re-binding the same legacy connection preserves its selector override");
  staleBar = true;
  injected.delete(7);
  await elements.get("recheck").onclick();
  assert.match(elements.get("status").textContent, /请刷新标签页后重新绑定/);
  assert.equal(injected.has(7), false);

  activeId = 8;
  staleBar = false;
  elements.get("connectionCode").value = "8766|abcdefghijklmnopqrstuvwxyz123456";
  await elements.get("bind").onclick();
  assert.ok(state.connections["7"]);
  assert.equal(state.connections["7"].title, "旧标题覆盖项",
    "re-binding keeps an existing legacy card title override");
  assert.equal(state.connections["7"].card, ".legacy-card",
    "re-binding keeps existing legacy selector data");
  assert.equal(state.connections["8"].port, 8766);
  assert.equal(Object.hasOwn(state.connections["8"], "title"), false,
    "new connections use built-in card recognition defaults");
  assert.equal(Object.hasOwn(state.connections["8"], "card"), false);
  assert.equal(elements.get("connectionConfigSection").hidden, true);
  assert.equal(elements.get("startSection").hidden, false,
    "a connected bridge in setup shows the start selector");
  assert.equal(elements.get("currentTaskSection").hidden, true);
  assert.equal(elements.get("reportRecoveryActions").hidden, true);
  elements.get("startMode").value = "A";
  await elements.get("startSelected").onclick();
  assert.equal(elements.get("startSection").hidden, true);
  assert.equal(elements.get("currentTaskSection").hidden, false,
    "await_instruction shows the current task card");
  assert.equal(elements.get("reportRecoveryActions").hidden, true);
  assert.deepEqual(lifecycleMessages.slice(0, 2), [
    {type: "bridgeTaskStarted", tabId: 8}, {type: "bridgeFlowStarted", tabId: 8}
  ], "starting a flow clears background suppression and resumes the content loop");
  elements.get("startMode").value = "B";
  await elements.get("startSelected").onclick();
  assert.deepEqual(starts, [{port: 8766, mode: "A"}, {port: 8766, mode: "B"}]);
  assert.equal(elements.get("currentTaskSection").hidden, false);
  assert.equal(elements.get("reportRecoveryActions").hidden, false,
    "report recovery appears for a pending report");
  phaseByPort.set(8766, "codex_running");
  codexInProgressByPort.set(8766, true);
  await intervals[0].callback();
  assert.equal(elements.get("currentTaskSection").hidden, false,
    "codex_running remains in the current task view");
  assert.match(elements.get("taskPhase").textContent, /codex_running/);
  assert.equal(elements.get("reportRecoveryActions").hidden, true,
    "report recovery hides when the report is no longer pending");
  assert.equal(intervals[0].delay, 1500);
  await elements.get("endFlow").onclick();
  assert.deepEqual(stopRequests, [{port: 8766, body: {reason: "用户结束当前流程", runId: "run"}}]);
  assert.equal(lifecycleMessages.at(-1).type, "bridgeTaskStopped",
    "ending a flow tells the background to suppress alarm checks immediately");
  assert.equal(lifecycleMessages.at(-1).tabId, 8);
  assert.equal(state.connections["8"].port, 8766, "ending the flow keeps the tag bound");
  assert.equal(elements.get("startSelected").disabled, true,
    "a new flow cannot start while the previous Codex task is still running");
  assert.match(elements.get("startTaskPhase").textContent, /Codex 仍在运行/);
  assert.equal(elements.get("startSection").hidden, false,
    "a stopped task returns to the start selector");
  assert.equal(elements.get("currentTaskSection").hidden, true);
  assert.equal(elements.get("reportRecoveryActions").hidden, true);
  codexInProgressByPort.set(8766, false);
  await intervals[0].callback();
  assert.equal(elements.get("startSelected").disabled, false,
    "the start button becomes available when the existing Codex task finishes");
  elements.get("startMode").value = "A";
  await elements.get("startSelected").onclick();
  assert.deepEqual(starts, [{port: 8766, mode: "A"}, {port: 8766, mode: "B"}, {port: 8766, mode: "A"}]);
  assert.deepEqual(lifecycleMessages.slice(-2), [
    {type: "bridgeTaskStarted", tabId: 8}, {type: "bridgeFlowStarted", tabId: 8}
  ], "a later flow resumes automatic transfer on the same bound tab");
  assert.ok(routed.some(item => item.port === 8766 && item.path === "/stop" && item.method === "POST"));
  assert.equal(routed.some(item => item.path === "/pause" || item.path === "/resume"), false);
  assert.match(routed.filter(item => item.path === "/state").map(item => item.port).join(","), /8765.*8766|8766.*8765/);
  const chatBRow = elements.get("connections").children.find(row =>
    row.children[0].textContent.startsWith("Chat B"));
  assert.ok(chatBRow, "each connected task remains listed");
  assert.equal(chatBRow.children[2].textContent, "解除绑定");
  phaseByPort.set(8766, "codex_running");
  codexInProgressByPort.set(8766, true);
  await chatBRow.children[2].onclick();
  assert.equal(state.connections["8"], undefined);
  assert.ok(state.connections["7"]);
  assert.deepEqual(stopRequests[1], {port: 8766, body: {
    reason: "ChatGPT 标签页已解除绑定", runId: "run"
  }}, "unbinding ends the old bridge flow without changing its run ID");
  assert.equal(phaseByPort.get(8766), "stopped");
  assert.equal(elements.get("connectionConfigSection").hidden, false,
    "an unbound active tab shows connection configuration");
  assert.equal(elements.get("startSection").hidden, true);
  assert.equal(elements.get("currentTaskSection").hidden, true);
  assert.equal(activeId, 8);

  elements.get("connectionCode").value = "8766|abcdefghijklmnopqrstuvwxyz123456";
  await elements.get("bind").onclick();
  assert.equal(elements.get("connectionConfigSection").hidden, true);
  assert.equal(elements.get("startSection").hidden, false,
    "rebinding after unbind shows the start selector instead of the old task view");
  assert.equal(elements.get("currentTaskSection").hidden, true);
  assert.equal(elements.get("startSelected").disabled, true,
    "the old Codex run keeps running and prevents a new flow from starting");
  assert.match(elements.get("startTaskPhase").textContent, /Codex 仍在运行/);
  codexInProgressByPort.set(8766, false);
  await intervals[0].callback();
  assert.equal(elements.get("startSelected").disabled, false,
    "the new flow becomes available when the old Codex run finishes");

  elements.get("optimizerEnabled").checked = false;
  elements.get("optimizerKeepRounds").value = "24";
  elements.get("optimizerLiveWindow").checked = false;
  elements.get("optimizerRenderOptimize").checked = true;
  await elements.get("optimizerKeepRounds").listeners.change[0]();
  assert.equal(state["optimizer.enabled"], false);
  assert.equal(state["optimizer.keepRounds"], 24);
  assert.equal(state["optimizer.liveWindow"], false);
  assert.equal(state["optimizer.renderOptimize"], true);
  await elements.get("optimizerApply").onclick();
  assert.ok(optimizerMessages.some(message => message.type === "OPTIMIZER_APPLY" &&
    message.settings.keepRounds === 24 && message.settings.enabled === false));
  assert.ok(optimizerMessages.some(message => message.type === "OPTIMIZER_LIVE_NOW"));
  assert.deepEqual(reloadedTabs, [8]);
  console.log("Popup preserves Codex bridge and applies long-chat optimizer settings");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
