const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

async function main() {
  const elements = new Map();
  for (const id of ["port", "token", "title", "card", "status", "bind", "unbind", "startA", "startB", "viewCards", "cardChoices", "recheck", "confirmSent", "retrySend", "viewLog", "operationLog"])
    elements.set(id, {value: "", textContent: "", onclick: null});
  const children = [];
  elements.get("cardChoices").replaceChildren = () => { children.length = 0; };
  elements.get("cardChoices").appendChild = child => { children.push(child); };
  const config = {tabId: 7, port: 8765, token: "test", title: "test", card: ""};
  let injected = false;
  let staleBar = false;
  let recoveryCalls = 0;
  let selectedKey = "";
  let startCalls = 0;
  const pageNotifications = [];
  const chrome = {
    runtime: {sendMessage: async () => ({ok: true})},
    storage: {local: {get: async () => config, set: async value => Object.assign(config, value), remove: async key => delete config[key]}},
    tabs: {
      get: async () => ({url: "https://chatgpt.com/c/example"}),
      query: async () => [{id: 8, url: "https://chatgpt.com/c/example"}],
      sendMessage: async (_id, message) => {
        if (message.type === "bridgePing") {
          if (!injected) throw new Error("Could not establish connection. Receiving end does not exist.");
          return {ok: true};
        }
        if (message.type === "bridgeCardChoices") return {ok: true, data: [{index: 0, key: "first", preview: "第一条"}, {index: 1, key: "second", preview: "第二条"}]};
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
      injected = true;
    }}
  };
  const fetch = async url => {
    if (url.endsWith("/start")) startCalls += 1;
    if (url.endsWith("/log")) return {ok: true, json: async () => ({path: "logs/bridge.jsonl",
      records: [{time: "2026-09-26T00:00:00Z", source: "bridge", event: "start", data: {mode: "A"}}]})};
    return {ok: true, json: async () => ({phase: "report_ready", round: 1})};
  };
  const source = fs.readFileSync(path.join(__dirname, "extension", "popup.js"), "utf8");
  vm.runInNewContext(source, {chrome, fetch, document: {getElementById: id => elements.get(id),
    createElement: () => ({className: "", textContent: "", onclick: null})}, console});
  await elements.get("recheck").onclick();
  assert.equal(injected, true);
  assert.equal(recoveryCalls, 1);
  assert.match(elements.get("status").textContent, /恢复成功/);
  assert.ok(pageNotifications.some(text => text.includes("重新检查报告：已完成")));
  await elements.get("viewCards").onclick();
  assert.equal(children.length, 2);
  await children[1].onclick();
  assert.equal(selectedKey, "second");
  assert.match(elements.get("status").textContent, /已发送第 2 张/);
  assert.ok(pageNotifications.some(text => text.includes("发送所选指令卡片：已完成")));
  await elements.get("viewLog").onclick();
  assert.match(elements.get("operationLog").textContent, /"event":"start"/);
  injected = false;
  staleBar = true;
  await elements.get("recheck").onclick();
  assert.match(elements.get("status").textContent, /请刷新标签页后重新绑定/);
  assert.equal(injected, false);
  elements.get("port").value = "8765";
  elements.get("token").value = "test";
  elements.get("title").value = "给 Codex 的指令";
  await elements.get("bind").onclick();
  assert.equal(config.tabId, 7);
  await elements.get("startA").onclick();
  assert.equal(startCalls, 0);
  console.log("Popup reinjects missing ChatGPT receiver and retries recovery OK");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
