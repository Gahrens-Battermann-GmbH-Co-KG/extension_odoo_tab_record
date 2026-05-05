// ═══════════════════════════════════════════════════════════════════
// G+B SMART GIF RECORDING — GIF-Erstellung im Editor
// Eingefügt/ersetzt in Schritt 6 des Cursor-Prompts
// ═══════════════════════════════════════════════════════════════════

const GIF_BUILD_PROGRESS_KEY = "gb_gif_build_progress";

/** Offscreen-Dokumente: kein chrome.storage — Zugriff per Service Worker. */
async function extSessionGet(keys) {
  if (chrome.storage?.session) {
    return chrome.storage.session.get(keys);
  }
  const res = await chrome.runtime.sendMessage({ type: "SESSION_STORAGE_GET", keys });
  if (res?.status !== "ok") {
    throw new Error(res?.message || "SESSION_STORAGE_GET");
  }
  return res.data;
}

async function extSessionSet(data) {
  if (chrome.storage?.session) {
    await chrome.storage.session.set(data);
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: "SESSION_STORAGE_SET", data });
  if (res?.status !== "ok") {
    throw new Error(res?.message || "SESSION_STORAGE_SET");
  }
}

async function extSessionRemove(keys) {
  if (chrome.storage?.session) {
    await chrome.storage.session.remove(keys);
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: "SESSION_STORAGE_REMOVE", keys });
  if (res?.status !== "ok") {
    throw new Error(res?.message || "SESSION_STORAGE_REMOVE");
  }
}

async function setBuildProgress(percent, phase) {
  try {
    await extSessionSet({
      [GIF_BUILD_PROGRESS_KEY]: {
        percent: Math.min(100, Math.max(0, Math.round(percent))),
        phase: phase || "",
      },
    });
  } catch (e) {
    console.warn("[G+B GIF Editor] Fortschritt speichern fehlgeschlagen:", e?.message);
  }
}

async function clearBuildProgress() {
  try {
    await extSessionRemove(GIF_BUILD_PROGRESS_KEY);
  } catch (e) {
    console.warn("[G+B GIF Editor] Fortschritt loeschen fehlgeschlagen:", e?.message);
  }
}

