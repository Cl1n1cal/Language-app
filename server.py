"""Local server for the language app.

Serves the static page and a small /api/chat endpoint that lets the
learner chat freely with Claude in French, German or Finnish.

The API key is read from the environment (serve.sh loads it from .env);
it never reaches the browser.
"""

import argparse
import json
import os
import platform
import subprocess
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import anthropic

ROOT = Path(__file__).resolve().parent


def load_dotenv(path):
    """Minimal .env reader: KEY=VALUE lines; real environment variables win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        if value:
            os.environ.setdefault(key.strip(), value)


load_dotenv(ROOT / ".env")
STATIC_FILES = {"/index.html", "/app.js", "/data.js", "/style.css"}

MODEL = os.environ.get("LANG_APP_MODEL", "claude-opus-5-5")
EFFORT = os.environ.get("LANG_APP_EFFORT", "low")
MAX_HISTORY = 40          # messages sent to Claude per request
MAX_BODY = 200_000        # bytes

LANGUAGES = {
    "fr": {
        "name": "French",
        "level": "a beginner: use simple, common words and mostly the present tense",
        "feedback": "English",
    },
    "de": {
        "name": "German",
        "level": "conversational (around A2/B1): natural everyday German, not too fast",
        "feedback": "German",
    },
    "fi": {
        "name": "Finnish",
        "level": "an absolute beginner: very short, simple sentences",
        "feedback": "English",
    },
}

SYSTEM_TEMPLATE = """\
You are a friendly conversation partner helping a learner practise {name}. \
The learner's level is {level}.

Chat naturally, like a friend would. Keep your replies short (one to three \
sentences) and usually end with a question that keeps the conversation going. \
If the learner asks for help or writes in another language, help briefly, but \
stay mostly in {name}.

Your reply is read aloud by text-to-speech, so write plain {name} text: no \
markdown, no emoji, no translations in brackets.

Also review the learner's latest message. For each real mistake (grammar, \
spelling, word choice, word order), give the wrong fragment, the corrected \
fragment and a one-sentence explanation of the rule, written in {feedback}. \
Messages that start with 🎤 came from speech recognition: never correct their \
capitalisation, punctuation or spelling of names. If there are no mistakes, \
return an empty list.

Give an English translation of your reply as well."""

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {"type": "string"},
        "translation": {"type": "string"},
        "corrections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "original": {"type": "string"},
                    "corrected": {"type": "string"},
                    "explanation": {"type": "string"},
                },
                "required": ["original", "corrected", "explanation"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["reply", "translation", "corrections"],
    "additionalProperties": False,
}


def has_credentials():
    return bool(
        os.environ.get("ANTHROPIC_API_KEY")
        or os.environ.get("ANTHROPIC_AUTH_TOKEN")
        or (Path.home() / ".config" / "anthropic").exists()
    )


client = anthropic.Anthropic() if has_credentials() else None


class ChatError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def clean_history(messages):
    """Validate the browser-supplied history and keep the recent part."""
    if not isinstance(messages, list) or not messages:
        raise ChatError(400, "No messages.")
    out = []
    for m in messages[-MAX_HISTORY:]:
        if (not isinstance(m, dict) or m.get("role") not in ("user", "assistant")
                or not isinstance(m.get("content"), str) or not m["content"].strip()):
            raise ChatError(400, "Malformed message.")
        out.append({"role": m["role"], "content": m["content"][:4000]})
    while out and out[0]["role"] != "user":
        out.pop(0)
    if not out or out[-1]["role"] != "user":
        raise ChatError(400, "The last message must come from the learner.")
    return out


def chat(lang, messages):
    if client is None:
        raise ChatError(503, "No API key configured. Put ANTHROPIC_API_KEY in .env and restart ./serve.sh.")
    if lang not in LANGUAGES:
        raise ChatError(400, "Unknown language.")

    try:
        response = client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=SYSTEM_TEMPLATE.format(**LANGUAGES[lang]),
            cache_control={"type": "ephemeral"},
            output_config={
                "effort": EFFORT,
                "format": {"type": "json_schema", "schema": RESPONSE_SCHEMA},
            },
            messages=clean_history(messages),
        )
    except anthropic.AuthenticationError:
        raise ChatError(401, "The API key was rejected. Check ANTHROPIC_API_KEY in .env.")
    except anthropic.PermissionDeniedError:
        raise ChatError(403, "This API key may not use the model.")
    except anthropic.RateLimitError:
        raise ChatError(429, "Rate limited. Wait a moment and try again.")
    except anthropic.BadRequestError as e:
        raise ChatError(400, f"Request rejected: {e.message}")
    except anthropic.APIStatusError as e:
        raise ChatError(502, f"Claude API error ({e.status_code}). Try again.")
    except anthropic.APIConnectionError:
        raise ChatError(502, "Could not reach the Claude API. Check your internet connection.")

    if response.stop_reason == "refusal":
        raise ChatError(422, "Claude declined to answer that. Try saying something else.")
    if response.stop_reason == "max_tokens":
        raise ChatError(502, "The reply was cut off. Try again.")

    raw = "".join(b.text for b in response.content if b.type == "text")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise ChatError(502, "Got an unreadable reply. Try again.")
    # The raw JSON goes back into the history so Claude sees its own turns.
    return {**data, "raw": raw}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def static_path(self):
        """The requested app file, or None. Never .env, .venv or the server source."""
        path = self.path.split("?", 1)[0]
        if path == "/":
            path = "/index.html"
        return path if path in STATIC_FILES else None

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/status":
            return self.send_json(200, {"chat": client is not None, "model": MODEL})
        path = self.static_path()
        if path is None:
            return self.send_error(404)
        self.path = path
        super().do_GET()

    def do_HEAD(self):
        path = self.static_path()
        if path is None:
            return self.send_error(404)
        self.path = path
        super().do_HEAD()

    def do_POST(self):
        if self.path != "/api/chat":
            return self.send_error(404)
        try:
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= MAX_BODY:
                raise ChatError(413, "Request too large.")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ChatError(400, "Bad request.")
            self.send_json(200, chat(body.get("lang"), body.get("messages")))
        except ChatError as e:
            self.send_json(e.status, {"error": e.message})
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "Bad request."})

    def send_json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def open_in_edge(url):
    """Open the app in Microsoft Edge (it has natural voices for all three
    languages); fall back to the default browser."""
    try:
        if sys.platform == "win32":
            subprocess.Popen(["cmd", "/c", "start", "", "msedge", url])
            return
        if "microsoft" in platform.uname().release.lower():   # WSL
            subprocess.Popen(
                ["powershell.exe", "-NoProfile", "-Command", f"Start-Process msedge '{url}'"],
                cwd="/mnt/c", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            return
    except OSError:
        pass
    webbrowser.open(url)


def main():
    parser = argparse.ArgumentParser(description="Serve the language practice app.")
    parser.add_argument("port", nargs="?", type=int, default=8000)
    parser.add_argument("--no-open", action="store_true", help="don't open a browser")
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://localhost:{args.port}"
    status = f"chat enabled ({MODEL}, effort {EFFORT})" if client else "chat disabled: no API key in .env"
    print(f"Serving {url}  [{status}]  Ctrl+C to stop", flush=True)
    if not args.no_open:
        threading.Timer(0.5, open_in_edge, [url]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
