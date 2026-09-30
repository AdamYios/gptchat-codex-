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
  closest(selector) {
    if (selector !== "[data-content-search-unit-key]") return null;
    for (let node = this; node; node = node.parentElement)
      if (node.getAttribute("data-content-search-unit-key")) return node;
    return null;
  }
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
  "  globalThis.extractCardForTest = extractCard; globalThis.reportWasSentForTest = reportWasSent; globalThis.reportTextEvidenceForTest = reportTextEvidence; globalThis.saveReportBaselineForTest = saveReportBaseline; globalThis.capturePreSendUserBaselineForTest = capturePreSendUserBaseline; globalThis.assistantMessagesForTest = assistantMessages; globalThis.userMessagesForTest = userMessages; globalThis.tickForTest = tick; globalThis.stopInvalidatedForTest = stopInvalidatedScript; globalThis.instructionIdForTest = instructionId; globalThis.statusForTest = status; globalThis.actionFeedbackForTest = actionFeedback; globalThis.statusSnapshotForTest = () => ({actionStatus, actionStatusError, actionChangedAt}); globalThis.forceStableForTest = () => { stableSince = Date.now() - 2000; };"
);
const saved = {"bridge.attemptedReport": "1", "bridge.preSendUserCount": "1", "bridge.preSendUserText": "以下是 Codex 上一轮的最终报告。 完整报告正文"};
let submitted = "";
let runId = "";
let bridgePhase = "await_instruction";
let bridgeReport = "";
let failNextInstructionAfterAccept = false;
let pendingWasWrittenBeforeRequest = false;
const instructionRequests = [];
const logged = [];
let bound = true;
let stateRequests = 0;
let contentMessageListener;
const context = {location: {pathname: "/c/test"}, sessionStorage: {
  getItem: key => saved[key] || null,
  setItem: (key, value) => { saved[key] = value; },
  removeItem: key => { delete saved[key]; }
},
  getComputedStyle: node => ({display: node.cssDisplay || "block",
    visibility: node.cssVisibility || "visible", contentVisibility: "visible"}),
  chrome: {
    runtime: {onMessage: {addListener: callback => { contentMessageListener = callback; }}, sendMessage: async message => {
      if (message.type === "bridgeLog") { logged.push(message); return {ok: true}; }
      if (message.type === "bridgeGetConfig") return {ok: true, bound, title: "给\\s*Codex\\s*的指令", card: ""};
      if (message.type === "bridgeIsBound") return {ok: true, bound};
      if (message.path === "/state") {
        stateRequests += 1;
        return {ok: true, data: {runId, phase: bridgePhase, round: 0, report: bridgeReport,
          reportId: 1}};
      }
      if (message.path === "/instruction") {
        instructionRequests.push({...message.body});
        submitted = message.body.instruction;
        if (failNextInstructionAfterAccept) {
          failNextInstructionAfterAccept = false;
          pendingWasWrittenBeforeRequest = JSON.parse(saved["bridge.instructionStates"] || "[]")
            .some(([id, state]) => id === message.body.instructionId && state === "pending");
          throw new Error("simulated lost response after server acceptance");
        }
        return {ok: true, data: {}};
      }
      return {ok: true, data: {}};
    }}
  }, console};
vm.runInNewContext(source, context, {filename: file});

const statusBar = {style: {}, dataset: {}, textContent: ""};
context.document = {getElementById: id => id === "codex-bridge-status" ? statusBar : null};
context.statusForTest("已自动识别并发送最新的未处理指令卡片");
assert.equal(context.statusSnapshotForTest().actionStatus, "已自动识别并发送最新的未处理指令卡片",
  "automatic bridge status transitions should appear in the recent-activity row");
assert.match(statusBar.textContent, /最近操作.*已自动识别并发送/);
context.actionFeedbackForTest("手动查看卡片");
const manualActionChangedAt = context.statusSnapshotForTest().actionChangedAt;
context.statusForTest("已自动识别并发送最新的未处理指令卡片");
assert.equal(context.statusSnapshotForTest().actionStatus, "手动查看卡片",
  "repeated polling of an unchanged status should not erase a newer manual action");
assert.equal(context.statusSnapshotForTest().actionChangedAt, manualActionChangedAt);
context.statusForTest("报告已发往 ChatGPT，等待下一轮");
assert.equal(context.statusSnapshotForTest().actionStatus, "报告已发往 ChatGPT，等待下一轮",
  "the next automatic status transition should become the recent activity");