async function initGifMode() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("mode") !== "gif") return;
  const silentMode = params.get("silent") === "1";
  const offscreenMode = params.get("offscreen") === "1";

  if (typeof GIF === "undefined") {
    showStatus("Fehler: gif.js wurde nicht geladen (Extension unvollstaendig).");
    await clearBuildProgress();
    try {
      await chrome.runtime.sendMessage({
        type: "GIF_ENCODER_FAILED",
        message: "gif.js fehlt im Extension-Paket (Ordner capture/).",
      });
    } catch (_) {}
    return;
  }

  showStatus("GIF wird vorbereitet…");
  await setBuildProgress(0, "prepare");

  // Frames aus Session Storage laden
  let result;
  try {
    result = await extSessionGet("gb_pending_gif_frames");
  } catch (e) {
    showStatus("Fehler: Frames konnten nicht aus dem Extension-Speicher gelesen werden.");
    await clearBuildProgress();
    try {
      await chrome.runtime.sendMessage({
        type: "GIF_ENCODER_FAILED",
        message: e?.message || "SESSION_STORAGE_GET",
      });
    } catch (_) {}
    return;
  }
  const gifData = result["gb_pending_gif_frames"];

  if (!gifData || !gifData.frames?.length) {
    showStatus("Fehler: Keine Frames gefunden. Bitte Aufnahme wiederholen.");
    await clearBuildProgress();
    return;
  }

  const { frames, duration } = gifData;

  // Frames sofort aus chrome.storage.session entfernen — sonst liegen sie noch während
  // der GIF-Erstellung neben gb_pending_attachment und sprengen das ~10 MB Session-Quota.
  try {
    await extSessionRemove("gb_pending_gif_frames");
  } catch (e) {
    console.warn("[G+B GIF Editor] gb_pending_gif_frames entfernen:", e?.message);
  }

  showStatus(
    `${frames.length} Frames geladen (${Math.round(duration / 1000)}s). ` +
    "GIF wird erstellt…"
  );

  try {
  // Erstes Frame laden um Canvas-Größe zu ermitteln
  const firstImg = await loadImage(frames[0].dataUrl);
  const width    = firstImg.naturalWidth;
  const height   = firstImg.naturalHeight;

  // gif.js initialisieren
  const gif = new GIF({
    workers:      2,
    quality:      10,
    workerScript: chrome.runtime.getURL("capture/gif.worker.js"),
    width,
    height,
  });

  // Frames hinzufügen mit echten Zeitabständen
  for (let i = 0; i < frames.length; i++) {
    const img  = await loadImage(frames[i].dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, width, height);
    drawShortcutKbdRow(ctx, frames[i].kbdKeys);
    drawCursorHighlight(ctx, frames[i].cursor);

    // Delay = Zeitabstand zum nächsten Frame
    // Letzter Frame: 2000ms damit das Ergebnis sichtbar bleibt
    const nextTs = frames[i + 1]?.timestamp ?? frames[i].timestamp + 2000;
    const delay  = Math.max(100, nextTs - frames[i].timestamp);
    // Minimum 100ms wegen GIF-Format-Limitierung in Browsern

    gif.addFrame(canvas, { delay });
    showStatus(`Frame ${i + 1} / ${frames.length} verarbeitet…`);
    await setBuildProgress(((i + 1) / frames.length) * 45, "frames");
  }

  // GIF rendern
  gif.on("progress", (p) => {
    const pct = Math.round(p * 100);
    showStatus(`GIF wird komprimiert: ${pct}%`);
    void setBuildProgress(45 + p * 40, "compress");
  });

  gif.on("finished", async (blob) => {
    showStatus("✓ GIF fertig. Wird für Upload vorbereitet…");
    showPreview(blob);
    await setBuildProgress(88, "encode_done");

    // Als base64 für Upload speichern
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await extSessionSet({
          "gb_pending_attachment": {
            dataUrl: reader.result,
            filename: `gb_recording_${Date.now()}.gif`,
            mimeType: "image/gif",
          },
        });
      } catch (e) {
        console.error("[G+B GIF Editor] Pending-Attachment speichern fehlgeschlagen:", e?.message);
        showStatus("Fehler: GIF konnte nicht fuer das Odoo-Modal gespeichert werden (Speicher/Quota).");
        await clearBuildProgress();
        try {
          await chrome.runtime.sendMessage({
            type: "GIF_ENCODER_FAILED",
            message: e?.message || "Pending-Attachment Quota",
          });
        } catch (_) {}
        return;
      }

      await setBuildProgress(100, "pending_saved");
      await clearBuildProgress();

      // Größe anzeigen
      const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
      showStatus(
        `✓ GIF bereit (${sizeMB} MB). ` +
        "Speichere die Odoo-Task — das GIF wird automatisch angehängt."
      );

      // Warnung bei großen Dateien
      if (blob.size > 15 * 1024 * 1024) {
        showWarning(
          `Hinweis: Das GIF ist ${sizeMB} MB groß. ` +
          "Odoo.sh akzeptiert standardmäßig max. 25 MB. " +
          "Bei Upload-Fehler bitte kürzere Aufnahme versuchen."
        );
      }

      if (offscreenMode) {
        try {
          await chrome.runtime.sendMessage({ type: "GIF_OFFSCREEN_DONE" });
        } catch (err) {
          console.warn("[G+B GIF Editor] GIF_OFFSCREEN_DONE:", err?.message);
        }
      } else if (silentMode) {
        setTimeout(() => window.close(), 900);
      }
    };
    reader.onerror = async () => {
      showStatus("Fehler: GIF konnte nicht als Base64 gelesen werden.");
      await clearBuildProgress();
      try {
        await chrome.runtime.sendMessage({
          type: "GIF_ENCODER_FAILED",
          message: "FileReader readAsDataURL fehlgeschlagen",
        });
      } catch (_) {}
    };
    reader.readAsDataURL(blob);
  });

  gif.render();
  } catch (e) {
    const errMsg = e?.message || String(e);
    console.error("[G+B GIF Editor] Encoding abgebrochen:", errMsg);
    showStatus(`Fehler beim GIF-Encoding: ${errMsg}`);
    await clearBuildProgress();
    try {
      await chrome.runtime.sendMessage({
        type: "GIF_ENCODER_FAILED",
        message: errMsg,
      });
    } catch (_) {}
  }
}

// ── Hilfsfunktionen ──────────────────────────────────────────────

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error("Bild konnte nicht geladen werden"));
    img.src = src;
  });
}

function showStatus(text) {
  const el = document.getElementById("gb-gif-status");
  if (el) el.textContent = text;
  console.log("[G+B GIF Editor]", text);
}

