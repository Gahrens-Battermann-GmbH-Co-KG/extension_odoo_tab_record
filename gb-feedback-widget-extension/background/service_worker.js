// ═══════════════════════════════════════════════════════════════════
// G+B SMART GIF RECORDING — State & Timer
// Eingefügt in Schritt 3 des Cursor-Prompts
// ═══════════════════════════════════════════════════════════════════

// ── Konstanten ───────────────────────────────────────────────────
/** Hartes Aufnahme-Limit (Anzeige + Auto-Stop). */
const GIF_MAX_DURATION_MS = 60 * 1000; // 60 Sekunden
const GIF_INACTIVITY_MS   = 30 * 1000;     // 30s Inaktivitäts-Timeout
const GIF_CAPTURE_QUALITY = 60;            // 1–100 (niedriger = kleinere Datei)
/** Chrome: MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND — seriell + Mindestabstand. */
const CAPTURE_VISIBLE_MIN_INTERVAL_MS = 520;
const CAPTURE_VISIBLE_QUOTA_BACKOFF_MS = 1200;

// ── Recording-State ──────────────────────────────────────────────
// Einzige Wahrheitsquelle für den Aufnahme-Zustand.
// Wird bei jedem Start zurückgesetzt, bei jedem Stop geleert.
function createEmptyRecordingState() {
  return {
    active:          false,
    tabId:           null,
    windowId:        null,
    frames:          [],     // Array von { dataUrl: string, timestamp: number }
    startTime:       null,   // Date.now() beim Start
    inactivityTimer: null,   // setTimeout-Handle
    hardLimitTimer:  null,   // setTimeout-Handle
    uiContext:       "popup", // "popup" | "modal"
    returnTabId:     null,    // Tab, der nach Stop wieder fokusiert werden soll
    returnTabUrl:    null,    // Fallback-URL fuer Ruecksprung
    returnWindowId:  null,    // Fallback-Window fuer Ruecksprung
    returnToModalOnStop: false, // Nur bei Aufnahme des Modal-Tabs aktiv
  };
}

let recordingState = createEmptyRecordingState();
let lastModalContext = {
  tabId: null,
  windowId: null,
  url: null,
};

/** Einmalig an Odoo-Modal (via GET_RECORDING_STATE.pipelineError) melden. */
let lastGifPipelineError = null;

/** Nur bei echten Modal-Aktionen — nicht bei jedem GET_*-Poll der Bridge. */
const MODAL_CONTEXT_REFRESH_TYPES = new Set([
  "START_RECORDING",
  "STOP_RECORDING",
  "LIST_RECORDABLE_TABS",
]);

function clearLastModalContext() {
  lastModalContext = { tabId: null, windowId: null, url: null };
}

function rememberModalContextFromSender(senderTab) {
  if (!senderTab?.id) return;
  const next = {
    tabId: senderTab.id,
    windowId: senderTab.windowId ?? null,
    url: senderTab.url ?? null,
  };
  if (
    lastModalContext.tabId === next.tabId &&
    lastModalContext.windowId === next.windowId &&
    lastModalContext.url === next.url
  ) {
    return;
  }
  lastModalContext = next;
}

async function focusWindowStrict(windowId) {
  if (!windowId) return false;
  try {
    await chrome.windows.update(windowId, { focused: true });
    return true;
  } catch (e) {
    console.warn("[G+B GIF][RETURN] focus window failed", windowId, e?.message);
    return false;
  }
}

async function activateTabStrict(tabId) {
  if (!tabId) return false;
  try {
    await chrome.tabs.update(tabId, { active: true });
    return true;
  } catch (e) {
    console.warn("[G+B GIF][RETURN] activate tab failed", tabId, e?.message);
    return false;
  }
}

// ── Inaktivitäts-Timer ───────────────────────────────────────────
// Wird bei jedem Frame-Capture zurückgesetzt.
// Läuft ab → automatischer Stop wegen Inaktivität.
function resetInactivityTimer() {
  if (recordingState.inactivityTimer) {
    clearTimeout(recordingState.inactivityTimer);
  }
  recordingState.inactivityTimer = setTimeout(
    () => stopRecording("inactivity"),
    GIF_INACTIVITY_MS
  );
}

