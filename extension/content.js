(() => {
  const DEFAULT_TITLE = /给\s*Codex\s*的指令|Instructions?\s+for\s+Codex/i;
  const REPORT_PREFIX = "以下是 Codex 上一轮的最终报告";
  const STOP = /^[\s#*_]*(任务完成|已完成|完成|需要人工处理|等待人工|human action required|task complete)/i;
  let busy = false;
  let lastSignature = "";
  let stableSince = 0;
  let lastSubmitted = sessionStorage.getItem("bridge.lastSubmitted") || "";
  let sentReport = Number(sessionStorage.getItem("bridge.sentReport") || "0");
  let attemptedReport = Number(sessionStorage.getItem("bridge.attemptedReport") || "0");
  let attemptedAt = Number(sessionStorage.getItem("bridge.attemptedAt") || "0");
  let preSendAssistant = sessionStorage.getItem("bridge.preSendAssistant") || "";
  let preSendAssistantCount = Number(sessionStorage.getItem("bridge.preSendAssistantCount") || "0");
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
  let phaseStatus = "等待桥接器状态";
  let phaseStatusError = false;
  let phaseChangedAt = Date.now();
  let lastCheckAt = 0;
  let actionStatus = "";
  let actionStatusError = false;
  let actionChangedAt = 0;
  const scriptInstance = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let tickInterval = null;

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

  function record(event, data = {}, onceKey = "") {
    if (onceKey) {
      if (recordedEvents.has(onceKey)) return Promise.resolve();
      recordedEvents.add(onceKey);
    }
    let snapshot;
    try { snapshot = operationSnapshot(); }
    catch { snapshot = {reason: "snapshot_failed"}; }
    try {
      return chrome.runtime.sendMessage({type: "bridgeLog", event,
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

  function renderStatus() {
    let bar = document.getElementById("codex-bridge-status");
    if (!bar) {
      bar = document.createElement("div"); bar.id = "codex-bridge-status";
      Object.assign(bar.style, {position: "fixed", bottom: "8px", right: "8px", zIndex: "2147483647",
        padding: "8px 10px", borderRadius: "7px", font: "12px system-ui", maxWidth: "360px",
        whiteSpace: "pre-wrap",
        boxShadow: "0 1px 7px #0004"});
      document.body.appendChild(bar);
    }
    bar.dataset.bridgeInstance = scriptInstance;
    bar.style.background = phaseStatusError || actionStatusError ? "#ffdfdf" : "#e5f4e9";
    bar.style.color = "#222";
    const clock = time => new Date(time).toLocaleTimeString();
    bar.textContent = `Codex 桥接：${phaseStatus}\n状态更新：${clock(phaseChangedAt)}` +
      (actionStatus ? `\n最近操作 ${clock(actionChangedAt)}：${actionStatus}` : "") +
      (lastCheckAt ? `\n连接检查：${clock(lastCheckAt)}` : "");
  }

  function status(text, error = false) {
    if (phaseStatus !== text || phaseStatusError !== error) {
      phaseStatus = text;
      phaseStatusError = error;
      phaseChangedAt = Date.now();
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
    if (tickInterval !== null) clearInterval(tickInterval);
    tickInterval = null;
    const bar = document.getElementById("codex-bridge-status");
    if (bar?.dataset.bridgeInstance === scriptInstance) {
      bar.style.background = "#fff0c2";
      bar.style.color = "#222";
      bar.textContent = "Codex 桥接：扩展已重新加载。请刷新当前 ChatGPT 标签页，然后在弹窗中重新绑定。";
    }
  }

  function assistantMessages() {
    const current = [...document.querySelectorAll('[data-content-search-unit-key$=":assistant"]')]
      .filter(el => isVisible(el) && (el.innerText || el.textContent || "").trim());
    if (current.length) return current;
    const direct = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
      .filter(el => isVisible(el) && (el.innerText || el.textContent || "").trim());
    if (direct.length) return direct;
    // A generic conversation turn or article may be a user message. Only use
    // a fallback when the DOM explicitly identifies the assistant author.
    return [...document.querySelectorAll(
      '[data-author-role="assistant"], [data-role="assistant"], [data-testid*="assistant-message"]'
    )].filter(el => isVisible(el) && (el.innerText || el.textContent || "").trim());
  }

  function isGenerating() {
    const selectors = '[data-testid="stop-button"], button[aria-label*="Stop generating"], button[aria-label*="停止生成"]';
    return [...document.querySelectorAll(selectors)].some(button => {
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
      .filter(node => isVisible(node) && node.children.length === 0 &&
        (node.innerText || node.textContent || "").trim().length < 100 &&
        isExactTitle((node.innerText || node.textContent || "").trim(), titleRegex));
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
    return [...document.querySelectorAll("[data-content-search-unit-key]")]
      .filter(el => isVisible(el) && (el.innerText || el.textContent || "").trim());
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
    if (messages.length) return `${messages.length}:${(messages.at(-1).innerText || "").trim()}`;
    const units = visibleContentSearchUnits();
    const latest = units.at(-1);
    return latest
      ? `content-search-unit:${latest.getAttribute("data-content-search-unit-key") || ""}:${normalize(latest.innerText || latest.textContent || "")}`
      : "";
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

  function drainQueuedReportWake() {
    if (busy || !reportWakeQueued) return;
    reportWakeQueued = false;
    void tick();
  }

  async function acknowledgeReport(reportId, skipPreviousAssistant = false) {
    record("report_confirmed", {reportId, confirmed: true}, `report_confirmed:${reportId}`);
    sentReport = reportId;
    sessionStorage.setItem("bridge.sentReport", String(reportId));
    if (skipPreviousAssistant && preSendAssistant) {
      lastSubmitted = preSendAssistant;
      sessionStorage.setItem("bridge.lastSubmitted", lastSubmitted);
    }
    await api("/ack", "POST", {reportId, runId});
    status("最终报告已发往 ChatGPT，等待下一轮");
  }

  async function sendReport(report, reportId) {
    const currentState = await api("/state");
    if (currentState.phase !== "report_ready" || currentState.reportId !== reportId) {
      status(currentState.detail || "当前流程已结束或报告状态已变化；未自动发送报告", true);
      return;
    }
    if (sentReport === reportId) { await api("/ack", "POST", {reportId, runId}); return; }
    record("report_send_started", {reportId}, `report_send_started:${reportId}`);
    record("report_ready", {reportId, reportLength: report.length}, `report_ready:${reportId}`);
    if (baselinedReport !== reportId) {
      const config = await bridgeSettings();
      rememberVisibleCards(new RegExp(config.title || DEFAULT_TITLE.source, "i"), config.card || "");
      baselinedReport = reportId;
      sessionStorage.setItem("bridge.baselinedReport", String(reportId));
    }
    const editor = composer();
    if (!editor) {
      record("composer_missing", {reportId}, `composer_missing:${reportId}`);
      throw new Error("找不到 ChatGPT 输入框");
    }
    const message = `以下是 Codex 上一轮的最终报告。请先分析，再决定下一步。若需继续，请把**仅给 Codex 的指令**放在一张标题为“给 Codex 的指令”、带复制按钮的内容卡片中；卡片外可写分析。若任务完成，请以“任务完成”开头且不要生成指令卡片。若需要人工处理，请以“需要人工处理”开头且不要生成指令卡片。另外，Codex 当前使用 Luna 模型，可能无法可靠遵循过长指令，请尽量把后续指令拆成简短、明确的步骤。若项目使用 Git 版本管理，请在阶段性工作完成后及时提醒 Codex 提交更改。\n\nCodex 最终报告：\n${report}`;
    if (reportWasSent(report, reportId)) { await acknowledgeReport(reportId, attemptedReport === reportId); return; }
    const existing = (editor.innerText || editor.textContent || "").trim();
    const ownDraft = normalize(existing).startsWith(normalize(message).slice(0, 90)) &&
      normalize(existing).includes(normalize(report).slice(0, 120));
    if (existing && !ownDraft) throw new Error("ChatGPT 输入框中有你的未发送草稿；桥接已暂停发送");
    if (attemptedReport === reportId) {
      const elapsed = Date.now() - (attemptedAt || Date.now());
      status(elapsed > 30000 ? "发送已触发，但仍未确认；请在扩展弹窗选择恢复操作" : "发送已触发，继续核对网页消息", elapsed > 30000);
      return;
    }
    if (!ownDraft) {
      if (confirmationBaselineId !== reportId) saveReportBaseline(report, reportId);
      editor.focus();
      document.execCommand("insertText", false, message);
      editor.dispatchEvent(new InputEvent("input", {bubbles: true, inputType: "insertText", data: message}));
      const filledLength = (editor.innerText || editor.textContent || "").length;
      record("report_fill", {reportId, filledLength}, `report_fill:${reportId}`);
      if (!(editor.innerText || editor.textContent || "").includes(report)) throw new Error("输入框填充校验失败");
    }
    const buttonReady = await waitFor(() => {
      const button = sendButton(editor);
      return !!button && !button.disabled && button.getAttribute("aria-disabled") !== "true";
    }, 2000);
    if (!buttonReady) {
      record("send_button_unavailable", {reportId}, `send_button_unavailable:${reportId}`);
      status("报告已填入输入框；发送按钮暂不可用，桥接将在下一轮重试");
      return;
    }
    const latestState = await api("/state");
    if (latestState.phase !== "report_ready" || latestState.reportId !== reportId) {
      status(latestState.detail || "当前流程已结束或报告状态已变化；未自动发送报告", true);
      return;
    }
    preSendAssistant = currentAssistantSignature();
    sessionStorage.setItem("bridge.preSendAssistant", preSendAssistant);
    preSendAssistantCount = assistantMessages().length;
    sessionStorage.setItem("bridge.preSendAssistantCount", String(preSendAssistantCount));
    capturePreSendUserBaseline(reportId);
    attemptedReport = reportId;
    sessionStorage.setItem("bridge.attemptedReport", String(reportId));
    attemptedAt = Date.now();
    sessionStorage.setItem("bridge.attemptedAt", String(attemptedAt));
    record("send_click", {reportId}, `send_click:${reportId}`);
    sendButton(editor).click();
    if (!await waitFor(() => reportWasSent(report, reportId), 10000)) {
      record("report_unconfirmed", {reportId, confirmed: false,
        ...reportTextEvidence(report, reportId),
        ...reportConfirmationSignals(report, reportId)}, `report_unconfirmed:${reportId}`);
      status("发送已触发，正在继续核对网页消息；如长时间未确认，可在扩展弹窗处理");
      return;
    }
    await acknowledgeReport(reportId, true);
  }

  async function recover(action) {
    if (busy) await waitFor(() => !busy, 12000);
    if (busy) throw new Error("桥接器仍在检查页面，请稍后重试");
    busy = true;
    try {
      const state = await api("/state");
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
    try {
      const config = await bridgeSettings();
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
      setInstructionState(id, "pending");
      await api("/instruction", "POST", {
        instruction: selected.instruction,
        instructionId: id,
        runId: state.runId
      });
      setInstructionState(id, "seen");
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
    if (message.type === "bridgeReportReady") {
      const reportId = Number(message.reportId);
      if (!Number.isSafeInteger(reportId) || reportId <= 0) {
        respond({ok: false, error: "无效的报告编号"}); return false;
      }
      record("content_wake_received", {reportId});
      if (busy) {
        reportWakeQueued = true;
        respond({ok: true, queued: true}); return false;
      }
      tick().then(() => respond({ok: true}), error => respond({ok: false, error: String(error)}));
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
    runId = state.runId;
    sentReport = 0;
    attemptedReport = 0;
    attemptedAt = 0;
    preSendAssistant = "";
    preSendAssistantCount = 0;
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
    for (const key of ["sentReport", "attemptedReport", "attemptedAt", "preSendAssistant", "preSendAssistantCount", "preSendUserCount", "preSendUserText", "preSendUserUnitKeys", "preSendUserUnitKeysReportId", "preSendGenerating", "preSendGeneratingReportId", "baselinedReport", "confirmationBaselineId", "confirmationBaselineCounts"])
      sessionStorage.removeItem(`bridge.${key}`);
  }

  async function tick() {
    if (busy) return;
    busy = true;
    let pendingAutomaticInstructionId = "";
    try {
      const config = await bridgeSettings();
      if (!config.bound) {
        const bar = document.getElementById("codex-bridge-status");
        if (bar?.dataset.bridgeInstance === scriptInstance) bar.remove();
        return;
      }
      const state = await api("/state");
      syncRun(state);
      if (state.phase !== lastPhase) {
        lastPhase = state.phase;
        record("phase", {phase: state.phase, round: state.round, reportId: state.reportId});
      }
      if (state.phase === "stopped") { status(state.detail || "已停止", true); return; }
      if (state.phase === "setup") { status("已连接；请在扩展弹窗选择 A 或 B 起点"); return; }
      if (state.phase === "codex_running") { status(`Codex 第 ${state.round} 轮运行中`); return; }
      if (state.phase === "report_ready") {
        status("正在处理 Codex 最终报告，核对 ChatGPT 发送状态");
        await sendReport(state.report, state.reportId); return;
      }
      const messages = assistantMessages();
      const unitFallback = messages.length === 0;
      const units = unitFallback ? visibleContentSearchUnits() : [];
      const latest = messages.at(-1) || units.at(-1);
      if (!latest) {
        record("page_wait", {reason: "no_content"}, "page_wait:no_content");
        status("等待 ChatGPT 内容区域出现"); return;
      }
      if (isGenerating()) {
        record("page_wait", {reason: "generating"}, "page_wait:generating");
        status("等待 ChatGPT 回复完成"); return;
      }
      const text = (latest.innerText || "").trim();
      if (!text) { status("等待 ChatGPT 回复内容"); return; }
      const unitKey = contentUnitKey(latest);
      const signature = unitKey
        ? `${location.pathname || "/"}:${unitKey}:${normalize(text)}`
        : unitFallback
          ? `content-search-unit:${normalize(text)}`
          : `${messages.length}:${text}`;
      if (signature !== lastSignature) { lastSignature = signature; stableSince = Date.now(); status("等待页面内容稳定"); return; }
      if (Date.now() - stableSince < 1800) { status("等待页面内容稳定"); return; }
      if (signature === lastSubmitted) { status("已处理当前指令，等待 ChatGPT 新回复"); return; }
      if (!unitFallback && STOP.test(text)) {
        await api("/stop", "POST", {reason: text.slice(0, 400), runId});
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
        reason: found.instruction ? "matched" : "not_matched"}, `card_scan:${signature}`);
      if (unitFallback) {
        if (!found.instruction) {
          status("等待当前回复中出现新的指令卡片");
          return;
        }
      }
      if (!found.instruction) {
        if (found.choices?.length > 1) {
          status(`找到 ${found.choices.length} 张不同的指令卡片；请在扩展弹窗选择`, true);
          return;
        }
        status(`${found.error}；可在扩展弹窗查看并人工选择卡片`, true); return;
      }
      const id = instructionId(found.instruction, latest);
      const instructionState = instructionStates.get(id);
      if (instructionState) {
        if (instructionState === "pending") {
          status("指令请求结果待确认；为避免重复投递，自动重试已暂停", true);
          return;
        }
        lastSubmitted = signature;
        sessionStorage.setItem("bridge.lastSubmitted", signature);
        status("当前指令卡片已处理，等待新卡片");
        return;
      }
      setInstructionState(id, "pending");
      pendingAutomaticInstructionId = id;
      await api("/instruction", "POST", {instruction: found.instruction, instructionId: id,
        runId});
      setInstructionState(id, "seen");
      pendingAutomaticInstructionId = "";
      record("card_submit", {instructionLength: found.instruction.length});
      lastSubmitted = signature;
      sessionStorage.setItem("bridge.lastSubmitted", signature);
      status(unitFallback
        ? "已自动识别并发送最新的未处理指令卡片"
        : "指令卡片已送往 Codex");
    } catch (error) {
      if (/Extension context invalidated/i.test(String(error))) {
        stopInvalidatedScript();
        return;
      }
      record("tick_error", {reason: "exception"}, `tick_error:${String(error)}`);
      status(String(error), true);
    } finally {
      busy = false;
      drainQueuedReportWake();
    }
  }
  tickInterval = setInterval(tick, 2000);
  tick();
})();
