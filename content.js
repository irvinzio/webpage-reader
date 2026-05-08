function normalizeSelectionText(value) {
  return (value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function getInputSelectionText(element) {
  if (!element) {
    return "";
  }

  const isTextInput =
    element.tagName === "TEXTAREA" ||
    (element.tagName === "INPUT" &&
      /^(email|number|password|search|tel|text|url)$/i.test(element.type || "text"));

  if (!isTextInput) {
    return "";
  }

  if (typeof element.selectionStart !== "number" || typeof element.selectionEnd !== "number") {
    return "";
  }

  if (element.selectionEnd <= element.selectionStart) {
    return "";
  }

  return normalizeSelectionText(
    (element.value || "").slice(element.selectionStart, element.selectionEnd)
  );
}

function getSelectionPayload() {
  const activeElement = document.activeElement;
  const inputSelection = getInputSelectionText(activeElement);
  const windowSelection = normalizeSelectionText(
    window.getSelection ? window.getSelection().toString() : ""
  );
  const text = inputSelection || windowSelection;

  return {
    ok: Boolean(text),
    text,
    title: normalizeSelectionText(document.title),
    lang: normalizeSelectionText(document.documentElement.lang || navigator.language || "en-US"),
    url: window.location.href,
    updatedAt: Date.now()
  };
}

let lastSentText = "";
let selectionTimer = null;
let lastStableSelection = null;

function pushSelectionState() {
  const payload = getSelectionPayload();
  const nextText = payload.text || "";

  if (nextText) {
    lastStableSelection = payload;
  }

  if (!nextText) {
    if (document.hasFocus() && lastSentText) {
      chrome.runtime.sendMessage({
        type: "selectionCleared",
        payload: {
          url: window.location.href,
          updatedAt: Date.now()
        }
      }).then(() => {
        lastSentText = "";
        lastStableSelection = null;
      }).catch(() => {
        lastSentText = "";
      });
    }

    return;
  }

  if (nextText === lastSentText) {
    return;
  }

  chrome.runtime.sendMessage({
    type: "selectionChanged",
    payload
  }).then(() => {
    lastSentText = nextText;
  }).catch(() => {
    lastSentText = "";
  });
}

function scheduleSelectionPush() {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(pushSelectionState, 80);
}

document.addEventListener("selectionchange", scheduleSelectionPush, true);
document.addEventListener("mouseup", scheduleSelectionPush, true);
document.addEventListener("keyup", scheduleSelectionPush, true);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    scheduleSelectionPush();
  }
});

window.addEventListener("load", scheduleSelectionPush);
scheduleSelectionPush();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "getLiveSelection") {
    const payload = getSelectionPayload();

    if (payload.ok) {
      sendResponse(payload);
      return true;
    }

    if (lastStableSelection) {
      sendResponse({
        ...lastStableSelection,
        ok: true,
        cached: true
      });
      return true;
    }

    sendResponse(payload);
    return true;
  }

  return false;
});
