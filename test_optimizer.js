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
  console.log("Optimizer settings sync, bounded initial requests, and history blocking OK");
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
