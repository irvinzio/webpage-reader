# Page Reader for Brave

This is a Manifest V3 browser extension that:

- detects the main readable content on the current page
- can also read only the text you have highlighted
- can use a local open-source model through Ollama to choose the main content block
- reads that content aloud with the best available system voice
- lets you pause, resume, stop, and tune voice settings

## Load it in Brave

1. Open `brave://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder: `C:\projects\extensions`

## Optional local LLM setup

If you want stronger main-content detection, run a local Ollama model and leave the **Use local Ollama to detect the main content** option enabled in the popup.

Example:

1. Install Ollama
2. Pull a model such as `gemma3`
3. Make sure Ollama is running locally on `http://127.0.0.1:11434`

## Use it

1. Open an article, blog post, or documentation page
2. Click the extension icon
3. Press **Read page** to read the main content
4. Or highlight text on the page and press **Read selection**
5. Optionally choose a specific voice, turn local LLM detection on or off, or change speed, pitch, and volume

## Notes

- Brave uses Chromium extension APIs, so this extension is built as a Chromium/Manifest V3 extension.
- Selected text is cached by a content script so it still works after the popup takes focus.
- LLM detection uses Ollama's local API when enabled and falls back to the built-in parser if Ollama is unavailable.
- Voice quality depends on the voices installed on your operating system and exposed by the browser speech engine.
- The content extractor is heuristic-based, so it works best on article-style pages with clear main content areas.