// ── Alle Timer stoppen ───────────────────────────────────────────
function clearAllTimers() {
  clearTimeout(recordingState.inactivityTimer);
  clearTimeout(recordingState.hardLimitTimer);
  recordingState.inactivityTimer = null;
  recordingState.hardLimitTimer  = null;
}

/** Nur Inaktivitaets-Timeout anhalten (z.B. waehrend Hauptframe-Navigation) — Hard-Limit bleibt aktiv. */
function pauseInactivityTimerOnly() {
  if (recordingState.inactivityTimer) {
    clearTimeout(recordingState.inactivityTimer);
    recordingState.inactivityTimer = null;
  }
}

let navigationReinjectTimer = null;

/** Einmal melden: warum die Aufnahme endete (fuer Odoo-Polling / Hinweis). */
let lastRecordingEndedReason = null;
let lastRecordingEndedAt = 0;

// ── Popup benachrichtigen ────────────────────────────────────────
// Fehler werden ignoriert — Popup ist evtl. geschlossen.
function broadcastToPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

async function focusReturnTabIfNeeded() {
  if (recordingState.uiContext !== "modal" || !recordingState.returnToModalOnStop) return false;
  const fallbackTabId = recordingState.returnTabId || lastModalContext.tabId || null;
  const fallbackWindowId = recordingState.returnWindowId || lastModalContext.windowId || null;
  const fallbackUrl = recordingState.returnTabUrl || lastModalContext.url || null;
  console.log("[G+B GIF][RETURN] start", {
    uiContext: recordingState.uiContext,
    fallbackTabId,
    fallbackWindowId,
    fallbackUrl,
    stateReturn: {
      tabId: recordingState.returnTabId,
      windowId: recordingState.returnWindowId,
      url: recordingState.returnTabUrl,
    },
    lastModalContext,
  });
  try {
    if (fallbackTabId) {
      const returnTab = await chrome.tabs.get(fallbackTabId);
      console.log("[G+B GIF][RETURN] found tab by id", {
        id: returnTab?.id,
        windowId: returnTab?.windowId,
        url: returnTab?.url,
      });
      if (returnTab?.windowId) {
        await focusWindowStrict(returnTab.windowId);
      }
      const activated = await activateTabStrict(fallbackTabId);
      if (activated) {
        console.log("[G+B GIF][RETURN] success by tab id", fallbackTabId);
        return true;
      }
    }
  } catch (_) {
    console.warn("[G+B GIF][RETURN] tab id fallback failed");
  }

  try {
    if (fallbackWindowId) {
      await focusWindowStrict(fallbackWindowId);
    }
    if (fallbackUrl) {
      const tabs = await chrome.tabs.query({});
      const byExact = tabs.find((tab) => tab.url === fallbackUrl);
      if (byExact?.id) {
        const activated = await activateTabStrict(byExact.id);
        if (activated) {
          console.log("[G+B GIF][RETURN] success by exact url", fallbackUrl, byExact.id);
          return true;
        }
      }
      const origin = (() => {
        try {
          return new URL(fallbackUrl).origin;
        } catch {
          return "";
        }
      })();
      if (origin) {
        const byOrigin = tabs.find((tab) => {
          try {
            return new URL(tab.url || "").origin === origin;
          } catch {
            return false;
          }
        });
        if (byOrigin?.id) {
          const activated = await activateTabStrict(byOrigin.id);
          if (activated) {
            console.log("[G+B GIF][RETURN] success by origin", origin, byOrigin.id);
            return true;
          }
        }
      }
    }
  } catch (_) {
    console.warn("[G+B GIF][RETURN] url/origin fallback failed");
  }
  // Letzter Fallback: Ausgangs-URL aktiv neu öffnen.
  if (fallbackUrl) {
    try {
      await chrome.tabs.create({ url: fallbackUrl, active: true });
      console.log("[G+B GIF][RETURN] success by opening url", fallbackUrl);
      return true;
    } catch (_) {
      console.warn("[G+B GIF][RETURN] open-url fallback failed", fallbackUrl);
    }
  }
  console.warn("[G+B GIF][RETURN] failed all fallbacks");
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// G+B SMART GIF RECORDING — Frame-Capture & Lifecycle
// Eingefügt in Schritt 4 des Cursor-Prompts
// ═══════════════════════════════════════════════════════════════════

function sanitizeKbdKeys(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const out = [];
  for (const s of raw.slice(0, 6)) {
    if (typeof s !== "string") continue;
    const t = s.trim().slice(0, 24);
    if (t) out.push(t);
  }
  return out.length ? out : null;
}

/** Serielle Warteschlange — verhindert parallele captureVisibleTab-Aufrufe (Quota). */
let captureFrameQueueTail = Promise.resolve();
let nextCaptureVisibleAllowedAt = 0;

function resetCaptureFrameQueue() {
  captureFrameQueueTail = Promise.resolve();
  nextCaptureVisibleAllowedAt = 0;
}

// ── Frame aufnehmen ──────────────────────────────────────────────
async function captureFrame(reason, cursor = null, kbdKeys = null) {
  if (!recordingState.active) return;

  const runOne = async () => {
    if (!recordingState.active) return;

    const now = Date.now();
    const waitMs = Math.max(0, nextCaptureVisibleAllowedAt - now);
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    if (!recordingState.active) return;

    try {
      const tab = await chrome.tabs.get(recordingState.tabId);

      if (tab.discarded) {
        console.warn("[G+B GIF] Tab discarded — Frame uebersprungen (Aufnahme laeuft weiter)");
        return;
      }

      if (!tab.active) {
        await chrome.tabs.update(recordingState.tabId, { active: true });
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!recordingState.active) return;

      const dataUrl = await chrome.tabs.captureVisibleTab(recordingState.windowId, {
        format:  "png",
        quality: GIF_CAPTURE_QUALITY,
      });

      nextCaptureVisibleAllowedAt = Date.now() + CAPTURE_VISIBLE_MIN_INTERVAL_MS;

      recordingState.frames.push({
        dataUrl,
        timestamp: Date.now() - recordingState.startTime,
        cursor: cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)
          ? { x: cursor.x, y: cursor.y }
          : null,
        kbdKeys: sanitizeKbdKeys(kbdKeys),
      });

      const elapsedSec = Math.floor((Date.now() - recordingState.startTime) / 1000);
      const maxSec = Math.floor(GIF_MAX_DURATION_MS / 1000);
      broadcastToPopup({
        type:       "FRAME_CAPTURED",
        frameCount: recordingState.frames.length,
        elapsed:    elapsedSec,
        maxDurationSec: maxSec,
        remainingSec: Math.max(0, maxSec - elapsedSec),
      });
    } catch (e) {
      const errMsg = e?.message || String(e);
      if (errMsg.includes("MAX_CAPTURE") || errMsg.includes("quota")) {
        nextCaptureVisibleAllowedAt = Date.now() + CAPTURE_VISIBLE_QUOTA_BACKOFF_MS;
        console.warn(
          "[G+B GIF] captureVisibleTab quota — Backoff ms:",
          CAPTURE_VISIBLE_QUOTA_BACKOFF_MS,
          "| reason:",
          reason
        );
        return;
      }
      console.warn("[G+B GIF] captureFrame fehlgeschlagen:", reason, errMsg);
    }
  };

  captureFrameQueueTail = captureFrameQueueTail.then(runOne, () => {});
  return captureFrameQueueTail;
}

