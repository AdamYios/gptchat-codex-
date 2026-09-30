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
  source: channel, direction: "TO_MAIN", type: "REFRESH_SETTINGS"
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

console.log("Optimizer storage keys and message namespaces OK");
