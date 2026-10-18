const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "extension/content.js"), "utf8")
  .replace('  void startAutomaticLoop("script_started");',
    `  globalThis.schedulerTest = {tick, record, startAutomaticLoop, stopAutomaticLoop,
      beginWait() {
        assistantWaitDiagnostic = {active: true, reportId: 1, startedAt: Date.now(),
          baselineCount: 0, baselineSignature: "before", baselineContentSignature: "before",
          turnDetected: true, replyCompleted: true, cardTitle: DEFAULT_TITLE.source,
          lastContentChangeAt: Date.now()};
        startAssistantWaitObserver(assistantWaitDiagnostic);
      }};`);

function fixture() {
  let now = 100000;
  let nextTimer = 0;
  let listener;
  let storageListener;
  let holdConfig = null;
  let holdState = null;
  let documentQueries = 0;
  let cardParses = 0;
  let generating = false;
  const timers = new Map();
  const intervals = new Map();
  const observers = [];
  const requests = [];
  const logs = [];
  const session = new Map();
  const config = {ok: true, bound: true, title: "", card: ""};
  const state = {runId: "scheduler-run", phase: "await_instruction", reportId: 0, round: 0, report: ""};

  class Element {
    constructor(tag, text = "", attributes = {}) {
      this.nodeType = 1;
      this.tagName = tag.toUpperCase();
      this.text = text;
      this.attributes = attributes;
      this.children = [];
      this.parentElement = null;
    }
    append(child) { child.parentElement = this; this.children.push(child); return child; }
    get innerText() { return [this.text, ...this.children.map(child => child.innerText)].join("\n").trim(); }
    get textContent() { return this.innerText; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    getClientRects() { return [{}]; }
    contains(node) {
      for (let current = node; current; current = current.parentElement) if (current === this) return true;
      return false;
    }
    matches(selectors) {
      return selectors.split(",").some(selector => {
        selector = selector.trim();
        const attribute = selector.match(/^\[([^\]$=*]+)(?:(\$=|=|\*=)["']([^"']*)["'])?\]$/);
        if (attribute) {
          const value = this.getAttribute(attribute[1]);
          if (value === null) return false;
          return !attribute[2] || (attribute[2] === "$=" ? value.endsWith(attribute[3]) :
            attribute[2] === "*=" ? value.includes(attribute[3]) : value === attribute[3]);
        }
        return selector === this.tagName.toLowerCase();
      });
    }
    closest(selector) {
      for (let current = this; current; current = current.parentElement)
        if (current.matches(selector)) return current;
      return null;
    }
    querySelectorAll(selector) {
      if (this.getAttribute("data-content-search-unit-key")?.endsWith(":assistant") && selector === "button")
        cardParses += 1;
      const result = [];
      const visit = node => {
        for (const child of node.children) {
          if (child.matches(selector)) result.push(child);
          visit(child);
        }
      };
      visit(this);
      return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }

  const body = new Element("body");
  const stopButton = new Element("button", "", {"data-testid": "stop-button"});
  const message = body.append(new Element("div", "这是没有指令卡片的助手回复。", {
    "data-content-search-unit-key": "one:assistant", "data-message-author-role": "assistant"
  }));
  const bar = {style: {}, dataset: {}, textContent: ""};
  const context = {
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    performance: {now: () => now},
    location: {pathname: "/c/scheduler"},
    sessionStorage: {getItem: key => session.get(key) || null,
      setItem: (key, value) => session.set(key, value), removeItem: key => session.delete(key)},
    document: {body, visibilityState: "visible", addEventListener() {},
      getElementById: () => bar,
      querySelector: selector => { documentQueries += 1; return selector === "main" ? body : null; },
      querySelectorAll: selector => {
        documentQueries += 1;
        if (selector.includes('data-testid="stop-button"')) return generating ? [stopButton] : [];
        return body.querySelectorAll(selector);
      }},
    getComputedStyle: () => ({display: "block", visibility: "visible", contentVisibility: "visible"}),
    setInterval: callback => { const id = ++nextTimer; intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, {callback, at: now + delay}); return id; },
    clearTimeout: id => timers.delete(id),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
      observe(target, options) { this.target = target; this.options = options; }
      disconnect() { this.disconnected = true; }
    },
    chrome: {
      storage: {onChanged: {addListener: callback => { storageListener = callback; }}},
      runtime: {
        onMessage: {addListener: callback => { listener = callback; }},
        sendMessage: async request => {
          if (request.type === "bridgeGetConfig") return holdConfig ? await holdConfig : {...config};
          if (request.type === "bridgeLog") { logs.push(request); return {ok: true}; }
          if (request.type === "bridgeRequest") {
            requests.push(request);
            if (request.path === "/state" && holdState) return await holdState;
            if (request.path === "/instruction") state.phase = "codex_running";
            return {ok: true, data: {...state}};
          }
          return {ok: true};
        }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const api = context.schedulerTest;
  const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
  const advance = async ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) {
      timers.delete(id); timer.callback();
    }
    await settle();
  };
  const emit = mutation => {
    for (const observer of [...observers]) {
      if (observer.disconnected) continue;
      if (observer.target !== mutation.target && !observer.target.contains(mutation.target)) continue;
      if (mutation.type === "attributes" && !observer.options.attributeFilter?.includes(mutation.attributeName)) continue;
      observer.callback([mutation]);
    }
  };
  const addCard = (root = message, hidden = false, title = "给 Codex 的指令") => {
    const card = root.append(new Element("div", "", hidden ? {"aria-hidden": "true"} : {}));
    const header = card.append(new Element("div"));
    header.append(new Element("span", title));
    header.append(new Element("button", "", {"aria-label": "复制"}));
    card.append(new Element("p", "请读取项目现有代码并报告具体证据。"));
    return card;
  };
  return {api, context, body, message, addCard, emit, advance, requests, logs, observers, timers, intervals, config,
    Element, counts: () => ({documentQueries, cardParses}),
    stop: () => listener({type: "bridgeFlowStopped"}, null, () => {}),
    configChanged: () => storageListener({connections: {newValue: {}}}, "local"),
    holdConfig: promise => { holdConfig = promise; },
    holdState: promise => { holdState = promise; },
    setGenerating: value => {
      generating = value;
      emit({type: "childList", target: body,
        addedNodes: value ? [stopButton] : [], removedNodes: value ? [] : [stopButton]});
    },
    viewCards: () => new Promise(resolve => listener({type: "bridgeCardChoices"}, null, resolve))};
}