// ── Aufnahme starten ─────────────────────────────────────────────
async function startRecording(tabId, options = {}) {
  if (recordingState.active) {
    console.warn("[G+B GIF] Aufnahme läuft bereits.");
    throw new Error("Aufnahme laeuft bereits.");
  }

  const targetTab = await chrome.tabs.get(tabId);
  if (targetTab?.windowId) {
    await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {});
  }
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});

  recordingState = {
    active:          true,
    tabId,
    windowId:        targetTab.windowId ?? null,
    frames:          [],
    startTime:       Date.now(),
    inactivityTimer: null,
    hardLimitTimer:  null,
    uiContext:       options.uiContext || "popup",
    returnTabId:     options.returnTabId || (options.uiContext === "modal" ? lastModalContext.tabId : null),
    returnTabUrl:    options.returnTabUrl || (options.uiContext === "modal" ? lastModalContext.url : null),
    returnWindowId:  options.returnWindowId || (options.uiContext === "modal" ? lastModalContext.windowId : null),
    returnToModalOnStop: Boolean(options.returnToModalOnStop),
  };

  resetCaptureFrameQueue();
  lastGifPipelineError = null;
  lastRecordingEndedReason = null;
  lastRecordingEndedAt = 0;

  // Alte Frame-/Fortschritts-Reste loeschen (Session-Storage ~10 MB gesamt).
  try {
    await chrome.storage.session.remove(["gb_pending_gif_frames", "gb_gif_build_progress"]);
  } catch (_) {}

  // Event-Injector in Ziel-Tab injizieren
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files:  ["capture/smart_event_injector.js"],
    });
  } catch (e) {
    console.error("[G+B GIF] Injektion fehlgeschlagen:", e.message);
    recordingState.active = false;
    resetCaptureFrameQueue();
    broadcastToPopup({ type: "RECORDING_ERROR", message: e.message });
    throw e;
  }

  // Ersten Frame sofort aufnehmen (Ausgangszustand dokumentieren)
  await captureFrame("initial");

  // Wenn nicht einmal der Initial-Frame möglich ist, sofort sauber abbrechen.
  if (!recordingState.frames.length) {
    recordingState = createEmptyRecordingState();
    clearAllTimers();
    resetCaptureFrameQueue();
    broadcastToPopup({
      type: "RECORDING_ERROR",
      message: "Kein Frame erfassbar. Tab sichtbar lassen und erneut starten.",
    });
    console.warn("[G+B GIF] Start abgebrochen: kein Initial-Frame.");
    throw new Error("Kein Frame erfassbar. Tab sichtbar lassen und erneut starten.");
  }

  // Timer starten
  resetInactivityTimer();

  recordingState.hardLimitTimer = setTimeout(
    () => stopRecording("hard_limit"),
    GIF_MAX_DURATION_MS
  );

  broadcastToPopup({ type: "RECORDING_STARTED", tabId });
  console.log("[G+B GIF] Aufnahme gestartet. Tab:", tabId);
}

