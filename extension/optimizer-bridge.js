(() => {
  "use strict";

  const CHANNEL = "CGO_V08";
  const SETTINGS_KEY = "cgo_v08_settings";
  const DEFAULTS = {
    enabled: true,
    keepRounds: 10,
    renderOptimize: true,
    liveWindow: true
  };

  let settings = { ...DEFAULTS };
  let mainStatus = null;

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

  function mirrorToPageStorage() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
  }

  function sendMain(type) {
    window.postMessage({
      source: CHANNEL,
      direction: "TO_MAIN",
      type
    }, "*");
  }

  window.addEventListener("message", event => {
    if (event.source !== window) return;
    const message = event.data;

    if (
      !message ||
      message.source !== CHANNEL ||
      message.direction !== "FROM_MAIN"
    ) {
      return;
    }

    if (message.type === "READY" || message.type === "STATUS") {
      mainStatus = message.payload || null;
    }
  });

  chrome.storage.local.get(DEFAULTS, stored => {
    settings = normalizeSettings(stored);
    mirrorToPageStorage();
    sendMain("REFRESH_SETTINGS");
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    if (changes.enabled) {
      settings.enabled = changes.enabled.newValue !== false;
    }
    if (changes.keepRounds) {
      settings.keepRounds = clampRounds(changes.keepRounds.newValue);
    }
    if (changes.renderOptimize) {
      settings.renderOptimize =
        changes.renderOptimize.newValue !== false;
    }
    if (changes.liveWindow) {
      settings.liveWindow =
        changes.liveWindow.newValue !== false;
    }

    mirrorToPageStorage();
    sendMain("REFRESH_SETTINGS");
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return;

    if (message.type === "CGO_V08_APPLY") {
      settings = normalizeSettings(message.settings);
      mirrorToPageStorage();
      sendMain("REFRESH_SETTINGS");
      sendResponse({ ok: true, settings });
      return true;
    }

    if (message.type === "CGO_V08_STATUS") {
      sendMain("GET_STATUS");
      setTimeout(() => {
        sendResponse({
          ok: true,
          settings,
          mainStatus,
          url: location.href
        });
      }, 80);
      return true;
    }

    if (message.type === "CGO_V08_LIVE_NOW") {
      sendMain("APPLY_LIVE_NOW");
      sendResponse({ ok: true });
      return true;
    }

  });
})();