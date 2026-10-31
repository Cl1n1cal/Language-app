# Language-app

A speaking-practice app for French, German and Finnish. It reads phrases out loud and highlights each word as it's spoken. It listens to your pronunciation, runs scripted dialogues, and lets you hold a free conversation with Claude that corrects your mistakes as you go.

## Run

You need Python 3.10+ and Microsoft Edge (or Chrome).

**Windows:** double-click `serve.cmd`, or run it from a terminal.

**Linux / macOS / WSL:**

```bash
./serve.sh
```

The first run creates a local Python environment (`.venv`) and installs the Anthropic SDK. After that, the script starts the server and opens <http://localhost:8000> in Edge. Edge has natural-sounding online voices for all three languages.

- `serve.cmd 8080` / `./serve.sh 8080` uses another port.
- `--no-open` only starts the server.

### Conversation mode (optional)

Free conversation uses the Claude API, so it needs your own API key:

1. Copy `.env.example` to `.env`.
2. Put your key from <https://console.anthropic.com/settings/keys> in it.
3. Restart the server.

`.env` is git-ignored, and the key stays on the server side; it never reaches the browser. Phrases and dialogues work without a key.

By default the app uses `claude-opus-5-5` at low effort. You can change this with `LANG_APP_MODEL` and `LANG_APP_EFFORT` in `.env`.

## Features

- **Phrases** in categories: greetings, about me, café, family, hobbies, weather, getting around, useful phrases, and tricky sounds.
- **Dialogues:** scripted conversations such as meeting someone, at the café, and family. You get hints and model answers.
- **Conversation:** chat freely with Claude in the language you're learning. Each reply is spoken aloud with an English translation, and your mistakes are corrected with a short explanation.
- **🎤 Speaking / ⌨️ Writing:** answer by voice or by typing. Writing mode tells you when only the accents are off.
- **Push-to-talk:** hold the 🎤 button (or Space) while you speak, and release when you're done.
- **Word highlighting:** each word lights up while it is spoken.
- Light and dark theme follow the browser setting.

## How it works

- `index.html`, `app.js` and `style.css` make up the page. Speech output and recognition use the browser's Web Speech API.
- `data.js` holds all phrases and dialogues. To add content, edit it: phrases are `{ t, en, note? }`, and dialogue steps are `{ say, en, answers }` (the first answer is the model answer, and `…` means "anything goes from here").
- `server.py` is a small standard-library HTTP server. It serves only the app's own files and has one endpoint, `/api/chat`. That endpoint calls Claude with structured output: `reply`, `translation` and `corrections`.

## Notes

- Speech recognition sends audio to the browser vendor's service (Microsoft for Edge, Google for Chrome). It doesn't work in Firefox or in embedded browsers; use ⌨️ Writing there.
- In Chrome, Finnish speech output needs a Windows voice: Settings → Time & language → Speech → Add voices.