async function main() {
  const idle = fixture();
  await idle.api.startAutomaticLoop("flow_started");
  idle.api.beginWait();
  for (let seconds = 2; seconds <= 60; seconds += 2) {
    await idle.advance(2000);
    await idle.api.tick("setInterval");
  }
  assert.ok(idle.counts().cardParses <= 3, "an unchanged reply is parsed at most once per 30-second fallback");
  assert.ok(idle.requests.filter(request => request.path === "/state").length < 12,
    "empty-card backoff also skips bridge requests and message selection");
  assert.equal(idle.requests.filter(request => request.path === "/instruction").length, 0);
  const beforeManual = idle.counts().cardParses;
  const choices = await idle.viewCards();
  assert.equal(choices.ok, true);
  assert.ok(idle.counts().cardParses > beforeManual, "manual card inspection bypasses the negative cache");

  const sameText = fixture();
  const hiddenCard = sameText.addCard(sameText.message, true);
  await sameText.api.startAutomaticLoop("flow_started");
  await sameText.advance(2000);
  await sameText.api.tick("setInterval");
  const beforeVisibility = sameText.counts().cardParses;
  const oldText = sameText.message.innerText;
  hiddenCard.attributes["aria-hidden"] = "false";
  sameText.emit({type: "attributes", target: hiddenCard, attributeName: "aria-hidden"});
  await sameText.advance(250);
  assert.equal(sameText.message.innerText, oldText);
  assert.ok(sameText.counts().cardParses > beforeVisibility,
    "card visibility invalidates the negative cache even when the reply text is unchanged");
  assert.equal(sameText.requests.filter(request => request.path === "/instruction").length, 1);
  await sameText.api.tick("setInterval");
  assert.equal(sameText.requests.filter(request => request.path === "/instruction").length, 1);

  const fresh = fixture();
  await fresh.api.startAutomaticLoop("flow_started");
  await fresh.advance(2000);
  await fresh.api.tick("setInterval");
  const newReply = fresh.body.append(new fresh.Element("div", "新的助手回复", {
    "data-content-search-unit-key": "two:assistant", "data-message-author-role": "assistant"
  }));
  fresh.addCard(newReply);
  fresh.emit({type: "childList", target: fresh.body, addedNodes: [newReply], removedNodes: []});
  await fresh.advance(250);
  await fresh.advance(2000);
  await fresh.api.tick("setInterval");
  assert.equal(fresh.requests.filter(request => request.path === "/instruction").length, 1,
    "a newly inserted assistant reply wakes discovery and submits after stability");

  const changedConfig = fixture();
  changedConfig.addCard(changedConfig.message, false, "新的卡片标题");
  await changedConfig.api.startAutomaticLoop("flow_started");
  await changedConfig.advance(2000);
  await changedConfig.api.tick("setInterval");
  changedConfig.config.title = "新的卡片标题";
  changedConfig.configChanged();
  await changedConfig.advance(250);
  assert.equal(changedConfig.requests.filter(request => request.path === "/instruction").length, 1,
    "changed title settings invalidate the negative cache and bypass backoff");

  const streaming = fixture();
  streaming.setGenerating(true);
  await streaming.api.startAutomaticLoop("flow_started");
  for (let index = 0; index < 50; index++) {
    streaming.message.text += "新";
    streaming.emit({type: "childList", target: streaming.message, addedNodes: [], removedNodes: []});
  }
  assert.equal(streaming.timers.size, 0, "streaming text does not schedule a scan for every mutation");
  assert.equal(streaming.requests.filter(request => request.path === "/instruction").length, 0);
  streaming.addCard();
  streaming.setGenerating(false);
  await streaming.advance(250);
  await streaming.advance(2000);
  await streaming.api.tick("setInterval");
  assert.equal(streaming.requests.filter(request => request.path === "/instruction").length, 1,
    "removing the generation control wakes and submits the completed card after stability");

  const telemetry = fixture();
  await telemetry.api.record("page_stability_reset", {reportId: 1, reason: "assistant_dom_content_changed"});
  const queriesAfterFirstLog = telemetry.counts().documentQueries;
  for (let index = 0; index < 100; index++)
    await telemetry.api.record("page_stability_reset", {reportId: 1,
      reason: "assistant_dom_content_changed", previousStableElapsedMs: index});
  assert.equal(telemetry.logs.length, 1, "streaming mutations do not flood stability-reset logs");
  assert.equal(telemetry.counts().documentQueries, queriesAfterFirstLog,
    "suppressed diagnostic events do not collect full-page snapshots");

  const cancelled = fixture();
  let resolveConfig;
  cancelled.holdConfig(new Promise(resolve => { resolveConfig = resolve; }));
  const pendingTick = cancelled.api.startAutomaticLoop("flow_started");
  const beforeOverlap = cancelled.counts().documentQueries;
  await cancelled.api.tick("setInterval");
  assert.equal(cancelled.counts().documentQueries, beforeOverlap,
    "a busy tick performs no diagnostic or page queries");
  cancelled.stop();
  resolveConfig({ok: true, bound: true, title: "", card: ""});
  await pendingTick;
  assert.equal(cancelled.requests.length, 0, "a stopped in-flight check never resumes with stale settings");
  assert.equal(cancelled.timers.size, 0);
  assert.equal(cancelled.intervals.size, 0);
  assert.ok(cancelled.observers.every(observer => observer.disconnected));
  await cancelled.api.tick("report_ready");
  assert.equal(cancelled.requests.length, 0, "late report wakes cannot restart a stopped flow");
  await cancelled.api.startAutomaticLoop("flow_started");
  assert.equal(cancelled.intervals.size, 1, "a new flow can restart after cancellation");
  assert.ok(cancelled.requests.length > 0);

  const staleState = fixture();
  staleState.addCard();
  await staleState.api.startAutomaticLoop("flow_started");
  await staleState.advance(2000);
  let resolveState;
  staleState.holdState(new Promise(resolve => { resolveState = resolve; }));
  const staleTick = staleState.api.tick("setInterval");
  for (let i = 0; i < 4; i++) await Promise.resolve();
  staleState.stop();
  const queriesAfterStop = staleState.counts().documentQueries;
  resolveState({ok: true, data: {runId: "scheduler-run", phase: "await_instruction", reportId: 0, round: 0}});
  await staleTick;
  assert.equal(staleState.requests.filter(request => request.path === "/instruction").length, 0,
    "a stale state response cannot submit a card after stopping");
  assert.equal(staleState.counts().documentQueries, queriesAfterStop,
    "a stale state response performs no further page scans after stopping");

  console.log(`Scheduler regressions OK: unchanged 60s reply parsed ${beforeManual} times before manual refresh; cache invalidation, discovery, overlap, stop and restart passed`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