/** Nach Full-Reload / harter Navigation Recorder-UI und Listener wiederherstellen. */
async function reinjectSmartRecorder(tabId) {
  if (!recordingState.active || recordingState.tabId !== tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["capture/smart_event_injector.js"],
    });
  } catch (e) {
    console.warn("[G+B GIF] Reinject fehlgeschlagen:", e?.message);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!recordingState.active || recordingState.tabId !== tabId) return;
  // Subframe-/Werbe-iframe-Loads: nicht den Haupt-Tab als „Navigation“ behandeln.
  const isSubFrame =
    typeof changeInfo.frameId === "number" && changeInfo.frameId !== 0;
  if (isSubFrame) return;

  if (changeInfo.status === "loading") {
    pauseInactivityTimerOnly();
    return;
  }
  if (changeInfo.status !== "complete") return;

  clearTimeout(navigationReinjectTimer);
  navigationReinjectTimer = setTimeout(() => {
    reinjectSmartRecorder(tabId)
      .then(() => captureFrame("after_navigation", null))
      .then(() => {
        if (recordingState.active) resetInactivityTimer();
      })
      .catch(() => {});
  }, 300);
});

/**
 * GIF-Encoding: sichtbarer Editor-Tab oder Offscreen (chrome.storage.local.openEditorTabAfterRecording).
 * Nicht gesetzt: Modal = ohne Tab (Offscreen), Popup = mit Tab (Vorschau).
 */
