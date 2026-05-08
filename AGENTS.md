# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Loading and Reloading

No build step. Plain JavaScript, no npm, no bundler.

To load: open `brave://extensions`, enable Developer mode, click **Load unpacked**, select `C:\projects\extensions\webpage-reader`.

To reload after edits: click the reload icon on the extension card at `brave://extensions`. For content/overlay script changes you also need to refresh the target page.

## Architecture

### Process boundaries

The extension runs across four isolated JavaScript contexts that communicate only via `chrome.runtime.sendMessage`:

| File | Context | Role |
|------|---------|------|
| `background.js` | Service worker | Orchestrates everything: holds `readerState`, runs content extraction, calls Ollama, routes messages |
| `content.js` | Content script (every page) | Tracks text selection and reports changes to background |
| `overlay.js` | Content script (every page) | Renders the floating "Read" button and control panel in-page |
| `offscreen.js` | Offscreen document | Owns `speechSynthesis`; the only context where audio playback is allowed in MV3 |
| `popup.js` / `popup.html` | Extension popup | Second UI surface; mirrors the overlay's controls |

### Message flow for "Read page"

1. User clicks **Read page** (overlay or popup) -> sends `readCurrentTabFromOverlay` / `readCurrentTab` to background
2. Background injects `extractPageCandidates` into the tab via `chrome.scripting.executeScript`
3. `extractPageCandidates` scores DOM candidates (heuristic: text length, paragraph count, link density, semantic tag/class bonuses) and returns top 10 with snippets
4. Background optionally POSTs candidates to Ollama (`/api/generate`) asking it to pick the best block(s) via JSON output
5. If Ollama fails or is disabled, falls back to the top heuristic candidate
6. Resolved text -> sanitized -> sent to offscreen doc as `{ type: "speak", payload }` 
7. Offscreen splits text into <=1400 char chunks (paragraph -> sentence -> word boundary), chooses best voice via `scoreVoice`, and drives `speechSynthesis` chunk-by-chunk
8. Each chunk's `onstart`/`onend`/`onerror` callbacks send `speechStatus` back to background, which updates `readerState` and re-broadcasts to popup/overlay

### State

- `readerState` - held in `chrome.storage.session` (clears on browser close). Fields: `status`, `activeTabId`, `progress`, `chunkCount`, `detectionMode`, `readingMode`, `lastError`.
- Settings - held in `chrome.storage.sync` (persists across sessions). Defaults defined in `background.js:DEFAULT_SETTINGS`: rate, pitch, volume, voiceName, llmEnabled, ollamaEndpoint, ollamaModel.
- `selectionCache` - `Map<tabId, payload>` in background service worker memory. Evicted on tab close or navigation.

### Selection caching

Because the popup takes focus and clears `window.getSelection`, selection is captured eagerly:
- `content.js` debounces `selectionchange`/`mouseup`/`keyup` (80 ms) and pushes `selectionChanged` messages to background, which stores them in `selectionCache`
- `overlay.js` duplicates this locally as `lastKnownSelection` because it lives in the same page context and can read selection directly before focus moves

### Two UIs

Overlay (`overlay.js`) and popup (`popup.js`/`popup.html`) are independent UI surfaces with equivalent controls. Both communicate with background via the same message types. The overlay uses `readCurrentTabFromOverlay` / `readSelectionFromOverlay` (so background uses `sender.tab.id`); the popup uses `readCurrentTab` / `readSelection` (tab id passed explicitly).

## Ollama integration

Endpoint: `http://127.0.0.1:11434/api/generate` (default). Model: `gemma3` (default).

The prompt sends up to 10 candidate blocks (each <=1400 chars) and asks for `{"selectedIndexes":[...],"reason":"..."}`. Response is parsed; invalid/empty selection falls back to heuristic top candidate. All Ollama calls happen in the background service worker (host permissions cover `127.0.0.1`).
