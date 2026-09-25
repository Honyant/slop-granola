#!/usr/bin/env bash
# Runs the transcription server on this Mac (Apple Silicon, MLX), for use without a GPU box.
#
#   server/scripts/run-local.sh            # first run installs into server/.venv-local (~2 GB with the model)
#
# Prints the URL and token to paste into the app (Settings → Connectors → Self-hosted server).
# For AI notes and chat locally, install Ollama and pick "Ollama on this Mac" in the app.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ "$(uname -sm)" == "Darwin arm64" ]] || { echo "run-local.sh needs an Apple Silicon Mac" >&2; exit 1; }
command -v uv >/dev/null || { echo "install uv first: https://docs.astral.sh/uv/" >&2; exit 1; }

VENV=.venv-local
if [[ ! -x "$VENV/bin/python" ]]; then
  uv venv -q -p 3.12 "$VENV"
  uv pip install -q -p "$VENV/bin/python" -e ".[mac]"
  uv pip install -q -p "$VENV/bin/python" --no-deps "silero-vad>=6.2"
fi

TOKEN_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/granola-asr/local-token"
if [[ ! -s "$TOKEN_FILE" ]]; then
  mkdir -p "$(dirname "$TOKEN_FILE")"
  (umask 077 && openssl rand -hex 24 > "$TOKEN_FILE")
fi

export GRANOLA_ASR_TOKEN="$(cat "$TOKEN_FILE")"
export GRANOLA_ASR_HOST="${GRANOLA_ASR_HOST:-127.0.0.1}"
export GRANOLA_ASR_PORT="${GRANOLA_ASR_PORT:-8765}"
export GRANOLA_ASR_INTERIM_MODEL=mlx-community/parakeet-tdt-0.6b-v3
export GRANOLA_ASR_FINAL_MODEL=mlx-community/parakeet-tdt-0.6b-v3
export GRANOLA_ASR_DEVICE=mlx
export GRANOLA_LLM_UPSTREAM="${GRANOLA_LLM_UPSTREAM:-http://127.0.0.1:11434/v1}"

cat <<INFO
Transcription server for the app (Settings → Connectors → Self-hosted server):
  URL:   ws://$GRANOLA_ASR_HOST:$GRANOLA_ASR_PORT/v1/listen
  Token: $GRANOLA_ASR_TOKEN
INFO
exec "$VENV/bin/python" -m granola_asr