async function launchGifEncoderAfterStop(uiContext, returnToModalOnStop) {
  const silent = uiContext === "modal";
  const raw = (await chrome.storage.local.get("openEditorTabAfterRecording")).openEditorTabAfterRecording;
  const openEditorTab = raw === undefined ? !silent : Boolean(raw);

  const base = chrome.runtime.getURL("editor/editor.html");
  const qs = `mode=gif&silent=${silent ? "1" : "0"}`;

  if (openEditorTab) {
    await chrome.tabs.create({
      url: `${base}?${qs}`,
      active: !silent,
    });
    if (silent && returnToModalOnStop) {
      await new Promise((r) => setTimeout(r, 120));
      await focusReturnTabIfNeeded();
    }
    return;
  }

  const offUrl = `${base}?${qs}&offscreen=1`;
  try {
    if (!chrome.offscreen?.createDocument) {
      throw new Error("offscreen API fehlt");
    }
    try {
      await chrome.offscreen.closeDocument();
    } catch (_) {
      /* kein Offscreen-Dokument */
    }
    await chrome.offscreen.createDocument({
      url: offUrl,
      reasons: ["DOM_SCRAPING"],
      justification: "GIF aus aufgezeichneten Frames erzeugen (G+B Feedback Widget).",
    });
  } catch (e) {
    console.warn("[G+B GIF] Offscreen nicht moeglich, Fallback inaktiver Tab:", e?.message);
    await chrome.tabs.create({
      url: `${base}?${qs}`,
      active: false,
    });
    if (silent && returnToModalOnStop) {
      await new Promise((r) => setTimeout(r, 120));
      await focusReturnTabIfNeeded();
    }
  }
}

// ── Aufnahme stoppen ─────────────────────────────────────────────
async function stopRecording(reason = "manual") {
  if (!recordingState.active) return { status: "noop", reason: "not_active" };

  clearTimeout(navigationReinjectTimer);
  navigationReinjectTimer = null;

  // Sofortiger Ruecksprung fuer den Nutzer, bevor die GIF-Nachbearbeitung startet.
  if (recordingState.uiContext === "modal" && recordingState.returnToModalOnStop) {
    await focusReturnTabIfNeeded();
  }

  // Bei manuellem Stop einen letzten Frame erzwingen, falls noch keiner da ist.
  if (reason === "manual" && !recordingState.frames.length) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(recordingState.windowId, {
        format: "png",
        quality: GIF_CAPTURE_QUALITY,
      });
      recordingState.frames.push({
        dataUrl,
        timestamp: Math.max(0, Date.now() - recordingState.startTime),
        cursor: null,
      });
    } catch (e) {
      console.warn("[G+B GIF] Finaler Manual-Frame fehlgeschlagen:", e.message);
    }
  }

  console.log("[G+B GIF] Aufnahme gestoppt. Grund:", reason,
    "| Frames:", recordingState.frames.length);

  recordingState.active = false;
  clearAllTimers();

  // Event-Injector im Ziel-Tab deaktivieren
  try {
    await chrome.tabs.sendMessage(recordingState.tabId, {
      type: "RECORDING_STOPPED"
    });
  } catch (_) {
    // Tab evtl. bereits geschlossen — kein Fehler
  }

  // Bei 0 Frames keinen leeren Editor öffnen, sondern Fehler melden.
  if (!recordingState.frames.length) {
    broadcastToPopup({
      type: "RECORDING_ERROR",
      message: "Keine Frames aufgenommen. Bitte Aufnahme wiederholen.",
    });
    // Entwicklungsmodus: Editor trotzdem öffnen, damit der Ablauf sichtbar bleibt.
    if (reason === "manual") {
      await chrome.storage.session.set({
        "gb_pending_gif_frames": {
          frames: [],
          reason: "no_frames_manual_stop",
          duration: Date.now() - recordingState.startTime,
        }
      });
      const uiCtx0 = recordingState.uiContext;
      const ret0 = recordingState.returnToModalOnStop;
      await launchGifEncoderAfterStop(uiCtx0, ret0);
    }
    recordingState = {
      ...createEmptyRecordingState(),
    };
    resetCaptureFrameQueue();
    clearLastModalContext();
    return { status: "error", reason: "no_frames" };
  }

  // Frames für Editor-Tab bereitstellen
  try {
    try {
      await chrome.storage.session.remove("gb_pending_gif_frames");
    } catch (_) {}
    await chrome.storage.session.set({
      "gb_pending_gif_frames": {
        frames:   recordingState.frames,
        reason,
        duration: Date.now() - recordingState.startTime,
      }
    });

    await launchGifEncoderAfterStop(
      recordingState.uiContext,
      recordingState.returnToModalOnStop
    );
  } catch (e) {
    console.error("[G+B GIF] Stop fehlgeschlagen:", e.message);
    lastGifPipelineError = `Stop/GIF-Session: ${e.message || "unbekannt"}`.slice(0, 500);
    broadcastToPopup({
      type: "RECORDING_ERROR",
      message: `Stop fehlgeschlagen: ${e.message}`,
    });
    recordingState = {
      ...createEmptyRecordingState(),
    };
    resetCaptureFrameQueue();
    clearLastModalContext();
    return { status: "error", reason: "stop_failed", message: e.message };
  }

  lastRecordingEndedReason = reason;
  lastRecordingEndedAt = Date.now();

  broadcastToPopup({
    type:       "RECORDING_STOPPED",
    reason,
    frameCount: recordingState.frames.length,
  });

  // State zurücksetzen
  recordingState = createEmptyRecordingState();
  resetCaptureFrameQueue();
  clearLastModalContext();
  return { status: "ok", reason };
}

