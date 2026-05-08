let playback = {
  chunks: [],
  currentIndex: 0,
  settings: null,
  voice: null,
  lang: "en-US",
  title: "",
  sourceUrl: "",
  isStopping: false,
  version: 0
};

function splitIntoChunks(text, maxChunkLength = 1400) {
  const paragraphs = (text || "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (!paragraphs.length) {
    return [];
  }

  const chunks = [];
  let buffer = "";

  function pushBuffer() {
    if (buffer.trim()) {
      chunks.push(buffer.trim());
      buffer = "";
    }
  }

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChunkLength) {
      if ((buffer + "\n\n" + paragraph).trim().length > maxChunkLength) {
        pushBuffer();
      }

      buffer = buffer ? buffer + "\n\n" + paragraph : paragraph;
      continue;
    }

    const sentences = paragraph.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      if (!sentence) {
        continue;
      }

      if (sentence.length > maxChunkLength) {
        const words = sentence.split(/\s+/);
        let sentenceBuffer = "";

        for (const word of words) {
          const next = sentenceBuffer ? sentenceBuffer + " " + word : word;
          if (next.length > maxChunkLength) {
            if (sentenceBuffer) {
              if ((buffer + " " + sentenceBuffer).trim().length > maxChunkLength) {
                pushBuffer();
              }

              buffer = buffer ? buffer + " " + sentenceBuffer : sentenceBuffer;
              sentenceBuffer = "";
            }
          }

          sentenceBuffer = sentenceBuffer ? sentenceBuffer + " " + word : word;
        }

        if (sentenceBuffer) {
          if ((buffer + " " + sentenceBuffer).trim().length > maxChunkLength) {
            pushBuffer();
          }

          buffer = buffer ? buffer + " " + sentenceBuffer : sentenceBuffer;
        }

        continue;
      }

      const nextSentence = buffer ? buffer + " " + sentence : sentence;
      if (nextSentence.length > maxChunkLength) {
        pushBuffer();
      }

      buffer = buffer ? buffer + " " + sentence : sentence;
    }

    pushBuffer();
  }

  pushBuffer();
  return chunks;
}

function scoreVoice(voice, preferredLang) {
  const name = (voice.name || "").toLowerCase();
  const lang = (voice.lang || "").toLowerCase();
  const languageBoost = lang.startsWith(preferredLang.toLowerCase()) ? 500 : 0;
  const localeBoost =
    preferredLang.includes("-") && lang === preferredLang.toLowerCase() ? 250 : 0;
  const naturalBoost = /(natural|neural|enhanced|premium|microsoft|google)/.test(name)
    ? 180
    : 0;
  const localBoost = voice.localService ? 40 : 0;
  const defaultBoost = voice.default ? 20 : 0;

  return languageBoost + localeBoost + naturalBoost + localBoost + defaultBoost;
}

async function getVoices() {
  const immediate = speechSynthesis.getVoices();
  if (immediate.length) {
    return immediate;
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(speechSynthesis.getVoices()), 1200);

    speechSynthesis.onvoiceschanged = () => {
      clearTimeout(timeout);
      resolve(speechSynthesis.getVoices());
    };
  });
}

async function chooseVoice(settings, lang) {
  const voices = await getVoices();
  if (!voices.length) {
    return null;
  }

  if (settings?.voiceName) {
    const exactMatch = voices.find((voice) => voice.name === settings.voiceName);
    if (exactMatch) {
      return exactMatch;
    }
  }

  const preferredLang = (lang || "en-US").trim();
  const sameLanguage = voices
    .filter((voice) => (voice.lang || "").toLowerCase().startsWith(preferredLang.toLowerCase().slice(0, 2)))
    .sort((a, b) => scoreVoice(b, preferredLang) - scoreVoice(a, preferredLang));

  if (sameLanguage.length) {
    return sameLanguage[0];
  }

  return voices.sort((a, b) => scoreVoice(b, preferredLang) - scoreVoice(a, preferredLang))[0];
}

function sendStatus(state) {
  chrome.runtime.sendMessage({
    source: "offscreen",
    type: "speechStatus",
    state
  }).catch(() => {
    // The service worker may be sleeping briefly; the next message will update it.
  });
}

function stopPlayback(resetToIdle = true) {
  playback.isStopping = true;
  speechSynthesis.cancel();
  playback = {
    chunks: [],
    currentIndex: 0,
    settings: null,
    voice: null,
    lang: "en-US",
    title: "",
    sourceUrl: "",
    isStopping: false,
    version: playback.version + 1
  };

  if (resetToIdle) {
    sendStatus({
      status: "idle",
      progress: 0,
      chunkCount: 0,
      lastError: ""
    });
  }
}

