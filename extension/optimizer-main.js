(() => {
  "use strict";

  const CHANNEL = "CHATGPT_LONG_CHAT_OPTIMIZER";
  const SETTINGS_KEY = "optimizer.settings";
  const DEFAULTS = {
    enabled: true,
    keepRounds: 10,
    renderOptimize: true,
    liveWindow: true
  };

  const originalFetch = window.fetch.bind(window);
  const NativeIntersectionObserver = window.IntersectionObserver;

  let settings = readSettings();
  let settingsReady = false;
  let resolveSettingsReady;
  const settingsReadyPromise = new Promise(resolve => {
    resolveSettingsReady = resolve;
  });
  let highestTurnIndexSeen = null;
  let lastUrl = location.href;
  let liveApplyTimer = null;
  let liveObserver = null;

  const hiddenUnits = new Map();
  const recentRequests = [];
  const MAX_REQUESTS = 50;

  const stats = {
    installedAt: new Date().toISOString(),
    mainWorldInstalled: true,

    conversationRequests: 0,
    rewrittenRequests: 0,
    initialResponsesLocked: 0,
    paginationRequests: 0,
    blockedPaginationRequests: 0,
    blockedPaginationEntries: 0,
    batchRequests: 0,

    lastConversationRequest: null,
    lastBlockedPagination: null,
    lastBatchRequest: null,

    liveScans: 0,
    liveUnits: 0,
    liveUserUnits: 0,
    liveHiddenUnits: 0,
    liveVisibleUserRounds: 0,
    liveHighestTurnIndex: null,
    liveCutoffTurnIndex: null,
    liveLastReason: null
  };

  function clampRounds(value) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n)
      ? Math.max(1, Math.min(500, n))
      : DEFAULTS.keepRounds;
  }

  function normalizeSettings(value) {
    const v = value && typeof value === "object" ? value : {};

    return {
      enabled: v.enabled !== false,
      keepRounds: clampRounds(v.keepRounds),
      renderOptimize: v.renderOptimize !== false,
      liveWindow: v.liveWindow !== false
    };
  }

  function readSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? normalizeSettings(JSON.parse(raw)) : { ...DEFAULTS };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function markSettingsReady() {
    if (settingsReady) return;
    settingsReady = true;
    resolveSettingsReady();
  }


  function emit(type, payload) {
    try {
      window.postMessage({
        source: CHANNEL,
        direction: "FROM_MAIN",
        type,
        payload
      }, "*");
    } catch {}
  }

  function pathForLog(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      return {
        path: url.pathname.replace(
          /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/ig,
          "/{conversation-id}"
        ),
        queryKeys: [...new Set([...url.searchParams.keys()])],
        numTurns: url.searchParams.get("num_turns"),
        hasBefore: url.searchParams.has("before")
      };
    } catch {
      return {
        path: String(rawUrl).slice(0, 180),
        queryKeys: [],
        numTurns: null,
        hasBefore: false
      };
    }
  }

  function pushRequest(entry) {
    recentRequests.push({
      at: new Date().toISOString(),
      ...entry
    });
    while (recentRequests.length > MAX_REQUESTS) recentRequests.shift();
  }

  function requestInfo(input, init) {
    let url = "";
    let method = "GET";
    try {
      if (input instanceof Request) {
        url = input.url;
        method = input.method || method;
      } else {
        url = String(input);
      }
      if (init?.method) method = init.method;
    } catch {}
    return { url, method: String(method || "GET").toUpperCase() };
  }

  function matchConversationUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      if (url.origin !== location.origin) return null;

      const match = url.pathname.match(
        /^\/backend-api\/conversations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/messages)?\/?$/i
      );
      if (!match) return null;

      return {
        url,
        conversationId: match[1],
        kind: match[2] ? "messages" : "initial"
      };
    } catch {
      return null;
    }
  }

  function buildEmptyHistoryResponse(exposedUrl) {
    const body = {
      current_node: null,
      messages: [],
      moderation_results: [],
      page_info: {
        has_previous_page: false,
        start_cursor: null
      }
    };

    const response = new Response(JSON.stringify(body), {
      status: 200,
      statusText: "OK",
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-chatgpt-long-chat-optimizer": "blocked-history-page"
      }
    });

    // Some app code reads response.url. Override when the runtime allows it.
    try {
      Object.defineProperty(response, "url", {
        configurable: true,
        value: exposedUrl
      });
    } catch {}

    return response;
  }

  function responseFromJson(originalResponse, data, marker) {
    const headers = new Headers(originalResponse.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("content-type", "application/json");
    headers.set("x-chatgpt-long-chat-optimizer", marker);

    const response = new Response(JSON.stringify(data), {
      status: originalResponse.status,
      statusText: originalResponse.statusText,
      headers
    });

    try {
      Object.defineProperty(response, "url", {
        configurable: true,
        value: originalResponse.url
      });
    } catch {}

    return response;
  }

  async function lockInitialHistoryBoundary(response) {
    if (!response?.ok) return response;

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("json")) return response;

    try {
      const data = await response.clone().json();

      if (
        !data ||
        typeof data !== "object" ||
        !data.page_info ||
        typeof data.page_info !== "object"
      ) {
        return response;
      }

      const alreadyLocked =
        data.page_info.has_previous_page === false &&
        (data.page_info.start_cursor == null || data.page_info.start_cursor === "");

      if (alreadyLocked) return response;

      stats.initialResponsesLocked += 1;

      return responseFromJson(
        response,
        {
          ...data,
          page_info: {
            ...data.page_info,
            has_previous_page: false,
            start_cursor: null
          }
        },
        "history-boundary-locked"
      );
    } catch {
      return response;
    }
  }

  function rewriteConversationUrl(rawUrl) {
    const match = matchConversationUrl(rawUrl);
    if (!match) return null;

    const url = new URL(match.url.href);
    const desired = clampRounds(settings.keepRounds);
    const existing = Number(url.searchParams.get("num_turns"));
    if (
      match.kind === "initial" ||
      !Number.isFinite(existing) ||
      existing <= 0 ||
      existing > desired
    ) {
      url.searchParams.set("num_turns", String(desired));
    }

    return {
      kind: match.kind,
      originalUrl: match.url.href,
      rewrittenUrl: url.href,
      changed: url.href !== match.url.href,
      hasBefore: match.url.searchParams.has("before")
    };
  }

  function rebuildFetchInput(input, rewrittenUrl) {
    if (input instanceof Request) {
      return new Request(rewrittenUrl, input);
    }
    if (input instanceof URL) {
      return new URL(rewrittenUrl);
    }
    return rewrittenUrl;
  }

  async function wrappedFetch(input, init) {
    const info = requestInfo(input, init);
    const started = performance.now();

    const conversation = matchConversationUrl(info.url);
    if (conversation && !settingsReady) await settingsReadyPromise;

    if (settings.enabled && conversation) {
      const rewritten = rewriteConversationUrl(info.url);

      if (rewritten) {
        // A /messages?before=... request is specifically asking for older history.
        // Stop it at the network boundary, regardless of which HTTP method was used.
        if (
          rewritten.kind === "messages" &&
          rewritten.hasBefore
        ) {
          stats.conversationRequests += 1;
          stats.paginationRequests += 1;
          stats.blockedPaginationRequests += 1;

          stats.lastBlockedPagination = {
            request: pathForLog(rewritten.originalUrl),
            returnedEmptyPage: true,
            durationMs: Math.round(performance.now() - started)
          };

          pushRequest({
            channel: "blocked-history-page",
            ...stats.lastBlockedPagination
          });

          emit("STATUS", snapshot());
          return buildEmptyHistoryResponse(rewritten.originalUrl);
        }

        if (info.method === "GET") {
          stats.conversationRequests += 1;
          if (rewritten.kind === "messages") stats.paginationRequests += 1;

          if (rewritten.changed) {
            stats.rewrittenRequests += 1;
          }

          const nextInput = rewritten.changed
            ? rebuildFetchInput(input, rewritten.rewrittenUrl)
            : input;

          try {
            let response = await originalFetch(nextInput, init);

            if (rewritten.kind === "initial") {
              response = await lockInitialHistoryBoundary(response);
            }

            stats.lastConversationRequest = {
              kind: rewritten.kind,
              changed: rewritten.changed,
              requested: pathForLog(rewritten.originalUrl),
              sent: pathForLog(rewritten.rewrittenUrl),
              status: response.status,
              contentType: response.headers.get("content-type"),
              contentLength: response.headers.get("content-length"),
              durationMs: Math.round(performance.now() - started)
            };

            pushRequest({
              channel: "conversation",
              ...stats.lastConversationRequest
            });

            emit("STATUS", snapshot());
            return response;
          } catch (error) {
            pushRequest({
              channel: "conversation-error",
              request: pathForLog(rewritten.rewrittenUrl),
              error: String(error?.message || error)
            });
            throw error;
          }
        }
      }
    }

    let urlObj = null;
    try { urlObj = new URL(info.url, location.href); } catch {}

    const isBatch =
      info.method === "POST" &&
      urlObj?.origin === location.origin &&
      urlObj.pathname === "/backend-api/conversations/batch";

    const response = await originalFetch(input, init);

    if (isBatch) {
      stats.batchRequests += 1;
      stats.lastBatchRequest = {
        status: response.status,
        contentType: response.headers.get("content-type"),
        contentLength: response.headers.get("content-length"),
        durationMs: Math.round(performance.now() - started)
      };

      pushRequest({
        channel: "conversations-batch",
        ...stats.lastBatchRequest
      });

      emit("STATUS", snapshot());
    }

    return response;
  }

  try {
    Object.defineProperty(wrappedFetch, "name", { value: "fetch" });
    Object.defineProperty(window, "fetch", {
      configurable: true,
      writable: true,
      value: wrappedFetch
    });
  } catch {
    window.fetch = wrappedFetch;
  }

  function isPaginationSentinel(target) {
    if (!(target instanceof Element)) return false;
    const testId = target.getAttribute("data-testid") || "";

    if (testId.includes("conversation-pagination-sentinel")) return true;

    return (
      testId.includes("pagination") &&
      (testId.includes("conversation") || testId.includes("history"))
    );
  }

  if (typeof NativeIntersectionObserver === "function") {
    class GuardedIntersectionObserver {
      constructor(callback, options) {
        this._observer = new NativeIntersectionObserver((entries) => {
          const filtered = [];

          for (const entry of entries) {
            const block =
              settings.enabled &&
              entry.isIntersecting &&
              isPaginationSentinel(entry.target);

            if (block) {
              stats.blockedPaginationEntries += 1;
            } else {
              filtered.push(entry);
            }
          }

          if (filtered.length) callback(filtered, this);
          if (stats.blockedPaginationEntries) emit("STATUS", snapshot());
        }, options);
      }

      observe(target) { return this._observer.observe(target); }
      unobserve(target) { return this._observer.unobserve(target); }
      disconnect() { return this._observer.disconnect(); }

      takeRecords() {
        return this._observer.takeRecords().filter(entry => {
          const block =
            settings.enabled &&
            entry.isIntersecting &&
            isPaginationSentinel(entry.target);

          if (block) stats.blockedPaginationEntries += 1;
          return !block;
        });
      }

      get root() { return this._observer.root; }
      get rootMargin() { return this._observer.rootMargin; }
      get thresholds() { return this._observer.thresholds; }
    }

    try {
      Object.setPrototypeOf(
        GuardedIntersectionObserver.prototype,
        NativeIntersectionObserver.prototype
      );
      Object.setPrototypeOf(GuardedIntersectionObserver, NativeIntersectionObserver);
      Object.defineProperty(GuardedIntersectionObserver, "name", {
        value: "IntersectionObserver"
      });
      Object.defineProperty(window, "IntersectionObserver", {
        configurable: true,
        writable: true,
        value: GuardedIntersectionObserver
      });
    } catch {
      window.IntersectionObserver = GuardedIntersectionObserver;
    }
  }

  function installRenderStyle() {
    const styleId = "cgo-v08-render-style";

    const apply = () => {
      let style = document.getElementById(styleId);

      if (!settings.renderOptimize) {
        style?.remove();
        return;
      }

      if (!style) {
        style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
          [data-content-search-unit-key] {
            content-visibility: auto;
            contain-intrinsic-size: auto 700px;
          }

          [data-testid*="conversation-pagination-sentinel"],
          [data-testid*="history-pagination-sentinel"] {
            display: none !important;
          }

          [data-cgo-live-hidden="true"] {
            display: none !important;
          }
        `;
        (document.head || document.documentElement).appendChild(style);
      }
    };

    if (document.documentElement) apply();
    else document.addEventListener("DOMContentLoaded", apply, { once: true });

    return apply;
  }

  const refreshRenderStyle = installRenderStyle();

  function getThreadScrollContainer() {
    return (
      document.querySelector(".thread-scroll-container") ||
      [...document.querySelectorAll("div")].find(el => {
        try {
          const style = getComputedStyle(el);
          return (
            ["auto", "scroll"].includes(style.overflowY) &&
            el.scrollHeight > el.clientHeight * 2 &&
            el.clientHeight > 250
          );
        } catch {
          return false;
        }
      }) ||
      null
    );
  }

  function allContentUnits() {
    const root = getThreadScrollContainer() || document;
    return [...root.querySelectorAll(
      "[data-content-search-unit-key]"
    )].filter(el => el instanceof HTMLElement);
  }

  function unitRole(el) {
    const key = el.getAttribute("data-content-search-unit-key") || "";

    const keyRole = key.match(
      /:(user|assistant|tool|system|developer)(?:$|:)/
    );
    if (keyRole) return keyRole[1];

    if (
      el.matches('[data-user-message-bubble="true"]') ||
      el.querySelector('[data-user-message-bubble="true"]')
    ) {
      return "user";
    }

    if (el.querySelector(".markdown") || el.querySelector('[class*="markdown"]')) {
      return "assistant";
    }

    return null;
  }

  function turnIndexOf(el) {
    const key = el.getAttribute("data-content-search-unit-key") || "";

    let match = key.match(/(?:^|:)fallback-turn-(\d+)(?=:|$)/);
    if (match) return Number.parseInt(match[1], 10);

    match = key.match(/(?:^|:)turn-(\d+)(?=:|$)/);
    if (match) return Number.parseInt(match[1], 10);

    return null;
  }

  function rememberUnit(el) {
    if (hiddenUnits.has(el)) return;

    hiddenUnits.set(el, {
      display: el.style.display,
      ariaHidden: el.getAttribute("aria-hidden")
    });
  }

  function hideUnit(el) {
    rememberUnit(el);
    el.style.display = "none";
    el.setAttribute("data-cgo-live-hidden", "true");
    el.setAttribute("aria-hidden", "true");
  }

  function showUnit(el) {
    const previous = hiddenUnits.get(el);

    if (!previous) {
      el.removeAttribute("data-cgo-live-hidden");
      return;
    }

    el.style.display = previous.display;

    if (previous.ariaHidden === null) {
      el.removeAttribute("aria-hidden");
    } else {
      el.setAttribute("aria-hidden", previous.ariaHidden);
    }

    el.removeAttribute("data-cgo-live-hidden");
    hiddenUnits.delete(el);
  }

  function restoreAllUnits() {
    for (const el of [...hiddenUnits.keys()]) {
      if (el?.isConnected) showUnit(el);
      else hiddenUnits.delete(el);
    }
    stats.liveHiddenUnits = 0;
  }

  function isNearBottom(container) {
    if (!container) return false;

    return (
      container.scrollHeight -
      container.scrollTop -
      container.clientHeight
    ) < 320;
  }

  function applyLiveWindow(reason = "mutation") {
    liveApplyTimer = null;
    stats.liveScans += 1;
    stats.liveLastReason = reason;

    if (!settings.enabled || !settings.liveWindow) {
      restoreAllUnits();
      emit("STATUS", snapshot());
      return;
    }

    const units = allContentUnits();
    const userUnits = units.filter(el => unitRole(el) === "user");

    stats.liveUnits = units.length;
    stats.liveUserUnits = userUnits.length;

    const keep = clampRounds(settings.keepRounds);
    const indexedUsers = userUnits
      .map(el => ({ el, index: turnIndexOf(el) }))
      .filter(item => Number.isInteger(item.index));

    const scroll = getThreadScrollContainer();
    const stayAtBottom = isNearBottom(scroll);
    let hiddenCount = 0;
    let visibleUserRounds = 0;
    let cutoffTurnIndex = null;

    if (indexedUsers.length) {
      const localMax = Math.max(...indexedUsers.map(item => item.index));

      if (highestTurnIndexSeen === null || localMax > highestTurnIndexSeen) {
        highestTurnIndexSeen = localMax;
      }

      cutoffTurnIndex = highestTurnIndexSeen - keep + 1;

      for (const el of units) {
        const index = turnIndexOf(el);

        if (Number.isInteger(index) && index < cutoffTurnIndex) {
          hideUnit(el);
          hiddenCount += 1;
        } else {
          showUnit(el);
          if (unitRole(el) === "user") visibleUserRounds += 1;
        }
      }

      visibleUserRounds = Math.min(keep, visibleUserRounds);
    } else if (userUnits.length > keep) {
      const cutoffUser = userUnits[userUnits.length - keep];
      const cutoffIndex = units.indexOf(cutoffUser);

      if (cutoffIndex >= 0) {
        for (let i = 0; i < units.length; i++) {
          if (i < cutoffIndex) {
            hideUnit(units[i]);
            hiddenCount += 1;
          } else {
            showUnit(units[i]);
          }
        }
      }

      visibleUserRounds = keep;
    } else {
      for (const el of units) showUnit(el);
      visibleUserRounds = userUnits.length;
    }

    for (const el of [...hiddenUnits.keys()]) {
      if (!el.isConnected) hiddenUnits.delete(el);
    }

    stats.liveHiddenUnits = hiddenCount;
    stats.liveVisibleUserRounds = visibleUserRounds;
    stats.liveHighestTurnIndex = highestTurnIndexSeen;
    stats.liveCutoffTurnIndex = cutoffTurnIndex;

    if (reason === "new-content" && stayAtBottom && scroll) {
      requestAnimationFrame(() => {
        scroll.scrollTop = scroll.scrollHeight;
      });
    }

    emit("STATUS", snapshot());
  }

  function scheduleLiveWindow(reason = "mutation", delay = 100) {
    if (liveApplyTimer !== null) clearTimeout(liveApplyTimer);
    liveApplyTimer = setTimeout(() => applyLiveWindow(reason), delay);
  }

  function startLiveObserver() {
    if (liveObserver) return;

    const start = () => {
      if (!document.documentElement) {
        setTimeout(start, 0);
        return;
      }

      liveObserver = new MutationObserver(mutations => {
        let relevant = false;

        for (const mutation of mutations) {
          if (mutation.type !== "childList") continue;

          for (const node of mutation.addedNodes) {
            if (!(node instanceof Element)) continue;

            if (
              node.matches?.("[data-content-search-unit-key]") ||
              node.querySelector?.("[data-content-search-unit-key]") ||
              node.matches?.('[data-user-message-bubble="true"]') ||
              node.querySelector?.('[data-user-message-bubble="true"]')
            ) {
              relevant = true;
              break;
            }
          }

          if (relevant) break;
        }

        if (relevant) scheduleLiveWindow("new-content", 80);
      });

      liveObserver.observe(document.documentElement, {
        childList: true,
        subtree: true
      });

      scheduleLiveWindow("startup", 500);
    };

    start();
  }

  startLiveObserver();

  setInterval(() => {
    if (location.href === lastUrl) return;

    lastUrl = location.href;
    highestTurnIndexSeen = null;
    restoreAllUnits();
    scheduleLiveWindow("navigation", 350);
  }, 600);

  function performanceSnapshot() {
    let heap = null;

    try {
      if (performance.memory) {
        heap = {
          usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
          totalMB: Math.round(performance.memory.totalJSHeapSize / 1048576),
          limitMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576)
        };
      }
    } catch {}

    const nav = performance.getEntriesByType("navigation")[0];

    return {
      heap,
      navigation: nav ? {
        durationMs: Math.round(nav.duration || 0),
        responseStartMs: Math.round(nav.responseStart || 0),
        domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd || 0),
        loadEventMs: Math.round(nav.loadEventEnd || 0),
        transferSize: nav.transferSize || null,
        decodedBodySize: nav.decodedBodySize || null
      } : null
    };
  }

  function liveDiagnostic() {
    const units = allContentUnits();
    const roles = units.map(unitRole);

    return {
      unitCount: units.length,
      userUnits: roles.filter(role => role === "user").length,
      assistantUnits: roles.filter(role => role === "assistant").length,
      toolUnits: roles.filter(role => role === "tool").length,
      unknownUnits: roles.filter(role => !role).length,
      hiddenUnits: units.filter(
        el => el.getAttribute("data-cgo-live-hidden") === "true"
      ).length,
      highestTurnIndexSeen,
      cutoffTurnIndex: stats.liveCutoffTurnIndex,
      sampleKeys: units.slice(-8).map(el => {
        const key = el.getAttribute("data-content-search-unit-key") || "";
        return key.slice(0, 120);
      })
    };
  }

  function snapshot() {
    return {
      ...stats,
      settings: { ...settings },
      ...performanceSnapshot(),
      liveDiagnostic: liveDiagnostic(),
      recentRequests: recentRequests.slice(-30)
    };
  }

  window.addEventListener("message", event => {
    if (event.source !== window) return;

    const message = event.data;
    if (
      !message ||
      message.source !== CHANNEL ||
      message.direction !== "TO_MAIN"
    ) {
      return;
    }

    if (message.type === "GET_STATUS") {
      emit("STATUS", snapshot());
      return;
    }

    if (message.type === "REFRESH_SETTINGS") {
      settings = message.payload && typeof message.payload === "object"
        ? normalizeSettings(message.payload)
        : readSettings();
      markSettingsReady();
      refreshRenderStyle();

      if (!settings.enabled || !settings.liveWindow) {
        restoreAllUnits();
      }

      scheduleLiveWindow("settings", 0);
      emit("STATUS", snapshot());
      return;
    }

    if (message.type === "APPLY_LIVE_NOW") {
      applyLiveWindow("manual");
    }
  });

  setTimeout(() => {
    settings = readSettings();
    refreshRenderStyle();
    scheduleLiveWindow("delayed-startup", 0);
    emit("STATUS", snapshot());
  }, 150);

  emit("READY", snapshot());
})();