// ═══════════════════════════════════════════════════════════════════
// G+B SMART GIF RECORDING — Message-Handler
// Eingefügt in Schritt 5 des Cursor-Prompts
// ═══════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const msgType = msg?.type || "";
  const isModalBridge = msg?.senderContext === "modal_bridge";
  if (msgType === "START_RECORDING" || msgType === "STOP_RECORDING") {
    console.log("[G+B GIF][MSG]", msgType, {
      senderContext: msg?.senderContext,
      uiContext: msg?.uiContext,
      senderTabId: _sender?.tab?.id || null,
      senderUrl: _sender?.tab?.url || null,
      senderWindowId: _sender?.tab?.windowId || null,
      payloadReturn: {
        tabId: msg?.returnTabId || null,
        url: msg?.returnTabUrl || null,
        windowId: msg?.returnWindowId || null,
      },
    });
  }
  if (_sender?.tab?.id && isModalBridge && MODAL_CONTEXT_REFRESH_TYPES.has(msgType)) {
    rememberModalContextFromSender(_sender.tab);
  }

  if (msg.type === "GIF_ENCODER_FAILED") {
    lastGifPipelineError = String(msg.message || "GIF-Encoding fehlgeschlagen").slice(0, 500);
    sendResponse({ status: "ok" });
    return false;
  }

  if (msg.type === "GIF_OFFSCREEN_DONE") {
    if (chrome.offscreen?.closeDocument) {
      chrome.offscreen.closeDocument().catch(() => {});
    }
    sendResponse({ status: "ok" });
    return false;
  }

  // Offscreen-Editor hat kein chrome.storage — Zugriff nur im Service Worker
  if (msg.type === "SESSION_STORAGE_GET") {
    if (msg.keys == null) {
      sendResponse({ status: "error", message: "keys fehlt" });
      return false;
    }
    chrome.storage.session.get(msg.keys)
      .then((data) => sendResponse({ status: "ok", data }))
      .catch((e) => sendResponse({ status: "error", message: e.message }));
    return true;
  }

  if (msg.type === "SESSION_STORAGE_SET") {
    if (!msg.data || typeof msg.data !== "object") {
      sendResponse({ status: "error", message: "data fehlt" });
      return false;
    }
    chrome.storage.session.set(msg.data)
      .then(() => sendResponse({ status: "ok" }))
      .catch((e) => sendResponse({ status: "error", message: e.message }));
    return true;
  }

  if (msg.type === "SESSION_STORAGE_REMOVE") {
    if (msg.keys == null) {
      sendResponse({ status: "error", message: "keys fehlt" });
      return false;
    }
    chrome.storage.session.remove(msg.keys)
      .then(() => sendResponse({ status: "ok" }))
      .catch((e) => sendResponse({ status: "error", message: e.message }));
    return true;
  }

  if (msg.type === "GET_GIF_BUILD_PROGRESS") {
    chrome.storage.session.get("gb_gif_build_progress")
      .then((r) => sendResponse({
        status: "ok",
        progress: r.gb_gif_build_progress || null,
      }))
      .catch((e) => sendResponse({ status: "error", message: e.message }));
    return true;
  }

  // ── Frame-Anforderung vom Event-Injector ────────────────────────
  if (msg.type === "CAPTURE_FRAME") {
    captureFrame(msg.reason ?? "unknown", msg.cursor ?? null, msg.kbdKeys ?? null)
      .then(() => {
        resetInactivityTimer();
        sendResponse({ status: "ok" });
      })
      .catch(e => sendResponse({ status: "error", message: e.message }));
    return true; // async response
  }

  // ── Aufnahme starten (vom Popup) ────────────────────────────────
  if (msg.type === "START_RECORDING") {
    if (!msg.tabId) {
      sendResponse({ status: "error", message: "tabId fehlt" });
      return false;
    }
    startRecording(msg.tabId, {
      uiContext: msg.uiContext || "popup",
      returnTabId: msg.returnTabId || _sender?.tab?.id || null,
      returnTabUrl: msg.returnTabUrl || _sender?.tab?.url || null,
      returnWindowId: msg.returnWindowId || _sender?.tab?.windowId || null,
      returnToModalOnStop: Boolean(
        msg.uiContext === "modal" &&
        (msg.returnToModalOnStop || ( _sender?.tab?.id && Number(msg.tabId) === Number(_sender.tab.id)))
      ),
    })
      .then(() => sendResponse({ status: "ok" }))
      .catch(e => sendResponse({ status: "error", message: e.message }));
    return true;
  }

  // ── Aufnahme manuell stoppen (vom Popup) ────────────────────────
  if (msg.type === "STOP_RECORDING") {
    // Modal-Bridge: Absender-Tab ist immer das Odoo-Fenster — Ruecksprung frisch halten
    if (recordingState.active && isModalBridge && _sender?.tab?.id) {
      recordingState.returnTabId = _sender.tab.id;
      if (_sender.tab.url) recordingState.returnTabUrl = _sender.tab.url;
      if (_sender.tab.windowId != null) recordingState.returnWindowId = _sender.tab.windowId;
    }
    if (msg.returnTabId && recordingState.active) {
      recordingState.returnTabId = msg.returnTabId;
    } else if (_sender?.tab?.id && recordingState.active && recordingState.uiContext !== "modal") {
      recordingState.returnTabId = _sender.tab.id;
    }
    if (msg.returnTabUrl && recordingState.active) {
      recordingState.returnTabUrl = msg.returnTabUrl;
    } else if (_sender?.tab?.url && recordingState.active && recordingState.uiContext !== "modal") {
      recordingState.returnTabUrl = _sender.tab.url;
    }
    if (msg.returnWindowId && recordingState.active) {
      recordingState.returnWindowId = msg.returnWindowId;
    } else if (_sender?.tab?.windowId && recordingState.active && recordingState.uiContext !== "modal") {
      recordingState.returnWindowId = _sender.tab.windowId;
    }
    if (msg.uiContext && recordingState.active && msg.senderContext !== "injector") {
      recordingState.uiContext = msg.uiContext;
    }
    stopRecording("manual")
      .then((result) => {
        if (result?.status === "noop") {
          sendResponse({ status: "noop", message: "not_active" });
          return;
        }
        sendResponse(
          result?.status === "ok"
            ? { status: "ok" }
            : { status: "error", message: result?.message || result?.reason || "stop_failed" }
        );
      })
      .catch(e => sendResponse({ status: "error", message: e.message }));
    return true;
  }

  // ── State abfragen (vom Popup für Live-Update) ──────────────────
  if (msg.type === "GET_RECORDING_STATE") {
    const consumeErr = msg.consumePipelineError !== false;
    const pipelineError = consumeErr ? lastGifPipelineError : null;
    if (consumeErr) {
      lastGifPipelineError = null;
    }
    const maxDurationSec = Math.floor(GIF_MAX_DURATION_MS / 1000);
    const elapsed = recordingState.startTime
      ? Math.floor((Date.now() - recordingState.startTime) / 1000)
      : 0;
    const remainingSec = recordingState.active ? Math.max(0, maxDurationSec - elapsed) : 0;

    let lastEndedReason = null;
    if (
      !recordingState.active &&
      lastRecordingEndedReason &&
      Date.now() - lastRecordingEndedAt < 8000
    ) {
      lastEndedReason = lastRecordingEndedReason;
    }

    sendResponse({
      active:     recordingState.active,
      frameCount: recordingState.frames.length,
      elapsed,
      maxDurationSec,
      remainingSec,
      lastEndedReason,
      pipelineError: pipelineError || null,
    });
    return false; // sync response
  }

  if (msg.type === "LIST_RECORDABLE_TABS") {
    chrome.tabs.query({})
      .then((tabs) => {
        const preferredUrl = (msg.preferredUrl || "").trim();
        const modalTabId =
          msg?.senderContext === "modal_bridge" && _sender?.tab?.id
            ? _sender.tab.id
            : null;
        const list = tabs
          .filter((tab) => Boolean(tab?.id) && /^https?:\/\//.test(tab.url || ""))
          .map((tab) => ({
            tabId: tab.id,
            title: tab.title || "Unbenannter Tab",
            displayTitle:
              (tab.title || "Unbenannter Tab") +
              (modalTabId && Number(tab.id) === Number(modalTabId) ? " (Modal-Tab)" : ""),
            isModalTab: Boolean(modalTabId && Number(tab.id) === Number(modalTabId)),
            url: tab.url || "",
            active: Boolean(tab.active),
            lastAccessed: tab.lastAccessed || 0,
            windowId: tab.windowId,
          }))
          .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));

        let defaultTabId = list[0]?.tabId || null;
        if (preferredUrl) {
          const byExactUrl = list.find((tab) => tab.url === preferredUrl);
          if (byExactUrl) {
            defaultTabId = byExactUrl.tabId;
          } else {
            const preferredOrigin = (() => {
              try {
                return new URL(preferredUrl).origin;
              } catch {
                return "";
              }
            })();
            if (preferredOrigin) {
              const byOrigin = list.find((tab) => {
                try {
                  return new URL(tab.url).origin === preferredOrigin;
                } catch {
                  return false;
                }
              });
              if (byOrigin) defaultTabId = byOrigin.tabId;
            }
          }
        }

        sendResponse({ status: "ok", tabs: list, defaultTabId, modalTabId });
      })
      .catch((e) => sendResponse({ status: "error", message: e.message }));
    return true;
  }

  if (msg.type === "GET_PENDING_ATTACHMENT") {
    chrome.storage.session.get("gb_pending_attachment")
      .then((result) => sendResponse({
        status: "ok",
        attachment: result.gb_pending_attachment || null,
      }))
      .catch((e) => sendResponse({ status: "error", message: e.message }));
    return true;
  }

  if (msg.type === "CLEAR_PENDING_ATTACHMENT") {
    chrome.storage.session.remove("gb_pending_attachment")
      .then(() => sendResponse({ status: "ok" }))
      .catch((e) => sendResponse({ status: "error", message: e.message }));
    return true;
  }
});
