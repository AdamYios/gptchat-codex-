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
  let runId = sessionStorage.getItem("bridge.runId") || "";
  let baselinedReport = Number(sessionStorage.getItem("bridge.baselinedReport") || "0");
  let confirmationBaselineId = Number(sessionStorage.getItem("bridge.confirmationBaselineId") || "0");
  let confirmationBaselineCounts;
  try { confirmationBaselineCounts = JSON.parse(sessionStorage.getItem("bridge.confirmationBaselineCounts") || "null"); }
  catch { confirmationBaselineCounts = null; }
  let seenCards;
  try { seenCards = new Set(JSON.parse(sessionStorage.getItem("bridge.seenCards") || "[]")); }
  catch { seenCards = new Set(); }
  let lastPhase = "";
  const recordedEvents = new Set();
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
    const candidates = [];
    const copyButton = node => [...node.querySelectorAll("button")].some(button => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${button.innerText || ""}`;
      return isVisible(button) && /(copy|复制)/i.test(label);
    });
    const titleNodes = looseTitleElements(message, titleRegex);

    // Anchor on the card title, then stop at the nearest ancestor that also
    // contains its copy control and actual body. Do not promote it to MAIN or
    // to the whole assistant turn just because those ancestors contain the
    // same descendants.
    for (const titleNode of titleNodes) {
      const titleText = (titleNode.innerText || titleNode.textContent || "").trim();
      for (let depth = 0, current = titleNode.parentElement;
           current && current !== message && depth < 12;
           depth++, current = current.parentElement) {
        const text = (current.innerText || current.textContent || "").trim();
        if (isVisible(current) && text.length >= titleText.length + 20 &&
            text.length <= 20000 && copyButton(current)) {
          candidates.push(current);
          break;
        }
      }
    }

    // If there is no title-anchored card, retain a conservative manual
    // fallback for copyable blocks. Take the nearest useful wrapper, not its
    // largest ancestor (which may be the whole conversation page).
    if (!candidates.length) {
      for (const button of [...message.querySelectorAll("button")].filter(isVisible)) {
        const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${button.innerText || ""}`;
        if (!/(copy|复制)/i.test(label)) continue;
        for (let depth = 0, current = button.parentElement;
             current && current !== message && depth < 12;
             depth++, current = current.parentElement) {
          const text = (current.innerText || current.textContent || "").trim();
          if (isVisible(current) && text.length >= 30 && text.length <= 20000) {
            candidates.push(current);
            break;
          }
        }
      }
      for (const node of [...message.querySelectorAll("pre,code")].filter(isVisible)) {
        const text = (node.innerText || node.textContent || "").trim();
        if (text.length >= 10 && text.length <= 20000) candidates.push(node);
      }
    }

    // Candidates were selected at their card boundary; only remove duplicates
    // here. Keeping a parent over a child is what previously swallowed MAIN.
    const unique = [...new Set(candidates)];
    const entries = [];
    for (const card of unique) {
      const instruction = cardText(card, titleRegex);
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
    return [...document.querySelectorAll('[data-message-author-role="user"]')];
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
    if (latestUserContains(report)) return true;
    if (!normalize(composer()?.innerText || composer()?.textContent || "")) {
      const evidence = reportTextEvidence(report, reportId);
      if (evidence.visibleDelta > 0 || evidence.domDelta > 0) return true;
    }
    // Without evidence of a new user turn or newly rendered report, require manual recovery.
    return false;
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

  function rememberVisibleCards(title, selector) {
    if (assistantMessages().length) return;
    const main = document.querySelector("main");
    if (!main) return;
    const found = extractCard(main, title, selector);
    for (const entry of cardEntries(found)) seenCards.add(cardKey(entry.instruction));
    sessionStorage.setItem("bridge.seenCards", JSON.stringify([...seenCards]));
  }

  function currentAssistantSignature() {
    const messages = assistantMessages();
    if (messages.length) return `${messages.length}:${(messages.at(-1).innerText || "").trim()}`;
    const main = document.querySelector("main");
    return main ? `main:${normalize(main.innerText || main.textContent || "")}` : "";
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
    if (sentReport === reportId) { await api("/ack", "POST", {reportId, runId}); return; }
    record("report_ready", {reportId, reportLength: report.length}, `report_ready:${reportId}`);
    if (baselinedReport !== reportId) {
      const config = await chrome.storage.local.get(["title", "card"]);
      rememberVisibleCards(new RegExp(config.title || DEFAULT_TITLE.source, "i"), config.card || "");
      baselinedReport = reportId;
      sessionStorage.setItem("bridge.baselinedReport", String(reportId));
    }
    const editor = composer();
    if (!editor) {
      record("composer_missing", {reportId}, `composer_missing:${reportId}`);
      throw new Error("找不到 ChatGPT 输入框");
    }
    const message = `以下是 Codex 上一轮的最终报告。请先分析，再决定下一步。若需继续，请把**仅给 Codex 的指令**放在一张标题为“给 Codex 的指令”、带复制按钮的内容卡片中；卡片外可写分析。若任务完成，请以“任务完成”开头且不要生成指令卡片。若需要人工处理，请以“需要人工处理”开头且不要生成指令卡片。\n\nCodex 最终报告：\n${report}`;
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
    }, 5000);
    if (!buttonReady) {
      record("send_button_unavailable", {reportId}, `send_button_unavailable:${reportId}`);
      throw new Error("报告已在输入框中，但发送按钮未启用；请检查页面，桥接不会重复填入");
    }
    preSendAssistant = currentAssistantSignature();
    sessionStorage.setItem("bridge.preSendAssistant", preSendAssistant);
    preSendAssistantCount = assistantMessages().length;
    sessionStorage.setItem("bridge.preSendAssistantCount", String(preSendAssistantCount));
    preSendUserCount = userMessages().length;
    preSendUserText = normalize(userMessages().at(-1)?.innerText || "");
    sessionStorage.setItem("bridge.preSendUserCount", String(preSendUserCount));
    sessionStorage.setItem("bridge.preSendUserText", preSendUserText);
    attemptedReport = reportId;
    sessionStorage.setItem("bridge.attemptedReport", String(reportId));
    attemptedAt = Date.now();
    sessionStorage.setItem("bridge.attemptedAt", String(attemptedAt));
    record("send_click", {reportId}, `send_click:${reportId}`);
    sendButton(editor).click();
    if (!await waitFor(() => reportWasSent(report, reportId), 10000)) {
      record("report_unconfirmed", {reportId, confirmed: false,
        ...reportTextEvidence(report, reportId)}, `report_unconfirmed:${reportId}`);
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
    } finally { busy = false; }
  }

  async function cardChoices(selectedIndex = null, selectedKey = null) {
    if (busy) await waitFor(() => !busy, 12000);
    if (busy) throw new Error("桥接器仍在检查页面，请稍后重试");
    busy = true;
    try {
      const config = await chrome.storage.local.get(["title", "card"]);
      if (isGenerating()) throw new Error("ChatGPT 当前回复仍在生成，请等待停止生成按钮消失");
      const title = new RegExp(config.title || DEFAULT_TITLE.source, "i");
      const roots = assistantMessages();
      const mainFallback = roots.length === 0;
      if (!roots.length) {
        const main = document.querySelector("main");
        if (main) roots.push(main);
      }
      if (!roots.length) throw new Error("找不到 ChatGPT 内容区域；页面结构可能已更新");

      // Viewing is scoped to the latest assistant turn when author markers exist.
      const strictChoices = [];
      const addUnique = (list, entry) => {
        if (entry?.instruction && !list.some(item => normalize(item.instruction) === normalize(entry.instruction)))
          list.push(entry);
      };
      const candidateRoots = mainFallback ? roots : roots.slice(-1);
      for (const root of candidateRoots) {
        const found = extractCard(root, title, config.card || "");
        if (found.choices?.length) for (const choice of found.choices) addUnique(strictChoices, choice);
        else if (found.instruction) addUnique(strictChoices, {
          instruction: found.instruction, preview: found.instruction.slice(0, 120)
        });
      }

      let choices = strictChoices;
      if (!choices.length && !mainFallback) {
        const looseTitle = /^\s*Codex\s*指令卡\s*[|｜:：]/i;
        choices = [];
        for (const root of candidateRoots)
          for (const choice of looseCardEntries(root, looseTitle)) addUnique(choices, choice);
      }
      let scopedLatestOnly = false;
      choices = choices.filter(choice => !seenCards.has(cardKey(choice.instruction)));
      if (mainFallback) {
        if (!seenCards.size && choices.length > 1) {
          choices = [choices.at(-1)];
          scopedLatestOnly = true;
        }
      }
      if (selectedIndex === null) {
        record("card_choices_viewed", {cardChoices: choices.length,
          latestCardLength: choices.at(-1)?.instruction.length || 0,
          method: mainFallback ? "main_latest" : "assistant_role"});
        return choices.map(({instruction, preview, relaxed}, index) =>
          ({index, key: cardKey(instruction), preview, relaxed: !!relaxed,
            latestOnly: scopedLatestOnly}));
      }
      const state = await api("/state");
      syncRun(state);
      if (state.phase !== "await_instruction")
        throw new Error(`当前状态 ${state.phase}；若先前因卡片歧义已停止，请先在扩展点 A 重新开始`);
      if (!Number.isInteger(selectedIndex) || typeof selectedKey !== "string" ||
          !choices[selectedIndex] ||
          cardKey(choices[selectedIndex].instruction) !== selectedKey)
        throw new Error("指令卡片已变化，请重新查看卡片");
      const text = roots.map(root => (root.innerText || root.textContent || "").trim()).join("\n");
      const signature = `${roots.length}:${text}`;
      await api("/instruction", "POST", {instruction: choices[selectedIndex].instruction, runId: state.runId});
      record("manual_card_submit", {instructionLength: choices[selectedIndex].instruction.length,
        cardChoices: choices.length});
      lastSubmitted = signature;
      sessionStorage.setItem("bridge.lastSubmitted", signature);
      seenCards.add(cardKey(choices[selectedIndex].instruction));
      sessionStorage.setItem("bridge.seenCards", JSON.stringify([...seenCards]));
      status(`已将第 ${selectedIndex + 1} 张指令卡片送往 Codex`);
      return `已发送第 ${selectedIndex + 1} 张指令卡片。`;
    } finally { busy = false; }
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === "bridgePing") { respond({ok: true}); return false; }
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
    lastSubmitted = "";
    sentReport = 0;
    attemptedReport = 0;
    attemptedAt = 0;
    preSendAssistant = "";
    preSendAssistantCount = 0;
    preSendUserCount = 0;
    preSendUserText = "";
    baselinedReport = 0;
    confirmationBaselineId = 0;
    confirmationBaselineCounts = null;
    seenCards = new Set();
    lastSignature = "";
    lastPhase = "";
    recordedEvents.clear();
    stableSince = Date.now();
    sessionStorage.setItem("bridge.runId", runId);
    for (const key of ["lastSubmitted", "sentReport", "attemptedReport", "attemptedAt", "preSendAssistant", "preSendAssistantCount", "preSendUserCount", "preSendUserText", "baselinedReport", "seenCards", "confirmationBaselineId", "confirmationBaselineCounts"])
      sessionStorage.removeItem(`bridge.${key}`);
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const config = await chrome.storage.local.get(["tabId", "title", "card"]);
      if (!config.tabId) return;
      const binding = await chrome.runtime.sendMessage({type: "bridgeIsBound"});
      if (!binding?.ok) throw new Error(binding?.error || "无法核对绑定标签页");
      if (!binding.bound) {
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
      const mainFallback = messages.length ? null : document.querySelector("main");
      const latest = messages.at(-1) || mainFallback;
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
      const signature = mainFallback ? `main:${normalize(text)}` : `${messages.length}:${text}`;
      if (signature !== lastSignature) { lastSignature = signature; stableSince = Date.now(); status("等待页面内容稳定"); return; }
      if (Date.now() - stableSince < 1800) { status("等待页面内容稳定"); return; }
      if (signature === lastSubmitted) { status("已处理当前指令，等待 ChatGPT 新回复"); return; }
      if (!mainFallback && STOP.test(text)) {
        await api("/stop", "POST", {reason: text.slice(0, 400), runId});
        status("ChatGPT 表示任务完成或需要人工处理，已停止"); return;
      }
      const title = new RegExp(config.title || DEFAULT_TITLE.source, "i");
      let found = extractCard(latest, title, config.card || "");
      let fallbackCandidateCount = 0;
      if (mainFallback) {
        // New ChatUI builds may omit author-role markers. In that case MAIN is
        // the only usable root. Older cards are baselined before each report
        // is sent; select the last unseen, strict card match in DOM order.
        const fresh = cardEntries(found).filter(entry => !seenCards.has(cardKey(entry.instruction)));
        fallbackCandidateCount = fresh.length;
        found = fresh.length
          ? {instruction: fresh.at(-1).instruction}
          : {error: "未找到新的严格匹配指令卡片"};
      }
      record("card_scan", {cardChoices: found.choices?.length || (found.instruction ? 1 : 0),
        instructionLength: found.instruction?.length || 0,
        latestCardLength: found.choices?.at(-1)?.instruction.length || found.instruction?.length || 0,
        fallbackCandidateCount,
        method: mainFallback ? "main" : "assistant_role",
        reason: found.instruction ? "matched" : "not_matched"}, `card_scan:${signature}`);
      if (mainFallback) {
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
      await api("/instruction", "POST", {instruction: found.instruction, runId});
      seenCards.add(cardKey(found.instruction));
      sessionStorage.setItem("bridge.seenCards", JSON.stringify([...seenCards]));
      record("card_submit", {instructionLength: found.instruction.length});
      lastSubmitted = signature;
      sessionStorage.setItem("bridge.lastSubmitted", signature);
      status(mainFallback
        ? "已自动识别并发送最新的未处理指令卡片"
        : "指令卡片已送往 Codex");
    } catch (error) {
      if (/Extension context invalidated/i.test(String(error))) {
        stopInvalidatedScript();
        return;
      }
      record("tick_error", {reason: "exception"}, `tick_error:${String(error)}`);
      status(String(error), true);
    } finally { busy = false; }
  }
  tickInterval = setInterval(tick, 2000);
  tick();
})();