const message = new Element("div", "", {"data-content-search-unit-key": "thread:latest:assistant"});
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
const currentAssistantUnit = new Element("div", "当前助手消息", {"data-content-search-unit-key": "thread:assistant"});
const legacyAssistantMessage = new Element("div", "旧标记助手消息", {"data-message-author-role": "assistant"});
const currentUserUnit = new Element("div", "当前用户消息", {"data-content-search-unit-key": "thread:user"});
const legacyUserMessage = new Element("div", "旧标记用户消息", {"data-message-author-role": "user"});
context.document.querySelectorAll = selector => {
  if (selector === '[data-content-search-unit-key$=":assistant"]') return [currentAssistantUnit];
  if (selector === '[data-content-search-unit-key$=":user"]') return [currentUserUnit];
  if (selector === '[data-message-author-role="assistant"]') return [legacyAssistantMessage];
  if (selector === '[data-message-author-role="user"]') return [legacyUserMessage];
  return [];
};
assert.equal(context.assistantMessagesForTest()[0], currentAssistantUnit);
assert.equal(context.userMessagesForTest()[0], currentUserUnit);
context.document.querySelectorAll = selector => {
  if (selector === '[data-message-author-role="assistant"]') return [legacyAssistantMessage];
  if (selector === '[data-message-author-role="user"]') return [legacyUserMessage];
  return [];
};
assert.equal(context.assistantMessagesForTest()[0], legacyAssistantMessage);
assert.equal(context.userMessagesForTest()[0], legacyUserMessage);
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
assert.ok(context.reportTextEvidenceForTest(repeatedReport, 1).visibleDelta > 0,
  "visible-text changes remain available as diagnostics");
assert.equal(context.reportWasSentForTest(repeatedReport, 1), false,
  "DOM text deltas alone no longer decide that a report was sent");
mainForReport.innerText = oldMainText;
context.saveReportBaselineForTest(repeatedReport, 1);
mainForReport.textContent += `\n折叠消息的 DOM 正文：${repeatedReport}`;
assert.ok(context.reportTextEvidenceForTest(repeatedReport, 1).domDelta > 0,
  "DOM text changes remain available as diagnostics");
assert.equal(context.reportWasSentForTest(repeatedReport, 1), false);

const priorUserUnit = new Element("div", "发送前已有的用户消息", {
  "data-content-search-unit-key": "thread:before:user"
});
const nextUserUnit = new Element("div", "新的用户消息，但不含可见报告正文", {
  "data-content-search-unit-key": "thread:after:user"
});
let currentUserUnits = [priorUserUnit];
const emptyComposer = {innerText: "", textContent: ""};
mainForReport.innerText = oldMainText;
mainForReport.textContent = oldMainText;
context.document = {
  querySelector: selector => selector === "main" ? mainForReport :
    selector.includes("contenteditable") ? emptyComposer : null,
  querySelectorAll: selector => selector === '[data-content-search-unit-key$=":user"]'
    ? currentUserUnits : []
};
context.saveReportBaselineForTest(repeatedReport, 1);
context.capturePreSendUserBaselineForTest(1);
assert.equal(context.userMessagesForTest().length, 1);
currentUserUnits = [nextUserUnit];
assert.equal(context.userMessagesForTest().length, 1,
  "the optimizer may hide the old node so the total mounted message count stays unchanged");
const noTextDelta = context.reportTextEvidenceForTest(repeatedReport, 1);
assert.equal(noTextDelta.baselineAvailable, true);
assert.equal(noTextDelta.visibleDelta, 0);
assert.equal(noTextDelta.domDelta, 0);
assert.equal(context.reportWasSentForTest(repeatedReport, 1), true,
  "a new user turn key confirms delivery even when counts and text deltas do not change");