function speakCurrentChunk() {
  const chunk = playback.chunks[playback.currentIndex];
  if (!chunk) {
    const finishedChunkCount = playback.chunks.length;
    stopPlayback(false);
    sendStatus({
      status: "idle",
      progress: 100,
      chunkCount: finishedChunkCount,
      lastError: ""
    });
    return;
  }

  const utterance = new SpeechSynthesisUtterance(chunk);
  const utteranceVersion = playback.version;
  utterance.lang = playback.voice?.lang || playback.lang || "en-US";
  utterance.rate = Number(playback.settings?.rate || 1);
  utterance.pitch = Number(playback.settings?.pitch || 1);
  utterance.volume = Number(playback.settings?.volume || 1);

  if (playback.voice) {
    utterance.voice = playback.voice;
  }

  utterance.onstart = () => {
    if (utteranceVersion !== playback.version) {
      return;
    }

    sendStatus({
      status: "speaking",
      progress: Math.round((playback.currentIndex / playback.chunks.length) * 100),
      chunkCount: playback.chunks.length,
      lastError: ""
    });
  };

  utterance.onend = () => {
    if (playback.isStopping || utteranceVersion !== playback.version) {
      return;
    }

    playback.currentIndex += 1;
    if (playback.currentIndex >= playback.chunks.length) {
      const finishedChunkCount = playback.chunks.length;
      stopPlayback(false);
      sendStatus({
        status: "idle",
        progress: 100,
        chunkCount: finishedChunkCount,
        lastError: ""
      });
      return;
    }

    speakCurrentChunk();
  };

  utterance.onerror = (event) => {
    if (utteranceVersion !== playback.version) {
      return;
    }

    const failedChunkCount = playback.chunks.length;
    stopPlayback(false);
    sendStatus({
      status: "error",
      progress: 0,
      chunkCount: failedChunkCount,
      lastError: event.error || "Speech synthesis failed."
    });
  };

  speechSynthesis.speak(utterance);
}

async function startPlayback(payload) {
  stopPlayback(false);

  const chunks = splitIntoChunks(payload.text);
  if (!chunks.length) {
    sendStatus({
      status: "error",
      progress: 0,
      chunkCount: 0,
      lastError: "There was no readable text to speak."
    });
    return;
  }

  const voice = await chooseVoice(payload.settings, payload.lang);

  playback = {
    chunks,
    currentIndex: 0,
    settings: payload.settings || {},
    voice,
    lang: payload.lang || "en-US",
    title: payload.title || "",
    sourceUrl: payload.url || "",
    isStopping: false,
    version: playback.version + 1
  };

  speakCurrentChunk();
}

async function updatePlaybackSettings(settings) {
  playback.settings = {
    ...(playback.settings || {}),
    ...(settings || {})
  };
  playback.voice = await chooseVoice(playback.settings, playback.lang);

  if (!playback.chunks.length) {
    return;
  }

  const wasPaused = speechSynthesis.paused;
  const wasSpeaking = speechSynthesis.speaking || wasPaused;

  if (!wasSpeaking) {
    return;
  }

  playback.version += 1;
  speechSynthesis.cancel();
  speakCurrentChunk();

  if (wasPaused) {
    setTimeout(() => {
      speechSynthesis.pause();
      sendStatus({
        status: "paused",
        progress: Math.round((playback.currentIndex / Math.max(playback.chunks.length, 1)) * 100),
        chunkCount: playback.chunks.length,
        lastError: ""
      });
    }, 0);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  (async () => {
    if (message.type === "speak") {
      await startPlayback(message.payload || {});
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "pause") {
      speechSynthesis.pause();
      sendStatus({
        status: "paused",
        progress: Math.round((playback.currentIndex / Math.max(playback.chunks.length, 1)) * 100),
        chunkCount: playback.chunks.length,
        lastError: ""
      });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "resume") {
      speechSynthesis.resume();
      sendStatus({
        status: "speaking",
        progress: Math.round((playback.currentIndex / Math.max(playback.chunks.length, 1)) * 100),
        chunkCount: playback.chunks.length,
        lastError: ""
      });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "stop") {
      stopPlayback(true);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "settingsChanged") {
      await updatePlaybackSettings(message.settings || {});
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "Unknown offscreen command." });
  })();

  return true;
});
