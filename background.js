const DEFAULT_SETTINGS = {
  rate: 1,
  pitch: 1,
  volume: 1,
  voiceName: "",
  llmEnabled: true,
  ollamaEndpoint: "http://127.0.0.1:11434/api/generate",
  ollamaModel: "gemma3"
};

const DEFAULT_STATE = {
  status: "idle",
  activeTabId: null,
  title: "",
  sourceUrl: "",
  readingMode: "",
  detectionMode: "",
  extractedFrom: "",
  progress: 0,
  chunkCount: 0,
  lastError: ""
};

let readerState = { ...DEFAULT_STATE };
const selectionCache = new Map();
const SELECTION_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

chrome.runtime.onInstalled.addListener(async () => {
  const currentSettings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set(currentSettings);
  await chrome.storage.session.set({ readerState });
});

chrome.runtime.onStartup.addListener(async () => {
  const stored = await chrome.storage.session.get("readerState");
  readerState = { ...DEFAULT_STATE, ...(stored.readerState || {}) };
});

async function loadState() {
  const stored = await chrome.storage.session.get("readerState");
  readerState = { ...DEFAULT_STATE, ...(stored.readerState || {}) };
  return readerState;
}

async function updateState(patch) {
  readerState = { ...readerState, ...patch };
  await chrome.storage.session.set({ readerState });

  try {
    await chrome.runtime.sendMessage({ type: "readerState", state: readerState });
  } catch (error) {
    // No popup is listening, which is fine.
  }

  return readerState;
}

async function getSettings() {
  return chrome.storage.sync.get(DEFAULT_SETTINGS);
}

function isReadableTabUrl(url) {
  return /^https?:\/\//i.test(url || "");
}

async function hasOffscreenDocument() {
  if (chrome.offscreen.hasDocument) {
    return chrome.offscreen.hasDocument();
  }

  const extensionUrl = chrome.runtime.getURL("offscreen.html");
  const matchedClients = await clients.matchAll();
  return matchedClients.some((client) => client.url === extensionUrl);
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Read the extracted main content of a page aloud while the user does other work."
  });
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({
    target: "offscreen",
    ...message
  });
}

async function stopReader() {
  try {
    await sendToOffscreen({ type: "stop" });
  } catch (error) {
    // If the offscreen document is unavailable, still reset extension state.
  }

  selectionCache.clear();
  await updateState({ ...DEFAULT_STATE });
}

