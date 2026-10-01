const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

async function main() {
  const saved = {connections: {
    "7": {id: "taskA", tabId: 7, port: 8765, token: "secretA", title: "A", card: "", threadId: "taskA"},
    "8": {id: "taskB", tabId: 8, port: 8766, token: "secretB", title: "B", card: "", threadId: "taskB"}
  }, tabId: 10, port: 8770, token: "old-secret", title: "Old", card: "",
    bridgePendingEvents: [{time: "old", source: "content", event: "queued_before_upgrade", data: {}}]};
  const written = new Map([[8765, []], [8766, []], [8767, []], [8768, []], [8770, []]]);
  const batchSizes = [];
  const apiRouted = [];
  const phaseByPort = new Map([[8765, "setup"], [8766, "setup"], [8767, "report_ready"],
    [8768, "setup"], [8770, "setup"]]);
  const reportWakeMessages = [];
  const alarmRecords = new Map();
  const missingTabIds = new Set();
  let online = false;
  let listener;
  let tabRemovedListener;
  let alarmListener;
  const chrome = {
    runtime: {onMessage: {addListener: callback => { listener = callback; }}},
    tabs: {onRemoved: {addListener: callback => { tabRemovedListener = callback; }},
      get: async tabId => {
        if (missingTabIds.has(tabId)) throw new Error("tab not found");
        return {id: tabId};
      },
      sendMessage: async (tabId, message) => { reportWakeMessages.push({tabId, message}); }},
    alarms: {
      get: async name => alarmRecords.get(name) || null,
      create: async (name, info) => { alarmRecords.set(name, info); },
      clear: async name => alarmRecords.delete(name),
      onAlarm: {addListener: callback => { alarmListener = callback; }}
    },
    storage: {local: {
      get: async keys => {
        const result = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) result[key] = saved[key];
        return result;
      },
      set: async values => Object.assign(saved, values),
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete saved[key]; }
    }}
  };
  const fetch = async (url, options) => {
    if (!online) throw new Error("offline");
    const parsedUrl = new URL(url);
    const port = Number(parsedUrl.port);
    assert.equal(options.headers["X-Bridge-Token"], port === 8765 ? "secretA" :
      port === 8766 ? "secretB" : port === 8767 ? "secretA2" :
      port === 8768 ? "secretZ" : "old-secret");
    if (parsedUrl.pathname !== "/events") {
      apiRouted.push(port);
      const phase = phaseByPort.get(port) || "setup";
      return {ok: true, json: async () => ({
        threadId: port === 8767 ? "taskA" : port === 8768 ? "taskZ" : port === 8766 ? "taskB" : "taskA",
        phase, reportId: phase === "report_ready" ? 4 : 0
      })};
    }
    const events = JSON.parse(options.body).events;
    batchSizes.push(events.length);
    written.get(port).push(...events);
    return {ok: true};
  };
  const source = fs.readFileSync(path.join(__dirname, "extension", "background.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "extension", "manifest.json"), "utf8"));
  assert.ok(manifest.permissions.includes("alarms"), "background report wake requires the alarms permission");
  vm.runInNewContext(source, {chrome, fetch, URL, AbortSignal, Promise, Set, Object, String, Number});
  const send = (message, sender = {}) => new Promise(resolve => {
    assert.equal(listener(message, sender, resolve), true);
  });
  const tabA = {tab: {id: 7, url: "https://chatgpt.com/c/a"}};
  const tabB = {tab: {id: 8, url: "https://chatgpt.com/c/b"}};
  assert.equal((await send({type: "bridgeIsBound"}, tabA)).bound, true);
  assert.equal((await send({type: "bridgeIsBound"}, tabB)).bound, true);
  assert.equal((await send({type: "bridgeIsBound"}, {tab: {id: 10, url: "https://chatgpt.com/c/old"}})).bound, true);
  assert.equal((await send({type: "bridgeIsBound"}, {tab: {id: 9, url: "https://chatgpt.com/c/other"}})).bound, false);
  const configB = await send({type: "bridgeGetConfig"}, tabB);
  assert.equal(configB.ok, true);
  assert.equal(configB.bound, true);
  assert.equal(configB.title, "B");
  assert.equal(configB.card, "");

  await send({type: "bridgeLog", event: "send_click", data: {
    reportId: 2, token: "secret", instruction: "private text", phase: "report_ready"
  }}, tabA);
  await send({type: "bridgeLog", event: "bind_error", data: {reason: "receiver_missing", token: "secret"}, tabId: 8});
  await send({type: "bridgeLog", event: "card_choices_viewed",
    occurredAt: "2000-01-01T00:00:00.000Z", data: {
    round: 1, cardChoices: 1, strictChoiceCount: 0, manualCandidateCount: 2,
    relaxedChoiceCount: 1, latestOnly: true, method: "main_manual_loose",
    instruction: "private text", elapsedMs: 3000, tickGapMs: 8000,
    visibilityState: "hidden", mutationObserverUsed: false,
    diagnosticObserverStarted: true, observerMutationCount: 3,
    reason: "stable_threshold", signatureChangeCount: 4,
    observerCallbackCount: 7, observerChildListCount: 11,
    observerCharacterDataCount: 5, observerAttributeCount: 9,
    observerCallbackDelta: 2, observerMutationDelta: 6,
    optimizerLiveWindowMutationCount: 3, optimizerLiveWindowMutationDelta: 1,
    optimizerBoundaryMutationCount: 2, optimizerBoundaryMutationDelta: 0,
    optimizerHiddenMarkerCount: 4, optimizerBoundaryMarkerCount: 1,
    optimizerStatusAvailable: true, optimizerLiveScans: 14, optimizerLiveScanDelta: 2,
    optimizerLiveUnits: 10, optimizerLiveHiddenUnits: 4, optimizerLiveLastReason: "new-content",
    latestTextLength: 123, assistantMessageCount: 6,
    coalescedWakeCount: 11,
    previousStableElapsedMs: 1900, cardFirstSeen: true, replyCompleted: true,
    lastContentChangeAt: 1770000000000, stabilityStartedAt: 1770000000000,
    assistantContentMutationCount: 2
  }}, tabB);
  await send({type: "bridgeLog", event: "post_upgrade", tabId: 10}, {tab: {id: 10, url: "https://chatgpt.com/c/old"}});
  await send({type: "bridgeLog", event: "ignored"}, {tab: {id: 9, url: "https://chatgpt.com/c/other"}});
  assert.equal(saved.bridgePendingEvents_taskA.length, 1);
  assert.equal(saved.bridgePendingEvents_taskB.length, 2);
  assert.equal(saved.bridgePendingEvents_taskA[0].taskId, "taskA");
  assert.equal(saved.bridgePendingEvents_taskA[0].occurredAt,
    saved.bridgePendingEvents_taskA[0].time,
    "events without an explicit timestamp use their original receive time");
  assert.equal(saved.bridgePendingEvents_taskA[0].delayedWrite, undefined,
    "a freshly queued event is not mislabeled as delayed");
  assert.equal(saved.bridgePendingEvents_taskA[0].data.token, undefined);
  assert.equal(saved.bridgePendingEvents_taskA[0].data.instruction, undefined);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.manualCandidateCount, 2);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.latestOnly, true);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.method, "main_manual_loose");
  assert.equal(saved.bridgePendingEvents_taskB[1].data.elapsedMs, 3000);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.tickGapMs, 8000);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.visibilityState, "hidden");
  assert.equal(saved.bridgePendingEvents_taskB[1].data.mutationObserverUsed, false);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.diagnosticObserverStarted, true);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.observerMutationCount, 3);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.reason, "stable_threshold");
  assert.equal(saved.bridgePendingEvents_taskB[1].data.signatureChangeCount, 4);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.observerCallbackCount, 7);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.observerChildListCount, 11);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.observerCharacterDataCount, 5);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.observerAttributeCount, 9);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.observerCallbackDelta, 2);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.observerMutationDelta, 6);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.optimizerLiveWindowMutationCount, 3);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.optimizerLiveWindowMutationDelta, 1);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.optimizerBoundaryMutationCount, 2);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.optimizerBoundaryMutationDelta, 0);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.optimizerHiddenMarkerCount, 4);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.optimizerBoundaryMarkerCount, 1);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.optimizerStatusAvailable, true);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.optimizerLiveScans, 14);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.optimizerLiveScanDelta, 2);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.optimizerLiveUnits, 10);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.optimizerLiveHiddenUnits, 4);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.optimizerLiveLastReason, "new-content");
  assert.equal(saved.bridgePendingEvents_taskB[1].data.latestTextLength, 123);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.assistantMessageCount, 6);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.coalescedWakeCount, 11,
    "wake coalescing counts survive the extension logging allowlist");
  assert.equal(saved.bridgePendingEvents_taskB[1].data.previousStableElapsedMs, 1900);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.cardFirstSeen, true);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.replyCompleted, true);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.lastContentChangeAt, 1770000000000);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.stabilityStartedAt, 1770000000000);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.assistantContentMutationCount, 2);
  assert.equal(saved.bridgePendingEvents_taskB[1].data.instruction, undefined);
  assert.equal(saved.bridgePendingEvents_taskB[1].occurredAt, "2000-01-01T00:00:00.000Z",
    "a queued event retains the content-side occurrence timestamp");
  assert.equal(saved.bridgePendingEvents_taskB[1].delayedWrite, true,
    "events that have waited in the extension log queue are visibly marked as delayed");
  assert.ok(saved.bridgePendingEvents_taskB[1].delayMs > 1000);

  for (let index = 0; index < 205; index += 1)
    await send({type: "bridgeLog", event: "offline_step", data: {round: index}}, tabA);

  await send({type: "bridgeUnbind", tabId: 7});
  assert.equal(saved.connections["7"], undefined);
  assert.equal(saved.bridgePendingEvents_taskA, undefined);
  assert.equal(saved.bridgePendingEvents_tab_7.length, 207);
  await send({type: "bridgeBind", connection: {
    id: "taskZ", tabId: 7, port: 8768, token: "secretZ", threadId: "taskZ", title: "Z", card: ""
  }});
  assert.equal(saved.connections["7"].threadId, "taskZ");
  assert.equal(saved.bridgePendingEvents_tab_7.length, 207);
  assert.equal(saved.bridgePendingEvents_taskZ, undefined);
  await send({type: "bridgeBind", connection: {
    id: "taskA2", tabId: 7, port: 8767, token: "secretA2", threadId: "taskA", title: "A", card: ""
  }});
  assert.equal(saved.connections["7"].id, "taskA2");
  assert.equal(saved.bridgePendingEvents_tab_7, undefined);

  online = true;
  const reboundTabA = {tab: {id: 7, url: "https://chatgpt.com/c/a"}};
  await send({type: "bridgeLog", event: "connected", tabId: 7}, reboundTabA);
  await send({type: "bridgeLog", event: "connected", tabId: 8}, tabB);
  await send({type: "bridgeLog", event: "connected", tabId: 10}, {tab: {id: 10, url: "https://chatgpt.com/c/old"}});
  const stateA = await send({type: "bridgeRequest", path: "/state"}, reboundTabA);
  const stateB = await send({type: "bridgeRequest", path: "/state"}, tabB);
  assert.equal(stateA.data.threadId, "taskA");
  assert.equal(stateB.data.threadId, "taskB");
  assert.deepEqual(apiRouted, [8767, 8766]);
  const deliveredQueuedEvent = written.get(8766).find(entry => entry.event === "card_choices_viewed");
  assert.equal(deliveredQueuedEvent.occurredAt, "2000-01-01T00:00:00.000Z",
    "the bridge receives the preserved occurrence time after queued delivery");
  assert.equal(deliveredQueuedEvent.delayedWrite, true,
    "the delayed-write marker survives extension queue delivery");
  assert.ok(deliveredQueuedEvent.delayMs > 1000);
  assert.equal(alarmRecords.get("bridge-report-ready-wake")?.periodInMinutes, 0.5,
    "the MV3 worker installs a minimum-period report wake alarm");
  missingTabIds.add(8);
  await alarmListener({name: "bridge-report-ready-wake"});
  await new Promise(resolve => setTimeout(resolve, 0));
  await send({type: "bridgeLog", event: "wake_log_flush", data: {}}, reboundTabA);
  assert.deepEqual(reportWakeMessages.map(({tabId, message}) => ({tabId,
    message: {type: message.type, reportId: message.reportId}})), [{tabId: 7,
    message: {type: "bridgeReportReady", reportId: 4}}],
  "the alarm polls bound tasks and wakes only the tab whose Codex report is ready");
  const wakeEvents = written.get(8767).filter(entry =>
    ["alarm_fired", "report_ready_detected", "wake_message_sent"].includes(entry.event)
  );
  assert.deepEqual(wakeEvents.map(entry => entry.event),
    ["alarm_fired", "report_ready_detected", "wake_message_sent"]);
  for (const event of wakeEvents) {
    assert.equal(event.source, "background");
    assert.equal(event.taskId, "taskA");
    assert.match(event.time, /^\d{4}-\d\d-\d\dT/);
  }
  assert.equal(wakeEvents[0].data.reportId, undefined);
  assert.equal(wakeEvents[1].data.reportId, 4);
  assert.equal(wakeEvents[2].data.reportId, 4);
  const stateCheckedA = written.get(8767).find(entry => entry.event === "alarm_state_checked");
  assert.equal(stateCheckedA.data.phase, "report_ready");
  assert.equal(stateCheckedA.data.taskId, "taskA");
  assert.equal(stateCheckedA.data.tabId, 7);
  assert.equal(stateCheckedA.data.reportId, 4);
  const reportMatchA = written.get(8767).find(entry => entry.event === "alarm_report_match");
  assert.equal(reportMatchA.data.reportId, 4);
  const tabFoundA = written.get(8767).find(entry => entry.event === "alarm_tab_found");
  assert.equal(tabFoundA.data.tabId, 7);
  assert.equal(tabFoundA.data.boundTabFound, true);
  assert.ok(written.get(8766).some(entry => entry.event === "alarm_fired" &&
    entry.taskId === "taskB"), "alarm events are logged separately per bound task");
  const taskBAlarmEvents = written.get(8766).filter(entry =>
    ["alarm_state_checked", "alarm_no_tab", "alarm_no_report"].includes(entry.event)
  );
  const stateCheckedB = taskBAlarmEvents.find(entry => entry.event === "alarm_state_checked");
  assert.equal(stateCheckedB.data.phase, "setup");
  assert.equal(stateCheckedB.data.taskId, "taskB");
  assert.equal(stateCheckedB.data.tabId, 8);
  assert.equal(stateCheckedB.data.reportId, 0);
  assert.ok(taskBAlarmEvents.some(entry => entry.event === "alarm_no_tab" &&
    entry.data.tabId === 8 && entry.data.boundTabFound === false));
  assert.ok(taskBAlarmEvents.some(entry => entry.event === "alarm_no_report" &&
    entry.data.phase === "setup"));
  assert.deepEqual(apiRouted.slice(2), [8767, 8766, 8770]);

  await send({type: "bridgeLog", event: "before_stop_check"}, tabB);
  const taskBWrittenBeforeStop = written.get(8766).length;
  const taskBStateChecksBeforeStop = apiRouted.filter(port => port === 8766).length;
  phaseByPort.set(8767, "stopped");
  await send({type: "bridgeTaskStopped", tabId: 7});
  phaseByPort.set(8770, "stopped");
  await send({type: "bridgeTaskStopped", tabId: 10});
  phaseByPort.set(8766, "stopped");
  await alarmListener({name: "bridge-report-ready-wake"});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(apiRouted.filter(port => port === 8766).length, taskBStateChecksBeforeStop + 1,
    "the alarm checks state once to discover a stopped task");
  assert.ok(saved.bridgeStoppedConnectionIds.includes("taskB"),
    "a stopped connection is remembered across service-worker restarts");
  assert.equal(written.get(8766).length, taskBWrittenBeforeStop,
    "the first stopped-state detection writes no periodic alarm events");

  await alarmListener({name: "bridge-report-ready-wake"});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(apiRouted.filter(port => port === 8766).length, taskBStateChecksBeforeStop + 1,
    "later alarms do not poll a remembered stopped task");
  assert.equal(written.get(8766).length, taskBWrittenBeforeStop,
    "later alarms do not append stopped-task log entries");
  assert.equal(saved.connections["8"].id, "taskB", "stopping preserves the tab binding");
  assert.equal(alarmRecords.has("bridge-report-ready-wake"), false,
    "the report wake alarm is cleared when every bound flow is stopped");

  phaseByPort.set(8766, "setup");
  await send({type: "bridgeTaskStarted", tabId: 8});
  assert.equal(alarmRecords.has("bridge-report-ready-wake"), true,
    "starting a new flow recreates the report wake alarm");
  assert.equal(saved.bridgeStoppedConnectionIds.includes("taskB"), false,
    "starting a new flow clears the stopped marker");
  const resumedPollsBefore = apiRouted.filter(port => port === 8766).length;
  await alarmListener({name: "bridge-report-ready-wake"});
  await new Promise(resolve => setTimeout(resolve, 0));
  await send({type: "bridgeLog", event: "resumed_poll_flush"}, tabB);
  assert.equal(apiRouted.filter(port => port === 8766).length, resumedPollsBefore + 1,
    "the alarm resumes checking after the popup starts a new flow");
  assert.equal(saved.connections["8"].id, "taskB", "restarting still keeps the same binding");

  online = false;
  await tabRemovedListener(8);
  assert.equal(saved.connections["8"], undefined);
  assert.equal(saved.bridgePendingEvents_taskB, undefined);
  assert.deepEqual(Array.from(saved.bridgePendingEvents_tab_8, entry => entry.event), ["unbind"]);
  assert.equal(saved.bridgePendingEvents_tab_8[0].source, "tab_closed");
  assert.equal(saved.bridgePendingEvents_tab_8[0].taskId, "taskB");

  assert.equal(written.get(8765).length, 0);
  assert.equal(written.get(8767).length, 215);
  assert.equal(written.get(8766).length, taskBWrittenBeforeStop + 5,
    "only one resumed poll and its explicit flush are added after the stopped interval");
  assert.equal(written.get(8770).length, 7);
  assert.deepEqual(written.get(8767).slice(0, 2).map(entry => entry.event), ["send_click", "offline_step"]);
  assert.equal(written.get(8767)[0].taskId, "taskA");
  assert.equal(written.get(8767).at(-1).taskId, "taskA");
  assert.ok(written.get(8767).some(entry => entry.event === "connected"));
  assert.equal(written.get(8767).at(-1).event, "wake_log_flush");
  assert.equal(written.get(8766)[0].event, "bind_error");
  assert.equal(written.get(8770)[0].event, "queued_before_upgrade");
  assert.ok(batchSizes.every(size => size <= 100));
  assert.equal(saved.bridgePendingEvents_taskA, undefined);
  assert.equal(saved.bridgePendingEvents_taskA2.length, 0);
  assert.equal(saved.bridgePendingEvents_taskB, undefined);
  assert.equal(saved.bridgePendingEvents, undefined);
  assert.equal(written.get(8767)[0].source, "content");
  assert.match(written.get(8767)[0].time, /^\d{4}-\d\d-\d\dT/);
  assert.equal(written.get(8766)[0].source, "popup");
  console.log("Per-tab bridge routing and offline log handoff across rebind OK");
  await verifyLegacyQueueMigratesOnReplacement();
}

