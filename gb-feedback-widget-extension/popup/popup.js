// ═══════════════════════════════════════════════════════════════════
// G+B SMART GIF RECORDING — Popup-Logik
// Eingefügt in Schritt 7 des Cursor-Prompts
// ═══════════════════════════════════════════════════════════════════

// ── Zustand ─────────────────────────────────────────────────────
let popupTimerInterval = null;
let selectableTabs = [];
/** Fallback falls GET_RECORDING_STATE kein maxDurationSec liefert (Extension-Version). */
const GIF_MAX_FALLBACK_SEC = 60;

// ── UI-Zustände umschalten ───────────────────────────────────────
function setGifUiState(state) {
  const states = ["ready", "running", "processing", "done", "error"];
  states.forEach((s) => {
    const el = document.getElementById("gb-gif-" + s);
    if (el) el.style.display = s === state ? "block" : "none";
  });
}

// ── Frame-Counter aktualisieren ──────────────────────────────────
function updateGifCounter(frameCount, elapsed, maxDurationSec) {
  const max = maxDurationSec != null ? maxDurationSec : GIF_MAX_FALLBACK_SEC;
  const remaining = Math.max(0, max - elapsed);
  const el = document.getElementById("gb-gif-counter");
  if (el) {
    el.textContent = `Frames: ${frameCount} | Dauer: ${elapsed}s | Restzeit: ${remaining}s (max. ${max}s)`;
  }
}

function isRecordableTab(tab) {
  return Boolean(tab?.id) && /^https?:\/\//.test(tab.url ?? "");
}

function getDefaultTabId(tabs) {
  if (!tabs.length) return null;
  const sorted = [...tabs].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return sorted[0]?.id ?? tabs[0].id;
}

function truncateTitle(title) {
  if (!title) return "Unbenannter Tab";
  return title.length > 42 ? `${title.slice(0, 39)}...` : title;
}

async function loadTabOptions() {
  const select = document.getElementById("gb-gif-tab-select");
  if (!select) return;

  const tabs = await chrome.tabs.query({ currentWindow: true });
  selectableTabs = tabs.filter(isRecordableTab);

  select.innerHTML = "";
  if (!selectableTabs.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Kein aufnehmbarer Tab gefunden";
    select.appendChild(opt);
    return;
  }

  for (const tab of selectableTabs) {
    const opt = document.createElement("option");
    opt.value = String(tab.id);
    opt.textContent = `${truncateTitle(tab.title)} (#${tab.id})`;
    select.appendChild(opt);
  }

  const defaultTabId = getDefaultTabId(selectableTabs);
  if (defaultTabId) {
    select.value = String(defaultTabId);
  }
}

// ── Aufnahme starten ─────────────────────────────────────────────
async function startGifRecording() {
  const selectedTabId = Number(document.getElementById("gb-gif-tab-select")?.value);
  if (!selectedTabId) {
    setGifUiState("error");
    document.getElementById("gb-gif-error").textContent =
      "Bitte zuerst einen gueltigen Tab auswaehlen.";
    return;
  }

  const selectedTab = selectableTabs.find((tab) => tab.id === selectedTabId);
  try {
    if (selectedTab?.windowId) {
      await chrome.windows.update(selectedTab.windowId, { focused: true });
    }
    await chrome.tabs.update(selectedTabId, { active: true });
  } catch (e) {
    setGifUiState("error");
    document.getElementById("gb-gif-error").textContent =
      "Ausgewaehlter Tab konnte nicht aktiviert werden.";
    return;
  }

  const result = await chrome.runtime.sendMessage({
    type: "START_RECORDING",
    tabId: selectedTabId,
  });

  if (result?.status !== "ok") {
    setGifUiState("error");
    document.getElementById("gb-gif-error").textContent =
      "Fehler beim Starten: " + (result?.message ?? "Unbekannt");
    return;
  }

  const procMain = document.querySelector("#gb-gif-processing .gb-gif-processing-main");
  if (procMain) {
    procMain.textContent = "⏳ GIF wird erstellt — bitte warten…";
  }

  setGifUiState("running");
  startPopupTimer();
}

// ── Popup-Timer (Live-Update alle 1s) ────────────────────────────
function startPopupTimer() {
  if (popupTimerInterval) clearInterval(popupTimerInterval);

  popupTimerInterval = setInterval(async () => {
    const state = await chrome.runtime.sendMessage({
      type: "GET_RECORDING_STATE",
      consumePipelineError: false,
    });

    if (!state?.active) {
      clearInterval(popupTimerInterval);
      return;
    }

    updateGifCounter(state.frameCount, state.elapsed, state.maxDurationSec);
  }, 1000);
}

// ── Auf Background-Nachrichten hören ────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "FRAME_CAPTURED") {
    updateGifCounter(msg.frameCount, msg.elapsed, msg.maxDurationSec);
  }

  if (msg.type === "RECORDING_STOPPED") {
    clearInterval(popupTimerInterval);
    const procEl = document.getElementById("gb-gif-processing");
    const main = procEl?.querySelector(".gb-gif-processing-main");
    if (main) {
      main.textContent =
        msg.reason === "hard_limit"
          ? "GIF wird erstellt — 60 s Maximaldauer erreicht, Aufnahme wurde beendet."
          : "GIF wird erstellt — bitte warten…";
    }
    setGifUiState("processing");
    // Nach kurzer Verzögerung → "Fertig"
    setTimeout(() => setGifUiState("done"), 3000);
  }

  if (msg.type === "RECORDING_ERROR") {
    clearInterval(popupTimerInterval);
    setGifUiState("error");
    document.getElementById("gb-gif-error").textContent =
      "Fehler: " + (msg.message ?? "Unbekannt");
  }
});

// ── Button-Handler ───────────────────────────────────────────────
function bindEditorTabAfterRecordingPreference() {
  const chk = document.getElementById("gb-open-editor-tab-after-recording");
  if (!chk) return;

  chrome.storage.local.get("openEditorTabAfterRecording").then((r) => {
    const v = r.openEditorTabAfterRecording;
    if (v === undefined) {
      chk.indeterminate = true;
      chk.checked = true;
    } else {
      chk.indeterminate = false;
      chk.checked = Boolean(v);
    }
  }).catch(() => {});

  chk.addEventListener("change", () => {
    chk.indeterminate = false;
    chrome.storage.local.set({ openEditorTabAfterRecording: chk.checked });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadTabOptions().catch(() => {
    setGifUiState("error");
    document.getElementById("gb-gif-error").textContent =
      "Tab-Auswahl konnte nicht geladen werden.";
  });

  bindEditorTabAfterRecordingPreference();

  document
    .getElementById("gb-gif-start-btn")
    ?.addEventListener("click", startGifRecording);

  document.getElementById("gb-gif-stop-btn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "STOP_RECORDING" });
  });

  // Beim Öffnen: aktuellen State wiederherstellen
  chrome.runtime
    .sendMessage({ type: "GET_RECORDING_STATE", consumePipelineError: false })
    .then((state) => {
      if (state?.active) {
        setGifUiState("running");
        updateGifCounter(state.frameCount, state.elapsed, state.maxDurationSec);
        startPopupTimer();
      }
    })
    .catch(() => {});
});
