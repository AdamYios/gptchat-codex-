(() => {
  "use strict";

  const CHANNEL = "CHATGPT_LONG_CHAT_OPTIMIZER";
  const SETTINGS_KEY = "optimizer.settings";
  const STORAGE_KEYS = {
    enabled: "optimizer.enabled",
    keepRounds: "optimizer.keepRounds",
    renderOptimize: "optimizer.renderOptimize",
    liveWindow: "optimizer.liveWindow"
  };
  const DEFAULTS = {
    enabled: true,
    keepRounds: 10,
    renderOptimize: true,
    liveWindow: true
  };
  const STORAGE_DEFAULTS = {
    [STORAGE_KEYS.enabled]: DEFAULTS.enabled,
    [STORAGE_KEYS.keepRounds]: DEFAULTS.keepRounds,
    [STORAGE_KEYS.renderOptimize]: DEFAULTS.renderOptimize,
    [STORAGE_KEYS.liveWindow]: DEFAULTS.liveWindow
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

  function settingsFromStorage(stored) {
    return normalizeSettings({
      enabled: stored[STORAGE_KEYS.enabled],
      keepRounds: stored[STORAGE_KEYS.keepRounds],
      renderOptimize: stored[STORAGE_KEYS.renderOptimize],
      liveWindow: stored[STORAGE_KEYS.liveWindow]
    });
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

  chrome.storage.local.get(STORAGE_DEFAULTS, stored => {
    settings = settingsFromStorage(stored);
    mirrorToPageStorage();
    sendMain("REFRESH_SETTINGS");
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    if (changes[STORAGE_KEYS.enabled]) {
      settings.enabled = changes[STORAGE_KEYS.enabled].newValue !== false;
    }
    if (changes[STORAGE_KEYS.keepRounds]) {
      settings.keepRounds = clampRounds(changes[STORAGE_KEYS.keepRounds].newValue);
    }
    if (changes[STORAGE_KEYS.renderOptimize]) {
      settings.renderOptimize =
        changes[STORAGE_KEYS.renderOptimize].newValue !== false;
    }
    if (changes[STORAGE_KEYS.liveWindow]) {
      settings.liveWindow =
        changes[STORAGE_KEYS.liveWindow].newValue !== false;
    }

    mirrorToPageStorage();
    sendMain("REFRESH_SETTINGS");
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return;

    if (message.type === "OPTIMIZER_APPLY") {
      settings = normalizeSettings(message.settings);
      mirrorToPageStorage();
      sendMain("REFRESH_SETTINGS");
      sendResponse({ ok: true, settings });
      return true;
    }

    if (message.type === "OPTIMIZER_STATUS") {
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

    if (message.type === "OPTIMIZER_LIVE_NOW") {
      sendMain("APPLY_LIVE_NOW");
      sendResponse({ ok: true });
      return true;
    }

  });
})();