function showWarning(text) {
  const el = document.getElementById("gb-gif-warning");
  if (el) {
    el.textContent = text;
    el.style.display = "block";
  }
}

function showPreview(blob) {
  const wrap = document.getElementById("gb-gif-preview-wrap");
  const img = document.getElementById("gb-gif-preview");
  if (!wrap || !img) return;

  const previewUrl = URL.createObjectURL(blob);
  img.src = previewUrl;
  wrap.style.display = "block";
}

/** Oben am GIF: Tastenkombination wie „Alt“ + „s“ (Kästen + Plus). */
function drawShortcutKbdRow(ctx, keys) {
  if (!keys?.length) return;

  const padX = 10;
  const keyH = Math.max(22, Math.min(36, Math.round(ctx.canvas.width * 0.034)));
  const fontPx = Math.round(keyH * 0.52);
  const radius = 5;
  const topY = Math.max(10, Math.round(ctx.canvas.height * 0.016));

  ctx.save();
  ctx.font = `600 ${fontPx}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";

  const keyWidths = keys.map((label) => ctx.measureText(label).width + padX * 2);
  const plusW = fontPx * 0.85;
  const totalW =
    keyWidths.reduce((a, b) => a + b, 0) + Math.max(0, keys.length - 1) * plusW;
  let x = (ctx.canvas.width - totalW) / 2;

  function strokeRoundRect(x0, y0, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x0 + rr, y0);
    ctx.lineTo(x0 + w - rr, y0);
    ctx.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + rr);
    ctx.lineTo(x0 + w, y0 + h - rr);
    ctx.quadraticCurveTo(x0 + w, y0 + h, x0 + w - rr, y0 + h);
    ctx.lineTo(x0 + rr, y0 + h);
    ctx.quadraticCurveTo(x0, y0 + h, x0, y0 + h - rr);
    ctx.lineTo(x0, y0 + rr);
    ctx.quadraticCurveTo(x0, y0, x0 + rr, y0);
    ctx.closePath();
  }

  for (let i = 0; i < keys.length; i++) {
    const label = keys[i];
    const kw = keyWidths[i];
    ctx.fillStyle = "#f4f4f6";
    ctx.strokeStyle = "rgba(60, 60, 70, 0.35)";
    ctx.lineWidth = 1;
    strokeRoundRect(x, topY, kw, keyH, radius);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#3a3a42";
    ctx.fillText(label, x + kw / 2, topY + keyH / 2);
    x += kw;
    if (i < keys.length - 1) {
      ctx.fillStyle = "#2a2a30";
      ctx.font = `500 ${fontPx}px "Segoe UI", Arial, sans-serif`;
      ctx.fillText("+", x + plusW / 2, topY + keyH / 2);
      ctx.font = `600 ${fontPx}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
      x += plusW;
    }
  }
  ctx.restore();
}

function drawCursorHighlight(ctx, cursor) {
  if (!cursor || !Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) return;

  const x = Math.max(0, Math.min(ctx.canvas.width, cursor.x));
  const y = Math.max(0, Math.min(ctx.canvas.height, cursor.y));

  ctx.save();
  ctx.strokeStyle = "rgba(217, 4, 41, 0.85)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, Math.PI * 2);
  ctx.stroke();

  // Mauszeiger (Pfeil) mit schwarzer Kontur und weißer Füllung.
  const pointerScale = 0.82;
  const pts = [
    [x, y],
    [x + 12 * pointerScale, y + 30 * pointerScale],
    [x + 18 * pointerScale, y + 23 * pointerScale],
    [x + 24 * pointerScale, y + 36 * pointerScale],
    [x + 30 * pointerScale, y + 33 * pointerScale],
    [x + 22 * pointerScale, y + 19 * pointerScale],
    [x + 31 * pointerScale, y + 19 * pointerScale]
  ];

  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i][0], pts[i][1]);
  }
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "rgba(25, 25, 25, 0.95)";
  ctx.lineWidth = 1.6;
  ctx.fill();
  ctx.stroke();

  // Kleiner roter Hotspot am tatsächlichen Klickpunkt.
  ctx.beginPath();
  ctx.fillStyle = "rgba(217, 4, 41, 0.92)";
  ctx.arc(x, y, 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// GIF-Modus starten sobald DOM bereit
document.addEventListener("DOMContentLoaded", initGifMode);
