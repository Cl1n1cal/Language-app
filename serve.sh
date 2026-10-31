#!/usr/bin/env bash
# Start the app (Linux, macOS, WSL). On Windows use serve.cmd.
#
#   ./serve.sh              port 8000, opens Edge
#   ./serve.sh 8080         another port
#   ./serve.sh --no-open    just serve
set -euo pipefail
cd "$(dirname "$0")"

# First run: create the Python environment with the Anthropic SDK.
if [ ! -x .venv/bin/python ]; then
  echo "Setting up Python environment (first run only)..."
  python3 -m venv .venv
  .venv/bin/pip install -q --upgrade pip anthropic
fi

exec .venv/bin/python server.py "$@"
