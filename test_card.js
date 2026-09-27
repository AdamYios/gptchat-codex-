const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

class Element {
  constructor(tag, ownText = "", attributes = {}) {
    this.nodeType = 1;
    this.tag = tag;
    this.ownText = ownText;
    this.attributes = attributes;
    this.children = [];
    this.parentElement = null;
  }
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  get innerText() { return [this.ownText, ...this.children.map(c => c.innerText)].filter(Boolean).join("\n"); }
  get textContent() { return this.innerText; }
  getAttribute(key) { return this.attributes[key] || null; }
  getClientRects() { for (let node = this; node; node = node.parentElement) if (node.hidden) return []; return [{}]; }
  contains(other) { for (let node = other; node; node = node.parentElement) if (node === this) return true; return false; }
  querySelectorAll(selector) {
    const tags = selector.split(",").map(s => s.trim().toLowerCase());
    const result = [];
    const visit = node => {
      for (const child of node.children) {
        if (tags.includes(child.tag) || (tags.includes("[role='heading']") && child.attributes.role === "heading")) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
}

const file = path.join(__dirname, "extension", "content.js");
const source = fs.readFileSync(file, "utf8").replace(
  /  tickInterval = setInterval\(tick, 2000\);\s*tick\(\);/,
  "  globalThis.extractCardForTest = extractCard; globalThis.reportWasSentForTest = reportWasSent; globalThis.saveReportBaselineForTest = saveReportBaseline; globalThis.assistantMessagesForTest = assistantMessages; globalThis.tickForTest = tick; globalThis.stopInvalidatedForTest = stopInvalidatedScript; globalThis.forceStableForTest = () => { stableSince = Date.now() - 2000; };"
);
const saved = {"bridge.attemptedReport": "1", "bridge.preSendUserCount": "1", "bridge.preSendUserText": "以下是 Codex 上一轮的最终报告。 完整报告正文"};
let submitted = "";
const logged = [];
let bound = true;
let stateRequests = 0;
let contentMessageListener;
const context = {sessionStorage: {
  getItem: key => saved[key] || null,
  setItem: (key, value) => { saved[key] = value; },
  removeItem: key => { delete saved[key]; }
},
  getComputedStyle: node => ({display: node.cssDisplay || "block",
    visibility: node.cssVisibility || "visible", contentVisibility: "visible"}),
  chrome: {
    storage: {local: {get: async () => ({tabId: 7, title: "给\\s*Codex\\s*的指令"})}},
    runtime: {onMessage: {addListener: callback => { contentMessageListener = callback; }}, sendMessage: async message => {
      if (message.type === "bridgeLog") { logged.push(message); return {ok: true}; }
      if (message.type === "bridgeIsBound") return {ok: true, bound};
      if (message.path === "/state") {
        stateRequests += 1;
        return {ok: true, data: {runId: "", phase: "await_instruction", round: 0}};
      }
      if (message.path === "/instruction") { submitted = message.body.instruction; return {ok: true, data: {}}; }
      return {ok: true, data: {}};
    }}
  }, console};
vm.runInNewContext(source, context, {filename: file});

const message = new Element("div");
message.append(new Element("p", "所以我建议先检查现有 schema。"));
const card = message.append(new Element("div"));
const header = card.append(new Element("div"));
header.append(new Element("span", "给 Codex 的指令"));
header.append(new Element("button", "", {"aria-label": "复制"}));
const body = card.append(new Element("div"));
body.append(new Element("p", "继续修 Stage 5A3b，不 commit，不开始 5A3c。"));
body.append(new Element("p", "先检查现有 domain/schema/tool 定义。"));

const result = context.extractCardForTest(message, /给\s*Codex\s*的指令/i, "");
assert.equal(result.error, undefined);
assert.match(result.instruction, /继续修 Stage 5A3b/);
assert.match(result.instruction, /先检查现有 domain/);
assert.doesNotMatch(result.instruction, /所以我建议/);
assert.doesNotMatch(result.instruction, /给 Codex 的指令/);
const nestedMessage = new Element("div");
const wrapper = nestedMessage.append(new Element("div"));
wrapper.append(new Element("span", "给 Codex 的指令"));
wrapper.append(new Element("button", "", {"aria-label": "复制"}));
wrapper.append(new Element("p", "外层说明不应发给 Codex。"));
const nestedCard = wrapper.append(new Element("div"));
nestedCard.append(new Element("span", "给 Codex 的指令"));
nestedCard.append(new Element("button", "", {"aria-label": "复制"}));
nestedCard.append(new Element("p", "只发送真正的内层指令。"));
const nested = context.extractCardForTest(nestedMessage, /给\s*Codex\s*的指令/i, "");
assert.equal(nested.instruction, "只发送真正的内层指令。");
const hiddenCard = nestedMessage.append(new Element("div"));
hiddenCard.hidden = true;
hiddenCard.append(new Element("span", "给 Codex 的指令"));
hiddenCard.append(new Element("button", "", {"aria-label": "复制"}));
hiddenCard.append(new Element("p", "隐藏的指令副本不能算第二张。"));
assert.equal(context.extractCardForTest(nestedMessage, /给\s*Codex\s*的指令/i, "").instruction, "只发送真正的内层指令。");
hiddenCard.hidden = false;
hiddenCard.cssVisibility = "hidden";
assert.equal(context.extractCardForTest(nestedMessage, /给\s*Codex\s*的指令/i, "").instruction, "只发送真正的内层指令。");
const secondCard = nestedMessage.append(new Element("div"));
secondCard.append(new Element("span", "给 Codex 的指令"));
secondCard.append(new Element("button", "", {"aria-label": "复制"}));
secondCard.append(new Element("p", "另一条不同的真实指令。"));
const ambiguous = context.extractCardForTest(nestedMessage, /给\s*Codex\s*的指令/i, "");
assert.equal(ambiguous.choices.length, 2);
const oversizedMessage = new Element("div");
const oversizedCard = oversizedMessage.append(new Element("div"));
oversizedCard.append(new Element("span", "给 Codex 的指令"));
oversizedCard.append(new Element("button", "", {"aria-label": "复制"}));
oversizedCard.append(new Element("p", "指".repeat(20001)));
assert.match(context.extractCardForTest(oversizedMessage, /给\s*Codex\s*的指令/i, "").error, /20000/);
const reportMessage = new Element("div");
const reportBlock = reportMessage.append(new Element("div"));
reportBlock.append(new Element("button", "", {"aria-label": "复制消息"}));
reportBlock.append(new Element("p", "以下是 Codex 上一轮的最终报告。请把仅给 Codex 的指令放在标题为给 Codex 的指令的卡片中。"));
reportBlock.append(new Element("p", "Codex 最终报告：这段正文应该发给 ChatGPT。"));
assert.equal(context.extractCardForTest(reportMessage, /给\s*Codex\s*的指令/i, "").choices.length, 0);
const quotedReport = new Element("div");
const quotedBlock = quotedReport.append(new Element("div"));
quotedBlock.append(new Element("span", "给 Codex 的指令"));
quotedBlock.append(new Element("button", "", {"aria-label": "复制"}));
quotedBlock.append(new Element("p", "以下是 Codex 上一轮的最终报告。请先分析。"));
quotedBlock.append(new Element("p", "Codex 最终报告：这段正文也不能当作指令。"));
assert.equal(context.extractCardForTest(quotedReport, /给\s*Codex\s*的指令/i, "").choices.length, 0);
const users = [{innerText: "以下是 Codex 上一轮的最终报告。 完整报告正文"}];
context.document = {
  querySelector: () => null,
  querySelectorAll: selector => selector === '[data-message-author-role="user"]' ? users : []
};
assert.equal(context.reportWasSentForTest("完整报告正文", 1), false);
assert.equal(context.reportWasSentForTest("完整报告正文", 2), false);
users.push({innerText: "以下是 Codex 上一轮的最终报告。 [长消息已折叠]"});
assert.equal(context.reportWasSentForTest("完整报告正文", 1), false);
const genericTurn = new Element("article", "用户消息");
context.document.querySelectorAll = selector => {
  if (selector === '[data-message-author-role="user"]') return users;
  if (selector.includes('conversation-turn') || selector === 'article') return [genericTurn];
  return [];
};
assert.equal(context.assistantMessagesForTest().length, 0);
const repeatedReport = "完整报告正文说明了修复结果和后续检查步骤，并列出了每一项需要验证的页面行为。";
const oldMainText = `旧消息：${repeatedReport}`;
const mainForReport = {innerText: oldMainText, textContent: oldMainText};
context.document = {
  querySelector: selector => selector === "main" ? mainForReport : null,
  querySelectorAll: () => []
};
context.saveReportBaselineForTest(repeatedReport, 1);
assert.equal(context.reportWasSentForTest(repeatedReport, 1), false);
mainForReport.innerText += `\n新发送的消息：${repeatedReport}`;
assert.equal(context.reportWasSentForTest(repeatedReport, 1), true);
mainForReport.innerText = oldMainText;
context.saveReportBaselineForTest(repeatedReport, 1);
mainForReport.textContent += `\n折叠消息的 DOM 正文：${repeatedReport}`;
assert.equal(context.reportWasSentForTest(repeatedReport, 1), true);
context.document = {
  querySelector: selector => selector === "main" ? message : null,
  querySelectorAll: selector => selector === "button" ? [header.children[1]] : [],
  getElementById: () => null,
  createElement: () => ({style: {}, dataset: {}, textContent: ""}),
  body: {appendChild: () => {}}
};
(async () => {
  await context.tickForTest();
  context.forceStableForTest();
  await context.tickForTest();
  assert.equal(submitted, "");
  assert.ok(logged.some(entry => entry.event === "auto_submit_blocked" && entry.data.reason === "unscoped_main"));
  context.document.querySelectorAll = selector =>
    selector === '[data-message-author-role="assistant"]' ? [message] : [];
  await context.tickForTest();
  context.forceStableForTest();
  await context.tickForTest();
  assert.match(submitted, /继续修 Stage 5A3b/);
  bound = false;
  const beforeUnboundTick = stateRequests;
  await context.tickForTest();
  assert.equal(stateRequests, beforeUnboundTick);
  bound = true;
  const request = value => new Promise(resolve => contentMessageListener(value, null, resolve));
  const choices = await request({type: "bridgeCardChoices"});
  assert.equal(choices.data.length, 1);
  const previousSubmission = submitted;
  body.children[0].ownText = "页面变化后另一条不同的指令，不能沿用旧按钮。";
  const changed = await request({type: "bridgeChooseCard", index: 0, key: choices.data[0].key});
  assert.equal(changed.ok, false);
  assert.match(changed.error, /指令卡片已变化/);
  assert.equal(submitted, previousSubmission);
  const bar = {style: {}, dataset: {}, textContent: ""};
  context.document.getElementById = () => bar;
  contentMessageListener({type: "bridgeUiAction", text: "按钮操作已完成"}, null, () => {});
  assert.match(bar.textContent, /最近操作.*按钮操作已完成/);
  assert.match(bar.textContent, /连接检查/);
  context.stopInvalidatedForTest();
  assert.match(bar.textContent, /请刷新当前 ChatGPT 标签页/);
  console.log("Card extraction and marker-free main fallback OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
