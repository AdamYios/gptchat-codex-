const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const root = __dirname;
const bridgeSource = fs.readFileSync(path.join(root, "extension", "optimizer-bridge.js"), "utf8");
const mainSource = fs.readFileSync(path.join(root, "extension", "optimizer-main.js"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const expectedKeys = [
  "optimizer.enabled",
  "optimizer.keepRounds",
  "optimizer.renderOptimize",
  "optimizer.liveWindow"
];
const channel = "CHATGPT_LONG_CHAT_OPTIMIZER";
assert.match(bridgeSource, new RegExp(`const CHANNEL = "${channel}"`));
assert.match(mainSource, new RegExp(`const CHANNEL = "${channel}"`));
assert.match(bridgeSource, /const SETTINGS_KEY = "optimizer\.settings"/);
assert.match(mainSource, /const SETTINGS_KEY = "optimizer\.settings"/);
assert.doesNotMatch(bridgeSource + mainSource, /CGO_V08|cgo_v08_settings/);

const storageValues = {
  "optimizer.enabled": false,
  "optimizer.keepRounds": 23,
  "optimizer.renderOptimize": false,
  "optimizer.liveWindow": false
};
const storageListeners = {};
const runtimeListeners = [];
const windowListeners = {};
const sentToPage = [];
const localStorageValues = new Map();
let storageDefaults;
const window = {
  addEventListener: (name, callback) => { windowListeners[name] = callback; },
  postMessage: message => { sentToPage.push(message); }
};
const context = {
  window,
  location: {href: "https://chatgpt.com/c/test"},
  localStorage: {
    setItem: (key, value) => localStorageValues.set(key, value),
    getItem: key => localStorageValues.get(key) || null
  },
  chrome: {
    storage: {
      local: {
        get: (defaults, callback) => {
          storageDefaults = defaults;
          callback({...defaults, ...storageValues});
        }
      },
      onChanged: {addListener: callback => { storageListeners.changed = callback; }}
    },
    runtime: {onMessage: {addListener: callback => runtimeListeners.push(callback)}}
  },
  setTimeout: callback => { callback(); return 1; }
};

vm.runInNewContext(bridgeSource, context, {filename: "optimizer-bridge.js"});
assert.deepEqual(Object.keys(storageDefaults).sort(), [...expectedKeys].sort());
assert.deepEqual(JSON.parse(localStorageValues.get("optimizer.settings")), {
  enabled: false, keepRounds: 23, renderOptimize: false, liveWindow: false
});
assert.deepEqual(plain(sentToPage.at(-1)), {
  source: channel, direction: "TO_MAIN", type: "REFRESH_SETTINGS",
  payload: {enabled: false, keepRounds: 23, renderOptimize: false, liveWindow: false}
});

storageListeners.changed({
  enabled: {newValue: true},
  "optimizer.keepRounds": {newValue: 31}
}, "local");
assert.deepEqual(JSON.parse(localStorageValues.get("optimizer.settings")), {
  enabled: false, keepRounds: 31, renderOptimize: false, liveWindow: false
});
storageListeners.changed({"optimizer.enabled": {newValue: true}}, "sync");
assert.equal(JSON.parse(localStorageValues.get("optimizer.settings")).enabled, false);
storageListeners.changed({"optimizer.enabled": {newValue: true}}, "local");
assert.equal(JSON.parse(localStorageValues.get("optimizer.settings")).enabled, true);

const runtimeListener = runtimeListeners[0];
const applyReply = {};
runtimeListener({type: "OPTIMIZER_APPLY", settings: {
  enabled: false, keepRounds: 7, renderOptimize: true, liveWindow: false
}}, {}, reply => Object.assign(applyReply, reply));
assert.deepEqual(plain(applyReply), {ok: true, settings: {
  enabled: false, keepRounds: 7, renderOptimize: true, liveWindow: false
}});
assert.deepEqual(JSON.parse(localStorageValues.get("optimizer.settings")), plain(applyReply.settings));
assert.equal(sentToPage.at(-1).type, "REFRESH_SETTINGS");
assert.deepEqual(plain(sentToPage.at(-1).payload), plain(applyReply.settings));

windowListeners.message({source: window, data: {
  source: channel, direction: "FROM_MAIN", type: "STATUS", payload: {rounds: 7}
}});
const statusReply = {};
runtimeListener({type: "OPTIMIZER_STATUS"}, {}, reply => Object.assign(statusReply, reply));
assert.deepEqual(plain(statusReply), {
  ok: true,
  settings: plain(applyReply.settings),
  mainStatus: {rounds: 7},
  url: "https://chatgpt.com/c/test"
});
assert.equal(sentToPage.at(-1).type, "GET_STATUS");

const liveReply = {};
runtimeListener({type: "OPTIMIZER_LIVE_NOW"}, {}, reply => Object.assign(liveReply, reply));
assert.deepEqual(plain(liveReply), {ok: true});
assert.equal(sentToPage.at(-1).type, "APPLY_LIVE_NOW");

async function testMainFetch() {
const mainWindowListeners = {};
const networkRequests = [];
let responseBody = {page_info: {has_previous_page: true, start_cursor: "older-cursor"}, messages: [1, 2, 3]};
const mainWindow = {
  fetch: async (input, init) => {
    networkRequests.push({input, init});
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: {"content-type": "application/json"}
    });
  },
  addEventListener: (name, callback) => { mainWindowListeners[name] = callback; },
  postMessage: message => sentToPage.push(message)
};
const fakeDocument = {
  documentElement: {},
  head: {appendChild() {}},
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  createElement: () => ({remove() {}}),
  addEventListener() {}
};
class FakeMutationObserver { observe() {} }
const mainContext = {
  window: mainWindow,
  document: fakeDocument,
  location: {
    href: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
    origin: "https://chatgpt.com"
  },
  localStorage: {getItem: () => JSON.stringify({enabled: true, keepRounds: 4})},
  performance: {now: () => 1, getEntriesByType: () => []},
  MutationObserver: FakeMutationObserver,
  Element: class Element {},
  HTMLElement: class HTMLElement {},
  URL,
  URLSearchParams,
  Request,
  Response,
  Headers,
  Date,
  Math,
  Number,
  String,
  Object,
  RegExp,
  JSON,
  setTimeout: () => 1,
  clearTimeout() {},
  setInterval: () => 1,
  requestAnimationFrame: callback => callback(),
  console
};
vm.runInNewContext(mainSource, mainContext, {filename: "optimizer-main.js"});

const conversationId = "12345678-1234-1234-1234-123456789abc";
const pendingInitial = mainWindow.fetch(
  `https://chatgpt.com/backend-api/conversations/${conversationId}?num_turns=3`
);
assert.equal(networkRequests.length, 0, "initial request waits for extension settings");
mainWindowListeners.message({source: mainWindow, data: {
  source: channel,
  direction: "TO_MAIN",
  type: "REFRESH_SETTINGS",
  payload: {enabled: true, keepRounds: 23, renderOptimize: true, liveWindow: true}
}});
const initialResponse = await pendingInitial;
assert.equal(new URL(networkRequests[0].input).searchParams.get("num_turns"), "23",
  "configured N replaces a smaller caller-provided num_turns");
assert.deepEqual(await initialResponse.json(), {
  page_info: {has_previous_page: false, start_cursor: null},
  messages: [1, 2, 3]
});

await mainWindow.fetch(
  `https://chatgpt.com/backend-api/conversations/${conversationId}?num_turns=99`
);
assert.equal(new URL(networkRequests[1].input).searchParams.get("num_turns"), "23",
  "configured N also replaces a larger caller-provided num_turns");

const requestCountBeforeHistory = networkRequests.length;
const blockedHistory = await mainWindow.fetch(
  `https://chatgpt.com/backend-api/conversations/${conversationId}/messages?before=older-cursor`
);
assert.equal(networkRequests.length, requestCountBeforeHistory,
  "older-history pagination is not sent to the server");
assert.deepEqual(await blockedHistory.json(), {
  current_node: null,
  messages: [],
  moderation_results: [],
  page_info: {has_previous_page: false, start_cursor: null}
});
const blockedPostHistory = await mainWindow.fetch(
  `https://chatgpt.com/backend-api/conversations/${conversationId}/messages?before=older-cursor`,
  {method: "POST"}
);
assert.equal(networkRequests.length, requestCountBeforeHistory,
  "before pagination is blocked for every method");
assert.equal(blockedPostHistory.status, 200);

responseBody = {messages: [4]};
const noPageInfo = await mainWindow.fetch(
  `https://chatgpt.com/backend-api/conversations/${conversationId}`
);
assert.deepEqual(await noPageInfo.json(), {messages: [4]},
  "responses without page_info keep their original shape");

}