context.document = {
  querySelector: selector => selector === "main" ? message : null,
  querySelectorAll: selector => {
    if (selector === '[data-content-search-unit-key$=":assistant"]') return [message];
    if (selector === "[data-content-search-unit-key]") return [message];
    return selector === "button" ? [header.children[1]] : [];
  },
  getElementById: () => null,
  createElement: () => ({style: {}, dataset: {}, textContent: ""}),
  body: {appendChild: () => {}}
};
(async () => {
  await context.tickForTest();
  context.forceStableForTest();
  await context.tickForTest();
  assert.match(submitted, /继续修 Stage 5A3b/);
  assert.ok(logged.some(entry => entry.event === "card_submit"));
  context.document.querySelectorAll = selector =>
    selector === '[data-message-author-role="assistant"]' ? [message] : [];
  await context.tickForTest();
  context.forceStableForTest();
  await context.tickForTest();
  assert.match(submitted, /继续修 Stage 5A3b/);
  assert.equal(logged.filter(entry => entry.event === "card_submit").length, 1);
  const outOfUnitMain = new Element("main");
  const staleUnit = outOfUnitMain.append(new Element("div", "", {"data-content-search-unit-key": "opaque:older"}));
  const latestUnit = outOfUnitMain.append(new Element("div", "", {"data-content-search-unit-key": "opaque:latest"}));
  const addStrictCard = (unit, instruction) => {
    const card = unit.append(new Element("div"));
    card.append(new Element("span", "给 Codex 的指令"));
    card.append(new Element("button", "", {"aria-label": "复制"}));
    card.append(new Element("p", instruction));
  };
  addStrictCard(staleUnit, "旧单元中的卡片不应该参与自动扫描。");
  addStrictCard(latestUnit, "无角色标记时只扫描最新可见单元里的卡片。");
  context.document = {
    querySelector: selector => selector === "main" ? outOfUnitMain : null,
    querySelectorAll: selector => selector === "[data-content-search-unit-key]" ? [staleUnit, latestUnit] : [],
    getElementById: () => null,
    createElement: () => ({style: {}, dataset: {}, textContent: ""}),
    body: {appendChild: () => {}}
  };
  const beforeUnitFallback = submitted;
  await context.tickForTest();
  context.forceStableForTest();
  await context.tickForTest();
  assert.notEqual(submitted, beforeUnitFallback);
  assert.match(submitted, /只扫描最新可见单元/);
  assert.doesNotMatch(submitted, /旧单元/);
  bound = false;
  const beforeUnboundTick = stateRequests;
  await context.tickForTest();
  assert.equal(stateRequests, beforeUnboundTick);
  bound = true;
  context.document = {
    querySelector: selector => selector === "main" ? message : null,
    querySelectorAll: selector => {
      if (selector === '[data-content-search-unit-key$=":assistant"]') return [message];
      if (selector === "[data-content-search-unit-key]") return [message];
      return selector === "button" ? message.querySelectorAll("button") : [];
    },
    getElementById: () => null,
    createElement: () => ({style: {}, dataset: {}, textContent: ""}),
    body: {appendChild: () => {}}
  };
  body.children[0].ownText = "当前尚未处理的新指令卡片。";
  const request = value => new Promise(resolve => contentMessageListener(value, null, resolve));
  const choices = await request({type: "bridgeCardChoices"});
  assert.equal(choices.data.length, 1);
  const previousSubmission = submitted;
  body.children[0].ownText = "页面变化后另一条不同的指令，不能沿用旧按钮。";
  const changed = await request({type: "bridgeChooseCard", index: 0, key: choices.data[0].key});
  assert.equal(changed.ok, false);
  assert.match(changed.error, /指令卡片已变化/);
  assert.equal(submitted, previousSubmission);

  // With missing role markers, manual viewing searches the latest visible
  // content-search unit instead of the whole conversation in MAIN.
  const markerlessMain = new Element("main");
  const addLooseCard = (unit, bodyText) => {
    const response = unit.append(new Element("div"));
    response.append(new Element("p", "这段对话背景不能混进发送给 Codex 的候选内容。"));
    const block = response.append(new Element("div"));
    block.append(new Element("span", "Codex 指令卡"));
    block.append(new Element("p", bodyText));
    response.append(new Element("button", "", {"aria-label": "复制"}));
  };
  const oldUnit = markerlessMain.append(new Element("div", "", {"data-content-search-unit-key": "opaque:older-unit"}));
  const latestManualUnit = markerlessMain.append(new Element("div", "", {"data-content-search-unit-key": "opaque:latest-unit"}));
  addLooseCard(oldUnit, "这是已经处理过的旧任务指令内容，不应该继续显示给当前任务。");
  addLooseCard(latestManualUnit, "这是最新对话里的待确认指令内容，查看卡片时应该能看到它。");
  context.document = {
    querySelector: selector => selector === "main" ? markerlessMain : null,
    querySelectorAll: selector => selector === "[data-content-search-unit-key]"
      ? [oldUnit, latestManualUnit]
      : selector === "button" ? markerlessMain.querySelectorAll("button") : [],
    getElementById: () => null,
    createElement: () => ({style: {}, dataset: {}, textContent: ""}),
    body: {appendChild: () => {}}
  };
  const markerlessChoices = await request({type: "bridgeCardChoices"});
  assert.equal(markerlessChoices.ok, true);
  assert.equal(markerlessChoices.data.length, 1);
  assert.equal(markerlessChoices.data[0].relaxed, true);
  assert.equal(markerlessChoices.data[0].latestOnly, true);
  assert.match(markerlessChoices.data[0].preview, /最新对话里的待确认指令/);
  assert.doesNotMatch(markerlessChoices.data[0].preview, /对话背景/);
  assert.doesNotMatch(markerlessChoices.data[0].preview, /已经处理过的旧任务/);
  const viewLog = logged.filter(entry => entry.event === "card_choices_viewed").at(-1);
  assert.equal(viewLog.data.method, "content_search_unit_manual_loose");
  assert.equal(viewLog.data.strictChoiceCount, 0);
  assert.equal(viewLog.data.manualCandidateCount, 1);
  assert.equal(viewLog.data.relaxedChoiceCount, 1);
  assert.equal(viewLog.data.latestOnly, true);
  const manuallyChosen = await request({type: "bridgeChooseCard", index: 0, key: markerlessChoices.data[0].key});
  assert.equal(manuallyChosen.ok, true);
  assert.match(submitted, /最新对话里的待确认指令/);
  assert.equal(instructionRequests.at(-1).instructionId, markerlessChoices.data[0].key,
    "manual instruction submission sends the same stable ID used by the choice");

  // An unmarked response with only a generic message Copy control is not a
  // card-shaped candidate; do not promote the whole response as a fallback.
  const unmarkedResponse = new Element("div");
  unmarkedResponse.append(new Element("p", "没有卡片标题的长回复正文，不能作为整条消息发给 Codex。"));
  unmarkedResponse.append(new Element("button", "", {"aria-label": "复制"}));
  const unmarkedUnit = new Element("div", "", {"data-content-search-unit-key": "opaque:unmarked"}).append(unmarkedResponse);
  const unmarkedMain = new Element("main").append(unmarkedUnit);
  context.document.querySelector = selector => selector === "main" ? unmarkedMain : null;
  context.document.querySelectorAll = selector => selector === "[data-content-search-unit-key]"
    ? [unmarkedUnit]
    : selector === "button" ? unmarkedMain.querySelectorAll("button") : [];
  const unmarkedChoices = await request({type: "bridgeCardChoices"});
  assert.deepEqual(Array.from(unmarkedChoices.data), []);
  const codeResponse = new Element("div");
  codeResponse.append(new Element("p", "回复里的普通说明不能一起发送。"));
  codeResponse.append(new Element("pre", "只发送这个代码块里的候选指令正文。"));
  codeResponse.append(new Element("button", "", {"aria-label": "复制代码"}));
  const codeUnit = new Element("div", "", {"data-content-search-unit-key": "opaque:code"}).append(codeResponse);
  const codeMain = new Element("main").append(codeUnit);
  context.document.querySelector = selector => selector === "main" ? codeMain : null;
  context.document.querySelectorAll = selector => selector === "[data-content-search-unit-key]"
    ? [codeUnit]
    : selector === "button" ? codeMain.querySelectorAll("button") : [];
  const codeChoices = await request({type: "bridgeCardChoices"});
  assert.equal(codeChoices.data.length, 1);
  assert.match(codeChoices.data[0].preview, /只发送这个代码块/);
  assert.doesNotMatch(codeChoices.data[0].preview, /普通说明/);

  const makeStrictMessage = (unitKey, instruction, analysis = "") => {
    const root = new Element("div", "", {"data-content-search-unit-key": unitKey});
    if (analysis) root.append(new Element("p", analysis));
    const card = root.append(new Element("div"));
    card.append(new Element("span", "给 Codex 的指令"));
    card.append(new Element("button", "", {"aria-label": "复制"}));
    card.append(new Element("p", instruction));
    return root;
  };
  const showAssistant = root => {
    context.document.querySelector = selector => selector === "main" ? root : null;
    context.document.querySelectorAll = selector => {
      if (selector === '[data-content-search-unit-key$=":assistant"]') return [root];
      if (selector === "[data-content-search-unit-key]") return [root];
      if (selector === '[data-message-author-role="assistant"]') return [];
      return [];
    };
  };

  const stableBody = "重启桥接后，这张旧卡片不能再次投递。";
  const stableTurn = makeStrictMessage("thread:stable-turn:assistant", stableBody, "初始分析");
  const stableId = context.instructionIdForTest(stableBody, stableTurn);
  const remountedStableTurn = makeStrictMessage("thread:stable-turn:assistant", `  ${stableBody}  `, "重挂后的分析");
  assert.equal(context.instructionIdForTest(stableBody, stableTurn),
    context.instructionIdForTest(stableBody, remountedStableTurn), "same turn and body yield the same ID after remount");
  const nextTurn = makeStrictMessage("thread:next-turn:assistant", stableBody, "下一轮分析");
  assert.notEqual(context.instructionIdForTest(stableBody, stableTurn),
    context.instructionIdForTest(stableBody, nextTurn), "the same body in a new turn gets a new ID");
  const noKey = new Element("div");
  assert.equal(context.instructionIdForTest(stableBody, noKey), context.instructionIdForTest(stableBody, new Element("div")),
    "without a content-unit key, the existing body hash is the fallback ID");
  const originalPathId = context.instructionIdForTest(stableBody, stableTurn);
  context.location.pathname = "/c/another-conversation";
  assert.notEqual(context.instructionIdForTest(stableBody, stableTurn), originalPathId,
    "conversation pathname scopes keyed IDs");
  context.location.pathname = "/c/test";

  showAssistant(stableTurn);
  await context.tickForTest();
  context.forceStableForTest();
  await context.tickForTest();
  assert.equal(instructionRequests.at(-1).instruction, stableBody);
  assert.equal(instructionRequests.at(-1).instructionId, stableId);
  assert.equal(JSON.parse(saved["bridge.instructionStates"]).find(entry => entry[0] === stableId)[1], "seen");

  const afterFirstStableSend = instructionRequests.length;
  runId = "new-bridge-run";
  await context.tickForTest();
  context.forceStableForTest();
  await context.tickForTest();
  assert.equal(instructionRequests.length, afterFirstStableSend,
    "runId changes do not clear the seen instruction ID");

  showAssistant(remountedStableTurn);
  await context.tickForTest();
  context.forceStableForTest();
  await context.tickForTest();
  assert.equal(instructionRequests.length, afterFirstStableSend,
    "a remounted DOM node with the same unit key does not resend");

  showAssistant(nextTurn);
  await context.tickForTest();
  context.forceStableForTest();
  await context.tickForTest();
  assert.equal(instructionRequests.length, afterFirstStableSend + 1,
    "the same instruction text on a new turn is allowed");
  assert.notEqual(instructionRequests.at(-1).instructionId, stableId);

  const uncertainBody = "服务器可能已接受，但客户端丢失响应时不要自动重试。";
  const uncertainTurn = makeStrictMessage("thread:uncertain-turn:assistant", uncertainBody);
  const uncertainId = context.instructionIdForTest(uncertainBody, uncertainTurn);
  showAssistant(uncertainTurn);
  failNextInstructionAfterAccept = true;
  await context.tickForTest();
  context.forceStableForTest();
  await context.tickForTest();
  const afterUncertainAttempt = instructionRequests.length;
  assert.equal(instructionRequests.at(-1).instructionId, uncertainId);
  assert.equal(pendingWasWrittenBeforeRequest, true, "pending is durable before the network request starts");
  assert.equal(JSON.parse(saved["bridge.instructionStates"]).find(entry => entry[0] === uncertainId)[1], "pending");
  context.forceStableForTest();
  await context.tickForTest();
  assert.equal(instructionRequests.length, afterUncertainAttempt,
    "an uncertain pending instruction is not automatically resent");

  const afterReloadRequests = [];
  runId = "post-reload-run";
  const reloadedContext = {
    location: {pathname: "/c/test"},
    sessionStorage: {
      getItem: key => saved[key] || null,
      setItem: (key, value) => { saved[key] = value; },
      removeItem: key => { delete saved[key]; }
    },
    getComputedStyle: node => ({display: node.cssDisplay || "block",
      visibility: node.cssVisibility || "visible", contentVisibility: "visible"}),
    chrome: {runtime: {
      onMessage: {addListener() {}},
      sendMessage: async message => {
        if (message.type === "bridgeLog") return {ok: true};
        if (message.type === "bridgeGetConfig") return {ok: true, bound: true,
          title: "给\\s*Codex\\s*的指令", card: ""};
        if (message.path === "/state") return {ok: true,
          data: {runId, phase: "await_instruction", round: 0}};
        if (message.path === "/instruction") {
          afterReloadRequests.push({...message.body});
          return {ok: true, data: {}};
        }
        return {ok: true, data: {}};
      }
    }},
    console
  };
  vm.runInNewContext(source, reloadedContext, {filename: `${file}:reloaded`});
  showAssistant(uncertainTurn);
  reloadedContext.document = context.document;
  await reloadedContext.tickForTest();
  reloadedContext.forceStableForTest();
  await reloadedContext.tickForTest();
  assert.equal(afterReloadRequests.length, 0,
    "pending instruction IDs survive content-script reload and stay blocked");

  const stoppedBody = "流程结束期间的卡片不应生成去重状态，新流程开始后再发送。";
  const stoppedTurn = makeStrictMessage("thread:stopped-turn:assistant", stoppedBody);
  const stoppedId = context.instructionIdForTest(stoppedBody, stoppedTurn);
  showAssistant(stoppedTurn);
  bridgePhase = "stopped";
  const beforeStoppedRequests = instructionRequests.length;
  await context.tickForTest();
  context.forceStableForTest();
  await context.tickForTest();
  assert.equal(instructionRequests.length, beforeStoppedRequests,
    "a stopped flow does not post newly visible instructions");
  assert.equal(JSON.parse(saved["bridge.instructionStates"] || "[]").some(([id]) => id === stoppedId), false,
    "a card observed after flow end is not marked seen or pending");

  bridgePhase = "await_instruction";
  await context.tickForTest();
  context.forceStableForTest();
  await context.tickForTest();
  assert.equal(instructionRequests.length, beforeStoppedRequests + 1,
    "the card can be sent after a new flow starts");
  assert.equal(Object.hasOwn(instructionRequests.at(-1), "automatic"), false,
    "instruction requests no longer carry the removed automatic/pause mode");

  bridgePhase = "report_ready";
  bridgeReport = "结束流程后生成的 Codex 报告不应回传。";
  bridgePhase = "stopped";
  const composerErrorsBeforeStop = logged.filter(entry => entry.event === "composer_missing").length;
  await context.tickForTest();
  assert.equal(logged.filter(entry => entry.event === "composer_missing").length, composerErrorsBeforeStop,
    "a stopped flow does not invoke automatic sendReport for its later report");
  bridgePhase = "await_instruction";
  bridgeReport = "";

  const bar = {style: {}, dataset: {}, textContent: ""};
  context.document.getElementById = () => bar;
  contentMessageListener({type: "bridgeUiAction", text: "按钮操作已完成"}, null, () => {});
  assert.match(bar.textContent, /最近操作.*按钮操作已完成/);
  assert.match(bar.textContent, /连接检查/);
  context.stopInvalidatedForTest();
  assert.match(bar.textContent, /请刷新当前 ChatGPT 标签页/);

  let fakeNow = 100000;
  class FastDate extends Date { static now() { return fakeNow; } }
  const reportLog = [];
  const reportSession = {"bridge.runId": "report-run"};
  let reportPhase = "report_ready";
  let reportEditorText = "";
  let reportSendButtonAvailable = false;
  let reportAckCount = 0;
  let reportGenerating = false;
  const reportMain = {innerText: "对话已有内容", textContent: "对话已有内容"};
  const reportUserBefore = new Element("div", "之前的用户消息", {
    "data-content-search-unit-key": "report:before:user"
  });
  const reportUserAfter = new Element("div", "新用户消息", {
    "data-content-search-unit-key": "report:after:user"
  });
  const reportAssistantBefore = new Element("div", "之前的助手消息", {
    "data-content-search-unit-key": "report:before:assistant"
  });
  let reportAssistantUnits = [reportAssistantBefore];
  let reportUserUnits = [reportUserBefore];
  const reportInstructionRequests = [];
  const reportButton = {
    disabled: false,
    type: "button",
    matches: () => true,
    getAttribute: () => null,
    click() {
      reportEditorText = "";
      reportGenerating = true;
    }
  };
  const reportForm = {querySelectorAll: () => reportSendButtonAvailable ? [reportButton] : []};
  const reportEditor = {
    get innerText() { return reportEditorText; },
    get textContent() { return reportEditorText; },
    focus() {},
    dispatchEvent() {},
    closest: () => reportForm
  };
  const reportStatusBar = {style: {}, dataset: {}, textContent: ""};
  let reportMessageListener;
  let reportObserver;
  class ReportMutationObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; reportObserver = this; }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
    emit(target) { this.callback([{target, addedNodes: []}]); }
  }
  const reportContext = {
    Date: FastDate,
    MutationObserver: ReportMutationObserver,
    setTimeout: callback => { fakeNow += 250; callback(); return 1; },
    InputEvent: class InputEvent {},
    location: {pathname: "/c/report"},
    sessionStorage: {
      getItem: key => reportSession[key] || null,
      setItem: (key, value) => { reportSession[key] = value; },
      removeItem: key => { delete reportSession[key]; }
    },
    getComputedStyle: () => ({display: "block", visibility: "visible", contentVisibility: "visible"}),
    chrome: {runtime: {
      onMessage: {addListener(callback) { reportMessageListener = callback; }},
      sendMessage: async request => {
        if (request.type === "bridgeLog") { reportLog.push(request); return {ok: true}; }
        if (request.type === "bridgeGetConfig") return {ok: true, bound: true, title: "", card: ""};
        if (request.type === "bridgeRequest" && request.path === "/state")
          return {ok: true, data: {runId: "report-run", phase: reportPhase, round: 0,
            report: repeatedReport, reportId: 1}};
        if (request.type === "bridgeRequest" && request.path === "/ack") {
          reportAckCount += 1;
          reportPhase = "await_instruction";
          return {ok: true, data: {}};
        }
        if (request.type === "bridgeRequest" && request.path === "/instruction") {
          reportInstructionRequests.push(request.body);
          return {ok: true, data: {}};
        }
        return {ok: true, data: {}};
      }
    }},
    document: {
      visibilityState: "visible",
      querySelector: selector => selector === "main" ? reportMain :
        selector === '#prompt-textarea[contenteditable="true"]' ? reportEditor : null,
      querySelectorAll: selector => {
        if (selector === '[data-content-search-unit-key$=":assistant"]') return reportAssistantUnits;
        if (selector === '[data-content-search-unit-key$=":user"]') return reportUserUnits;
        if (selector.includes('data-testid="stop-button"'))
          return reportGenerating ? [{getAttribute: () => null}] : [];
        return [];
      },
      getElementById: id => id === "codex-bridge-status" ? reportStatusBar : null,
      createElement: () => reportStatusBar,
      body: {appendChild() {}},
      execCommand: (_command, _ui, text) => { reportEditorText = text; return true; }
    },
    console
  };
  vm.runInNewContext(source, reportContext, {filename: `${file}:report-send`});
  const wakeForReport = () => new Promise(resolve => {
    const keepChannelOpen = reportMessageListener({type: "bridgeReportReady", reportId: 1}, null, resolve);
    assert.equal(keepChannelOpen, true, "report-ready notification waits for the page-side wake tick");
  });
  assert.equal((await wakeForReport()).ok, true);
  assert.ok(reportLog.some(entry => entry.event === "content_wake_received" &&
    entry.data.reportId === 1), "content logs the received wake with its report ID");
  assert.ok(reportLog.some(entry => entry.event === "report_send_started" &&
    entry.data.reportId === 1), "content logs when automatic report sending begins");
  assert.match(reportEditorText, /Codex 最终报告：/,
    "an event wake sends the report without waiting for the content-script interval");
  assert.equal(reportLog.some(entry => entry.event === "send_button_unavailable"), true);
  assert.equal(reportLog.some(entry => entry.event === "tick_error"), false,
    "a temporarily missing send button is retried without becoming a tick error");
  reportSendButtonAvailable = true;
  assert.equal((await wakeForReport()).ok, true);
  assert.equal(reportAckCount, 0,
    "an empty composer and started generation do not confirm delivery without a new user message");
  assert.equal(reportPhase, "report_ready",
    "unconfirmed sends leave the bridge report pending");
  const unconfirmed = reportLog.find(entry => entry.event === "report_unconfirmed");
  assert.equal(unconfirmed.data.composerEmpty, true);
  assert.equal(unconfirmed.data.generationStarted, true,
    "the formerly permissive signals remain diagnostic but cannot acknowledge the report");
  reportUserUnits = [reportUserAfter];
  assert.equal((await wakeForReport()).ok, true);
  assert.equal(reportAckCount, 1,
    "a new user message unit key confirms delivery and allows the bridge acknowledgement");
  assert.ok(reportLog.some(entry => entry.event === "report_acknowledged" && entry.data.reportId === 1),
    "the assistant-wait diagnostics start only after the bridge acknowledges the report");
  const waitStarted = reportLog.find(entry => entry.event === "assistant_wait_started");
  assert.equal(waitStarted.data.method, "setInterval");
  assert.equal(waitStarted.data.tickIntervalMs, 2000);
  assert.equal(waitStarted.data.rafUsed, false);
  assert.equal(waitStarted.data.setTimeoutUsed, false,
    "the stability wait itself does not use setTimeout");
  assert.equal(waitStarted.data.waitForUsesSetTimeout, true,
    "other send confirmation waits still use setTimeout");
  assert.equal(waitStarted.data.visibilityUsed, false);
  assert.equal(waitStarted.data.mutationObserverUsed, false);
  assert.equal(reportLog.find(entry => entry.event === "assistant_wait_observer_started")
    .data.diagnosticObserverStarted, true,
  "a separate observer records DOM appearance without driving the automatic flow");
  assert.ok(reportLog.some(entry => entry.event === "report_unconfirmed"),
    "the failed early confirmation remains recorded for diagnosis");
  assert.equal((await wakeForReport()).ok, true);
  assert.equal(reportAckCount, 1, "a stale repeated wake after acknowledgement does not resend the report");
  assert.equal(reportLog.filter(entry => entry.event === "send_click").length, 1);

  reportGenerating = true;
  const reportAssistantAfter = new Element("div", "ChatGPT 回复正在生成", {
    "data-content-search-unit-key": "report:after:assistant"
  });
  reportAssistantUnits = [reportAssistantBefore, reportAssistantAfter];
  reportContext.document.visibilityState = "hidden";
  reportObserver.emit(reportAssistantAfter);
  await reportContext.tickForTest();
  assert.ok(reportLog.some(entry => entry.event === "assistant_wait_observer_fired"),
    "the diagnostic observer logs when ChatGPT mutates an assistant turn");
  assert.ok(reportLog.some(entry => entry.event === "assistant_turn_detected" &&
    entry.data.isGenerating === true), "a new assistant turn is logged while the stop button is present");
  assert.equal(reportLog.some(entry => entry.event === "assistant_reply_completed"), false,
    "a detected turn is not logged complete while ChatGPT is still generating");

  fakeNow += 62000;
  reportGenerating = false;
  const diagnosticCard = reportAssistantAfter.append(new Element("div"));
  const diagnosticHeader = diagnosticCard.append(new Element("div"));
  diagnosticHeader.append(new Element("span", "给 Codex 的指令"));
  diagnosticHeader.append(new Element("button", "", {"aria-label": "复制"}));
  const diagnosticBody = diagnosticCard.append(new Element("div"));
  diagnosticBody.append(new Element("p", "诊断后继续检查卡片等待阶段。"));
  reportObserver.emit(diagnosticCard);
  await reportContext.tickForTest();
  assert.equal(reportLog.find(entry => entry.event === "assistant_reply_completed").data.visibilityState, "hidden");
  const firstCardSeen = reportLog.find(entry => entry.event === "card_dom_first_seen");
  assert.equal(firstCardSeen.data.method, "mutation_observer",
    "the observer records when the complete card first exists in the DOM");
  assert.equal(firstCardSeen.data.visibilityState, "hidden");
  assert.ok(reportLog.some(entry => entry.event === "page_stability_wait_started"),
    "the signature change starts the existing stability wait");
  const delayedTick = reportLog.filter(entry => entry.event === "assistant_wait_tick").at(-1);
  assert.equal(delayedTick.data.tickGapMs, 62000,
    "the diagnostic records a long gap between ticks while the tab is hidden");
  assert.equal(delayedTick.data.visibilityState, "hidden");

  fakeNow += 500;
  await reportContext.tickForTest();
  assert.equal(reportInstructionRequests.length, 0,
    "the card is not submitted before the existing 1.8 second stability threshold");
  fakeNow += 1500;
  await reportContext.tickForTest();
  assert.ok(reportLog.some(entry => entry.event === "page_stability_wait_ended"),
    "the end of the stability wait is recorded");
  assert.ok(reportLog.some(entry => entry.event === "card_scan" && entry.data.reportId === 1),
    "the normal card scan is timestamped after the stability wait");
  assert.ok(reportLog.some(entry => entry.event === "instruction_submit" && entry.data.reportId === 1),
    "automatic instruction submission has a distinct pre-request log event");
  assert.equal(reportInstructionRequests.length, 1);
  console.log("Card extraction and content-search-unit fallback OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
