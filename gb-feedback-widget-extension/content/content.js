// Bridge zwischen Odoo-Modal (window.postMessage) und Extension-Runtime.
(function () {
  const PAGE_SOURCE = "gb_feedback_widget_page";
  const EXT_SOURCE = "gb_feedback_extension_bridge";
  const MODAL_BRIDGE_CONTEXT = "modal_bridge";

  function sendToPage(type, payload = {}) {
    window.postMessage({ source: EXT_SOURCE, type, ...payload }, window.location.origin);
  }

  // Signalisiert dem Odoo-Modal, dass die Bridge aktiv ist.
  sendToPage("GB_BRIDGE_READY", { status: "ok" });

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const msg = event.data || {};
    if (msg.source !== PAGE_SOURCE || !msg.type) return;

    if (msg.type === "GB_BRIDGE_PING") {
      sendToPage("GB_BRIDGE_READY", { status: "ok" });
      return;
    }

    if (msg.type === "GB_GIF_LIST_TABS") {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "LIST_RECORDABLE_TABS",
          preferredUrl: window.location.href,
          senderContext: MODAL_BRIDGE_CONTEXT,
        });
        sendToPage("GB_GIF_TABS", response);
      } catch (e) {
        sendToPage("GB_GIF_TABS", { status: "error", message: e.message });
      }
      return;
    }

    if (msg.type === "GB_GIF_START") {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "START_RECORDING",
          tabId: msg.tabId,
          uiContext: "modal",
          returnTabUrl: window.location.href,
          senderContext: MODAL_BRIDGE_CONTEXT,
        });
        sendToPage("GB_GIF_START_RESULT", response);
      } catch (e) {
        sendToPage("GB_GIF_START_RESULT", { status: "error", message: e.message });
      }
      return;
    }

    if (msg.type === "GB_GIF_STOP") {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "STOP_RECORDING",
          uiContext: "modal",
          returnTabUrl: window.location.href,
          senderContext: MODAL_BRIDGE_CONTEXT,
        });
        sendToPage("GB_GIF_STOP_RESULT", response);
      } catch (e) {
        sendToPage("GB_GIF_STOP_RESULT", { status: "error", message: e.message });
      }
      return;
    }

    if (msg.type === "GB_GIF_GET_STATE") {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "GET_RECORDING_STATE",
          senderContext: MODAL_BRIDGE_CONTEXT,
          consumePipelineError: msg.consumePipelineError,
        });
        sendToPage("GB_GIF_STATE", response);
      } catch (e) {
        sendToPage("GB_GIF_STATE", { status: "error", message: e.message });
      }
      return;
    }

    if (msg.type === "GB_GIF_GET_ATTACHMENT") {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "GET_PENDING_ATTACHMENT",
          senderContext: MODAL_BRIDGE_CONTEXT,
        });
        sendToPage("GB_GIF_ATTACHMENT", response);
      } catch (e) {
        sendToPage("GB_GIF_ATTACHMENT", { status: "error", message: e.message });
      }
      return;
    }

    if (msg.type === "GB_GIF_GET_BUILD_PROGRESS") {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "GET_GIF_BUILD_PROGRESS",
          senderContext: MODAL_BRIDGE_CONTEXT,
        });
        sendToPage("GB_GIF_BUILD_PROGRESS", response);
      } catch (e) {
        sendToPage("GB_GIF_BUILD_PROGRESS", { status: "error", message: e.message });
      }
      return;
    }

    if (msg.type === "GB_GIF_CLEAR_ATTACHMENT") {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "CLEAR_PENDING_ATTACHMENT",
          senderContext: MODAL_BRIDGE_CONTEXT,
        });
        sendToPage("GB_GIF_CLEAR_ATTACHMENT_RESULT", response);
      } catch (e) {
        sendToPage("GB_GIF_CLEAR_ATTACHMENT_RESULT", { status: "error", message: e.message });
      }
    }
  });
})();
