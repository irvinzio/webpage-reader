(() => {
  if (window.__pageReaderOverlayLoaded) {
    return;
  }

  window.__pageReaderOverlayLoaded = true;

  const root = document.createElement("div");
  root.id = "page-reader-root";
  root.innerHTML = `
    <button class="page-reader-launcher" type="button" title="Open Page Reader">Read</button>
    <section class="page-reader-panel" hidden>
      <div class="page-reader-topbar">
        <div>
          <h2 class="page-reader-title">Page Reader</h2>
          <p class="page-reader-subtitle">Keep reading available while you stay on the page.</p>
        </div>
        <button class="page-reader-close" type="button" aria-label="Close">x</button>
      </div>

      <section class="page-reader-status">
        <div class="page-reader-status-head">
          <span class="page-reader-status-label">Status</span>
          <span class="page-reader-badge idle">Idle</span>
        </div>
        <p class="page-reader-status-text">Select text or open an article, then start reading.</p>
      </section>

      <div class="page-reader-actions">
        <button class="page-reader-button primary" data-action="read-page" type="button">Read page</button>
        <button class="page-reader-button selection" data-action="read-selection" type="button">Read selection</button>
      </div>

      <div class="page-reader-secondary">
        <button class="page-reader-button secondary" data-action="pause" type="button">Pause</button>
        <button class="page-reader-button secondary" data-action="resume" type="button">Resume</button>
        <button class="page-reader-button secondary" data-action="stop" type="button">Stop</button>
      </div>

      <div class="page-reader-fields">
        <div class="page-reader-field">
          <label for="page-reader-voice">Voice</label>
          <select id="page-reader-voice"></select>
        </div>

        <label class="page-reader-toggle">
          <input id="page-reader-llm-enabled" type="checkbox">
          <span class="page-reader-toggle-text">Use local Ollama for main-content detection</span>
        </label>

        <div class="page-reader-field">
          <label for="page-reader-ollama-model">Ollama model</label>
          <input id="page-reader-ollama-model" type="text">
        </div>

        <div class="page-reader-field">
          <label for="page-reader-ollama-endpoint">Ollama endpoint</label>
          <input id="page-reader-ollama-endpoint" type="text">
        </div>

        <div class="page-reader-field">
          <div class="page-reader-slider-row">
            <span>Speed</span>
            <span id="page-reader-rate-value">1.0x</span>
          </div>
          <input id="page-reader-rate" type="range" min="0.7" max="1.3" step="0.05" value="1">
        </div>

        <div class="page-reader-field">
          <div class="page-reader-slider-row">
            <span>Pitch</span>
            <span id="page-reader-pitch-value">1.0</span>
          </div>
          <input id="page-reader-pitch" type="range" min="0.8" max="1.2" step="0.05" value="1">
        </div>

        <div class="page-reader-field">
          <div class="page-reader-slider-row">
            <span>Volume</span>
            <span id="page-reader-volume-value">100%</span>
          </div>
          <input id="page-reader-volume" type="range" min="0.2" max="1" step="0.05" value="1">
        </div>
      </div>
    </section>
  `;

  document.documentElement.appendChild(root);

  const launcher = root.querySelector(".page-reader-launcher");
  const panel = root.querySelector(".page-reader-panel");
  const closeButton = root.querySelector(".page-reader-close");
  const badge = root.querySelector(".page-reader-badge");
  const statusText = root.querySelector(".page-reader-status-text");
  const voiceSelect = root.querySelector("#page-reader-voice");
  const llmEnabledInput = root.querySelector("#page-reader-llm-enabled");
  const ollamaModelInput = root.querySelector("#page-reader-ollama-model");
  const ollamaEndpointInput = root.querySelector("#page-reader-ollama-endpoint");
  const rateInput = root.querySelector("#page-reader-rate");
  const pitchInput = root.querySelector("#page-reader-pitch");
  const volumeInput = root.querySelector("#page-reader-volume");
  const rateValue = root.querySelector("#page-reader-rate-value");
  const pitchValue = root.querySelector("#page-reader-pitch-value");
  const volumeValue = root.querySelector("#page-reader-volume-value");
  const pauseButton = root.querySelector('[data-action="pause"]');
  const resumeButton = root.querySelector('[data-action="resume"]');
  const stopButton = root.querySelector('[data-action="stop"]');
  const readSelectionButton = root.querySelector('[data-action="read-selection"]');
  const actionButtons = Array.from(root.querySelectorAll("button"));

  const DEFAULT_SETTINGS = {
    rate: 1,
    pitch: 1,
    volume: 1,
    voiceName: "",
    llmEnabled: true,
    ollamaEndpoint: "http://127.0.0.1:11434/api/generate",
    ollamaModel: "gemma3"
  };

  let lastKnownSelection = null;

  function preventFocusLoss(button) {
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
  }

  for (const button of actionButtons) {
    preventFocusLoss(button);
  }

  function formatStatus(status) {
    if (status === "starting") {
      return "Starting";
    }

    if (status === "speaking") {
      return "Speaking";
    }

    if (status === "paused") {
      return "Paused";
    }

    if (status === "error") {
      return "Error";
    }

    return "Idle";
  }

  function updateSliderLabels(settings) {
    rateValue.textContent = `${Number(settings.rate).toFixed(1)}x`;
    pitchValue.textContent = Number(settings.pitch).toFixed(1);
    volumeValue.textContent = `${Math.round(Number(settings.volume) * 100)}%`;
  }

  function renderState(state) {
    const status = state?.status || "idle";
    badge.textContent = formatStatus(status);
    badge.className = `page-reader-badge ${status}`;

    if (status === "starting") {
      const title = state.readingMode === "selection"
        ? "your selected text"
        : state.title
          ? `"${state.title}"`
          : "the current page";
      statusText.textContent = `Preparing ${title} for playback.`;
    } else if (status === "speaking") {
      const title = state.readingMode === "selection"
        ? "your selected text"
        : state.title
          ? `"${state.title}"`
          : "the current page";
      const progress = typeof state.progress === "number" ? ` ${state.progress}% complete.` : "";
      const detectionText =
        state.readingMode === "page" && state.detectionMode
          ? ` ${state.detectionMode === "llm" ? "LLM-detected content." : "Focused parser content."}`
          : "";
      statusText.textContent = `Reading ${title}.${progress}${detectionText}`;
    } else if (status === "paused") {
      statusText.textContent = "Playback is paused. Resume when you're ready.";
    } else if (status === "error") {
      statusText.textContent = state.lastError || "Unable to start reading.";
    } else {
      statusText.textContent = "Select text or open an article, then start reading.";
    }

    pauseButton.disabled = status !== "speaking";
    resumeButton.disabled = status !== "paused";
    stopButton.disabled = !["starting", "speaking", "paused"].includes(status);
  }

  async function sendMessage(message) {
    return chrome.runtime.sendMessage(message);
  }

  async function getStatusAndSettings() {
    return sendMessage({ type: "getStatus" });
  }

  function setPanelOpen(open) {
    panel.hidden = !open;
  }

  function getSelectionPayload() {
    const inputSelection = (() => {
      const element = document.activeElement;
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

      return (element.value || "").slice(element.selectionStart, element.selectionEnd).trim();
    })();

    const text = inputSelection || (window.getSelection ? window.getSelection().toString().trim() : "");

    return {
      ok: Boolean(text),
      text,
      title: document.title || "",
      lang: document.documentElement.lang || navigator.language || "en-US",
      url: window.location.href,
      updatedAt: Date.now()
    };
  }

  function captureStableSelection() {
    const payload = getSelectionPayload();
    if (payload.ok) {
      lastKnownSelection = payload;
      sendMessage({ type: "selectionChanged", payload }).catch(() => {});
    }
  }

  async function saveSettings() {
    const settings = {
      voiceName: voiceSelect.value,
      llmEnabled: llmEnabledInput.checked,
      ollamaModel: ollamaModelInput.value.trim() || DEFAULT_SETTINGS.ollamaModel,
      ollamaEndpoint: ollamaEndpointInput.value.trim() || DEFAULT_SETTINGS.ollamaEndpoint,
      rate: Number(rateInput.value),
      pitch: Number(pitchInput.value),
      volume: Number(volumeInput.value)
    };

    updateSliderLabels(settings);
    await chrome.storage.sync.set(settings);
    await sendMessage({ type: "saveSettings", settings });
  }

  function populateVoices(selectedVoiceName) {
    const voices = speechSynthesis.getVoices().slice().sort((a, b) => a.name.localeCompare(b.name));
    voiceSelect.innerHTML = "";

    const autoOption = document.createElement("option");
    autoOption.value = "";
    autoOption.textContent = "Automatic best voice";
    voiceSelect.appendChild(autoOption);

    for (const voice of voices) {
      const option = document.createElement("option");
      option.value = voice.name;
      option.textContent = `${voice.name} (${voice.lang})`;
      voiceSelect.appendChild(option);
    }

    voiceSelect.value = selectedVoiceName || "";
  }

  async function handleReadPage() {
    const response = await sendMessage({
      type: "readCurrentTabFromOverlay"
    });

    if (!response?.ok) {
      renderState({
        status: "error",
        lastError: response?.error || "Unable to read this page."
      });
    }
  }

  async function handleReadSelection() {
    captureStableSelection();

    const selection = getSelectionPayload();
    const payload = selection.ok ? selection : lastKnownSelection;

    if (!payload?.text) {
      renderState({
        status: "error",
        lastError: "Select some text on the page first."
      });
      return;
    }

    const response = await sendMessage({
      type: "readSelectionFromOverlay",
      payload
    });

    if (!response?.ok) {
      renderState({
        status: "error",
        lastError: response?.error || "Unable to read the selected text."
      });
    }
  }

  launcher.addEventListener("click", () => {
    setPanelOpen(panel.hidden);
  });

  closeButton.addEventListener("click", () => {
    setPanelOpen(false);
  });

  root.querySelector('[data-action="read-page"]').addEventListener("click", () => {
    handleReadPage().catch((error) => {
      renderState({
        status: "error",
        lastError: error.message || "Unable to read this page."
      });
    });
  });

  readSelectionButton.addEventListener("click", () => {
    handleReadSelection().catch((error) => {
      renderState({
        status: "error",
        lastError: error.message || "Unable to read the selected text."
      });
    });
  });

  pauseButton.addEventListener("click", () => {
    sendMessage({ type: "pause" }).catch(() => {});
  });

  resumeButton.addEventListener("click", () => {
    sendMessage({ type: "resume" }).catch(() => {});
  });

  stopButton.addEventListener("click", () => {
    sendMessage({ type: "stop" }).catch(() => {});
  });

  voiceSelect.addEventListener("change", () => {
    saveSettings().catch(() => {});
  });
  llmEnabledInput.addEventListener("change", () => {
    saveSettings().catch(() => {});
  });
  ollamaModelInput.addEventListener("change", () => {
    saveSettings().catch(() => {});
  });
  ollamaEndpointInput.addEventListener("change", () => {
    saveSettings().catch(() => {});
  });
  rateInput.addEventListener("input", () => {
    saveSettings().catch(() => {});
  });
  pitchInput.addEventListener("input", () => {
    saveSettings().catch(() => {});
  });
  volumeInput.addEventListener("input", () => {
    saveSettings().catch(() => {});
  });

  document.addEventListener("selectionchange", captureStableSelection, true);
  document.addEventListener("mouseup", captureStableSelection, true);
  document.addEventListener("keyup", captureStableSelection, true);

  speechSynthesis.onvoiceschanged = () => {
    populateVoices(voiceSelect.value);
  };

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "readerState") {
      renderState(message.state || {});
    }
  });

  getStatusAndSettings().then((response) => {
    const settings = response?.settings || DEFAULT_SETTINGS;
    rateInput.value = settings.rate;
    pitchInput.value = settings.pitch;
    volumeInput.value = settings.volume;
    llmEnabledInput.checked = settings.llmEnabled;
    ollamaModelInput.value = settings.ollamaModel;
    ollamaEndpointInput.value = settings.ollamaEndpoint;
    updateSliderLabels(settings);
    populateVoices(settings.voiceName);
    renderState(response?.state || {});
  }).catch(() => {
    populateVoices("");
    renderState({});
  });
})();