async function verifyLegacyQueueMigratesOnReplacement() {
  const saved = {tabId: 7, port: 8765, token: "old-secret", title: "Old", card: "",
    bridgePendingEvents: [{event: "legacy_global", time: "old-global", data: {}}],
    bridgePendingEvents_legacy: [{event: "legacy_connection", time: "old-connection", data: {}}]};
  let listener;
  const chrome = {runtime: {onMessage: {addListener: callback => { listener = callback; }}},
    storage: {local: {
      get: async keys => {
        const result = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) result[key] = saved[key];
        return result;
      },
      set: async values => Object.assign(saved, values),
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete saved[key]; }
    }}};
  const source = fs.readFileSync(path.join(__dirname, "extension", "background.js"), "utf8");
  vm.runInNewContext(source, {chrome, fetch: async () => { throw new Error("offline"); },
    URL, AbortSignal, Promise, Set, Object, String, Number});
  const result = await new Promise(resolve => listener({type: "bridgeBind", connection: {
    id: "replacement", tabId: 7, port: 8766, token: "new-secret", threadId: "old-task", title: "New", card: ""
  }}, {}, resolve));
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(saved.bridgePendingEvents_replacement, entry => entry.event),
    ["legacy_global", "legacy_connection"]);
  assert.equal(saved.bridgePendingEvents, undefined);
  assert.equal(saved.bridgePendingEvents_legacy, undefined);
  assert.equal(saved.connections["7"].id, "replacement");
  console.log("Legacy singleton log queues migrate when replacing its connection OK");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
