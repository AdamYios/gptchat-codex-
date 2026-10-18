(() => {
  const DEFAULT_TITLE = /给\s*Codex\s*的指令|Instructions?\s+for\s+Codex/i;
  const REPORT_PREFIX = "以下是 Codex 上一轮的最终报告";
  const CODEX_FORWARDING_PROMPT = `【处理原则】你是一名代码工程师，你负责审核并决定是否执行方案指令。每次执行前，先向用户简要报告方案审核结论：说明对目标和范围的理解、可行性判断及依据，并明确是否存在实质分歧；即使没有分歧，也要说明“无实质分歧”及判断理由。无实质分歧时，报告后直接继续执行，不需等待确认。你不只是执行方案，也要结合本地项目评估其可行性、复杂度、风险和架构契合度。如果你认为目标、技术方案或关键前提存在分歧——例如方案不可行、实现代价明显不合适，或有更合适的替代方案——先报告你的判断、依据和选项，等待用户决定；不要先按自己的方案修改。\n【以下为任务指令；请按以上原则核验并处理】`;
  const MAX_CODEX_INSTRUCTION_CHARS = 20000;
  const STOP = /^[\s#*_]*(任务完成|已完成|完成|需要人工处理|等待人工|human action required|task complete)/i;
  let busy = false;
  let lastSignature = "";
  let stableSince = 0;
  let lastSubmitted = sessionStorage.getItem("bridge.lastSubmitted") || "";
  let sentReport = Number(sessionStorage.getItem("bridge.sentReport") || "0");
  let attemptedReport = Number(sessionStorage.getItem("bridge.attemptedReport") || "0");
  let attemptedAt = Number(sessionStorage.getItem("bridge.attemptedAt") || "0");
  let preSendAssistant = sessionStorage.getItem("bridge.preSendAssistant") || "";
  let preSendAssistantContentSignature = sessionStorage.getItem("bridge.preSendAssistantContentSignature") || "";
  let preSendAssistantCount = Number(sessionStorage.getItem("bridge.preSendAssistantCount") || "0");
  let preSendAssistantUnitKey = "";
  let preSendUserCount = Number(sessionStorage.getItem("bridge.preSendUserCount") || "0");
  let preSendUserText = sessionStorage.getItem("bridge.preSendUserText") || "";
  let preSendUserUnitKeys;
  try {
    const savedKeys = JSON.parse(sessionStorage.getItem("bridge.preSendUserUnitKeys") || "[]");
    preSendUserUnitKeys = Array.isArray(savedKeys)
      ? savedKeys.filter(key => typeof key === "string" && key) : [];
  } catch { preSendUserUnitKeys = []; }
  let preSendUserUnitKeysReportId = Number(sessionStorage.getItem("bridge.preSendUserUnitKeysReportId") || "0");
  let preSendGenerating = sessionStorage.getItem("bridge.preSendGenerating") === "true";
  let preSendGeneratingReportId = Number(sessionStorage.getItem("bridge.preSendGeneratingReportId") || "0");
  let runId = sessionStorage.getItem("bridge.runId") || "";
  let baselinedReport = Number(sessionStorage.getItem("bridge.baselinedReport") || "0");
  let confirmationBaselineId = Number(sessionStorage.getItem("bridge.confirmationBaselineId") || "0");
  let confirmationBaselineCounts;
  try { confirmationBaselineCounts = JSON.parse(sessionStorage.getItem("bridge.confirmationBaselineCounts") || "null"); }
  catch { confirmationBaselineCounts = null; }
  let instructionStates;
  try {
    const saved = JSON.parse(sessionStorage.getItem("bridge.instructionStates") || "[]");
    instructionStates = new Map(Array.isArray(saved)
      ? saved.filter(entry => Array.isArray(entry) && entry.length === 2 &&
        typeof entry[0] === "string" && ["pending", "seen"].includes(entry[1]))
      : []);
  } catch { instructionStates = new Map(); }
  let lastPhase = "";
  const recordedEvents = new Set();
  let reportWakeQueued = false;
  let assistantWaitDiagnostic = null;
  let assistantWaitObserver = null;
  let assistantWaitTickQueued = false;
  let assistantWaitQueuedWakeCount = 0;
  let assistantWaitQueuedWakeLogged = false;
  let assistantWaitLastWakeAt = 0;
  const ASSISTANT_WAIT_WAKE_MIN_INTERVAL_MS = 250;
  const ASSISTANT_WAIT_HIDDEN_WAKE_MIN_INTERVAL_MS = 1800;
  let optimizerDiagnosticStatus = null;
  let phaseStatus = "等待桥接器状态";
  let phaseStatusError = false;
  let phaseChangedAt = Date.now();
  let lastCheckAt = 0;
  let actionStatus = "";
  let actionStatusError = false;
  let actionChangedAt = 0;
  const scriptInstance = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let tickInterval = null;
  let flowEpoch = 0;
  let automaticLoopStopped = false;
  let pageObserver = null;
  let focusedPageObserver = null;
  let pageCheckQueued = false;
  let pageWakeTimer = null;
  let observedAssistant = null;
  let pageRevision = 0;
  let nextAutomaticCheckAt = 0;
  let emptyCardChecks = 0;
  let pageIsGenerating = false;
  let scanPass = null;
  let cardScanCache = new WeakMap();
  const signatureFingerprints = new Map();
  let scanMetrics = {checkCount: 0, cardParseCount: 0, cardCacheHits: 0, cardParseMs: 0};
  let lastScanMetricsAt = 0;
  const CARD_CACHE_MAX_AGE_MS = 30000;
  const EMPTY_CARD_DELAYS_MS = [2000, 5000, 10000, 30000];
  const LOG_REPEAT_INTERVAL_MS = 30000;
  const RATE_LIMITED_LOG_EVENTS = new Set(["assistant_wait_tick", "assistant_wait_pending_submit",
    "page_stability_checkpoint", "page_stability_reset", "page_stability_wait_started"]);
  const rateLimitedLogStates = new Map();
  const STATUS_WIDGET_POSITION_KEY = "bridge.statusWidgetPosition";
  const STATUS_WIDGET_COLLAPSED_KEY = "bridge.statusWidgetCollapsed";

  try {
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("message", event => {
        const message = event.data;
        if (event.source !== window || message?.source !== "CHATGPT_LONG_CHAT_OPTIMIZER" ||
            message.direction !== "FROM_MAIN" || !["READY", "STATUS"].includes(message.type)) return;
        const payload = message.payload || {};
        optimizerDiagnosticStatus = {
          liveScans: Number.isFinite(Number(payload.liveScans)) ? Number(payload.liveScans) : null,
          liveUnits: Number.isFinite(Number(payload.liveUnits)) ? Number(payload.liveUnits) : null,
          liveHiddenUnits: Number.isFinite(Number(payload.liveHiddenUnits)) ? Number(payload.liveHiddenUnits) : null,
          liveLastReason: typeof payload.liveLastReason === "string" ? payload.liveLastReason : ""
        };
      });
    }
  } catch { /* Optimizer diagnostics are optional and must not affect bridge startup. */ }

  function operationSnapshot() {
    const editor = composer();
    const button = editor && sendButton(editor);
    return {
      assistantMessages: assistantMessages().length,
      userMessages: userMessages().length,
      conversationTurns: document.querySelectorAll('[data-testid*="conversation-turn"]').length,
      articles: document.querySelectorAll("article").length,
      copyButtons: [...document.querySelectorAll("button")].filter(isCopyButton).length,
      stopButtons: document.querySelectorAll('[data-testid="stop-button"]').length,
      mainFound: !!document.querySelector("main"),
      composerFound: !!editor,
      composerTag: editor?.tagName || "",
      composerLength: (editor?.innerText || editor?.textContent || "").length,
      sendButtonFound: !!button,
      sendButtonDisabled: !!button && (button.disabled || button.getAttribute("aria-disabled") === "true")
    };
  }

  function logStateSignature(event, data) {
    const fields = event === "assistant_wait_tick"
      ? ["reportId", "cardFirstSeen", "assistantTurnDetected", "replyCompleted", "visibilityState",
        "busy", "phase", "isGenerating", "assistantCount", "latestAssistantUnitKey",
        "assistantUnitKeyChanged", "assistantSignatureChanged", "assistantCountChanged",
        "assistantSelectionSource"]
      : ["reportId", "cardFirstSeen", "visibilityState", "phase", "reason", "pendingSubmit",
        "assistantTurnDetected", "replyCompleted", "isGenerating"];
    return JSON.stringify(fields.map(field => [field, data?.[field] ?? null]));
  }

  function shouldRecordRateLimitedEvent(event, data) {
    if (!RATE_LIMITED_LOG_EVENTS.has(event)) return true;
    const now = Date.now();
    const signature = logStateSignature(event, data);
    const key = event === "page_stability_reset" ? `${event}:${data.reason || ""}` : event;
    const previous = rateLimitedLogStates.get(key);
    if (previous && previous.signature === signature &&
        now - previous.loggedAt < LOG_REPEAT_INTERVAL_MS) return false;
    rateLimitedLogStates.set(key, {signature, loggedAt: now});
    return true;
  }

  function record(event, data = {}, onceKey = "") {
    if (onceKey) {
      if (recordedEvents.has(onceKey)) return Promise.resolve();
      if (recordedEvents.size >= 512) recordedEvents.delete(recordedEvents.values().next().value);
      recordedEvents.add(onceKey);
    }
    if (!shouldRecordRateLimitedEvent(event, data)) return Promise.resolve();
    let snapshot;
    try {
      snapshot = scanPass?.snapshot || operationSnapshot();
      if (scanPass) scanPass.snapshot = snapshot;
    }
    catch { snapshot = {reason: "snapshot_failed"}; }
    try {
      return chrome.runtime.sendMessage({type: "bridgeLog", occurredAt: new Date().toISOString(), event,
        data: {...snapshot, ...data}}).catch(() => {});
    } catch { return Promise.resolve(); /* Logging must never interrupt the bridge. */ }
  }

  async function api(path, method = "GET", body) {
    const result = await chrome.runtime.sendMessage({type: "bridgeRequest", path, method, body});
    if (!result?.ok) throw new Error(result?.error || "本地桥接无响应");
    return result.data;
  }

  async function bridgeSettings() {
    const result = await chrome.runtime.sendMessage({type: "bridgeGetConfig"});
    if (!result?.ok) throw new Error(result?.error || "无法读取当前标签页的桥接配置");
    return result;
  }

  function statusWidgetPosition(bar) {
    const width = Number(typeof window !== "undefined" && window.innerWidth) ||
      Number(document.documentElement?.clientWidth) || 1280;
    const height = Number(typeof window !== "undefined" && window.innerHeight) ||
      Number(document.documentElement?.clientHeight) || 800;
    const barWidth = Number(bar.offsetWidth) || 320;
    const barHeight = Number(bar.offsetHeight) || 96;
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(STATUS_WIDGET_POSITION_KEY) || "null"); }
    catch { saved = null; }
    if (!Number.isFinite(saved?.left) || !Number.isFinite(saved?.top)) return null;
    return {
      left: Math.min(Math.max(0, saved.left), Math.max(0, width - barWidth)),
      top: Math.min(Math.max(0, saved.top), Math.max(0, height - barHeight))
    };
  }

  function setStatusWidgetPosition(bar, left, top, persist = false) {
    const width = Number(typeof window !== "undefined" && window.innerWidth) ||
      Number(document.documentElement?.clientWidth) || 1280;
    const height = Number(typeof window !== "undefined" && window.innerHeight) ||
      Number(document.documentElement?.clientHeight) || 800;
    const barWidth = Number(bar.offsetWidth) || 320;
    const barHeight = Number(bar.offsetHeight) || 96;
    const position = {
      left: Math.min(Math.max(0, left), Math.max(0, width - barWidth)),
      top: Math.min(Math.max(0, top), Math.max(0, height - barHeight))
    };
    Object.assign(bar.style, {
      left: `${position.left}px`, top: `${position.top}px`, right: "auto", bottom: "auto"
    });
    if (persist) {
      try { sessionStorage.setItem(STATUS_WIDGET_POSITION_KEY, JSON.stringify(position)); }
      catch { /* Widget placement is optional. */ }
    }
    return position;
  }

  function keepStatusWidgetInViewport(bar, persist = false) {
    if (typeof bar?.getBoundingClientRect !== "function") return null;
    const rect = bar.getBoundingClientRect();
    return setStatusWidgetPosition(bar, rect.left, rect.top, persist);
  }

  function setStatusWidgetCollapsed(bar, collapsed, persist = true) {
    const body = bar.querySelector?.(".codex-bridge-status-body");
    const toggle = bar.querySelector?.(".codex-bridge-status-toggle");
    if (!body || !toggle) return;
    bar.dataset.bridgeCollapsed = String(collapsed);
    body.style.display = collapsed ? "none" : "block";
    toggle.textContent = collapsed ? "+" : "−";
    toggle.title = collapsed ? "展开状态窗口" : "收起状态窗口";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    if (persist) {
      try { sessionStorage.setItem(STATUS_WIDGET_COLLAPSED_KEY, String(collapsed)); }
      catch { /* Widget collapse state is optional. */ }
    }
    if (!collapsed && typeof bar.getBoundingClientRect === "function") {
      const rect = bar.getBoundingClientRect();
      setStatusWidgetPosition(bar, rect.left, rect.top, true);
    }
  }

  function initializeStatusWidget(bar) {
    if (bar.querySelector?.(".codex-bridge-status-body") &&
        bar.querySelector?.(".codex-bridge-status-toggle")) return true;
    if (typeof document.createElement !== "function" || typeof bar.appendChild !== "function") return false;

    const header = document.createElement("div");
    header.className = "codex-bridge-status-header";
    Object.assign(header.style, {
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px",
      padding: "6px 8px", cursor: "move", userSelect: "none", touchAction: "none"
    });
    const label = document.createElement("span");
    label.textContent = "Codex 桥接";
    label.style.fontWeight = "600";
    const toggle = document.createElement("button");
    toggle.className = "codex-bridge-status-toggle";
    toggle.type = "button";
    toggle.textContent = "−";
    Object.assign(toggle.style, {
      border: "0", borderRadius: "4px", padding: "0 5px", background: "transparent",
      color: "inherit", cursor: "pointer", font: "16px system-ui", lineHeight: "20px"
    });
    const body = document.createElement("div");
    body.className = "codex-bridge-status-body";
    Object.assign(body.style, {padding: "0 8px 8px", maxWidth: "340px", whiteSpace: "pre-wrap"});
    header.appendChild(label);
    header.appendChild(toggle);
    if (typeof bar.replaceChildren === "function") bar.replaceChildren(header, body);
    else {
      bar.textContent = "";
      bar.appendChild(header);
      bar.appendChild(body);
    }
    Object.assign(bar.style, {
      position: "fixed", bottom: "8px", left: "8px", right: "auto", zIndex: "2147483647",
      padding: "0", borderRadius: "7px", font: "12px system-ui",
      maxWidth: "min(360px, calc(100vw - 16px))", maxHeight: "calc(100vh - 16px)", whiteSpace: "pre-wrap",
      boxShadow: "0 1px 7px #0004", overflow: "auto"
    });
    bar.dataset.bridgeWidgetVersion = "1";
    let initiallyCollapsed = false;
    try { initiallyCollapsed = sessionStorage.getItem(STATUS_WIDGET_COLLAPSED_KEY) === "true"; }
    catch { /* Start expanded if session storage is unavailable. */ }
    const savedPosition = statusWidgetPosition(bar);
    if (savedPosition) setStatusWidgetPosition(bar, savedPosition.left, savedPosition.top);
    setStatusWidgetCollapsed(bar, initiallyCollapsed, false);
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("resize", () => keepStatusWidgetInViewport(bar, true));
    }

    toggle.addEventListener("click", event => {
      event.stopPropagation?.();
      setStatusWidgetCollapsed(bar, bar.dataset.bridgeCollapsed !== "true");
    });
    let drag = null;
    header.addEventListener("pointerdown", event => {
      if (event.target?.closest?.("button") || event.button > 0) return;
      const rect = bar.getBoundingClientRect();
      drag = {pointerId: event.pointerId, offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top};
      try { header.setPointerCapture(event.pointerId); } catch { /* Pointer capture is optional. */ }
      header.style.cursor = "grabbing";
      event.preventDefault?.();
    });
    header.addEventListener("pointermove", event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      setStatusWidgetPosition(bar, event.clientX - drag.offsetX, event.clientY - drag.offsetY);
    });
    const finishDrag = event => {
      if (!drag || (event.pointerId !== undefined && drag.pointerId !== event.pointerId)) return;
      const rect = bar.getBoundingClientRect();
      setStatusWidgetPosition(bar, rect.left, rect.top, true);
      drag = null;
      header.style.cursor = "move";
    };
    header.addEventListener("pointerup", finishDrag);
    header.addEventListener("pointercancel", finishDrag);
    return true;
  }

  function setStatusWidgetMessage(bar, message) {
    const body = bar.querySelector?.(".codex-bridge-status-body");
    if ((body || bar).textContent === message) return;
    if (body) body.textContent = message;
    else bar.textContent = message;
    // The initial empty widget is shorter than its first status message. Clamp
    // again after the content has changed so the expanded widget stays visible.
    if (bar.style?.top && bar.style.top !== "auto") keepStatusWidgetInViewport(bar, true);
  }

  function renderStatus() {
    let bar = document.getElementById("codex-bridge-status");
    if (!bar) {
      bar = document.createElement("div"); bar.id = "codex-bridge-status";
      document.body.appendChild(bar);
    }
    const widgetReady = initializeStatusWidget(bar);
    if (!widgetReady) {
      Object.assign(bar.style, {position: "fixed", bottom: "8px", left: "8px", zIndex: "2147483647",
        padding: "8px 10px", borderRadius: "7px", font: "12px system-ui", maxWidth: "360px",
        whiteSpace: "pre-wrap", boxShadow: "0 1px 7px #0004"});
    }
    bar.dataset.bridgeInstance = scriptInstance;
    bar.style.background = phaseStatusError || actionStatusError ? "#ffdfdf" : "#e5f4e9";
    bar.style.color = "#222";
    const clock = time => new Date(time).toLocaleTimeString();
    setStatusWidgetMessage(bar, `Codex 桥接：${phaseStatus}\n状态更新：${clock(phaseChangedAt)}` +
      (actionStatus ? `\n最近操作 ${clock(actionChangedAt)}：${actionStatus}` : "") +
      (lastCheckAt ? `\n连接检查：${clock(lastCheckAt)}` : ""));
  }

  function status(text, error = false) {
    const unchanged = phaseStatus === text && phaseStatusError === error;
    if (unchanged && Date.now() - lastCheckAt < LOG_REPEAT_INTERVAL_MS) return;
    if (phaseStatus !== text || phaseStatusError !== error) {
      phaseStatus = text;
      phaseStatusError = error;
      phaseChangedAt = Date.now();
      // Keep the recent-activity line useful for automatic bridge progress,
      // not only popup button actions. Repeated polling of the same status
      // does not replace a newer manual action or refresh its timestamp.
      actionStatus = String(text || "").slice(0, 160);
      actionStatusError = error;
      actionChangedAt = phaseChangedAt;
    }
    lastCheckAt = Date.now();
    renderStatus();
  }

  function actionFeedback(text, error = false) {
    actionStatus = String(text || "").slice(0, 160);
    actionStatusError = error;
    actionChangedAt = Date.now();
    renderStatus();
  }

  function stopInvalidatedScript() {
    stopAutomaticLoop();
    const bar = document.getElementById("codex-bridge-status");
    if (bar?.dataset.bridgeInstance === scriptInstance) {
      bar.style.background = "#fff0c2";
      bar.style.color = "#222";
      setStatusWidgetMessage(bar, "扩展已重新加载。请刷新当前 ChatGPT 标签页，然后在弹窗中重新绑定。");
    }
  }

  function assistantMessages() {
    if (scanPass?.messages) return scanPass.messages;
    const current = [...document.querySelectorAll('[data-content-search-unit-key$=":assistant"]')]
      .filter(el => isVisible(el) && messageText(el));
    if (current.length) return scanPass ? (scanPass.messages = current) : current;
    const direct = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
      .filter(el => isVisible(el) && messageText(el));
    if (direct.length) return scanPass ? (scanPass.messages = direct) : direct;
    // A generic conversation turn or article may be a user message. Only use
    // a fallback when the DOM explicitly identifies the assistant author.
    const fallback = [...document.querySelectorAll(
      '[data-author-role="assistant"], [data-role="assistant"], [data-testid*="assistant-message"]'
    )].filter(el => isVisible(el) && messageText(el));
    return scanPass ? (scanPass.messages = fallback) : fallback;
  }

  function messageText(element) {
    if (element && scanPass?.texts.has(element)) return scanPass.texts.get(element);
    const innerText = element?.innerText;
    const rendered = typeof innerText === "string" ? innerText : "";
    const source = rendered.trim() ? rendered : element?.textContent || "";
    const text = String(source).trim();
    if (element && scanPass) scanPass.texts.set(element, text);
    return text;
  }

  function isGenerating() {
    return [...document.querySelectorAll(GENERATION_CONTROL_SELECTOR)].some(button => {
      if (!isVisible(button) || button.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(button);
      return style.display !== "none" && style.visibility !== "hidden";
    });
  }

  function isCopyButton(b) {
    return /^(copy|复制|复制代码|copy code)/i.test(
      `${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""} ${b.innerText || ""}`.trim());
  }

  function isVisible(el) {
    if (scanPass?.visibility.has(el)) return scanPass.visibility.get(el);
    const visible = computeVisibility(el);
    if (scanPass) scanPass.visibility.set(el, visible);
    return visible;
  }

  function computeVisibility(el) {
    if (el.getClientRects && !el.getClientRects().length) return false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (node.hidden || node.getAttribute?.("aria-hidden") === "true") return false;
      if (typeof getComputedStyle === "function") {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" ||
            style.visibility === "collapse" || style.contentVisibility === "hidden") return false;
      }
    }
    return true;
  }

  function hasCopyButton(el) {
    return [...el.querySelectorAll("button")].some(isCopyButton);
  }

  function titleElements(el, titleRegex) {
    return [...el.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading'],span,div,p,strong")]
      .filter(node => node.children.length === 0 &&
        (node.textContent || "").trim().length < 100 &&
        isExactTitle((node.textContent || "").trim(), titleRegex) && isVisible(node));
  }

  function isExactTitle(text, titleRegex) {
    const match = titleRegex.exec(text);
    return !!match && match.index === 0 && match[0].length === text.length;
  }

  function looseTitleElements(el, titleRegex) {
    const nodes = [...el.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading'],span,div,p,strong")]
      .filter(node => isVisible(node) &&
        (node.innerText || node.textContent || "").trim().length < 200 &&
        titleRegex.test((node.innerText || node.textContent || "").trim()));
    // If the title has an icon or other nested markup, keep the smallest
    // matching element instead of requiring a text-only leaf node.
    return nodes.filter(node => !nodes.some(other =>
      other !== node && node.contains?.(other)));
  }

  function cardText(card, titleRegex) {
    // Read rendered text from the live card. Detached clones often have no innerText,
    // and removing aria-hidden wrappers can accidentally remove visible card content.
    const lines = (card.innerText || card.textContent || "").split(/\r?\n/)
      .map(line => line.trim()).filter(line => line && !/^(复制|copy|展开|expand)$/i.test(line));
    const titleIndex = lines.findIndex(line => line.length < 100 && isExactTitle(line, titleRegex));
    if (titleIndex >= 0) lines.splice(titleIndex, 1);
    return lines.join("\n").trim();
  }

  function looseCardText(card, titleText) {
    const lines = (card.innerText || card.textContent || "").split(/\r?\n/)
      .map(line => line.trim()).filter(line => line && !/^(复制|copy|展开|expand)$/i.test(line));
    const heading = normalize(titleText).replace(/^#+\s*/, "");
    const titleIndex = lines.findIndex(line => {
      const normalized = normalize(line).replace(/^#+\s*/, "");
      return normalized === heading || (normalized.startsWith(heading) &&
        /^[\s|｜:：]/.test(normalized.slice(heading.length)));
    });
    if (titleIndex < 0) return "";
    const nextTitle = lines.findIndex((line, index) => index > titleIndex &&
      /^(?:给\s*Codex\s*的指令|Instructions?\s+for\s+Codex|Codex\s*指令卡)/i.test(line));
    return lines.slice(titleIndex + 1, nextTitle < 0 ? undefined : nextTitle).join("\n").trim();
  }

  function extractCard(message, titleRegex, selector) {
    // Direct/manual callers always recheck the DOM. Automatic passes share both
    // positive and negative results, with a bounded fallback for missed mutations.
    if (!scanPass || !message) return parseCard(message, titleRegex, selector);
    const key = `${titleRegex.source}/${titleRegex.flags}:${selector || ""}:${contentUnitKey(message)}`;
    const cached = cardScanCache.get(message);
    if (cached && cached.key === key && cached.revision === pageRevision &&
        Date.now() - cached.at < CARD_CACHE_MAX_AGE_MS) {
      scanPass.cardCacheHits += 1;
      return cached.result;
    }
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const result = parseCard(message, titleRegex, selector);
    cardScanCache.set(message, {key, revision: pageRevision, at: Date.now(), result});
    scanPass.cardScans += 1;
    scanPass.cardScanMs += (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt;
    return result;
  }

  function parseCard(message, titleRegex, selector) {
    let candidates = [];
    if (selector) {
      try { candidates = [...message.querySelectorAll(selector)]; }
      catch { throw new Error("卡片 CSS 选择器无效"); }
    } else {
      const buttons = [...message.querySelectorAll("button")].filter(b => isVisible(b) && isCopyButton(b));
      for (const button of buttons) {
        let node = button.parentElement;
        for (let depth = 0; node && node !== message && depth < 12; depth++, node = node.parentElement) {
          if (titleElements(node, titleRegex).length && cardText(node, titleRegex).length >= 10) {
            candidates.push(node); break;
          }
        }
      }
    }
    candidates = [...new Set(candidates)].filter(c => isVisible(c) && hasCopyButton(c) && c !== message);
    // A card can be matched through several copy buttons and nested wrappers.
    // Keep the innermost matched wrapper, then merge identical visible content.
    candidates = candidates.filter(c => !candidates.some(other => other !== c && c.contains?.(other)));
    const entries = [];
    for (const card of candidates) {
      const instruction = cardText(card, titleRegex);
      if (instruction.includes(REPORT_PREFIX) && instruction.includes("Codex 最终报告：")) continue;
      if (instruction && !entries.some(entry => normalize(entry.instruction) === normalize(instruction)))
        entries.push({instruction, preview: instruction.slice(0, 120)});
    }
    if (entries.length !== 1) return {error: `找到 ${entries.length} 张不同的可见指令卡片`, choices: entries};
    const cardWords = entries[0].instruction;
    if (!cardWords) return {error: "指令卡片内容为空"};
    if (cardWords.length > 20000) return {error: "指令卡片超过桥接器的 20000 字符上限"};
    return {instruction: cardWords};
  }

  // Manual fallback only: expose likely card-shaped blocks when strict
  // matching found nothing. This is never used by the automatic tick loop.
  function looseCardEntries(message, titleRegex) {
    const candidates = new Map();
    const copyButton = node => [...node.querySelectorAll("button")].some(button => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${button.innerText || ""}`;
      return isVisible(button) && /(copy|复制)/i.test(label);
    });
    const titleNodes = looseTitleElements(message, titleRegex);

    // Anchor on the card title and the nearest ancestor with a copy control.
    // That ancestor may still be the full assistant response, so the final
    // text extraction below starts after the title instead of taking it whole.
    for (const titleNode of titleNodes) {
      const titleText = (titleNode.innerText || titleNode.textContent || "").trim();
      for (let depth = 0, current = titleNode.parentElement;
           current && current !== message && depth < 12;
           depth++, current = current.parentElement) {
        const text = (current.innerText || current.textContent || "").trim();
        if (isVisible(current) && text.length >= titleText.length + 20 &&
            text.length <= 20000 && copyButton(current)) {
          if (!candidates.has(current)) candidates.set(current, titleText);
          break;
        }
      }
    }

    // If the heading wrapper only reaches a whole message-level Copy button,
    // extract the body after the actual heading instead of sending the
    // surrounding assistant response as the candidate.
    if (candidates.size === 0) {
      // With no recognized card heading, only expose a bounded code/pre block.
      // A generic message Copy button's ancestors can be the entire latest turn.
      for (const node of [...message.querySelectorAll("pre,code")].filter(isVisible)) {
        const text = (node.innerText || node.textContent || "").trim();
        if (text.length >= 10 && text.length <= 20000) candidates.set(node, "");
      }
    }

    // Candidates were selected at their card boundary; only remove duplicate
    // nodes here. Keeping a parent over a child is what previously swallowed MAIN.
    const entries = [];
    for (const [card, titleText] of candidates) {
      const instruction = titleText ? looseCardText(card, titleText) : cardText(card, titleRegex);
      if (instruction.includes(REPORT_PREFIX) && instruction.includes("Codex 最终报告：")) continue;
      if (instruction && !entries.some(entry => normalize(entry.instruction) === normalize(instruction)))
        entries.push({instruction, preview: instruction.slice(0, 120), relaxed: true});
    }
    return entries;
  }

  function composer() {
    return document.querySelector('#prompt-textarea[contenteditable="true"]') ||
      document.querySelector('[data-testid="composer-text-input"][contenteditable="true"]') ||
      document.querySelector('form [contenteditable="true"][role="textbox"]');
  }

  function userMessages() {
    const current = [...document.querySelectorAll('[data-content-search-unit-key$=":user"]')];
    if (current.length) return current;
    return [...document.querySelectorAll('[data-message-author-role="user"]')];
  }

  function userMessageUnitKeys() {
    return [...document.querySelectorAll('[data-content-search-unit-key$=":user"]')]
      .map(message => message.getAttribute("data-content-search-unit-key") || "")
      .filter(Boolean);
  }

  function capturePreSendUserBaseline(reportId) {
    const messages = userMessages();
    preSendUserCount = messages.length;
    preSendUserText = normalize(messages.at(-1)?.innerText || messages.at(-1)?.textContent || "");
    preSendUserUnitKeys = userMessageUnitKeys();
    preSendUserUnitKeysReportId = reportId;
    preSendGenerating = isGenerating();
    preSendGeneratingReportId = reportId;
    sessionStorage.setItem("bridge.preSendUserCount", String(preSendUserCount));
    sessionStorage.setItem("bridge.preSendUserText", preSendUserText);
    sessionStorage.setItem("bridge.preSendUserUnitKeys", JSON.stringify(preSendUserUnitKeys));
    sessionStorage.setItem("bridge.preSendUserUnitKeysReportId", String(reportId));
    sessionStorage.setItem("bridge.preSendGenerating", String(preSendGenerating));
    sessionStorage.setItem("bridge.preSendGeneratingReportId", String(reportId));
  }

  function visibleContentSearchUnits() {
    if (scanPass?.units) return scanPass.units;
    const units = [...document.querySelectorAll("[data-content-search-unit-key]")]
      .filter(el => isVisible(el) && messageText(el));
    return scanPass ? (scanPass.units = units) : units;
  }

  function invalidatePageScan() {
    pageRevision += 1;
    emptyCardChecks = 0;
    nextAutomaticCheckAt = 0;
  }

  function schedulePageCheck() {
    if (automaticLoopStopped || tickInterval === null) return;
    // Streaming text is sampled by the 2-second fallback. Generation-control
    // transitions explicitly clear this flag to promptly check the final reply.
    if (pageIsGenerating) return;
    if (busy) { pageCheckQueued = true; return; }
    if (pageWakeTimer !== null || document.visibilityState === "hidden") return;
    pageWakeTimer = setTimeout(() => {
      pageWakeTimer = null;
      void tick("page_changed");
    }, ASSISTANT_WAIT_WAKE_MIN_INTERVAL_MS);
  }

  const ASSISTANT_DISCOVERY_SELECTOR = '[data-content-search-unit-key], ' +
    '[data-message-author-role="assistant"], [data-author-role="assistant"], ' +
    '[data-role="assistant"], [data-testid*="assistant-message"]';

  function nodeHasMessageUnit(node) {
    if (node?.nodeType !== 1) return false;
    return !!node.matches?.(ASSISTANT_DISCOVERY_SELECTOR) ||
      !!node.querySelector?.(ASSISTANT_DISCOVERY_SELECTOR);
  }

  function observeLatestAssistant(latest) {
    if (!pageObserver || observedAssistant === latest) return;
    focusedPageObserver?.disconnect();
    focusedPageObserver = null;
    observedAssistant = latest;
    if (!latest) return;
    const epoch = flowEpoch;
    focusedPageObserver = new MutationObserver(mutations => {
      if (epoch !== flowEpoch || observedAssistant !== latest || automaticLoopStopped) return;
      if (mutations.some(mutationAffectsGenerationState)) pageIsGenerating = false;
      invalidatePageScan();
      schedulePageCheck();
    });
    focusedPageObserver.observe(latest, {subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden", "aria-label",
        "title", "data-testid", "data-content-search-unit-key"]});
  }

  function startPageObserver() {
    const root = document.body || document.querySelector("main");
    if (pageObserver || !root || typeof MutationObserver !== "function") return;
    // Discovery only: content and card attributes are observed on the latest
    // reply. Changes in the composer, status widget or old replies do no scans.
    const epoch = flowEpoch;
    pageObserver = new MutationObserver(mutations => {
      if (epoch !== flowEpoch || automaticLoopStopped) return;
      const relevant = mutations.some(mutation => {
        if (mutation.target?.closest?.("#codex-bridge-status")) return false;
        if (observedAssistant && (mutation.target === observedAssistant ||
            observedAssistant.contains?.(mutation.target))) return false;
        if (mutationAffectsGenerationState(mutation)) {
          pageIsGenerating = false;
          return true;
        }
        if (mutation.type === "attributes") return !!observedAssistant &&
          !!mutation.target?.contains?.(observedAssistant);
        return [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])]
          .some(node => nodeHasMessageUnit(node) || node === observedAssistant ||
            !!node.contains?.(observedAssistant));
      });
      if (!relevant) return;
      invalidatePageScan();
      schedulePageCheck();
    });
    pageObserver.observe(root, {subtree: true, childList: true, attributes: true,
      attributeOldValue: true, attributeFilter: ["class", "style", "hidden", "aria-hidden",
        "aria-label", "data-testid", "data-message-author-role", "data-content-search-unit-key"]});
  }

  function deferEmptyCardCheck() {
    const delay = EMPTY_CARD_DELAYS_MS[Math.min(emptyCardChecks, EMPTY_CARD_DELAYS_MS.length - 1)];
    emptyCardChecks += 1;
    nextAutomaticCheckAt = Date.now() + delay;
  }

  function latestUserContains(report) {
    const messages = userMessages();
    const latest = messages.at(-1);
    const sample = normalize(report).slice(0, 120);
    const text = normalize(latest?.innerText || latest?.textContent || "");
    const changed = messages.length > preSendUserCount || text !== preSendUserText;
    return !!sample && changed && text.includes(REPORT_PREFIX) && text.includes(sample);
  }

  function reportWasSent(report, reportId) {
    if (attemptedReport !== reportId) return false;
    const signals = reportConfirmationSignals(report, reportId);
    return signals.newUserUnitKey || signals.latestUserContainsReport;
  }

  function reportConfirmationSignals(report, reportId) {
    const previousKeys = new Set(preSendUserUnitKeys);
    const newUserUnitKey = preSendUserUnitKeysReportId === reportId &&
      userMessageUnitKeys().some(key => !previousKeys.has(key));
    const editor = composer();
    const generating = isGenerating();
    return {
      newUserUnitKey,
      latestUserContainsReport: latestUserContains(report),
      composerEmpty: !normalize(editor?.innerText || editor?.textContent || ""),
      generating,
      generationStarted: preSendGeneratingReportId === reportId && !preSendGenerating && generating
    };
  }

  function normalize(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function reportMessage(report) {
    return `以下是 Codex 上一轮的最终报告。请先分析，再决定下一步。

【交互与文件边界】本桥接只在 ChatGPT 与 Codex 之间传递文本，不会传递文件或附件。若下一步需要在 ChatGPT 与本机/Codex 之间打开、选择、上传、下载或转交文件，请暂停该步骤，以“需要人工处理”开头说明具体要用户做什么，并且不要生成指令卡片。不得假设附件已传给 Codex，也不得声称已读取或处理实际无法访问的文件。

【证据核验】Codex 当前使用 Luna 模型，可能出现幻觉、误读、把未执行的检查说成已完成，也可能无法可靠遵循过长指令。对关键事实、文件内容、代码行为、执行结果以及“已修复/已通过”等结论，要求 Codex 尽量用可重复核查的确定性证据验证，例如实际文件内容及路径/行号、命令及其实际输出、测试或构建结果、日志。不要把模型记忆或推断当作证据；没有足够证据或未实际验证时，必须明确标为“未验证”“推测”或“未知”，并指出需要人工确认的事项。

若需继续，请把**仅给 Codex 的指令**放在一张标题栏为“给 Codex 的指令”、带复制按钮和打开编辑器按钮的writingblock卡片中；卡片外可写分析。若任务完成，请以“任务完成”开头且不要生成指令卡片。若需要人工处理，请以“需要人工处理”开头且不要生成指令卡片。另外，请尽量把后续指令拆成简短、明确的步骤，不要让codex执行过长的任务，以免发生错误。若项目使用 Git 版本管理，请在阶段性工作完成后及时提醒 Codex 提交更改。

Codex 最终报告：
${report}`;
  }

  function readComposerText(editor) {
    const innerText = editor?.innerText;
    if (innerText) return {text: String(innerText), source: "innerText"};
    return {text: String(editor?.textContent || ""), source: "textContent"};
  }

  function errorDiagnostics(error) {
    const message = String(error?.message || error || "未知错误");
    return {
      reason: message.slice(0, 2000),
      errorName: String(error?.name || "Error").slice(0, 120),
      errorMessage: message.slice(0, 2000),
      errorStack: String(error?.stack || "").slice(0, 4000)
    };
  }

  function reportSamples(report) {
    const raw = normalize(report);
    const rendered = normalize(report.replace(/[`*_#>\[\]]/g, ""));
    const windows = text => [0, Math.floor(text.length / 3), Math.floor(text.length * 2 / 3)]
      .map(start => text.slice(start, start + 80));
    const minimumLength = Math.max(24, Math.min(40, raw.length));
    return [...new Set([...windows(raw), ...windows(rendered)])]
      .filter(sample => sample.length >= minimumLength);
  }

  function countIn(haystack, needle) {
    return needle ? haystack.split(needle).length - 1 : 0;
  }

  function reportTextEvidence(report, reportId) {
    const baseline = confirmationBaselineCounts;
    if (confirmationBaselineId !== reportId || !baseline ||
        !Array.isArray(baseline.visible) || !Array.isArray(baseline.dom))
      return {baselineAvailable: false, visibleDelta: 0, domDelta: 0};
    const main = document.querySelector("main");
    const visible = normalize(main?.innerText || "");
    const dom = normalize(main?.textContent || "");
    const samples = reportSamples(report);
    const increased = (text, counts) => samples.filter((sample, index) =>
      countIn(text, sample) > (counts[index] || 0)).length;
    return {baselineAvailable: true,
      visibleDelta: increased(visible, baseline.visible),
      domDelta: increased(dom, baseline.dom)};
  }

  function saveReportBaseline(report, reportId) {
    const main = document.querySelector("main");
    const samples = reportSamples(report);
    const counts = text => samples.map(sample => countIn(normalize(text), sample));
    confirmationBaselineCounts = {
      visible: counts(main?.innerText || ""),
      dom: counts(main?.textContent || "")
    };
    confirmationBaselineId = reportId;
    sessionStorage.setItem("bridge.confirmationBaselineId", String(reportId));
    sessionStorage.setItem("bridge.confirmationBaselineCounts", JSON.stringify(confirmationBaselineCounts));
    record("report_baseline", {reportId, mainFound: !!main}, `report_baseline:${reportId}`);
  }

  function cardEntries(found) {
    return found.choices || (found.instruction ? [{instruction: found.instruction}] : []);
  }

  function cardKey(instruction) {
    const text = normalize(instruction);
    let hash = 0xcbf29ce484222325n;
    for (let index = 0; index < text.length; index++) {
      hash = (hash ^ BigInt(text.charCodeAt(index))) * 0x100000001b3n & 0xffffffffffffffffn;
    }
    return `${text.length}:${hash.toString(16)}`;
  }

  function reportComposerDiagnostics(composerText, message, report, source = "innerText_or_textContent") {
    const normalizedComposer = normalize(composerText);
    const normalizedMessage = normalize(message);
    const expectedPrefix = normalizedMessage.slice(0, 90);
    const reportSample = normalize(report).slice(0, 120);
    const prefixMatch = normalizedComposer.startsWith(expectedPrefix);
    const reportSampleMatch = normalizedComposer.includes(reportSample);
    let firstPrefixMismatchAt = -1;
    if (!prefixMatch) {
      const limit = Math.min(normalizedComposer.length, expectedPrefix.length);
      firstPrefixMismatchAt = 0;
      while (firstPrefixMismatchAt < limit &&
          normalizedComposer[firstPrefixMismatchAt] === expectedPrefix[firstPrefixMismatchAt])
        firstPrefixMismatchAt += 1;
    }
    const containsReportWrapper = normalizedComposer.includes(REPORT_PREFIX) &&
      normalizedComposer.includes("Codex 最终报告：");
    const composerMatchesExpectedMessage = normalizedComposer === normalizedMessage;
    const diagnostics = {
      composerTextSource: source,
      composerRawLength: String(composerText || "").length,
      composerNormalizedLength: normalizedComposer.length,
      composerStartsWithExpectedPrefix: prefixMatch,
      composerContainsReportSample: reportSampleMatch,
      composerContainsReportWrapper: containsReportWrapper,
      composerMatchesExpectedMessage,
      ownDraftMatch: composerMatchesExpectedMessage,
      firstPrefixMismatchAt,
      expectedPrefixLength: expectedPrefix.length,
      expectedMessageFingerprint: cardKey(normalizedMessage),
      expectedReportFingerprint: cardKey(report)
    };
    // Include fingerprints and code points only when the text contains the
    // bridge's report wrapper. Arbitrary user drafts are logged verbatim by
    // the blocking/error event, but are not additionally fingerprinted here.
    if (containsReportWrapper) {
      diagnostics.composerFingerprint = cardKey(normalizedComposer);
      diagnostics.composerLeadingCodePoints = [...normalizedComposer].slice(0, 8)
        .map(char => char.codePointAt(0));
    }
    return diagnostics;
  }

  function pendingReportMessageFingerprint(reportId, message) {
    return cardKey(`${Number(reportId)}:${normalize(message)}`);
  }

  function readPendingReport() {
    try {
      const value = JSON.parse(sessionStorage.getItem("bridge.pendingReport") || "null");
      return value && typeof value === "object" ? value : null;
    } catch { return null; }
  }

  function pendingReportMatches(pending, reportId, message) {
    return Number(pending?.reportId) === Number(reportId) &&
      String(pending?.runId || "") === String(runId || "") &&
      pending?.messageFingerprint === pendingReportMessageFingerprint(reportId, message);
  }

  function savePendingReport(reportId, message, stage) {
    const pending = {reportId: Number(reportId), runId: String(runId || ""),
      messageFingerprint: pendingReportMessageFingerprint(reportId, message),
      normalizedLength: normalize(message).length, stage, updatedAt: Date.now()};
    sessionStorage.setItem("bridge.pendingReport", JSON.stringify(pending));
    return pending;
  }

  function clearPendingReport(reportId) {
    const pending = readPendingReport();
    if (reportId === undefined || !pending || Number(pending.reportId) === Number(reportId))
      sessionStorage.removeItem("bridge.pendingReport");
  }

  function contentUnitKey(anchor) {
    const unit = anchor?.closest?.("[data-content-search-unit-key]");
    return unit?.getAttribute("data-content-search-unit-key") || "";
  }

  function instructionId(instruction, anchor) {
    const bodyHash = cardKey(instruction);
    const unitKey = contentUnitKey(anchor);
    if (!unitKey) return bodyHash;
    return `v1:${encodeURIComponent(location.pathname || "/")}:${encodeURIComponent(unitKey)}:${bodyHash}`;
  }

  function formatCodexInstruction(instruction) {
    const formatted = `${CODEX_FORWARDING_PROMPT}\n\n${instruction}`;
    if (formatted.length > MAX_CODEX_INSTRUCTION_CHARS)
      throw new Error("指令卡片与固定提示词合计超过桥接器的 20000 字符上限");
    return formatted;
  }

  function persistInstructionStates() {
    sessionStorage.setItem("bridge.instructionStates", JSON.stringify([...instructionStates]));
  }

  function setInstructionState(id, state) {
    if (state === null) instructionStates.delete(id);
    else instructionStates.set(id, state);
    persistInstructionStates();
  }

  function instructionIsHandled(id) {
    return instructionStates.has(id);
  }

  function rememberVisibleCards(title, selector) {
    if (assistantMessages().length) return;
    for (const unit of visibleContentSearchUnits()) {
      const found = extractCard(unit, title, selector);
      for (const entry of cardEntries(found)) {
        const id = instructionId(entry.instruction, unit);
        if (!instructionStates.has(id)) instructionStates.set(id, "seen");
      }
    }
    persistInstructionStates();
  }

  function currentAssistantSignature() {
    const messages = assistantMessages();
    if (messages.length) return `${messages.length}:${messageText(messages.at(-1))}`;
    const units = visibleContentSearchUnits();
    const latest = units.at(-1);
    return latest
      ? `content-search-unit:${latest.getAttribute("data-content-search-unit-key") || ""}:${normalize(messageText(latest))}`
      : "";
  }

  function assistantContentSignature(element, titlePattern = DEFAULT_TITLE.source, selector = "") {
    let text = normalize(messageText(element));
    if (!element) return text;
    try {
      const found = extractCard(element, new RegExp(titlePattern || DEFAULT_TITLE.source, "i"), selector || "");
      const entries = cardEntries(found);
      if (entries.length) {
        for (const entry of entries) {
          const cardTextValue = normalize(entry.instruction);
          if (cardTextValue) text = text.replace(cardTextValue, " ");
        }
        text = text.replace(/给\s*Codex\s*的指令|Instructions?\s+for\s+Codex|Codex\s*指令卡|复制代码|复制|copy code/gi, " ");
      }
    } catch { /* Card parsing is only a turn-detection aid. */ }
    return normalize(text);
  }

  function assistantSignatureFingerprint(signature) {
    const value = String(signature || "");
    if (signatureFingerprints.has(value)) return signatureFingerprints.get(value);
    const details = {length: value.length, fingerprint: value ? cardKey(value) : ""};
    if (signatureFingerprints.size >= 4) signatureFingerprints.delete(signatureFingerprints.keys().next().value);
    signatureFingerprints.set(value, details);
    return details;
  }

  function assistantWaitSelectionDiagnostics(wait, messages, latest) {
    if (scanPass?.selection?.wait === wait && scanPass.selection.latest === latest)
      return scanPass.selection.details;
    const assistant = messages.at(-1) || null;
    const signature = messages.length
      ? `${messages.length}:${messageText(assistant)}`
      : latest
        ? `content-search-unit:${latest.getAttribute("data-content-search-unit-key") || ""}:${normalize(messageText(latest))}`
        : "";
    const baselineUnitKey = wait.baselineUnitKey || "";
    const latestUnitKey = contentUnitKey(latest);
    const unitKeyComparable = !!baselineUnitKey && !!latestUnitKey;
    const baselineSignature = String(wait.baselineSignature || "");
    const baselineSignatureDetails = assistantSignatureFingerprint(baselineSignature);
    const currentSignatureDetails = assistantSignatureFingerprint(signature);
    const baselineContentSignature = String(wait.baselineContentSignature || "");
    const currentContentSignature = assistantContentSignature(assistant || latest,
      wait.cardTitle, wait.cardSelector);
    const details = {
      baselineAssistantUnitKey: baselineUnitKey,
      latestAssistantUnitKey: contentUnitKey(assistant),
      latestSelectedUnitKey: latestUnitKey,
      assistantSelectionSource: assistant ? "assistant_role" : latest ? "content_unit_fallback" : "none",
      assistantUnitKeyComparable: unitKeyComparable,
      assistantUnitKeyChanged: unitKeyComparable ? latestUnitKey !== baselineUnitKey : null,
      baselineAssistantSignature: baselineSignatureDetails,
      currentAssistantSignature: currentSignatureDetails,
      assistantSignatureChanged: signature !== baselineSignature,
      baselineAssistantContentSignature: assistantSignatureFingerprint(baselineContentSignature),
      currentAssistantContentSignature: assistantSignatureFingerprint(currentContentSignature),
      assistantContentSignatureChanged: currentContentSignature !== baselineContentSignature,
      baselineAssistantCount: wait.baselineCount,
      assistantCount: messages.length,
      assistantCountChanged: messages.length !== wait.baselineCount,
      assistantCountDelta: messages.length - wait.baselineCount
    };
    if (scanPass) scanPass.selection = {wait, latest, details};
    return details;
  }

  function assistantTurnChanged(wait, diagnostics, messages) {
    const unitKeysComparable = !!wait.baselineUnitKey && !!diagnostics.latestSelectedUnitKey;
    return unitKeysComparable
      ? diagnostics.assistantUnitKeyChanged || diagnostics.assistantContentSignatureChanged
      : diagnostics.assistantContentSignatureChanged || messages.length > wait.baselineCount;
  }

  function assistantWaitCanScan(wait) {
    return !wait || (wait.turnDetected && wait.replyCompleted);
  }

  function sendButton(editor) {
    const form = editor.closest("form") || document;
    const buttons = [...form.querySelectorAll("button")];
    return buttons.find(b => b.matches('[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="发送提示"],button[aria-label="Send message"],button[aria-label="发送消息"]')) ||
      buttons.find(b => b.type === "submit");
  }

  async function waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return predicate();
  }

  function disconnectAssistantWaitObserver() {
    assistantWaitObserver?.disconnect();
    assistantWaitObserver = null;
  }

  function queueAssistantWaitTick(wait, method) {
    assistantWaitTickQueued = true;
    assistantWaitQueuedWakeCount += 1;
    if (assistantWaitQueuedWakeLogged) return;
    assistantWaitQueuedWakeLogged = true;
    record("assistant_wait_wake_coalesced", {reportId: wait.reportId, method,
      coalescedWakeCount: assistantWaitQueuedWakeCount});
  }

  function clearQueuedAssistantWaitTick() {
    assistantWaitTickQueued = false;
    assistantWaitQueuedWakeCount = 0;
    assistantWaitQueuedWakeLogged = false;
  }

  function requestAssistantWaitTick(method) {
    const wait = assistantWaitDiagnostic;
    if (!wait?.active) return;
    const now = Date.now();
    const hidden = document.visibilityState === "hidden";
    if (hidden && wait.pendingSubmit) {
      clearQueuedAssistantWaitTick();
      return;
    }
    if (hidden && wait.lastHiddenPreparationAt &&
        now - wait.lastHiddenPreparationAt < ASSISTANT_WAIT_HIDDEN_WAKE_MIN_INTERVAL_MS) {
      clearQueuedAssistantWaitTick();
      return;
    }
    if (busy || (!hidden && assistantWaitLastWakeAt &&
        now - assistantWaitLastWakeAt < ASSISTANT_WAIT_WAKE_MIN_INTERVAL_MS)) {
      queueAssistantWaitTick(wait, method);
      return;
    }
    const coalescedWakeCount = assistantWaitQueuedWakeCount;
    clearQueuedAssistantWaitTick();
    if (hidden) wait.lastHiddenPreparationAt = now;
    else assistantWaitLastWakeAt = now;
    record("assistant_wait_wake_requested", {reportId: wait.reportId, method, coalescedWakeCount,
      visibilityState: document.visibilityState || "unknown"});
    void tick(method);
  }

  function drainQueuedAssistantWaitTick() {
    if (busy || !assistantWaitTickQueued) return;
    if (!assistantWaitDiagnostic?.active) {
      clearQueuedAssistantWaitTick();
      return;
    }
    requestAssistantWaitTick("mutation_observer_queued");
  }

  function mutationTouchesAssistantMessage(message, mutation) {
    if (!message) return false;
    const elementFor = node => node?.nodeType === 1 ? node : node?.parentElement;
    const withinMessage = node => {
      const element = elementFor(node);
      return !!element && (element === message || message.contains?.(element));
    };
    if (withinMessage(mutation.target)) return true;
    return [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])].some(node => {
      const element = elementFor(node);
      return !!element && (element === message || message.contains?.(element) || element.contains?.(message));
    });
  }

  function mutationAffectsGenerationState(mutation) {
    if (mutation.type === "childList")
      return [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])]
        .some(nodeContainsGenerationControl);
    if (mutation.type !== "attributes" ||
        !["data-testid", "aria-label", "aria-hidden"].includes(mutation.attributeName)) return false;
    if (nodeIsGenerationControl(mutation.target)) return true;
    if (mutation.attributeName === "data-testid" && mutation.oldValue === "stop-button") return true;
    return mutation.attributeName === "aria-label" &&
      /Stop generating|停止生成/i.test(mutation.oldValue || "");
  }

  function nodeContainsGenerationControl(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element) return false;
    return nodeIsGenerationControl(element) || !!element.querySelector?.(GENERATION_CONTROL_SELECTOR);
  }

  function nodeIsGenerationControl(element) {
    return !!element?.matches?.(GENERATION_CONTROL_SELECTOR);
  }

  const GENERATION_CONTROL_SELECTOR =
    '[data-testid="stop-button"], button[aria-label*="Stop generating"], button[aria-label*="停止生成"]';

  function diagnosticSelectorCount(selector) {
    try { return document.querySelectorAll(selector).length; }
    catch { return 0; }
  }

  function assistantWaitDiagnosticFields(wait) {
    const liveScans = optimizerDiagnosticStatus?.liveScans;
    const fields = {
      lastContentChangeAt: wait.lastContentChangeAt || 0,
      stabilityStartedAt: wait.stabilityStartedAt || 0,
      assistantContentMutationCount: wait.assistantContentMutationCount || 0,
      observerCallbackCount: wait.observerCallbackCount || 0,
      observerMutationCount: wait.observerMutationCount || 0,
      observerChildListCount: wait.observerChildListCount || 0,
      observerCharacterDataCount: wait.observerCharacterDataCount || 0,
      observerAttributeCount: wait.observerAttributeCount || 0,
      optimizerLiveWindowMutationCount: wait.optimizerLiveWindowMutationCount || 0,
      optimizerBoundaryMutationCount: wait.optimizerBoundaryMutationCount || 0,
      optimizerHiddenMarkerCount: diagnosticSelectorCount('[data-cgo-live-hidden="true"]'),
      optimizerBoundaryMarkerCount: diagnosticSelectorCount('[data-cgo-history-boundary="true"]'),
      optimizerStatusAvailable: !!optimizerDiagnosticStatus,
      optimizerLiveScans: liveScans ?? 0,
      optimizerLiveUnits: optimizerDiagnosticStatus?.liveUnits ?? 0,
      optimizerLiveHiddenUnits: optimizerDiagnosticStatus?.liveHiddenUnits ?? 0,
      optimizerLiveLastReason: optimizerDiagnosticStatus?.liveLastReason || ""
    };
    const previous = wait.lastDiagnosticSnapshot || {};
    fields.observerCallbackDelta = fields.observerCallbackCount - (previous.observerCallbackCount || 0);
    fields.observerMutationDelta = fields.observerMutationCount - (previous.observerMutationCount || 0);
    fields.optimizerLiveWindowMutationDelta = fields.optimizerLiveWindowMutationCount -
      (previous.optimizerLiveWindowMutationCount || 0);
    fields.optimizerBoundaryMutationDelta = fields.optimizerBoundaryMutationCount -
      (previous.optimizerBoundaryMutationCount || 0);
    fields.optimizerLiveScanDelta = liveScans === null || liveScans === undefined ||
      wait.lastOptimizerLiveScans === null || wait.lastOptimizerLiveScans === undefined
      ? 0 : liveScans - wait.lastOptimizerLiveScans;
    if (liveScans !== null && liveScans !== undefined) wait.lastOptimizerLiveScans = liveScans;
    wait.lastDiagnosticSnapshot = fields;
    return fields;
  }

  function recordAssistantWaitCheckpoint(wait, reason, details = {}) {
    if (!wait?.active) return;
    const now = Date.now();
    const signature = JSON.stringify([reason, document.visibilityState, wait.cardFirstSeen,
      wait.pendingSubmit, wait.turnDetected, wait.replyCompleted, details.phase, details.isGenerating]);
    if (wait.lastCheckpoint?.signature === signature &&
        now - wait.lastCheckpoint.at < LOG_REPEAT_INTERVAL_MS) return;
    wait.lastCheckpoint = {signature, at: now};
    record("page_stability_checkpoint", {reportId: wait.reportId,
      elapsedMs: now - wait.startedAt,
      stableElapsedMs: wait?.lastContentChangeAt
        ? now - wait.lastContentChangeAt : stableSince ? now - stableSince : 0,
      stableThresholdMs: 1800,
      signatureChangeCount: wait.signatureChangeCount || 0,
      cardFirstSeen: !!wait.cardFirstSeen,
      pendingSubmit: !!wait.pendingSubmit,
      pendingSubmitAt: wait.pendingSubmitAt || 0,
      assistantTurnDetected: !!wait.turnDetected,
      replyCompleted: !!wait.replyCompleted,
      visibilityState: document.visibilityState || "unknown",
      reason,
      ...assistantWaitDiagnosticFields(wait),
      ...details});
  }

  function startAssistantWaitObserver(diagnostic) {
    const root = document.querySelector("main") || document.body;
    if (typeof MutationObserver !== "function" || !root) {
      record("assistant_wait_observer_unavailable", {reportId: diagnostic.reportId,
        visibilityState: document.visibilityState || "unknown"}, `assistant_wait_observer_unavailable:${diagnostic.reportId}`);
      return;
    }
    diagnostic.latestObservedAssistant = assistantMessages().at(-1) || null;
    const observer = new MutationObserver(mutations => {
      const current = assistantWaitDiagnostic;
      if (!current?.active || current.reportId !== diagnostic.reportId) {
        observer.disconnect();
        if (assistantWaitObserver === observer) assistantWaitObserver = null;
        return;
      }
      const generationMutations = mutations.filter(mutationAffectsGenerationState);
      const hasContentMutations = mutations.some(mutation =>
        mutation.type === "childList" || mutation.type === "characterData");
      if (!hasContentMutations && !generationMutations.length) return;
      const previous = current.latestObservedAssistant;
      const outsideMessage = hasContentMutations && mutations.some(mutation => {
        if (!["childList", "characterData"].includes(mutation.type) ||
            mutationTouchesAssistantMessage(previous, mutation)) return false;
        const unit = mutation.target?.closest?.(ASSISTANT_DISCOVERY_SELECTOR);
        if (unit && (!previous?.compareDocumentPosition || (previous.compareDocumentPosition(unit) & 4)))
          return true;
        return [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])].some(nodeHasMessageUnit);
      });
      if (!previous || outsideMessage) current.latestObservedAssistant = assistantMessages().at(-1) || null;
      const latestAssistant = current.latestObservedAssistant;
      const assistantContentMutations = mutations.filter(mutation =>
        (mutation.type === "childList" || mutation.type === "characterData") &&
        mutationTouchesAssistantMessage(latestAssistant, mutation));
      const relevantMutations = [...assistantContentMutations, ...generationMutations];
      if (!relevantMutations.length) return;
      invalidatePageScan();

      const observedAt = Date.now();
      current.observerCallbackCount = (current.observerCallbackCount || 0) + 1;
      current.observerMutationCount = (current.observerMutationCount || 0) + relevantMutations.length;
      current.observerLastMutationAt = observedAt;
      if (assistantContentMutations.length) {
        current.assistantContentMutationCount = (current.assistantContentMutationCount || 0) +
          assistantContentMutations.length;
        const previousStabilityStartedAt = current.stabilityStartedAt || 0;
        current.lastContentChangeAt = observedAt;
        if (current.pendingSubmit) {
          record("assistant_wait_pending_submit_invalidated", {reportId: current.reportId,
            reason: "assistant_dom_content_changed",
            pendingForMs: current.pendingSubmitAt ? observedAt - current.pendingSubmitAt : 0,
            visibilityState: document.visibilityState || "unknown"});
          current.pendingSubmit = false;
          current.pendingSubmitAt = 0;
        }
        if (previousStabilityStartedAt) {
          current.stabilityStartedAt = observedAt;
          current.stabilityEndedAt = 0;
          record("page_stability_reset", {reportId: current.reportId,
            reason: "assistant_dom_content_changed",
            previousStableElapsedMs: observedAt - previousStabilityStartedAt,
            lastContentChangeAt: observedAt,
            stabilityStartedAt: observedAt,
            assistantContentMutationCount: current.assistantContentMutationCount,
            visibilityState: document.visibilityState || "unknown"});
        }
      }
      for (const mutation of relevantMutations) {
        if (mutation.type === "childList") current.observerChildListCount = (current.observerChildListCount || 0) + 1;
        else if (mutation.type === "characterData") current.observerCharacterDataCount = (current.observerCharacterDataCount || 0) + 1;
        else if (mutation.type === "attributes") current.observerAttributeCount =
          (current.observerAttributeCount || 0) + 1;
      }
      if (!current.observerFirstFiredAt) {
        current.observerFirstFiredAt = observedAt;
        record("assistant_wait_observer_fired", {reportId: current.reportId,
          elapsedMs: observedAt - current.startedAt,
          observerMutationCount: current.observerMutationCount,
          visibilityState: document.visibilityState || "unknown"},
        `assistant_wait_observer_fired:${current.reportId}`);
      }
      if (current.cardFirstSeen) {
        if (!isGenerating() && assistantContentMutations.length)
          requestAssistantWaitTick("mutation_observer_assistant_content");
        else if (!isGenerating() && generationMutations.length)
          requestAssistantWaitTick("mutation_observer_generation_state");
        return;
      }
      if (!assistantContentMutations.length) return;
      if (current.lastCardProbeAt && observedAt - current.lastCardProbeAt < 1000) return;
      current.lastCardProbeAt = observedAt;
      const latest = latestAssistant || visibleContentSearchUnits().at(-1);
      if (!latest) return;
      try {
        const title = new RegExp(current.cardTitle || DEFAULT_TITLE.source, "i");
        const found = extractCard(latest, title, current.cardSelector || "");
        const cardChoices = found.choices?.length || (found.instruction ? 1 : 0);
        if (!cardChoices) return;
        current.cardFirstSeen = true;
        record("card_dom_first_seen", {reportId: current.reportId,
          elapsedMs: observedAt - current.startedAt,
          assistantMessages: assistantMessages().length,
          cardChoices,
          instructionLength: found.instruction?.length || 0,
          isGenerating: isGenerating(),
          observerMutationCount: current.observerMutationCount,
          visibilityState: document.visibilityState || "unknown",
          method: "mutation_observer"}, `card_dom_first_seen:${current.reportId}`);
        requestAssistantWaitTick("mutation_observer_card_found");
      } catch {
        record("card_dom_probe_error", {reportId: current.reportId,
          elapsedMs: observedAt - current.startedAt,
          method: "mutation_observer"}, `card_dom_probe_error:${current.reportId}`);
      }
    });
    assistantWaitObserver = observer;
    observer.observe(root, {subtree: true, childList: true, characterData: true,
      attributes: true, attributeOldValue: true,
      attributeFilter: ["data-testid", "aria-label", "aria-hidden"]});
    record("assistant_wait_observer_started", {reportId: diagnostic.reportId,
      diagnosticObserverStarted: true,
      visibilityState: document.visibilityState || "unknown",
      method: root === document.body ? "main_fallback" : "conversation_main"},
    `assistant_wait_observer_started:${diagnostic.reportId}`);
  }

  function drainQueuedReportWake() {
    if (busy || !reportWakeQueued) return;
    reportWakeQueued = false;
    void tick();
  }

  async function acknowledgeReport(reportId, skipPreviousAssistant = false, diagnosticConfig = null,
      epoch = flowEpoch) {
    if (epoch !== flowEpoch) return;
    record("report_confirmed", {reportId, confirmed: true}, `report_confirmed:${reportId}`);
    sentReport = reportId;
    sessionStorage.setItem("bridge.sentReport", String(reportId));
    if (skipPreviousAssistant && preSendAssistant) {
      lastSubmitted = preSendAssistant;
      sessionStorage.setItem("bridge.lastSubmitted", lastSubmitted);
    }
    await api("/ack", "POST", {reportId, runId});
    if (epoch !== flowEpoch) return;
    clearPendingReport(reportId);
    const startedAt = Date.now();
    clearQueuedAssistantWaitTick();
    assistantWaitLastWakeAt = 0;
    assistantWaitDiagnostic = {
      active: true,
      reportId,
      startedAt,
      baselineSignature: preSendAssistant,
      baselineContentSignature: preSendAssistantContentSignature,
      baselineCount: preSendAssistantCount,
      baselineUnitKey: preSendAssistantUnitKey,
      cardTitle: diagnosticConfig?.title || DEFAULT_TITLE.source,
      cardSelector: diagnosticConfig?.card || "",
      lastTickAt: 0,
      turnDetected: false,
      replyCompleted: false,
      cardFirstSeen: false,
      pendingSubmit: false,
      pendingSubmitAt: 0,
      lastHiddenPreparationAt: 0,
      lastContentChangeAt: startedAt,
      stabilityStartedAt: 0,
      stabilityEndedAt: 0,
      assistantContentMutationCount: 0,
      lastSignatureMutationCount: 0,
      observerMutationCount: 0,
      observerFirstFiredAt: 0,
      observerCallbackCount: 0,
      observerChildListCount: 0,
      observerCharacterDataCount: 0,
      observerAttributeCount: 0,
      optimizerLiveWindowMutationCount: 0,
      optimizerBoundaryMutationCount: 0,
      signatureChangeCount: 0,
      lastSignatureChangedAt: 0,
      lastOptimizerLiveScans: optimizerDiagnosticStatus?.liveScans ?? null,
      lastDiagnosticSnapshot: null
    };
    record("report_acknowledged", {reportId,
      baselineAssistantUnitKey: preSendAssistantUnitKey,
      baselineAssistantSignature: assistantSignatureFingerprint(preSendAssistant),
      baselineAssistantContentSignature: assistantSignatureFingerprint(preSendAssistantContentSignature),
      baselineAssistantCount: preSendAssistantCount}, `report_acknowledged:${reportId}`);
    record("assistant_wait_started", {reportId,
      assistantBaselineCount: preSendAssistantCount,
      visibilityState: document.visibilityState || "unknown",
      method: "setInterval_and_mutation_observer",
      tickIntervalMs: 2000,
      stableThresholdMs: 1800,
      rafUsed: false,
      setTimeoutUsed: false,
      waitForUsesSetTimeout: true,
      visibilityUsed: false,
      mutationObserverUsed: true}, `assistant_wait_started:${reportId}`);
    startAssistantWaitObserver(assistantWaitDiagnostic);
    status("最终报告已发往 ChatGPT，等待下一轮");
  }

  async function sendReport(report, reportId, diagnosticConfig = null, epoch = flowEpoch) {
    let stage = "read_bridge_state";
    let editor = null;
    let message = "";
    try {
      const currentState = await api("/state");
      if (epoch !== flowEpoch) return;
      if (currentState.phase !== "report_ready" || currentState.reportId !== reportId) {
        status(currentState.detail || "当前流程已结束或报告状态已变化；未自动发送报告", true);
        return;
      }
      if (sentReport === reportId) {
        await api("/ack", "POST", {reportId, runId});
        clearPendingReport(reportId);
        return;
      }
      record("report_send_started", {reportId}, `report_send_started:${reportId}`);
      record("report_ready", {reportId, reportLength: report.length}, `report_ready:${reportId}`);
      if (baselinedReport !== reportId) {
        stage = "load_report_settings";
        const config = await bridgeSettings();
        if (epoch !== flowEpoch) return;
        rememberVisibleCards(new RegExp(config.title || DEFAULT_TITLE.source, "i"), config.card || "");
        baselinedReport = reportId;
        sessionStorage.setItem("bridge.baselinedReport", String(reportId));
      }
      stage = "find_composer";
      editor = composer();
      if (!editor) {
        record("composer_missing", {reportId}, `composer_missing:${reportId}`);
        throw new Error("找不到 ChatGPT 输入框");
      }
      message = reportMessage(report);
      if (reportWasSent(report, reportId)) {
        stage = "acknowledge_already_sent_report";
        await acknowledgeReport(reportId, attemptedReport === reportId, diagnosticConfig, epoch); return;
      }
      stage = "check_existing_composer_text";
      const existingValue = readComposerText(editor);
      const existing = existingValue.text.trim();
      const existingDiagnostics = reportComposerDiagnostics(
        existingValue.text, message, report, existingValue.source);
      const ownDraft = existingDiagnostics.ownDraftMatch;
      const pending = readPendingReport();
      const pendingMatches = pendingReportMatches(pending, reportId, message);
      const normalizedExisting = normalize(existing);
      const normalizedExpectedMessage = normalize(message);
      const pendingPartial = !!existing && pendingMatches && !!normalizedExisting &&
        normalizedExpectedMessage.startsWith(normalizedExisting);
      if (existing) {
        record("report_draft_check", {reportId, stage,
          classification: ownDraft ? "bridge_report_draft" : pendingPartial ? "bridge_report_fill_pending" : "user_draft",
          pendingReportId: pending?.reportId || null,
          pendingReportStage: pendingMatches ? pending.stage : null,
          ...existingDiagnostics,
          ...(!ownDraft && !pendingPartial ? {composerText: existingValue.text} : {})},
        `report_draft_check:${reportId}:${existingDiagnostics.composerFingerprint || cardKey(existing)}`);
      }
      if (existing && !ownDraft && pendingPartial) {
        record("report_fill_pending", {reportId,
          pendingStage: pending.stage || "filling",
          composerLength: existingValue.text.length,
          composerFingerprint: cardKey(normalizedExisting),
          expectedMessageFingerprint: pendingReportMessageFingerprint(reportId, message)},
        `report_fill_pending:${reportId}:${pendingReportMessageFingerprint(reportId, message)}`);
        status("报告仍在写入输入框；确认完整后再发送");
        return;
      }
      if (existing && !ownDraft && pendingMatches) {
        record("report_fill_conflict", {reportId,
          composerFingerprint: cardKey(normalizedExisting),
          expectedMessageFingerprint: pendingReportMessageFingerprint(reportId, message)},
        `report_fill_conflict:${reportId}:${pendingReportMessageFingerprint(reportId, message)}`);
        status("输入框内容与待发送报告不一致；为保护草稿，已暂停自动发送", true);
        return;
      }
      if (existing && !ownDraft)
        throw new Error("ChatGPT 输入框中有你的未发送草稿；桥接已暂停发送");
      if (ownDraft && !pendingMatches) savePendingReport(reportId, message, "filled");
      if (attemptedReport === reportId) {
        const elapsed = Date.now() - (attemptedAt || Date.now());
        status(elapsed > 30000 ? "发送已触发，但仍未确认；请在扩展弹窗选择恢复操作" : "发送已触发，继续核对网页消息", elapsed > 30000);
        return;
      }
      if (!ownDraft) {
        savePendingReport(reportId, message, "filling");
        stage = "save_report_baseline";
        if (confirmationBaselineId !== reportId) saveReportBaseline(report, reportId);
        stage = "fill_composer";
        editor.focus();
        document.execCommand("insertText", false, message);
        editor.dispatchEvent(new InputEvent("input", {bubbles: true, inputType: "insertText", data: message}));
        const expectedNormalized = normalize(message);
        const fillConfirmed = await waitFor(() =>
          epoch !== flowEpoch || normalize(readComposerText(editor).text) === expectedNormalized, 2000);
        if (epoch !== flowEpoch) return;
        const filledValue = readComposerText(editor);
        const fillDiagnostics = reportComposerDiagnostics(filledValue.text, message, report, filledValue.source);
        record("report_fill", {reportId, filledLength: filledValue.text.length,
          fillContainsReport: normalize(filledValue.text).includes(normalize(report)),
          fillConfirmed, ...fillDiagnostics}, `report_fill:${reportId}`);
        stage = "verify_filled_composer";
        if (!fillConfirmed) {
          const normalizedFilled = normalize(filledValue.text);
          if (normalizedFilled && expectedNormalized.startsWith(normalizedFilled)) {
            record("report_fill_pending", {reportId, pendingStage: "filling",
              composerLength: filledValue.text.length,
              composerFingerprint: cardKey(normalizedFilled),
              expectedMessageFingerprint: pendingReportMessageFingerprint(reportId, message)},
            `report_fill_pending:${reportId}:${pendingReportMessageFingerprint(reportId, message)}`);
            status("报告仍在写入输入框；确认完整后再发送");
            return;
          }
          record("report_fill_conflict", {reportId,
            composerFingerprint: cardKey(normalizedFilled),
            expectedMessageFingerprint: pendingReportMessageFingerprint(reportId, message)},
          `report_fill_conflict:${reportId}:${pendingReportMessageFingerprint(reportId, message)}`);
          status("输入框内容与待发送报告不一致；为保护草稿，已暂停自动发送", true);
          return;
        }
        savePendingReport(reportId, message, "filled");
      }
      stage = "wait_for_send_button";
      const buttonReady = await waitFor(() => {
        if (epoch !== flowEpoch) return true;
        const button = sendButton(editor);
        return !!button && !button.disabled && button.getAttribute("aria-disabled") !== "true";
      }, 2000);
      if (epoch !== flowEpoch) return;
      if (!buttonReady) {
        record("send_button_unavailable", {reportId}, `send_button_unavailable:${reportId}`);
        status("报告已填入输入框；发送按钮暂不可用，桥接将在下一轮重试");
        return;
      }
      stage = "recheck_bridge_state";
      const latestState = await api("/state");
      if (epoch !== flowEpoch) return;
      if (latestState.phase !== "report_ready" || latestState.reportId !== reportId) {
        status(latestState.detail || "当前流程已结束或报告状态已变化；未自动发送报告", true);
        return;
      }
      stage = "capture_pre_send_baseline";
      preSendAssistant = currentAssistantSignature();
      sessionStorage.setItem("bridge.preSendAssistant", preSendAssistant);
      const preSendAssistantMessages = assistantMessages();
      preSendAssistantContentSignature = assistantContentSignature(preSendAssistantMessages.at(-1),
        diagnosticConfig?.title || DEFAULT_TITLE.source, diagnosticConfig?.card || "");
      sessionStorage.setItem("bridge.preSendAssistantContentSignature", preSendAssistantContentSignature);
      preSendAssistantCount = preSendAssistantMessages.length;
      preSendAssistantUnitKey = contentUnitKey(preSendAssistantMessages.at(-1));
      sessionStorage.setItem("bridge.preSendAssistantCount", String(preSendAssistantCount));
      capturePreSendUserBaseline(reportId);
      attemptedReport = reportId;
      sessionStorage.setItem("bridge.attemptedReport", String(reportId));
      attemptedAt = Date.now();
      sessionStorage.setItem("bridge.attemptedAt", String(attemptedAt));
      savePendingReport(reportId, message, "sending");
      stage = "click_send_button";
      record("send_click", {reportId}, `send_click:${reportId}`);
      sendButton(editor).click();
      stage = "confirm_report_message";
      const confirmed = await waitFor(() => epoch !== flowEpoch || reportWasSent(report, reportId), 10000);
      if (epoch !== flowEpoch) return;
      if (!confirmed) {
        record("report_unconfirmed", {reportId, confirmed: false,
          ...reportTextEvidence(report, reportId),
          ...reportConfirmationSignals(report, reportId)}, `report_unconfirmed:${reportId}`);
        status("发送已触发，正在继续核对网页消息；如长时间未确认，可在扩展弹窗处理");
        return;
      }
      stage = "acknowledge_report";
      await acknowledgeReport(reportId, true, diagnosticConfig, epoch);
    } catch (error) {
      if (error && typeof error === "object") {
        error.bridgeReportStage = stage;
        error.reportId = reportId;
      }
      let composerEvidence = {};
      if (editor) {
        try {
          const currentValue = readComposerText(editor);
          composerEvidence = {
            composerText: currentValue.text,
            ...(message ? reportComposerDiagnostics(currentValue.text, message, report, currentValue.source)
              : {composerTextSource: currentValue.source, composerRawLength: currentValue.text.length})
          };
        } catch (diagnosticError) {
          composerEvidence = {composerReadError: errorDiagnostics(diagnosticError)};
        }
      }
      await record("report_send_error", {reportId, stage, ...errorDiagnostics(error), ...composerEvidence});
      throw error;
    }
  }

  async function recover(action) {
    if (busy) await waitFor(() => !busy, 12000);
    if (busy) throw new Error("桥接器仍在检查页面，请稍后重试");
    busy = true;
    const epoch = flowEpoch;
    try {
      const state = await api("/state");
      if (epoch !== flowEpoch) throw new Error("当前流程已结束，请重新开始后再恢复报告");
      syncRun(state);
      record("recovery", {phase: state.phase, reportId: state.reportId, method: action});
      if (state.phase === "await_instruction" || state.phase === "codex_running")
        return state.phase === "await_instruction"
          ? "当前报告已处理；桥接正在等待 ChatGPT 的下一张指令卡片。"
          : "当前指令已发送；Codex 正在运行。";
      if (state.phase !== "report_ready") throw new Error(`当前没有待处理报告（状态 ${state.phase}）`);
      if (reportWasSent(state.report, state.reportId)) {
        await acknowledgeReport(state.reportId, true);
        return "已确认报告发送成功，并恢复自动循环。";
      }
      if (action === "recheck") return "仍未在网页用户消息中找到报告；请目视确认后选择下方恢复按钮。";
      if (action === "confirmSent") {
        await acknowledgeReport(state.reportId, true);
        return "已按你的确认标记为发送成功，继续等待 ChatGPT 下一轮。";
      }
      if (action === "retrySend") {
        attemptedReport = 0;
        attemptedAt = 0;
        sessionStorage.removeItem("bridge.attemptedReport");
        sessionStorage.removeItem("bridge.attemptedAt");
        await sendReport(state.report, state.reportId);
        return sentReport === state.reportId ? "已重新发送并确认网页收到报告。" : "已重新点击发送；扩展会继续核对网页消息。";
      }
      throw new Error("未知恢复操作");
    } finally { busy = false; drainQueuedReportWake(); }
  }

  async function cardChoices(selectedIndex = null, selectedKey = null) {
    if (busy) await waitFor(() => !busy, 12000);
    if (busy) throw new Error("桥接器仍在检查页面，请稍后重试");
    busy = true;
    const epoch = flowEpoch;
    invalidatePageScan();
    try {
      const config = await bridgeSettings();
      if (epoch !== flowEpoch) throw new Error("当前流程已结束，请重新开始后再选择卡片");
      if (!config.bound) throw new Error("当前 ChatGPT 标签页未绑定桥接任务");
      if (isGenerating()) throw new Error("ChatGPT 当前回复仍在生成，请等待停止生成按钮消失");
      const title = new RegExp(config.title || DEFAULT_TITLE.source, "i");
      const roots = assistantMessages();
      const unitFallback = roots.length === 0;
      if (unitFallback) roots.push(...visibleContentSearchUnits());
      if (!roots.length) throw new Error("找不到 ChatGPT 内容区域；页面结构可能已更新");

      // Search only the latest message unit, whether it was found by role or content key.
      const strictChoices = [];
      const addUnique = (list, entry, anchor) => {
        if (entry?.instruction && !list.some(item => normalize(item.instruction) === normalize(entry.instruction)))
          list.push({...entry, anchor});
      };
      const candidateRoots = roots.slice(-1);
      for (const root of candidateRoots) {
        const found = extractCard(root, title, config.card || "");
        if (found.choices?.length) for (const choice of found.choices) addUnique(strictChoices, choice, root);
        else if (found.instruction) addUnique(strictChoices, {
          instruction: found.instruction, preview: found.instruction.slice(0, 120)
        }, root);
      }

      let choices = strictChoices;
      const manualFallbackUsed = !strictChoices.length;
      if (manualFallbackUsed) {
        // ChatUI may omit assistant-role markers. Search the latest visible
        // content unit for likely cards; this relaxed path is never auto-submitted.
        const looseTitle = new RegExp(`(?:${config.title || DEFAULT_TITLE.source}|Codex\\s*指令卡)`, "i");
        choices = [];
        for (const root of candidateRoots)
          for (const choice of looseCardEntries(root, looseTitle)) addUnique(choices, choice, root);
      }
      const manualCandidateCount = choices.length;
      let scopedLatestOnly = unitFallback && roots.length > 0;
      choices = choices.filter(choice => !instructionIsHandled(instructionId(choice.instruction, choice.anchor)));
      if (selectedIndex === null) {
        record("card_choices_viewed", {cardChoices: choices.length,
          strictChoiceCount: strictChoices.length,
          manualCandidateCount,
          relaxedChoiceCount: choices.filter(choice => choice.relaxed).length,
          latestOnly: scopedLatestOnly,
          latestCardLength: choices.at(-1)?.instruction.length || 0,
          method: unitFallback
            ? (manualFallbackUsed ? "content_search_unit_manual_loose" : "content_search_unit_latest")
            : (manualFallbackUsed ? "assistant_manual_loose" : "assistant_role")});
        return choices.map(({instruction, preview, relaxed, anchor}, index) =>
          ({index, key: instructionId(instruction, anchor), preview, relaxed: !!relaxed,
            latestOnly: scopedLatestOnly}));
      }
      const state = await api("/state");
      if (epoch !== flowEpoch) throw new Error("当前流程已结束，请重新开始后再选择卡片");
      syncRun(state);
      if (state.phase !== "await_instruction")
        throw new Error(`当前状态 ${state.phase}；若先前因卡片歧义已停止，请先在扩展点 A 重新开始`);
      if (!Number.isInteger(selectedIndex) || typeof selectedKey !== "string" ||
          !choices[selectedIndex] ||
          instructionId(choices[selectedIndex].instruction, choices[selectedIndex].anchor) !== selectedKey)
        throw new Error("指令卡片已变化，请重新查看卡片");
      const text = roots.map(root => (root.innerText || root.textContent || "").trim()).join("\n");
      const signature = `${roots.length}:${text}`;
      const selected = choices[selectedIndex];
      const id = instructionId(selected.instruction, selected.anchor);
      if (instructionIsHandled(id)) throw new Error("这张指令卡已提交或结果待确认，不会自动重发");
      const codexInstruction = formatCodexInstruction(selected.instruction);
      setInstructionState(id, "pending");
      await api("/instruction", "POST", {
        instruction: codexInstruction,
        instructionId: id,
        runId: state.runId
      });
      setInstructionState(id, "seen");
      if (epoch !== flowEpoch) return "当前流程已结束";
      record("manual_card_submit", {instructionLength: choices[selectedIndex].instruction.length,
        cardChoices: choices.length});
      lastSubmitted = signature;
      sessionStorage.setItem("bridge.lastSubmitted", signature);
      status(`已将第 ${selectedIndex + 1} 张指令卡片送往 Codex`);
      return `已发送第 ${selectedIndex + 1} 张指令卡片。`;
    } finally { busy = false; drainQueuedReportWake(); }
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === "bridgePing") { respond({ok: true}); return false; }
    if (message.type === "bridgeFlowStopped") {
      stopAutomaticLoop();
      status("当前流程已结束；自动检查已停止");
      respond({ok: true}); return false;
    }
    if (message.type === "bridgeFlowStarted") {
      startAutomaticLoop("flow_started").then(() => respond({ok: true}),
        error => respond({ok: false, error: String(error)}));
      return true;
    }
    if (message.type === "bridgeReportReady") {
      if (automaticLoopStopped) { respond({ok: true, stopped: true}); return false; }
      const reportId = Number(message.reportId);
      if (!Number.isSafeInteger(reportId) || reportId <= 0) {
        respond({ok: false, error: "无效的报告编号"}); return false;
      }
      record("content_wake_received", {reportId});
      if (busy) {
        reportWakeQueued = true;
        respond({ok: true, queued: true}); return false;
      }
      tick("report_ready").then(() => respond({ok: true}), error => respond({ok: false, error: String(error)}));
      return true;
    }
    if (message.type === "bridgeUiAction") {
      actionFeedback(message.text, !!message.error);
      if (message.phase === "unbound") status("未绑定；自动桥接已停止");
      respond({ok: true}); return false;
    }
    if (message.type === "bridgeCardChoices" || message.type === "bridgeChooseCard") {
      cardChoices(message.type === "bridgeChooseCard" ? message.index : null,
        message.type === "bridgeChooseCard" ? message.key : null)
        .then(result => respond({ok: true, data: result}), error => respond({ok: false, error: String(error)}));
      return true;
    }
    if (message.type !== "bridgeRecover") return false;
    recover(message.action).then(result => respond({ok: true, message: result}),
      error => respond({ok: false, error: String(error)}));
    return true;
  });

  function syncRun(state) {
    if (state.runId === runId) return;
    invalidatePageScan();
    signatureFingerprints.clear();
    if (assistantWaitDiagnostic?.active) {
      record("assistant_wait_abandoned", {reportId: assistantWaitDiagnostic.reportId,
        reason: "run_changed"});
      assistantWaitDiagnostic = null;
    }
    clearQueuedAssistantWaitTick();
    assistantWaitLastWakeAt = 0;
    disconnectAssistantWaitObserver();
    runId = state.runId;
    sentReport = 0;
    attemptedReport = 0;
    attemptedAt = 0;
    preSendAssistant = "";
    preSendAssistantContentSignature = "";
    preSendAssistantCount = 0;
    preSendAssistantUnitKey = "";
    preSendUserCount = 0;
    preSendUserText = "";
    preSendUserUnitKeys = [];
    preSendUserUnitKeysReportId = 0;
    preSendGenerating = false;
    preSendGeneratingReportId = 0;
    baselinedReport = 0;
    confirmationBaselineId = 0;
    confirmationBaselineCounts = null;
    lastPhase = "";
    recordedEvents.clear();
    stableSince = Date.now();
    sessionStorage.setItem("bridge.runId", runId);
    for (const key of ["sentReport", "attemptedReport", "attemptedAt", "pendingReport", "preSendAssistant", "preSendAssistantContentSignature", "preSendAssistantCount", "preSendUserCount", "preSendUserText", "preSendUserUnitKeys", "preSendUserUnitKeysReportId", "preSendGenerating", "preSendGeneratingReportId", "baselinedReport", "confirmationBaselineId", "confirmationBaselineCounts"])
      sessionStorage.removeItem(`bridge.${key}`);
  }

  async function tick(trigger = "manual") {
    if (automaticLoopStopped && trigger !== "manual" && trigger !== "flow_started") return;
    if (busy) {
      if (trigger !== "setInterval") pageCheckQueued = true;
      return;
    }
    if (trigger === "setInterval" && Date.now() < nextAutomaticCheckAt) return;
    if (trigger === "manual") invalidatePageScan();
    clearQueuedAssistantWaitTick();
    busy = true;
    const epoch = flowEpoch;
    let pass = null;
    let pendingAutomaticInstructionId = "";
    try {
      const config = await bridgeSettings();
      if (epoch !== flowEpoch) return;
      if (!config.bound) {
        recordAssistantWaitCheckpoint(assistantWaitDiagnostic, "bridge_unbound");
        const bar = document.getElementById("codex-bridge-status");
        if (bar?.dataset.bridgeInstance === scriptInstance) bar.remove();
        return;
      }
      const state = await api("/state");
      if (epoch !== flowEpoch) return;
      syncRun(state);
      if (state.phase !== lastPhase) {
        lastPhase = state.phase;
        record("phase", {phase: state.phase, round: state.round, reportId: state.reportId});
      }
      if (state.phase === "stopped") {
        status(state.detail || "已停止", true);
        stopAutomaticLoop();
        return;
      }
      if (state.phase === "setup") {
        recordAssistantWaitCheckpoint(assistantWaitDiagnostic, "bridge_phase", {phase: state.phase});
        status("已连接；请在扩展弹窗选择 A 或 B 起点"); return;
      }
      if (state.phase === "codex_running") {
        recordAssistantWaitCheckpoint(assistantWaitDiagnostic, "bridge_phase", {phase: state.phase});
        status(`Codex 第 ${state.round} 轮运行中`); return;
      }
      if (state.phase === "report_ready") {
        recordAssistantWaitCheckpoint(assistantWaitDiagnostic, "bridge_phase", {phase: state.phase});
        status("正在处理 Codex 最终报告，核对 ChatGPT 发送状态");
        await sendReport(state.report, state.reportId, config, epoch); return;
      }
      if (document.visibilityState === "hidden" && !assistantWaitDiagnostic?.active) {
        status("ChatGPT 标签页在后台；恢复可见后继续自动检查");
        return;
      }
      pass = {texts: new WeakMap(), visibility: new WeakMap(),
        cardScans: 0, cardCacheHits: 0, cardScanMs: 0};
      scanPass = pass;
      const messages = assistantMessages();
      const unitFallback = messages.length === 0;
      const units = unitFallback ? visibleContentSearchUnits() : [];
      const latest = messages.at(-1) || units.at(-1);
      observeLatestAssistant(latest || null);
      const wait = assistantWaitDiagnostic?.active ? assistantWaitDiagnostic : null;
      if (wait) {
        const tickAt = Date.now();
        record("assistant_wait_tick", {reportId: wait.reportId,
          elapsedMs: tickAt - wait.startedAt,
          tickGapMs: wait.lastTickAt ? tickAt - wait.lastTickAt : 0,
          cardFirstSeen: !!wait.cardFirstSeen, assistantTurnDetected: !!wait.turnDetected,
          replyCompleted: !!wait.replyCompleted, visibilityState: document.visibilityState || "unknown",
          busy: false, method: trigger, ...assistantWaitSelectionDiagnostics(wait, messages, latest)});
        wait.lastTickAt = tickAt;
      }
      if (!latest) {
        deferEmptyCardCheck();
        if (wait) record("assistant_wait_blocked", {reportId: wait.reportId,
          elapsedMs: Date.now() - wait.startedAt, reason: "no_content",
          visibilityState: document.visibilityState || "unknown"}, `assistant_wait_blocked:${wait.reportId}:no_content`);
        recordAssistantWaitCheckpoint(wait, "no_content", {assistantMessageCount: messages.length,
          latestTextLength: 0, isGenerating: false});
        record("page_wait", {reason: "no_content"}, "page_wait:no_content");
        status("等待 ChatGPT 内容区域出现"); return;
      }
      const generating = isGenerating();
      pageIsGenerating = generating;
      if (wait) {
        if (!wait.cardFirstSeen && !wait.initialAssistantStateLogged) {
          wait.initialAssistantStateLogged = true;
          recordAssistantWaitCheckpoint(wait, "assistant_state", {phase: state.phase,
            assistantMessageCount: messages.length,
            latestTextLength: (latest.innerText || latest.textContent || "").trim().length,
            isGenerating: generating});
        }
        const latestUnitKey = contentUnitKey(latest);
        const turnDiagnostics = assistantWaitSelectionDiagnostics(wait, messages, latest);
        const newTurn = assistantTurnChanged(wait, turnDiagnostics, messages);
        if (newTurn && !wait.turnDetected) {
          wait.turnDetected = true;
          const turnDetectionReasons = turnDiagnostics.assistantUnitKeyChanged
            ? ["unit_key_changed"]
            : turnDiagnostics.assistantContentSignatureChanged
              ? ["signature_changed"]
              : messages.length > wait.baselineCount ? ["count_changed"] : [];
          record("assistant_turn_detected", {reportId: wait.reportId,
            elapsedMs: Date.now() - wait.startedAt,
            assistantMessages: messages.length,
            assistantBaselineCount: wait.baselineCount,
            assistantCountDelta: messages.length - wait.baselineCount,
            assistantTurnDetected: true,
            turnDetectionReasons,
            ...turnDiagnostics,
            isGenerating: generating,
            visibilityState: document.visibilityState || "unknown",
            method: turnDiagnostics.assistantUnitKeyChanged ? "unit_key" : "signature"},
          `assistant_turn_detected:${wait.reportId}`);
        }
        if (newTurn && !generating && !wait.replyCompleted) {
          wait.replyCompleted = true;
          record("assistant_reply_completed", {reportId: wait.reportId,
            elapsedMs: Date.now() - wait.startedAt,
            assistantMessages: messages.length,
            assistantBaselineCount: wait.baselineCount,
            assistantCountDelta: messages.length - wait.baselineCount,
            assistantTurnDetected: true,
            isGenerating: false,
            visibilityState: document.visibilityState || "unknown",
            method: "stop_button_absent"}, `assistant_reply_completed:${wait.reportId}`);
        }
        if (!wait.cardFirstSeen) {
          try {
            const diagnosticTitle = new RegExp(config.title || DEFAULT_TITLE.source, "i");
            const diagnosticCard = extractCard(latest, diagnosticTitle, config.card || "");
            const cardChoices = diagnosticCard.choices?.length || (diagnosticCard.instruction ? 1 : 0);
            if (cardChoices) {
              wait.cardFirstSeen = true;
              record("card_dom_first_seen", {reportId: wait.reportId,
                elapsedMs: Date.now() - wait.startedAt,
                assistantMessages: messages.length,
                cardChoices,
                instructionLength: diagnosticCard.instruction?.length || 0,
                isGenerating: generating,
                visibilityState: document.visibilityState || "unknown",
                method: "setInterval_poll"}, `card_dom_first_seen:${wait.reportId}`);
            }
          } catch {
            record("card_dom_probe_error", {reportId: wait.reportId,
              elapsedMs: Date.now() - wait.startedAt}, `card_dom_probe_error:${wait.reportId}`);
          }
        }
      }
      if (generating) {
        if (wait) record("assistant_wait_blocked", {reportId: wait.reportId,
          elapsedMs: Date.now() - wait.startedAt, reason: "generating",
          visibilityState: document.visibilityState || "unknown"}, `assistant_wait_blocked:${wait.reportId}:generating`);
        recordAssistantWaitCheckpoint(wait, "assistant_generating", {phase: state.phase,
          assistantMessageCount: messages.length, isGenerating: true});
        record("page_wait", {reason: "generating"}, "page_wait:generating");
        status("等待 ChatGPT 回复完成"); return;
      }
      const text = messageText(latest);
      if (!text) {
        deferEmptyCardCheck();
        recordAssistantWaitCheckpoint(wait, "empty_assistant_text", {phase: state.phase,
          assistantMessageCount: messages.length, latestTextLength: 0, isGenerating: false});
        status("等待 ChatGPT 回复内容"); return;
      }
      if (wait && !assistantWaitCanScan(wait)) {
        deferEmptyCardCheck();
        recordAssistantWaitCheckpoint(wait, "waiting_for_new_assistant_turn", {
          assistantMessageCount: messages.length,
          latestTextLength: text.length,
          assistantTurnDetected: !!wait.turnDetected,
          replyCompleted: !!wait.replyCompleted,
          ...assistantWaitSelectionDiagnostics(wait, messages, latest)
        });
        status("等待 ChatGPT 新回复"); return;
      }
      const unitKey = contentUnitKey(latest);
      const signature = unitKey
        ? `${location.pathname || "/"}:${unitKey}:${normalize(text)}`
        : unitFallback
          ? `content-search-unit:${normalize(text)}`
          : `${messages.length}:${text}`;
      const now = Date.now();
      const observedMutationCount = wait?.assistantContentMutationCount || 0;
      const hasUnprocessedObservedChange = !!wait &&
        observedMutationCount > (wait.lastSignatureMutationCount || 0);
      const signatureChanged = signature !== lastSignature;
      if (signatureChanged) {
        const previousStableElapsedMs = wait?.lastContentChangeAt
          ? now - wait.lastContentChangeAt : stableSince ? now - stableSince : 0;
        lastSignature = signature;
        if (wait) {
          wait.signatureChangeCount = (wait.signatureChangeCount || 0) + 1;
          wait.lastSignatureChangedAt = hasUnprocessedObservedChange
            ? wait.lastContentChangeAt : now;
          if (!hasUnprocessedObservedChange) wait.lastContentChangeAt = now;
          wait.lastSignatureMutationCount = observedMutationCount;
          wait.stabilityStartedAt = wait.lastContentChangeAt || now;
          wait.stabilityEndedAt = 0;
          stableSince = wait.lastContentChangeAt || now;
          record("page_stability_reset", {reportId: wait.reportId,
            reason: "signature_changed",
            elapsedMs: now - wait.startedAt,
            previousStableElapsedMs,
            signatureChangeCount: wait.signatureChangeCount,
            signatureLength: signature.length,
            unitKeyLength: unitKey.length,
            latestTextLength: text.length,
            assistantMessageCount: messages.length,
            isGenerating: generating,
            visibilityState: document.visibilityState || "unknown",
            ...assistantWaitDiagnosticFields(wait)});
          record("page_stability_wait_started", {reportId: wait.reportId,
            elapsedMs: now - wait.startedAt,
            lastContentChangeAt: wait.lastContentChangeAt,
            stabilityStartedAt: wait.stabilityStartedAt,
            stableThresholdMs: 1800,
            stableElapsedMs: Math.max(0, now - wait.lastContentChangeAt),
            signatureChanged: true,
            signatureChangeCount: wait.signatureChangeCount,
            visibilityState: document.visibilityState || "unknown",
            method: "setInterval_or_observer",
            rafUsed: false,
            setTimeoutUsed: false,
            visibilityUsed: false,
            mutationObserverUsed: true},
          `page_stability_wait_started:${wait.reportId}:${wait.stabilityStartedAt}`);
        } else {
          stableSince = now;
        }
      } else if (wait && hasUnprocessedObservedChange) {
        wait.lastSignatureMutationCount = observedMutationCount;
        wait.stabilityStartedAt = wait.lastContentChangeAt || now;
        wait.stabilityEndedAt = 0;
      }
      const lastContentChangeAt = wait?.lastContentChangeAt || stableSince;
      const stableElapsedMs = Math.max(0, now - lastContentChangeAt);
      if (wait && !wait.stabilityStartedAt) {
        wait.stabilityStartedAt = lastContentChangeAt || now;
        record("page_stability_wait_started", {reportId: wait.reportId,
          elapsedMs: now - wait.startedAt,
          lastContentChangeAt: wait.lastContentChangeAt || now,
          stabilityStartedAt: wait.stabilityStartedAt,
          stableThresholdMs: 1800,
          stableElapsedMs,
          signatureChanged: false,
          visibilityState: document.visibilityState || "unknown",
          method: "setInterval_or_observer",
          rafUsed: false,
          setTimeoutUsed: false,
          visibilityUsed: false,
          mutationObserverUsed: true},
        `page_stability_wait_started:${wait.reportId}:${wait.stabilityStartedAt}`);
      }
      if (stableElapsedMs < 1800) {
        recordAssistantWaitCheckpoint(wait, "stable_threshold", {phase: state.phase,
          stableElapsedMs, assistantMessageCount: messages.length,
          latestTextLength: text.length, isGenerating: false});
        status("等待页面内容稳定"); return;
      }
      if (wait?.stabilityStartedAt && !wait.stabilityEndedAt) {
        wait.stabilityEndedAt = now;
        record("page_stability_wait_ended", {reportId: wait.reportId,
          elapsedMs: wait.stabilityEndedAt - wait.startedAt,
          lastContentChangeAt: wait.lastContentChangeAt,
          stabilityStartedAt: wait.stabilityStartedAt,
          stableElapsedMs,
          stableThresholdMs: 1800,
          signatureChangeCount: wait.signatureChangeCount || 0,
          reason: "threshold_reached_no_signature_change",
          ...assistantWaitDiagnosticFields(wait),
          visibilityState: document.visibilityState || "unknown",
          method: trigger,
          rafUsed: false,
          setTimeoutUsed: false,
          visibilityUsed: false,
          mutationObserverUsed: true}, `page_stability_wait_ended:${wait.reportId}:${wait.stabilityStartedAt}`);
      }
      if (signature === lastSubmitted) {
        deferEmptyCardCheck();
        recordAssistantWaitCheckpoint(wait, "signature_already_submitted", {phase: state.phase,
          stableElapsedMs, latestTextLength: text.length, isGenerating: false});
        status("已处理当前指令，等待 ChatGPT 新回复"); return;
      }
      if (document.visibilityState === "hidden") {
        if (wait?.active && wait.cardFirstSeen && stableElapsedMs >= 1800 && !wait.pendingSubmit) {
          wait.pendingSubmit = true;
          wait.pendingSubmitAt = now;
          record("assistant_wait_pending_submit", {reportId: wait.reportId,
            elapsedMs: now - wait.startedAt,
            stableElapsedMs,
            stableThresholdMs: 1800,
            cardFirstSeen: true,
            visibilityState: "hidden"});
          status("指令卡片已稳定，正在后台扫描并提交");
        }
        if (!wait?.pendingSubmit) {
          status("后台等待有效指令卡片");
          return;
        }
      }
      if (wait?.pendingSubmit) {
        const pendingForMs = wait.pendingSubmitAt ? now - wait.pendingSubmitAt : 0;
        if (document.visibilityState !== "hidden") {
          record("assistant_wait_pending_submit_resumed", {reportId: wait.reportId,
            elapsedMs: now - wait.startedAt,
            pendingForMs,
            visibilityState: "visible"});
        }
        wait.pendingSubmit = false;
        wait.pendingSubmitAt = 0;
      }
      if (!unitFallback && STOP.test(text)) {
        scanPass = null;
        if (epoch !== flowEpoch) return;
        await api("/stop", "POST", {reason: text.slice(0, 400), runId});
        if (epoch !== flowEpoch) return;
        stopAutomaticLoop();
        status("ChatGPT 表示任务完成或需要人工处理，已停止"); return;
      }
      const title = new RegExp(config.title || DEFAULT_TITLE.source, "i");
      let found = extractCard(latest, title, config.card || "");
      let fallbackCandidateCount = 0;
      if (unitFallback) {
        const fresh = cardEntries(found).filter(entry => !instructionIsHandled(instructionId(entry.instruction, latest)));
        fallbackCandidateCount = fresh.length;
        if (found.instruction) {
          if (instructionIsHandled(instructionId(found.instruction, latest)))
            found = {error: "未找到新的严格匹配指令卡片"};
        } else if (found.choices?.length && fresh.length === 1) {
          found = {instruction: fresh[0].instruction};
        } else if (found.choices?.length && fresh.length > 1) {
          found = {choices: fresh};
        } else {
          found = {error: "未找到新的严格匹配指令卡片"};
        }
      }
      record("card_scan", {cardChoices: found.choices?.length || (found.instruction ? 1 : 0),
        instructionLength: found.instruction?.length || 0,
        latestCardLength: found.choices?.at(-1)?.instruction.length || found.instruction?.length || 0,
        fallbackCandidateCount,
        method: unitFallback ? "content_search_unit" : "assistant_role",
        ...(wait ? {reportId: wait.reportId, elapsedMs: Date.now() - wait.startedAt,
          stableElapsedMs: Date.now() - stableSince,
          assistantTurnDetected: wait.turnDetected,
          visibilityState: document.visibilityState || "unknown"} : {}),
        reason: found.instruction ? "matched" : "not_matched"}, `card_scan:${signature}`);
      if (unitFallback) {
        if (!found.instruction) {
          deferEmptyCardCheck();
          status("等待当前回复中出现新的指令卡片");
          return;
        }
      }
      if (!found.instruction) {
        deferEmptyCardCheck();
        if (found.choices?.length > 1) {
          status(`找到 ${found.choices.length} 张不同的指令卡片；请在扩展弹窗选择`, true);
          return;
        }
        status(`${found.error}；等待页面更新，或在扩展弹窗重新检查并人工选择卡片`, true); return;
      }
      const id = instructionId(found.instruction, latest);
      const instructionState = instructionStates.get(id);
      if (instructionState) {
        deferEmptyCardCheck();
        if (instructionState === "pending") {
          status("指令请求结果待确认；为避免重复投递，自动重试已暂停", true);
          return;
        }
        lastSubmitted = signature;
        sessionStorage.setItem("bridge.lastSubmitted", signature);
        status("当前指令卡片已处理，等待新卡片");
        return;
      }
      emptyCardChecks = 0;
      nextAutomaticCheckAt = 0;
      const codexInstruction = formatCodexInstruction(found.instruction);
      if (epoch !== flowEpoch) return;
      setInstructionState(id, "pending");
      pendingAutomaticInstructionId = id;
      if (wait) {
        record("instruction_submit", {reportId: wait.reportId,
          instructionId: id,
          instructionLength: found.instruction.length,
          elapsedMs: Date.now() - wait.startedAt,
          visibilityState: document.visibilityState || "unknown"});
        wait.active = false;
        disconnectAssistantWaitObserver();
      }
      scanPass = null;
      await api("/instruction", "POST", {instruction: codexInstruction, instructionId: id,
        runId});
      setInstructionState(id, "seen");
      pendingAutomaticInstructionId = "";
      if (epoch !== flowEpoch) return;
      record("card_submit", {instructionLength: found.instruction.length});
      lastSubmitted = signature;
      sessionStorage.setItem("bridge.lastSubmitted", signature);
      status(unitFallback
        ? "已自动识别并发送最新的未处理指令卡片"
        : "指令卡片已送往 Codex");
    } catch (error) {
      if (epoch !== flowEpoch) return;
      if (/Extension context invalidated/i.test(String(error))) {
        stopInvalidatedScript();
        return;
      }
      const details = errorDiagnostics(error);
      deferEmptyCardCheck();
      record("tick_error", {...details,
        stage: error?.bridgeReportStage || "automatic_tick",
        ...(Number.isFinite(Number(error?.reportId)) ? {reportId: Number(error.reportId)} : {})});
      status(String(error), true);
    } finally {
      if (pass && epoch === flowEpoch) {
        scanMetrics.checkCount += 1;
        scanMetrics.cardParseCount += pass.cardScans;
        scanMetrics.cardCacheHits += pass.cardCacheHits;
        scanMetrics.cardParseMs += pass.cardScanMs;
        if (Date.now() - lastScanMetricsAt >= LOG_REPEAT_INTERVAL_MS) {
          record("scan_metrics", {...scanMetrics,
            cardParseMs: Math.round(scanMetrics.cardParseMs * 1000) / 1000,
            pollDelayMs: Math.max(0, nextAutomaticCheckAt - Date.now())});
          scanMetrics = {checkCount: 0, cardParseCount: 0, cardCacheHits: 0, cardParseMs: 0};
          lastScanMetricsAt = Date.now();
        }
      }
      scanPass = null;
      busy = false;
      if (epoch === flowEpoch) {
        drainQueuedAssistantWaitTick();
        drainQueuedReportWake();
        if (pageCheckQueued) { pageCheckQueued = false; schedulePageCheck(); }
      }
    }
  }
  function stopAutomaticLoop() {
    flowEpoch += 1;
    automaticLoopStopped = true;
    if (tickInterval !== null) clearInterval(tickInterval);
    tickInterval = null;
    if (pageWakeTimer !== null) clearTimeout(pageWakeTimer);
    pageWakeTimer = null;
    pageCheckQueued = false;
    pageIsGenerating = false;
    pageObserver?.disconnect();
    focusedPageObserver?.disconnect();
    pageObserver = null;
    focusedPageObserver = null;
    observedAssistant = null;
    cardScanCache = new WeakMap();
    signatureFingerprints.clear();
    scanMetrics = {checkCount: 0, cardParseCount: 0, cardCacheHits: 0, cardParseMs: 0};
    lastScanMetricsAt = 0;
    invalidatePageScan();
    clearQueuedAssistantWaitTick();
    assistantWaitLastWakeAt = 0;
    reportWakeQueued = false;
    assistantWaitDiagnostic = null;
    disconnectAssistantWaitObserver();
  }

  function startAutomaticLoop(trigger = "setInterval") {
    automaticLoopStopped = false;
    invalidatePageScan();
    startPageObserver();
    if (tickInterval !== null) return tick(trigger).then(() => false);
    tickInterval = setInterval(() => { void tick("setInterval"); }, 2000);
    return tick(trigger).then(() => true);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || automaticLoopStopped) return;
    invalidatePageScan();
    if (!assistantWaitDiagnostic?.active) { schedulePageCheck(); return; }
    assistantWaitLastWakeAt = 0;
    requestAssistantWaitTick("visibility_visible");
  });

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !["connections", "title", "card"].some(key => key in changes)) return;
    invalidatePageScan();
    schedulePageCheck();
  });

  void startAutomaticLoop("script_started");
})();
