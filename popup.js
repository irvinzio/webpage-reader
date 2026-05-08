const elements = {
  readButton: document.getElementById("readButton"),
  selectionButton: document.getElementById("selectionButton"),
  pauseButton: document.getElementById("pauseButton"),
  resumeButton: document.getElementById("resumeButton"),
  stopButton: document.getElementById("stopButton"),
  voiceSelect: document.getElementById("voiceSelect"),
  llmEnabledInput: document.getElementById("llmEnabledInput"),
  ollamaModelInput: document.getElementById("ollamaModelInput"),
  ollamaEndpointInput: document.getElementById("ollamaEndpointInput"),
  rateInput: document.getElementById("rateInput"),
  pitchInput: document.getElementById("pitchInput"),
  volumeInput: document.getElementById("volumeInput"),
  rateValue: document.getElementById("rateValue"),
  pitchValue: document.getElementById("pitchValue"),
  volumeValue: document.getElementById("volumeValue"),
  statusBadge: document.getElementById("statusBadge"),
  statusDetail: document.getElementById("statusDetail")
};

const DEFAULT_SETTINGS = {
  rate: 1,
  pitch: 1,
  volume: 1,
  voiceName: "",
  llmEnabled: true,
  ollamaEndpoint: "http://127.0.0.1:11434/api/generate",
  ollamaModel: "gemma3"
};

async function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  return tab;
}

async function loadSettings() {
  return chrome.storage.sync.get(DEFAULT_SETTINGS);
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
  elements.rateValue.textContent = `${Number(settings.rate).toFixed(1)}x`;
  elements.pitchValue.textContent = Number(settings.pitch).toFixed(1);
  elements.volumeValue.textContent = `${Math.round(Number(settings.volume) * 100)}%`;
}

function renderState(state) {
  const status = state?.status || "idle";
  elements.statusBadge.textContent = formatStatus(status);
  elements.statusBadge.className = `status-badge ${status}`;

  if (status === "starting") {
    const title = state.title ? `"${state.title}"` : "the current page";
    const modeText =
      state.readingMode === "selection" ? "your selected text" : title;
    elements.statusDetail.textContent = `Preparing ${modeText} for playback.`;
  } else if (status === "speaking") {
    const title =
      state.readingMode === "selection"
        ? "your selected text"
        : state.title
          ? `"${state.title}"`
          : "the current page";
    const progress = typeof state.progress === "number" ? ` ${state.progress}% complete.` : "";
    const detectionText =
      state.readingMode === "page" && state.detectionMode
        ? ` ${state.detectionMode === "llm" ? "LLM-detected content." : "Fallback parser content."}`
        : "";
    elements.statusDetail.textContent = `Reading ${title}.${progress}${detectionText}`;
  } else if (status === "paused") {
    elements.statusDetail.textContent = "Playback is paused. Resume when you're ready.";
  } else if (status === "error") {
    elements.statusDetail.textContent = state.lastError || "Something went wrong while trying to read this page.";
  } else {
    elements.statusDetail.textContent = "Open an article or documentation page, then press Read page.";
  }

  elements.pauseButton.disabled = status !== "speaking";
  elements.resumeButton.disabled = status !== "paused";
  elements.stopButton.disabled =
    status !== "starting" && status !== "speaking" && status !== "paused";
}

async function populateVoices(selectedVoiceName) {
  function fill(voices) {
    const items = voices
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((voice) => {
        const option = document.createElement("option");
        option.value = voice.name;
        option.textContent = `${voice.name} (${voice.lang})`;
        return option;
      });

    elements.voiceSelect.innerHTML = "";

    const autoOption = document.createElement("option");
    autoOption.value = "";
    autoOption.textContent = "Automatic best voice";
    elements.voiceSelect.appendChild(autoOption);

    for (const item of items) {
      elements.voiceSelect.appendChild(item);
    }

    elements.voiceSelect.value = selectedVoiceName || "";
  }

  const current = speechSynthesis.getVoices();
  if (current.length) {
    fill(current);
  } else {
    fill([]);
  }

  speechSynthesis.onvoiceschanged = () => {
    fill(speechSynthesis.getVoices());
  };
}

async function saveSettings() {
  const settings = {
    voiceName: elements.voiceSelect.value,
    llmEnabled: elements.llmEnabledInput.checked,
    ollamaModel: elements.ollamaModelInput.value.trim() || DEFAULT_SETTINGS.ollamaModel,
    ollamaEndpoint:
      elements.ollamaEndpointInput.value.trim() || DEFAULT_SETTINGS.ollamaEndpoint,
    rate: Number(elements.rateInput.value),
    pitch: Number(elements.pitchInput.value),
    volume: Number(elements.volumeInput.value)
  };

  updateSliderLabels(settings);
  await chrome.storage.sync.set(settings);
  await sendMessage({ type: "saveSettings", settings });
}

async function handleRead() {
  const tab = await getActiveTab();

  if (!tab?.id) {
    renderState({
      status: "error",
      lastError: "No active tab is available."
    });
    return;
  }

  const response = await sendMessage({
    type: "readCurrentTab",
    tabId: tab.id
  });

  if (!response?.ok) {
    renderState({
      status: "error",
      lastError: response?.error || "Unable to read this page."
    });
  }
}

async function handleReadSelection() {
  const tab = await getActiveTab();

  if (!tab?.id) {
    renderState({
      status: "error",
      lastError: "No active tab is available."
    });
    return;
  }

  const response = await sendMessage({
    type: "readSelection",
    tabId: tab.id
  });

  if (!response?.ok) {
    renderState({
      status: "error",
      lastError: response?.error || "Unable to read the selected text."
    });
  }
}

async function init() {
  const [settings, statusResponse] = await Promise.all([
    loadSettings(),
    sendMessage({ type: "getStatus" })
  ]);

  elements.rateInput.value = settings.rate;
  elements.pitchInput.value = settings.pitch;
  elements.volumeInput.value = settings.volume;
  elements.llmEnabledInput.checked = settings.llmEnabled;
  elements.ollamaModelInput.value = settings.ollamaModel;
  elements.ollamaEndpointInput.value = settings.ollamaEndpoint;
  updateSliderLabels(settings);
  await populateVoices(settings.voiceName);
  renderState(statusResponse?.state || { status: "idle" });

  elements.readButton.addEventListener("click", handleRead);
  elements.selectionButton.addEventListener("click", handleReadSelection);
  elements.pauseButton.addEventListener("click", async () => {
    await sendMessage({ type: "pause" });
  });
  elements.resumeButton.addEventListener("click", async () => {
    await sendMessage({ type: "resume" });
  });
  elements.stopButton.addEventListener("click", async () => {
    await sendMessage({ type: "stop" });
    renderState({ status: "idle" });
  });

  elements.voiceSelect.addEventListener("change", saveSettings);
  elements.llmEnabledInput.addEventListener("change", saveSettings);
  elements.ollamaModelInput.addEventListener("change", saveSettings);
  elements.ollamaEndpointInput.addEventListener("change", saveSettings);
  elements.rateInput.addEventListener("input", saveSettings);
  elements.pitchInput.addEventListener("input", saveSettings);
  elements.volumeInput.addEventListener("input", saveSettings);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "readerState") {
      renderState(message.state || { status: "idle" });
    }
  });
}

init().catch((error) => {
  renderState({
    status: "error",
    lastError: error.message || "Unable to initialize the extension popup."
  });
});
