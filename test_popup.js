const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

async function main() {
  const elements = new Map();
  for (const id of ["connectionCode", "title", "card", "status", "bind", "unbind", "startA", "startB",
    "viewCards", "cardChoices", "connections", "recheck", "confirmSent", "retrySend", "viewLog", "operationLog"])
    elements.set(id, {value: "", textContent: "", onclick: null, children: [],
      replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); },
      append(...children) { this.children.push(...children); }});
  const state = {
    connections: undefined,
    tabId: 7, port: 8765, token: "legacy", title: "给 Codex 的指令", card: ""
  };
  const tabStates = new Map([[7, {url: "https://chatgpt.com/c/a", title: "Chat A"}],
    [8, {url: "https://chatgpt.com/c/b", title: "Chat B"}]]);
  const injected = new Set();
  let staleBar = false;
  let recoveryCalls = 0;
  let selectedKey = "";
  const starts = [];
  const pageNotifications = [];
  let activeId = 7;
  const chrome = {
    runtime: {sendMessage: async message => {
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
      sendMessage: async (id, message) => {
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
        recoveryCalls += 1;
        return {ok: true, message: "恢复成功"};
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
  const fetch = async (url, options = {}) => {
    const endpoint = new URL(url);
    routed.push({port: Number(endpoint.port), path: endpoint.pathname, method: options.method || "GET"});
    if (endpoint.pathname === "/log") return {ok: true, json: async () => ({path: "logs/bridge.jsonl",
      records: [{time: "2026-09-26T00:00:00Z", source: "bridge", event: "start", data: {mode: "A"}}]})};
    if (endpoint.pathname === "/start") starts.push({port: Number(endpoint.port), mode: JSON.parse(options.body).mode});
    return {ok: true, json: async () => ({phase: "report_ready", round: 1})};
  };
  const source = fs.readFileSync(path.join(__dirname, "extension", "popup.js"), "utf8");
  const document = {getElementById: id => elements.get(id), createElement: () => ({
    className: "", textContent: "", onclick: null, children: [],
    append(...children) { this.children.push(...children); }
  })};
  vm.runInNewContext(source, {chrome, fetch, document, console, URL, Date, Math, Number, String, Object, RegExp});
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
  staleBar = true;
  injected.delete(7);
  await elements.get("recheck").onclick();
  assert.match(elements.get("status").textContent, /请刷新标签页后重新绑定/);
  assert.equal(injected.has(7), false);

  activeId = 8;
  staleBar = false;
  elements.get("connectionCode").value = "8766|abcdefghijklmnopqrstuvwxyz123456";
  elements.get("title").value = "给 Codex 的指令";
  await elements.get("bind").onclick();
  assert.ok(state.connections["7"]);
  assert.equal(state.connections["8"].port, 8766);
  await elements.get("startA").onclick();
  assert.deepEqual(starts, [{port: 8766, mode: "A"}]);
  assert.match(routed.filter(item => item.path === "/state").map(item => item.port).join(","), /8765.*8766|8766.*8765/);
  await elements.get("unbind").onclick();
  assert.equal(state.connections["8"], undefined);
  assert.ok(state.connections["7"]);
  assert.equal(activeId, 8);
  console.log("Popup binds and operates independent per-tab bridge connections OK");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
