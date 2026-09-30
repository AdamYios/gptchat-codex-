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
  let liveApplyDueAt = 0;
  let liveApplyReason = "";
  let liveObserver = null;
  let anchoredScrollContainer = null;
  let previousOverflowAnchor = "";

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
        /^\/backend-api\/(conversations|conversation)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/messages)?\/?$/i
      );
      if (!match) return null;

      return {
        url,
        endpoint: match[1].toLowerCase() === "conversation" ? "singular" : "plural",
        conversationId: match[2],
        kind: match[3] ? "messages" : "initial"
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

  function messageRole(item) {
    return item?.message?.author?.role || item?.author?.role || item?.role || null;
  }

  function trimMessageArray(messages, keepRounds) {
    if (!Array.isArray(messages)) return {messages, trimmed: false};
    const userIndexes = [];
    messages.forEach((message, index) => {
      if (messageRole(message) === "user") userIndexes.push(index);
    });
    if (userIndexes.length <= keepRounds) return {messages, trimmed: false};
    return {
      messages: messages.slice(userIndexes[userIndexes.length - keepRounds]),
      trimmed: true
    };
  }

  function trimConversationMapping(data, keepRounds) {
    const mapping = data?.mapping;
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return false;

    let nodeId = data.current_node == null ? "" : String(data.current_node);
    if (!nodeId || !Object.prototype.hasOwnProperty.call(mapping, nodeId)) return false;

    const reversePath = [];
    const visited = new Set();
    while (nodeId && Object.prototype.hasOwnProperty.call(mapping, nodeId) && !visited.has(nodeId)) {
      visited.add(nodeId);
      reversePath.push(nodeId);
      const parent = mapping[nodeId]?.parent;
      nodeId = typeof parent === "string" ? parent : "";
    }
    const path = reversePath.reverse();
    const userIndexes = [];
    path.forEach((id, index) => {
      if (messageRole(mapping[id]) === "user") userIndexes.push(index);
    });
    const startIndex = userIndexes.length > keepRounds
      ? userIndexes[userIndexes.length - keepRounds]
      : 0;
    const retainedIds = path.slice(startIndex);
    const retained = new Set(retainedIds);
    const mappingHasOtherNodes = Object.keys(mapping).some(id => !retained.has(id));
    const historyTrimmed = startIndex > 0 || mappingHasOtherNodes;
    if (!historyTrimmed) return false;

    const nextMapping = {};
    retainedIds.forEach((id, index) => {
      const node = mapping[id];
      if (!node || typeof node !== "object") return;
      nextMapping[id] = {
        ...node,
        parent: index === 0 ? null : node.parent,
        children: Array.isArray(node.children)
          ? node.children.filter(childId => retained.has(String(childId)))
          : []
      };
    });
    data.mapping = nextMapping;
    return true;
  }

  function trimConversationHistory(data, keepRounds) {
    if (!data || typeof data !== "object") return false;
    let trimmed = trimConversationMapping(data, keepRounds);
    if (Array.isArray(data.messages)) {
      const result = trimMessageArray(data.messages, keepRounds);
      if (result.trimmed) {
        data.messages = result.messages;
        trimmed = true;
      }
    }
    return trimmed;
  }

  async function lockInitialHistoryBoundary(response, keepRounds = null) {
    if (!response?.ok) return response;

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("json")) return response;

    try {
      const data = await response.clone().json();

      if (!data || typeof data !== "object") return response;

      const historyTrimmed = Number.isInteger(keepRounds) &&
        trimConversationHistory(data, clampRounds(keepRounds));
      const hasPageInfo = data.page_info && typeof data.page_info === "object";
      const alreadyLocked = hasPageInfo &&
        data.page_info.has_previous_page === false &&
        (data.page_info.start_cursor == null || data.page_info.start_cursor === "");

      if (!historyTrimmed && (!hasPageInfo || alreadyLocked)) return response;

      let normalized = data;
      if (hasPageInfo && !alreadyLocked) {
        stats.initialResponsesLocked += 1;
        normalized = {
          ...data,
          page_info: {
            ...data.page_info,
            has_previous_page: false,
            start_cursor: null
          }
        };
      }

      return responseFromJson(
        response,
        normalized,
        historyTrimmed ? "history-response-trimmed" : "history-boundary-locked"
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
      endpoint: match.endpoint,
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
              const keepRounds = rewritten.endpoint === "singular"
                ? clampRounds(settings.keepRounds)
                : null;
              response = await lockInitialHistoryBoundary(response, keepRounds);
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
    const ariaLabel = target.getAttribute("aria-label") || "";
    const className = typeof target.className === "string" ? target.className : "";
    const identity = `${testId} ${ariaLabel} ${className}`.toLowerCase();
    const isBoundary =
      (identity.includes("conversation") || identity.includes("history")) &&
      (identity.includes("pagination") || identity.includes("sentinel") ||
        identity.includes("spacer"));

    if (isBoundary && target.getAttribute("data-cgo-history-boundary") !== "true") {
      target.setAttribute("data-cgo-history-boundary", "true");
    }
    return isBoundary;
  }

  if (typeof NativeIntersectionObserver === "function") {
    class GuardedIntersectionObserver {
      constructor(callback, options) {
        this._observer = new NativeIntersectionObserver((entries) => {
          const filtered = [];

          for (const entry of entries) {
            const block = settings.enabled && isPaginationSentinel(entry.target);

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
          const block = settings.enabled && isPaginationSentinel(entry.target);

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
      const needsStyle = settings.renderOptimize ||
        (settings.enabled && settings.liveWindow);

      if (!needsStyle) {
        style?.remove();
        return;
      }

      if (!style) {
        style = document.createElement("style");
        style.id = styleId;
        (document.head || document.documentElement).appendChild(style);
      }
      style.textContent = `${settings.renderOptimize ? `
        [data-content-search-unit-key] {
          content-visibility: auto;
          contain-intrinsic-size: auto 700px;
        }
      ` : ""}${settings.enabled && settings.liveWindow ? `
        [data-testid*="conversation-pagination-sentinel"],
        [data-testid*="history-pagination-sentinel"],
        [data-cgo-history-boundary="true"] {
          display: none !important;
          height: 0 !important;
          min-height: 0 !important;
          margin: 0 !important;
          padding: 0 !important;
        }

        [data-cgo-live-hidden="true"] {
          display: none !important;
        }
      ` : ""}`;
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

  function layoutTargetForUnit(el) {
    return el.closest?.('[data-testid*="conversation-turn"]') || el;
  }

  function rememberUnit(el) {
    const target = layoutTargetForUnit(el);
    if (hiddenUnits.has(target)) return;

    hiddenUnits.set(target, {
      display: target.style.display,
      ariaHidden: target.getAttribute("aria-hidden")
    });
  }

  function hideUnit(el) {
    const target = layoutTargetForUnit(el);
    rememberUnit(target);
    target.style.display = "none";
    target.setAttribute("data-cgo-live-hidden", "true");
    target.setAttribute("aria-hidden", "true");
  }

  function showUnit(el) {
    const target = layoutTargetForUnit(el);
    const previous = hiddenUnits.get(target);

    if (!previous) {
      target.removeAttribute("data-cgo-live-hidden");
      return;
    }

    target.style.display = previous.display;

    if (previous.ariaHidden === null) {
      target.removeAttribute("aria-hidden");
    } else {
      target.setAttribute("aria-hidden", previous.ariaHidden);
    }

    target.removeAttribute("data-cgo-live-hidden");
    hiddenUnits.delete(target);
  }

  function applyUnitVisibility(units, shouldHideUnit) {
    const groups = new Map();
    units.forEach((el, index) => {
      const target = layoutTargetForUnit(el);
      if (!groups.has(target)) groups.set(target, []);
      groups.get(target).push({el, hide: shouldHideUnit(el, index)});
    });

    let hiddenCount = 0;
    let visibleUserRounds = 0;
    for (const [target, entries] of groups) {
      const hide = entries.every(entry => entry.hide);
      if (hide) {
        hideUnit(target);
        hiddenCount += entries.length;
      } else {
        showUnit(target);
        visibleUserRounds += entries.filter(entry => unitRole(entry.el) === "user").length;
      }
    }
    return {hiddenCount, visibleUserRounds};
  }

  function disableScrollAnchoring(container) {
    if (!container) return;
    if (anchoredScrollContainer && anchoredScrollContainer !== container) {
      restoreScrollAnchoring();
    }
    if (!anchoredScrollContainer) {
      anchoredScrollContainer = container;
      previousOverflowAnchor = container.style.overflowAnchor || "";
    }
    container.style.overflowAnchor = "none";
  }

  function restoreScrollAnchoring() {
    if (!anchoredScrollContainer) return;
    if (anchoredScrollContainer.isConnected) {
      anchoredScrollContainer.style.overflowAnchor = previousOverflowAnchor;
    }
    anchoredScrollContainer = null;
    previousOverflowAnchor = "";
  }

  function restoreAllUnits() {
    for (const el of [...hiddenUnits.keys()]) {
      if (el?.isConnected) showUnit(el);
      else hiddenUnits.delete(el);
    }
    stats.liveHiddenUnits = 0;
    restoreScrollAnchoring();
  }

  function isNearBottom(container) {
    if (!container) return false;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (maxScrollTop <= 1) return true;
    return container.scrollTop > 0 && maxScrollTop - container.scrollTop < 320;
  }

  function applyLiveWindow(reason = "mutation") {
    liveApplyTimer = null;
    liveApplyDueAt = 0;
    liveApplyReason = "";
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
    if (scroll) disableScrollAnchoring(scroll);
    else restoreScrollAnchoring();
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
      const visibility = applyUnitVisibility(units, el => {
        const index = turnIndexOf(el);
        return Number.isInteger(index) && index < cutoffTurnIndex;
      });
      hiddenCount = visibility.hiddenCount;
      visibleUserRounds = Math.min(keep, visibility.visibleUserRounds);
    } else if (userUnits.length > keep) {
      const cutoffUser = userUnits[userUnits.length - keep];
      const cutoffIndex = units.indexOf(cutoffUser);

      if (cutoffIndex >= 0) {
        const visibility = applyUnitVisibility(units, (_el, index) => index < cutoffIndex);
        hiddenCount = visibility.hiddenCount;
        visibleUserRounds = visibility.visibleUserRounds;
      }

      visibleUserRounds = Math.min(keep, visibleUserRounds);
    } else {
      const visibility = applyUnitVisibility(units, () => false);
      visibleUserRounds = visibility.visibleUserRounds;
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
    const dueAt = Date.now() + Math.max(0, delay);
    if (liveApplyTimer !== null && liveApplyDueAt <= dueAt) return;
    if (liveApplyTimer !== null) clearTimeout(liveApplyTimer);
    liveApplyDueAt = dueAt;
    liveApplyReason = reason;
    liveApplyTimer = setTimeout(() => applyLiveWindow(liveApplyReason), Math.max(0, dueAt - Date.now()));
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
        el => layoutTargetForUnit(el).getAttribute("data-cgo-live-hidden") === "true"
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