function sanitizeText(text) {
  return (text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractPageCandidates() {
  const IGNORE_SELECTOR = [
    "script",
    "style",
    "noscript",
    "svg",
    "canvas",
    "iframe",
    "header",
    "footer",
    "nav",
    "aside",
    "form",
    "button",
    "input",
    "select",
    "textarea",
    "dialog",
    "[hidden]",
    "[aria-hidden='true']"
  ].join(",");
  const READABLE_BLOCK_SELECTOR = "h1, h2, h3, h4, p, pre, blockquote, li";

  function normalizeText(value) {
    return (value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function isVisible(element) {
    if (!element) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width >= 100 &&
      rect.height >= 40
    );
  }

  function isIgnored(element) {
    return Boolean(element.closest(IGNORE_SELECTOR));
  }

  function hasBoilerplateAncestor(element) {
    let current = element;

    while (current && current !== document.body) {
      const className = typeof current.className === "string" ? current.className : "";
      const marker = `${current.id || ""} ${className}`.toLowerCase();

      if (
        /(^|[\s_-])(nav|menu|header|footer|sidebar|aside|share|social|comment|breadcrumb|related|promo|advert|ads|banner|cookie|subscribe|newsletter|pagination|toolbar|modal|dialog)([\s_-]|$)/.test(
          marker
        )
      ) {
        return true;
      }

      if (current.matches("nav, header, footer, aside, form")) {
        return true;
      }

      current = current.parentElement;
    }

    return false;
  }

  function linkDensity(element) {
    const textLength = normalizeText(element.innerText).length || 1;
    const linkText = Array.from(element.querySelectorAll("a"))
      .map((link) => normalizeText(link.innerText))
      .join(" ");

    return linkText.length / textLength;
  }

  function isReadableBlock(element) {
    return element.matches(READABLE_BLOCK_SELECTOR);
  }

  function extractCleanTextFromElement(root) {
    const nodes = [
      ...(isReadableBlock(root) ? [root] : []),
      ...Array.from(root.querySelectorAll(READABLE_BLOCK_SELECTOR))
    ];

    const seen = new Set();
    const blocks = [];

    for (const node of nodes) {
      if (!node || seen.has(node)) {
        continue;
      }

      seen.add(node);

      if (isIgnored(node) || hasBoilerplateAncestor(node)) {
        continue;
      }

      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") {
        continue;
      }

      const text = normalizeText(node.innerText);
      const words = text.split(/\s+/).filter(Boolean);
      const density = linkDensity(node);
      const tagName = node.tagName.toLowerCase();
      const shortLinkedLine =
        words.length <= 8 && node.querySelectorAll("a, button").length >= 1;
      const listLikeBoilerplate =
        tagName === "li" && (words.length < 6 || density > 0.2);

      if (!text) {
        continue;
      }

      if (shortLinkedLine || listLikeBoilerplate) {
        continue;
      }

      if (tagName.startsWith("h")) {
        if (words.length < 2 || density > 0.25) {
          continue;
        }
      } else if (tagName === "li") {
        if (words.length < 8 || density > 0.2) {
          continue;
        }
      } else if (words.length < 8 || density > 0.35) {
        continue;
      }

      if (blocks[blocks.length - 1] !== text) {
        blocks.push(text);
      }
    }

    return blocks.join("\n\n").trim();
  }

  function textScore(element, text) {
    const textLength = text.length;
    const paragraphCount = element.querySelectorAll("p").length;
    const headingCount = element.querySelectorAll("h1, h2, h3").length;
    const listCount = element.querySelectorAll("li").length;
    const articleBonus = element.matches("article, main, [role='main']") ? 600 : 0;
    const semanticBonus = /article|content|entry|post|story|body|main/i.test(
      [element.id, element.className].filter(Boolean).join(" ")
    )
      ? 350
      : 0;
    const densityPenalty = Math.min(linkDensity(element), 1) * 1200;

    return (
      textLength +
      paragraphCount * 180 +
      headingCount * 80 +
      Math.min(listCount, 12) * 20 +
      articleBonus +
      semanticBonus -
      densityPenalty
    );
  }

  function gatherCandidates() {
    const directMatches = Array.from(
      document.querySelectorAll(
        "article, main, [role='main'], section, div, .post, .article, .content, #content, .entry-content, .post-content, .article-body"
      )
    );

    const paragraphAncestors = Array.from(document.querySelectorAll("p"))
      .filter((paragraph) => normalizeText(paragraph.innerText).length > 160)
      .flatMap((paragraph) => [paragraph.parentElement, paragraph.parentElement?.parentElement])
      .filter(Boolean);

    return Array.from(new Set([...directMatches, ...paragraphAncestors]));
  }

  const candidates = gatherCandidates()
    .map((candidate, domOrder) => {
      if (!candidate || !isVisible(candidate) || isIgnored(candidate)) {
        return null;
      }

      const text = extractCleanTextFromElement(candidate);
      const wordCount = text.split(/\s+/).filter(Boolean).length;

      if (text.length < 180 || wordCount < 35) {
        return null;
      }

      return {
        domOrder,
        tagName: candidate.tagName.toLowerCase(),
        text,
        wordCount,
        score: textScore(candidate, text)
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((candidate) => ({
      id: candidate.domOrder,
      domOrder: candidate.domOrder,
      tagName: candidate.tagName,
      wordCount: candidate.wordCount,
      score: Math.round(candidate.score),
      snippet: candidate.text.slice(0, 1400),
      text: candidate.text
    }));

  const bodyText = extractCleanTextFromElement(document.body) ||
    normalizeText(document.body ? document.body.innerText : "");
  const bodyWordCount = bodyText.split(/\s+/).filter(Boolean).length;

  if (!candidates.length && bodyWordCount < 40) {
    return {
      ok: false,
      error: "I couldn't find enough readable content on this page."
    };
  }

  return {
    ok: true,
    title: normalizeText(document.title),
    lang: normalizeText(document.documentElement.lang || navigator.language || "en-US"),
    url: window.location.href,
    candidates,
    fallbackText: bodyText,
    wordCount: bodyWordCount
  };
}

function fallbackMainContent(candidates, fallbackText) {
  if (Array.isArray(candidates) && candidates.length) {
    return {
      text: candidates[0].text,
      extractedFrom: candidates[0].tagName || "candidate",
      detectionMode: "fallback"
    };
  }

  return {
    text: fallbackText,
    extractedFrom: "body",
    detectionMode: "fallback"
  };
}

function buildOllamaPrompt(candidates, pageMeta) {
  const compactCandidates = candidates.map((candidate) => {
    return [
      `ID: ${candidate.id}`,
      `Tag: ${candidate.tagName}`,
      `Words: ${candidate.wordCount}`,
      `Score: ${candidate.score}`,
      `Text: ${candidate.snippet}`
    ].join("\n");
  });

  return [
    "Choose the page blocks that contain the main article or primary readable content.",
    "Avoid navigation, sidebars, cookie banners, footers, comments, and repeated site chrome.",
    "Return JSON only with this shape: {\"selectedIndexes\":[number],\"reason\":\"short text\"}.",
    "Pick 1 to 3 block IDs, ordered by their reading order.",
    "",
    `Page title: ${pageMeta.title || ""}`,
    `Page language: ${pageMeta.lang || ""}`,
    "",
    compactCandidates.join("\n\n---\n\n")
  ].join("\n");
}

async function detectMainContentWithOllama(payload, settings) {
  if (!settings.llmEnabled) {
    throw new Error("LLM detection is disabled.");
  }

  if (!settings.ollamaEndpoint || !settings.ollamaModel) {
    throw new Error("Ollama settings are incomplete.");
  }

  if (!payload.candidates?.length) {
    throw new Error("No content candidates were available for the LLM.");
  }

  const response = await fetch(settings.ollamaEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: settings.ollamaModel,
      prompt: buildOllamaPrompt(payload.candidates, payload),
      format: "json",
      stream: false,
      options: {
        temperature: 0.1
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed with ${response.status}.`);
  }

  const data = await response.json();
  const parsed = JSON.parse(data.response || "{}");
  const selectedIndexes = Array.isArray(parsed.selectedIndexes)
    ? parsed.selectedIndexes.filter((value) => Number.isInteger(value))
    : [];

  const selectedBlocks = selectedIndexes
    .map((index) => payload.candidates.find((candidate) => candidate.id === index))
    .filter(Boolean)
    .sort((a, b) => a.domOrder - b.domOrder);

  if (!selectedBlocks.length) {
    throw new Error("Ollama did not return a usable content block.");
  }

  const text = sanitizeText(selectedBlocks.map((block) => block.text).join("\n\n"));
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  if (wordCount < 40) {
    throw new Error("Ollama selected too little content to read.");
  }

  return {
    text,
    extractedFrom: selectedBlocks.map((block) => block.tagName).join(", "),
    detectionMode: "llm"
  };
}

async function resolveMainContent(payload, settings) {
  try {
    return await detectMainContentWithOllama(payload, settings);
  } catch (error) {
    return fallbackMainContent(payload.candidates, payload.fallbackText);
  }
}

async function getLiveSelection(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "getLiveSelection" });
  } catch (error) {
    return null;
  }
}

async function getInjectedSelection(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
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

          if (
            !isTextInput ||
            typeof element.selectionStart !== "number" ||
            typeof element.selectionEnd !== "number" ||
            element.selectionEnd <= element.selectionStart
          ) {
            return "";
          }

          return normalizeSelectionText(
            (element.value || "").slice(element.selectionStart, element.selectionEnd)
          );
        }

        const inputSelection = getInputSelectionText(document.activeElement);
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
          extractedFrom: "selection",
          updatedAt: Date.now()
        };
      }
    });

    return results.map((result) => result.result).find((payload) => payload?.text) || null;
  } catch (error) {
    return null;
  }
}

async function ensureSelectionContentScript(tabId, tabUrl) {
  if (!isReadableTabUrl(tabUrl)) {
    return false;
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: "getLiveSelection" });
    return true;
  } catch (error) {
    try {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ["content.css"]
      });
    } catch (cssError) {
      // CSS may already be injected; the content script is the important part.
    }

    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"]
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["overlay.js"]
    });
    return true;
  }
}

function getCachedSelection(tabId, currentUrl) {
  const cached = selectionCache.get(tabId);
  if (!cached?.text) {
    return null;
  }

  if (currentUrl && cached.url && cached.url !== currentUrl) {
    return null;
  }

  if (cached.updatedAt && Date.now() - cached.updatedAt > SELECTION_CACHE_MAX_AGE_MS) {
    selectionCache.delete(tabId);
    return null;
  }

  return cached;
}

function rememberSelection(tabId, payload) {
  if (typeof tabId !== "number" || !payload?.text) {
    return;
  }

  selectionCache.set(tabId, {
    extractedFrom: "selection",
    ...payload,
    updatedAt: payload.updatedAt || Date.now()
  });
}

function clearTabSelection(tabId) {
  if (typeof tabId === "number") {
    selectionCache.delete(tabId);
  }
}

async function readPage(tabId) {
  const tab = await chrome.tabs.get(tabId);

  if (!isReadableTabUrl(tab?.url)) {
    throw new Error("Open an http or https page first. Browser pages like brave://extensions cannot be read.");
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractPageCandidates
  });

  const payload = result?.result;

  if (!payload?.ok) {
    throw new Error(payload?.error || "Unable to extract readable content from the page.");
  }

  const settings = await getSettings();
  const resolved = await resolveMainContent(payload, settings);

  await updateState({
    status: "starting",
    activeTabId: tabId,
    title: payload.title,
    sourceUrl: payload.url,
    readingMode: "page",
    detectionMode: resolved.detectionMode,
    extractedFrom: resolved.extractedFrom,
    progress: 0,
    chunkCount: 0,
    lastError: ""
  });

  await sendToOffscreen({
    type: "speak",
    payload: {
      ...payload,
      text: sanitizeText(resolved.text),
      settings
    }
  });

  return {
    ...payload,
    text: resolved.text,
    extractedFrom: resolved.extractedFrom
  };
}

async function readSelection(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await ensureSelectionContentScript(tabId, tab?.url);

  const cachedSelection = getCachedSelection(tabId, tab?.url);
  const liveSelection = await getLiveSelection(tabId);
  const injectedSelection = await getInjectedSelection(tabId);
  const payload = cachedSelection || (liveSelection?.ok ? liveSelection : null) || (injectedSelection?.ok ? injectedSelection : null);

  if (!payload?.text) {
    throw new Error(payload?.error || "Select text on the page first, then open the reader and press Read selection.");
  }

  const settings = await getSettings();
  const selectionText = sanitizeText(payload.text);

  if (selectionText.split(/\s+/).filter(Boolean).length < 3) {
    throw new Error("Select some text on the page first.");
  }

  await updateState({
    status: "starting",
    activeTabId: tabId,
    title: payload.title || tab?.title || "",
    sourceUrl: payload.url || tab?.url || "",
    readingMode: "selection",
    detectionMode: "selection",
    extractedFrom: payload.extractedFrom,
    progress: 0,
    chunkCount: 0,
    lastError: ""
  });

  await sendToOffscreen({
    type: "speak",
    payload: {
      ...payload,
      text: selectionText,
      settings
    }
  });

  return payload;
}

async function readSelectionPayload(tabId, payload) {
  const tab = await chrome.tabs.get(tabId);
  const settings = await getSettings();
  const text = sanitizeText(payload?.text || "");

  if (text.split(/\s+/).filter(Boolean).length < 3) {
    throw new Error("Select some text on the page first.");
  }

  await updateState({
    status: "starting",
    activeTabId: tabId,
    title: payload?.title || tab?.title || "",
    sourceUrl: payload?.url || tab?.url || "",
    readingMode: "selection",
    detectionMode: "selection",
    extractedFrom: "selection",
    progress: 0,
    chunkCount: 0,
    lastError: ""
  });

  await sendToOffscreen({
    type: "speak",
    payload: {
      ...payload,
      text,
      settings
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "selectionChanged") {
      if (typeof sender.tab?.id === "number" && message.payload) {
        if (message.payload.text) {
          rememberSelection(sender.tab.id, message.payload);
        } else {
          clearTabSelection(sender.tab.id);
        }
      }

      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "selectionCleared") {
      // Opening the popup can clear the live page selection before the popup
      // handler asks for it, so keep the last non-empty selection until it ages
      // out or the tab navigates.
      sendResponse({ ok: true });
      return;
    }

    if (message?.source === "offscreen" && message?.type === "speechStatus") {
      await updateState(message.state || {});
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "getStatus") {
      const state = await loadState();
      const settings = await getSettings();
      sendResponse({ ok: true, state, settings });
      return;
    }

    if (message?.type === "saveSettings") {
      await chrome.storage.sync.set(message.settings || {});
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "readCurrentTab") {
      try {
        const tabId = message.tabId;

        if (typeof tabId !== "number") {
          throw new Error("No active tab was provided.");
        }

        const payload = await readPage(tabId);
        sendResponse({ ok: true, payload });
      } catch (error) {
        await updateState({
          status: "error",
          lastError: error.message || "Unable to start reading."
        });
        sendResponse({ ok: false, error: error.message || "Unable to start reading." });
      }

      return;
    }

    if (message?.type === "readCurrentTabFromOverlay") {
      try {
        const tabId = sender.tab?.id;

        if (typeof tabId !== "number") {
          throw new Error("No active tab was provided.");
        }

        const payload = await readPage(tabId);
        sendResponse({ ok: true, payload });
      } catch (error) {
        await updateState({
          status: "error",
          lastError: error.message || "Unable to start reading."
        });
        sendResponse({ ok: false, error: error.message || "Unable to start reading." });
      }

      return;
    }

    if (message?.type === "readSelection") {
      try {
        const tabId = message.tabId;

        if (typeof tabId !== "number") {
          throw new Error("No active tab was provided.");
        }

        const payload = await readSelection(tabId);
        sendResponse({ ok: true, payload });
      } catch (error) {
        await updateState({
          status: "error",
          lastError: error.message || "Unable to start reading the selection."
        });
        sendResponse({
          ok: false,
          error: error.message || "Unable to start reading the selection."
        });
      }

      return;
    }

    if (message?.type === "readSelectionFromOverlay") {
      try {
        const tabId = sender.tab?.id;

        if (typeof tabId !== "number") {
          throw new Error("No active tab was provided.");
        }

        await readSelectionPayload(tabId, message.payload || {});
        sendResponse({ ok: true });
      } catch (error) {
        await updateState({
          status: "error",
          lastError: error.message || "Unable to start reading the selection."
        });
        sendResponse({
          ok: false,
          error: error.message || "Unable to start reading the selection."
        });
      }

      return;
    }

    if (message?.type === "pause") {
      await sendToOffscreen({ type: "pause" });
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "resume") {
      await sendToOffscreen({ type: "resume" });
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "stop") {
      await stopReader();
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "Unknown message type." });
  })();

  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  clearTabSelection(tabId);
  const state = await loadState();
  if (state.activeTabId === tabId && state.status !== "idle") {
    await stopReader();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url) {
    clearTabSelection(tabId);
  }
});
