/**
 * smart_event_injector.js
 * G+B Feedback Widget — Smart GIF Recording
 *
 * Wird dynamisch in den Ziel-Tab injiziert wenn eine Aufnahme startet.
 * Sendet CAPTURE_FRAME an den Background Worker bei sichtbaren
 * Zustandsänderungen. Entfernt sich selbst bei RECORDING_STOPPED.
 * Tastenkürzel: Alt… und Ctrl… nur bei Whitelist (Buchstabe/Ziffer/F1–F12/
 * Navigation/einzelne Sonderzeichen), damit weniger nutzlose Frames entstehen.
 *
 * Recording-UI:
 *   - Rahmen: Vollflaechen-Maske mit innen abgerundeten Kanten (border-radius)
 *     und inset-Schatten (rot + weicher Verlauf nach innen).
 *   - Steuerung: kompaktes Widget unten rechts (pointer-events nur dort).
 */

(function () {
  if (window.__gbSmartRecorderActive) {
    const mask = document.getElementById("gb-recording-frame-mask");
    const widget = document.getElementById("gb-recording-widget");
    if (mask && widget && document.documentElement.contains(widget)) {
      return;
    }
    delete window.__gbSmartRecorderActive;
  }
  window.__gbSmartRecorderActive = true;

  /** Sichtbare „Rahmen“-Dicke (inset spread). */
  const FRAME_INSET_PX = 5;
  /** Innen-Eckenradius des Aufnahme-Rahmens (wirkt auf die innere Kontur). */
  const FRAME_RADIUS_PX = 9;
  /** Abstand der Maske zur Viewport-Kante — Rahmen optisch naeher an die Ecke. */
  const FRAME_EDGE_GAP_PX = 2;
  /** Zusaetzlicher weicher Schatten nach innen. */
  const FRAME_INNER_SHADOW = "inset 0 3px 28px rgba(0,0,0,0.26)";

  let frameMaskEl = null;
  let recordingWidgetEl = null;
  let stopButtonEl = null;
  let countdownEl = null;
  let countdownTimer = null;
  let stopRequested = false;
  let uiWatchTimer = null;
  const STOP_RETRY_DELAYS_MS = [0, 200, 600];

  function clearCountdownTimer() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function startCountdownTicker() {
    clearCountdownTimer();
    countdownTimer = setInterval(async () => {
      try {
        const state = await chrome.runtime.sendMessage({
          type: "GET_RECORDING_STATE",
          consumePipelineError: false,
        });
        if (!state?.active || !countdownEl) {
          clearCountdownTimer();
          return;
        }
        const max = state.maxDurationSec ?? 60;
        const rem = typeof state.remainingSec === "number" ? state.remainingSec : Math.max(0, max - (state.elapsed ?? 0));
        countdownEl.textContent = `Noch ${rem} s`;
        countdownEl.style.color = rem <= 10 ? "#fff59d" : "#ffffff";
      } catch (_) {
        clearCountdownTimer();
      }
    }, 1000);
    void chrome.runtime
      .sendMessage({ type: "GET_RECORDING_STATE", consumePipelineError: false })
      .then((state) => {
        if (state?.active && countdownEl && typeof state.remainingSec === "number") {
          countdownEl.textContent = `Noch ${state.remainingSec} s`;
        }
      })
      .catch(() => {});
  }

  function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  let lastPointerCaptureTs = 0;
  let lastPointerCaptureSig = "";

  function requestFrame(reason, cursor = null, kbdKeys = null) {
    const payload = { type: "CAPTURE_FRAME", reason, cursor };
    if (Array.isArray(kbdKeys) && kbdKeys.length) {
      payload.kbdKeys = kbdKeys;
    }
    chrome.runtime.sendMessage(payload).catch(() => {});
  }

  function isRecordingChromeUi(target) {
    return Boolean(target?.closest?.("#gb-recording-widget"));
  }

  function shouldCapturePointer(e) {
    if (!e.isPrimary || e.button !== 0) return false;
    if (isRecordingChromeUi(e.target)) return false;
    return true;
  }

  /** Zuverlässiger als bubble-phase click (Odoo stoppt oft Propagation). */
  function onPointerDownCapture(e) {
    if (!shouldCapturePointer(e)) return;
    const x = Math.round(e.clientX ?? 0);
    const y = Math.round(e.clientY ?? 0);
    const sig = `${x},${y}`;
    const now = Date.now();
    if (now - lastPointerCaptureTs < 140 && sig === lastPointerCaptureSig) return;
    lastPointerCaptureTs = now;
    lastPointerCaptureSig = sig;
    requestFrame("pointerdown", { x, y });
  }

  /** Fallback, falls nur click ohne vorheriges pointerdown (selten). */
  function onDocumentClickCapture(e) {
    if (!shouldCapturePointer(e)) return;
    const x = Math.round(e.clientX ?? 0);
    const y = Math.round(e.clientY ?? 0);
    const sig = `${x},${y}`;
    const now = Date.now();
    if (now - lastPointerCaptureTs < 220 && sig === lastPointerCaptureSig) return;
    lastPointerCaptureTs = now;
    lastPointerCaptureSig = sig;
    requestFrame("click", { x, y });
  }

  function isTextLikeField(el) {
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    if (["input", "textarea", "select"].includes(tag)) return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function onFocusOut(e) {
    if (!isTextLikeField(e.target)) return;
    requestFrame("focusout:text");
  }

  const onTextInputDebounced = debounce((e) => {
    if (!isTextLikeField(e.target)) return;
    requestFrame("input:debounced");
  }, 450);

  function labelForShortcutKey(e) {
    const k = e.key;
    if (!k || k === "Dead") return "";
    if (k === " ") return "Space";
    if (k.length === 1) return k;
    const map = {
      Escape: "Esc",
      ArrowLeft: "←",
      ArrowRight: "→",
      ArrowUp: "↑",
      ArrowDown: "↓",
      Enter: "Enter",
      Tab: "Tab",
      Backspace: "⌫",
      Delete: "Del",
      Home: "Home",
      End: "End",
      PageUp: "PgUp",
      PageDown: "PgDn",
    };
    return map[k] || k;
  }

  /**
   * Nur typische Odoo-/UI-Kürzel → weniger GIF-Frames bei Sonder- oder Systemtasten.
   * (Buchstaben, Ziffern, F1–F12, Navigation, einzelne Satzzeichen.)
   */
  function isWhitelistedShortcutMainKey(label) {
    if (!label) return false;
    const block = new Set([
      "Alt", "Control", "Shift", "Meta", "ContextMenu",
      "CapsLock", "NumLock", "ScrollLock", "OS", "Fn", "Unidentified",
    ]);
    if (block.has(label)) return false;
    if (label.length > 10) return false;
    if (/^[a-zA-Z]$/.test(label)) return true;
    if (/^[0-9]$/.test(label)) return true;
    if (/^F([1-9]|1[0-2])$/i.test(label)) return true;
    const named = new Set([
      "Esc", "Enter", "Tab", "Space", "←", "→", "↑", "↓",
      "PgUp", "PgDn", "Home", "End", "Del", "⌫", "Insert",
    ]);
    if (named.has(label)) return true;
    const punct = ".,;:/+_-=*?[](){}`~!@#$%^&|\\";
    if (label.length === 1 && punct.includes(label)) return true;
    return false;
  }

  function onShortcutKeyDownCapture(e) {
    if (e.repeat) return;
    if (e.getModifierState?.("AltGraph")) return;

    // Alt … (Odoo-Menü / Unterstrichene Buchstaben)
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const keyLabel = labelForShortcutKey(e);
      if (!keyLabel || keyLabel === "Alt") return;
      if (!isWhitelistedShortcutMainKey(keyLabel)) return;
      const parts = ["Alt"];
      if (e.shiftKey) parts.push("Shift");
      parts.push(keyLabel);
      requestFrame("shortcut:alt", null, parts);
      return;
    }

    // Ctrl … (z. B. Speichern, Suche) — ohne Alt/Meta
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const keyLabel = labelForShortcutKey(e);
      if (!keyLabel || keyLabel === "Control") return;
      if (!isWhitelistedShortcutMainKey(keyLabel)) return;
      const parts = ["Ctrl"];
      if (e.shiftKey) parts.push("Shift");
      parts.push(keyLabel);
      requestFrame("shortcut:ctrl", null, parts);
    }
  }

  const onScroll = debounce(() => requestFrame("scroll"), 500);

  function onHashChange() {
    requestFrame("navigation");
  }

  function sendStopSignalWithRetries() {
    for (const delay of STOP_RETRY_DELAYS_MS) {
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: "STOP_RECORDING", senderContext: "injector" }).catch(() => {});
      }, delay);
    }
  }

  function createRecordingUi() {
    const existingMask = document.getElementById("gb-recording-frame-mask");
    const existingWidget = document.getElementById("gb-recording-widget");
    if (existingMask && existingWidget && document.documentElement.contains(existingWidget)) {
      frameMaskEl = existingMask;
      recordingWidgetEl = existingWidget;
      stopButtonEl = existingWidget.querySelector("button");
      countdownEl = existingWidget.querySelector("[data-gb-rec-countdown]");
      if (countdownEl && !countdownTimer) {
        startCountdownTicker();
      }
      return;
    }
    existingMask?.remove();
    existingWidget?.remove();

    frameMaskEl = document.createElement("div");
    frameMaskEl.id = "gb-recording-frame-mask";
    frameMaskEl.setAttribute("aria-hidden", "true");
    const redInset = `inset 0 0 0 ${FRAME_INSET_PX}px #d90429`;
    const g = FRAME_EDGE_GAP_PX;
    frameMaskEl.style.cssText = [
      "position:fixed",
      `top:${g}px`,
      `left:${g}px`,
      `right:${g}px`,
      `bottom:${g}px`,
      "box-sizing:border-box",
      `border-radius:${FRAME_RADIUS_PX}px`,
      `box-shadow:${redInset}, ${FRAME_INNER_SHADOW}`,
      "pointer-events:none",
      "z-index:2147483646",
    ].join(";");

    recordingWidgetEl = document.createElement("div");
    recordingWidgetEl.id = "gb-recording-widget";
    recordingWidgetEl.style.cssText = [
      "position:fixed",
      "right:8px",
      "bottom:8px",
      "display:flex",
      "flex-direction:column",
      "align-items:stretch",
      "gap:6px",
      "padding:8px 10px 8px 10px",
      "background:#d90429",
      "color:#ffffff",
      "border-radius:10px",
      "box-shadow:0 4px 18px rgba(0,0,0,0.38)",
      "font:600 11px/1.2 'Segoe UI', Arial, sans-serif",
      "z-index:2147483647",
      "pointer-events:auto",
      "max-width:min(92vw, 320px)",
      "min-width:132px",
    ].join(";");

    const label = document.createElement("span");
    label.textContent = "● Record";
    label.style.cssText = "white-space:nowrap;opacity:0.95;text-align:center;";

    countdownEl = document.createElement("div");
    countdownEl.setAttribute("data-gb-rec-countdown", "1");
    countdownEl.setAttribute("aria-live", "polite");
    countdownEl.style.cssText = [
      "text-align:center",
      "font-size:13px",
      "font-weight:700",
      "font-variant-numeric:tabular-nums",
      "letter-spacing:0.02em",
      "line-height:1.2",
      "color:#ffffff",
    ].join(";");
    countdownEl.textContent = "Noch 60 s";

    stopButtonEl = document.createElement("button");
    stopButtonEl.type = "button";
    stopButtonEl.textContent = "Stop";
    stopButtonEl.title = "Aufnahme beenden";
    stopButtonEl.style.cssText = [
      "border:none",
      "border-radius:6px",
      "background:#ffffff",
      "color:#d90429",
      "padding:5px 10px",
      "font:700 11px/1 'Segoe UI', Arial, sans-serif",
      "cursor:pointer",
      "flex-shrink:0",
    ].join(";");

    async function requestStop(e) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (stopRequested) return;
      stopRequested = true;
      stopButtonEl.disabled = true;
      stopButtonEl.textContent = "…";

      try {
        const response = await Promise.race([
          chrome.runtime.sendMessage({ type: "STOP_RECORDING", senderContext: "injector" }),
          new Promise((resolve) => setTimeout(() => resolve({ status: "timeout" }), 1400)),
        ]);

        if (response?.status !== "ok") {
          sendStopSignalWithRetries();
        }
      } catch (err) {
        console.warn("[G+B GIF] STOP_RECORDING konnte nicht gesendet werden:", err?.message);
        sendStopSignalWithRetries();
      } finally {
        cleanup();
      }
    }

    stopButtonEl.addEventListener("pointerdown", requestStop, { capture: true });
    stopButtonEl.addEventListener("click", requestStop, { capture: true });

    recordingWidgetEl.appendChild(label);
    recordingWidgetEl.appendChild(countdownEl);
    recordingWidgetEl.appendChild(stopButtonEl);
    document.documentElement.appendChild(frameMaskEl);
    document.documentElement.appendChild(recordingWidgetEl);
    startCountdownTicker();
  }

  document.addEventListener("pointerdown", onPointerDownCapture, { passive: true, capture: true });
  document.addEventListener("click", onDocumentClickCapture, { passive: true, capture: true });
  document.addEventListener("focusout", onFocusOut, { passive: true, capture: true });
  document.addEventListener("input", onTextInputDebounced, { passive: true, capture: true });
  document.addEventListener("keydown", onShortcutKeyDownCapture, { passive: true, capture: true });
  document.addEventListener("scroll", onScroll, { passive: true, capture: true });
  window.addEventListener("hashchange", onHashChange);
  createRecordingUi();

  uiWatchTimer = setInterval(() => {
    if (!window.__gbSmartRecorderActive) return;
    if (
      !document.getElementById("gb-recording-frame-mask") ||
      !document.getElementById("gb-recording-widget")
    ) {
      frameMaskEl = null;
      recordingWidgetEl = null;
      stopButtonEl = null;
      stopRequested = false;
      createRecordingUi();
    }
  }, 2000);

  function cleanup() {
    clearCountdownTimer();
    countdownEl = null;
    if (uiWatchTimer) {
      clearInterval(uiWatchTimer);
      uiWatchTimer = null;
    }
    document.removeEventListener("pointerdown", onPointerDownCapture, true);
    document.removeEventListener("click", onDocumentClickCapture, true);
    document.removeEventListener("focusout", onFocusOut, true);
    document.removeEventListener("input", onTextInputDebounced, true);
    document.removeEventListener("keydown", onShortcutKeyDownCapture, { capture: true });
    document.removeEventListener("scroll", onScroll, { capture: true });
    window.removeEventListener("hashchange", onHashChange);
    recordingWidgetEl?.remove();
    frameMaskEl?.remove();
    stopButtonEl = null;
    recordingWidgetEl = null;
    frameMaskEl = null;
    stopRequested = false;
    delete window.__gbSmartRecorderActive;
  }

  chrome.runtime.onMessage.addListener(function onStop(msg) {
    if (msg.type !== "RECORDING_STOPPED") return;
    cleanup();
    chrome.runtime.onMessage.removeListener(onStop);
  });
})();