testMainFetch().then(() => {
  testLiveWindow();
  console.log("Optimizer settings sync, bounded initial requests, and history blocking OK");
  console.log("Live window removes old turn layout and blocks top-history jitter OK");
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});

function testLiveWindow() {
  const mutationObservers = [];
  const intersectionObservers = [];
  const timers = new Map();
  const mainMessages = [];
  let nextTimer = 1;

  class FakeElement {
    constructor(attributes = {}) {
      this.nodeType = 1;
      this.attributes = {...attributes};
      this.style = {display: "", overflowAnchor: ""};
      this.children = [];
      this.parentElement = null;
      this.isConnected = true;
      this.className = "";
      this.height = 0;
    }
    append(child) { child.parentElement = this; this.children.push(child); return child; }
    prepend(child) { child.parentElement = this; this.children.unshift(child); return child; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    matches(selector) {
      if (selector === "[data-content-search-unit-key]")
        return this.getAttribute("data-content-search-unit-key") !== null;
      if (selector === '[data-user-message-bubble="true"]')
        return this.getAttribute("data-user-message-bubble") === "true";
      if (selector === '[data-testid*="conversation-turn"]')
        return (this.getAttribute("data-testid") || "").includes("conversation-turn");
      return false;
    }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) { return this.descendants().filter(child => child.matches(selector)); }
    closest(selector) {
      for (let node = this; node; node = node.parentElement)
        if (node.matches(selector)) return node;
      return null;
    }
  }
  class FakeHTMLElement extends FakeElement {}
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; mutationObservers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
  }
  class FakeIntersectionObserver {
    constructor(callback, options) { this.callback = callback; this.options = options; intersectionObservers.push(this); }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  }

  const scroll = new FakeHTMLElement();
  scroll.clientHeight = 500;
  let scrollTop = 0;
  Object.defineProperty(scroll, "scrollTop", {
    get: () => scrollTop,
    set: value => {
      scrollTop = Math.min(Math.max(0, Number(value) || 0), Math.max(0, scroll.scrollHeight - scroll.clientHeight));
    }
  });
  Object.defineProperty(scroll, "scrollHeight", {
    get: () => scroll.children.reduce((height, turn) =>
      height + (turn.style.display === "none" ? 0 : turn.height), 0)
  });
  const turns = [];
  const addTurn = (index, role, atTop = false) => {
    const turn = new FakeHTMLElement({"data-testid": `conversation-turn-${index}-${role}`});
    turn.height = 100;
    const unit = new FakeHTMLElement({"data-content-search-unit-key": `thread:turn-${index}:${role}`});
    turn.append(unit);
    if (atTop) scroll.prepend(turn);
    else scroll.append(turn);
    turns.push({turn, unit, index, role});
    return {turn, unit};
  };
  for (let index = 1; index <= 5; index += 1) {
    addTurn(index, "user");
    addTurn(index, "assistant");
  }

  let injectedStyle = null;
  const document = {
    documentElement: new FakeHTMLElement(),
    head: {appendChild: style => { injectedStyle = style; }},
    querySelector: selector => selector === ".thread-scroll-container" ? scroll : null,
    querySelectorAll: () => [],
    getElementById: id => id === "cgo-v08-render-style" ? injectedStyle : null,
    createElement: () => ({id: "", textContent: "", remove() { injectedStyle = null; }}),
    addEventListener() {}
  };
  const mainWindow = {
    fetch: async () => new Response("{}"),
    IntersectionObserver: FakeIntersectionObserver,
    addEventListener() {},
    postMessage: message => mainMessages.push(message)
  };
  const liveSource = mainSource.replace(
    "  startLiveObserver();",
    "  globalThis.applyLiveWindowForTest = applyLiveWindow; globalThis.liveSnapshotForTest = snapshot;\n  startLiveObserver();"
  );
  const context = {
    window: mainWindow,
    document,
    location: {href: "https://chatgpt.com/c/live-window", origin: "https://chatgpt.com"},
    localStorage: {getItem: () => JSON.stringify({enabled: true, keepRounds: 3,
      renderOptimize: false, liveWindow: true})},
    performance: {now: () => 1, memory: null, getEntriesByType: () => []},
    MutationObserver: FakeMutationObserver,
    Element: FakeElement,
    HTMLElement: FakeHTMLElement,
    URL, URLSearchParams, Request, Response, Headers, Date, Math, Number, String, Object, RegExp, JSON,
    setTimeout: callback => { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: () => 1,
    requestAnimationFrame: callback => callback(),
    console
  };
  vm.runInNewContext(liveSource, context, {filename: "optimizer-live-window.js"});

  context.applyLiveWindowForTest("startup-test");
  timers.clear();
  assert.equal(context.liveSnapshotForTest().liveVisibleUserRounds, 3);
  assert.equal(scroll.children.filter(turn => turn.style.display !== "none").length, 6);
  assert.equal(scroll.scrollHeight, 600,
    "N=3 removes the old conversation-turn wrappers from layout height");
  assert.equal(turns[0].turn.style.display, "none");
  assert.equal(turns[0].unit.style.display, "",
    "the containing turn, rather than only its message contents, is removed from layout");
  assert.equal(scroll.style.overflowAnchor, "none");

  scroll.scrollTop = 0;
  const olderA = addTurn(0, "user", true);
  const olderB = addTurn(0, "assistant", true);
  const mutationObserver = mutationObservers[0];
  mutationObserver.callback([{type: "childList", addedNodes: [olderA.turn]}]);
  mutationObserver.callback([{type: "childList", addedNodes: [olderB.turn]}]);
  assert.equal(timers.size, 1, "multiple top-history mutations coalesce into one live-window scan");
  const [timerId, runScan] = timers.entries().next().value;
  timers.delete(timerId);
  runScan();

  assert.equal(olderA.turn.style.display, "none");
  assert.equal(olderB.turn.style.display, "none");
  assert.equal(scroll.scrollHeight, 600, "newly mounted older turns immediately stop contributing height");
  assert.equal(scroll.scrollTop, 0,
    "being at the top of a short N-turn window is not mistaken for being near the bottom");
  const scansAfterTop = context.liveSnapshotForTest().liveScans;
  mutationObserver.callback([{type: "attributes", target: olderA.turn, attributeName: "style"}]);
  assert.equal(timers.size, 0, "hiding a turn does not schedule another mutation scan");
  assert.equal(context.liveSnapshotForTest().liveScans, scansAfterTop);

  const observerCallbackResults = [];
  const guardedObserver = new mainWindow.IntersectionObserver(entries => observerCallbackResults.push(...entries));
  const historySpacer = new FakeElement({"data-testid": "history-spacer"});
  for (let attempt = 0; attempt < 3; attempt += 1)
    intersectionObservers.at(-1).callback([{target: historySpacer, isIntersecting: true}]);
  assert.equal(observerCallbackResults.length, 0,
    "top history sentinel/spacer intersections are suppressed before ChatGPT can request history");
  assert.equal(historySpacer.getAttribute("data-cgo-history-boundary"), "true");
  assert.match(injectedStyle.textContent, /data-cgo-history-boundary/);
  assert.doesNotMatch(injectedStyle.textContent, /content-visibility/,
    "history boundary protection remains active when render optimization is off");
  assert.ok(context.liveSnapshotForTest().blockedPaginationEntries >= 1);
  assert.equal(context.liveSnapshotForTest().liveScans, scansAfterTop,
    "repeated top sentinel intersections do not schedule another live-window scan");
}
