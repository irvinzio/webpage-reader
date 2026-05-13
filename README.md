# 📖 Page Reader for Brave

A lightweight, **Manifest V3** browser extension that lets you read web pages aloud with optional local LLM‑powered content detection.

### Features

- Detects the main readable content on the current page
- Reads only the highlighted text when desired
- Optional local LLM (Ollama) for intelligent content block selection
- Plays the content aloud using the best available system voice
- Provides pause, resume, stop, and voice‑tuning controls (speed, pitch, volume)

## 🚀 Installation

1. Open `brave://extensions` in your browser
2. Enable **Developer mode** (toggle in the top‑right corner)
3. Click **Load unpacked**
4. Select the extension folder:

```
C:\projects\extensions\webpage-reader
```

## Optional local LLM setup

If you want stronger main-content detection, run a local Ollama model and leave the **Use local Ollama to detect the main content** option enabled in the popup.

Example:

1. Install Ollama
2. Pull a model such as `gemma3`
3. Make sure Ollama is running locally on `http://127.0.0.1:11434`

## ⚙️ Configuration

> **Note:** All `host_permissions` have been removed from `manifest.json` to streamline Chrome Web Store review. The extension still works for any HTTP/HTTPS page via `content_scripts.matches`. When Ollama is unreachable (no network permission), the extension gracefully falls back to the built‑in heuristic parser.


## Use it

1. Open an article, blog post, or documentation page
2. Click the extension icon
3. Press **Read page** to read the main content
4. Or highlight text on the page and press **Read selection**
5. Optionally choose a specific voice, turn local LLM detection on or off, or change speed, pitch, and volume

## Notes

- Brave uses Chromium extension APIs, so this extension is built as a Chromium/Manifest V3 extension.
- Selected text is cached by a content script so it still works after the popup takes focus.
- LLM detection uses Ollama's local API when enabled and falls back to the built‑in parser if Ollama is unavailable.
- Voice quality depends on the voices installed on your operating system and exposed by the browser speech engine.
- The content extractor is heuristic‑based, so it works best on article‑style pages with clear main content areas.

## ☕ Support the Project

If you find Page Reader useful, consider buying me a coffee!

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/irvinzio)

## 🤝 Contributing

Contributions are welcome! Feel free to open issues or submit pull requests to improve features, fix bugs, or enhance documentation.

- Fork the repository
- Create a feature branch (`git checkout -b feature/your-feature`)
- Commit your changes with clear messages
- Open a pull request against the `main` branch

Please ensure your changes respect the project’s coding style and pass existing tests.

## 📄 License

This project is licensed under the MIT License.



If you find Page Reader useful, consider buying me a coffee!

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/irvinzio)
