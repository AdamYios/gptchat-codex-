const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

async function main() {
  const saved = {tabId: 7, port: 8765, token: "secret"};
  const written = [];
  const batchSizes = [];
  let online = false;
  let listener;
  const chrome = {
    runtime: {onMessage: {addListener: callback => { listener = callback; }}},
    storage: {local: {
      get: async keys => {
        const result = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) result[key] = saved[key];
        return result;
      },
      set: async values => Object.assign(saved, values)
    }}
  };
  const fetch = async (_url, options) => {
    if (!online) throw new Error("offline");
    const events = JSON.parse(options.body).events;
    batchSizes.push(events.length);
    written.push(...events);
    return {ok: true};
  };
  const source = fs.readFileSync(path.join(__dirname, "extension", "background.js"), "utf8");
  vm.runInNewContext(source, {chrome, fetch, URL, AbortSignal, Promise, Set, Object, String, Number});
  const send = (message, sender = {}) => new Promise(resolve => {
    assert.equal(listener(message, sender, resolve), true);
  });
  const bound = {tab: {id: 7, url: "https://chatgpt.com/c/example"}};
  assert.equal((await send({type: "bridgeIsBound"}, bound)).bound, true);
  assert.equal((await send({type: "bridgeIsBound"}, {tab: {id: 8, url: "https://chatgpt.com/c/other"}})).bound, false);
  await send({type: "bridgeLog", event: "send_click", data: {
    reportId: 2, token: "secret", instruction: "private text", phase: "report_ready"
  }}, bound);
  await send({type: "bridgeLog", event: "bind_error", data: {reason: "receiver_missing", token: "secret"}});
  await send({type: "bridgeLog", event: "ignored"}, {tab: {id: 8, url: "https://chatgpt.com/c/other"}});
  assert.equal(saved.bridgePendingEvents.length, 2);
  assert.equal(saved.bridgePendingEvents[0].data.token, undefined);
  assert.equal(saved.bridgePendingEvents[0].data.instruction, undefined);
  for (let index = 0; index < 205; index += 1)
    await send({type: "bridgeLog", event: "offline_step", data: {round: index}}, bound);
  online = true;
  await send({type: "bridgeLog", event: "connected"}, bound);
  assert.equal(written.length, 208);
  assert.deepEqual(written.slice(0, 2).map(entry => entry.event), ["send_click", "bind_error"]);
  assert.equal(written.at(-1).event, "connected");
  assert.ok(batchSizes.every(size => size <= 100));
  assert.equal(saved.bridgePendingEvents.length, 0);
  assert.equal(written[0].source, "content");
  assert.match(written[0].time, /^\d{4}-\d\d-\d\dT/);
  assert.equal(written[1].source, "popup");
  console.log("Unified operation log queues offline, flushes and removes private fields OK");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
