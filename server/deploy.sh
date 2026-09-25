#!/usr/bin/env bash
# Build and (re)start the transcription service on the GPU host. Idempotent: safe to rerun.
#
#   GRANOLA_DEPLOY_HOST=gpu-box ./deploy.sh   # sync, build, restart, wait for /healthz, refresh .env.local
#
# Settings can also live in server/deploy.env (gitignored):
#   GRANOLA_DEPLOY_HOST  ssh host to deploy to (required)
#   GRANOLA_BIND_IP      address to listen on; defaults to the host's Tailscale IPv4, so the
#                        service is reachable over the tailnet and nowhere else
#   GRANOLA_PORT         defaults to 8765
#
# The bearer token is generated once on the host (~/.config/granola-asr/env, mode 600) and
# reused on every later deploy; .env.local on this machine is rewritten from it.
set -euo pipefail

cd "$(dirname "$0")"
# shellcheck source=/dev/null
[[ -f deploy.env ]] && source deploy.env

HOST="${GRANOLA_DEPLOY_HOST:?set GRANOLA_DEPLOY_HOST to the ssh name of the GPU host (or put it in server/deploy.env)}"
BIND_IP="${GRANOLA_BIND_IP:-$(ssh "$HOST" tailscale ip -4 | head -n1)}"
[[ -n "$BIND_IP" ]] || { echo "could not determine a bind address; set GRANOLA_BIND_IP" >&2; exit 1; }
PORT="${GRANOLA_PORT:-8765}"
REMOTE_DIR="granola-asr"
NAME="granola-asr"

rsync -a --delete \
    --exclude .venv --exclude .venv-local --exclude .env.local --exclude deploy.env --exclude __pycache__ --exclude .pytest_cache --exclude "*.egg-info" \
    ./ "$HOST:$REMOTE_DIR/"

ssh "$HOST" BIND_IP="$BIND_IP" PORT="$PORT" REMOTE_DIR="$REMOTE_DIR" NAME="$NAME" bash -s <<'REMOTE'
set -euo pipefail
conf_dir="$HOME/.config/granola-asr"
env_file="$conf_dir/env"
mkdir -p "$conf_dir" "$HOME/.cache/huggingface" "$HOME/.cache/granola-asr-compile"
chmod 700 "$conf_dir"
if [[ ! -f "$env_file" ]]; then
    (umask 077 && printf 'GRANOLA_ASR_TOKEN=%s\n' "$(openssl rand -hex 32)" > "$env_file")
fi
# Host/port live in the env file too so a manual `docker run --env-file` matches deploys.
grep -v -E '^GRANOLA_ASR_(HOST|PORT)=' "$env_file" > "$env_file.tmp" || true
printf 'GRANOLA_ASR_HOST=%s\nGRANOLA_ASR_PORT=%s\n' "$BIND_IP" "$PORT" >> "$env_file.tmp"
chmod 600 "$env_file.tmp" && mv "$env_file.tmp" "$env_file"

running_here=$(docker ps -q --filter "name=^${NAME}$")
if [[ -z "$running_here" ]] && ss -ltn | awk '{print $4}' | grep -qE "(^|:)${PORT}$"; then
    echo "port $PORT is taken by something other than $NAME; refusing to deploy" >&2
    exit 1
fi

docker build -q -t "$NAME:latest" "$HOME/$REMOTE_DIR" >/dev/null

# Once both models are cached, start offline: after a reboot the network (DNS, tailscale) may
# not be up yet, and online mode would stall startup in Hugging Face retry loops for minutes.
# The first deploy on a fresh host runs online and downloads them (keep in sync with config.py).
hf_offline=1
for repo in models--nvidia--parakeet-tdt-0.6b-v3 models--ibm-granite--granite-speech-4.1-2b; do
    [[ -d "$HOME/.cache/huggingface/hub/$repo/snapshots" ]] || hf_offline=0
done
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
    --restart unless-stopped \
    --network host \
    --device nvidia.com/gpu=all \
    --user "$(id -u):$(id -g)" \
    --env-file "$env_file" \
    -e HF_HUB_OFFLINE="$hf_offline" \
    -v "$HOME/.cache/huggingface:/hf" \
    -v "$HOME/.cache/granola-asr-compile:/compile-cache" \
    "$NAME:latest" >/dev/null

echo "waiting for http://$BIND_IP:$PORT/healthz (model load + warm-up) ..."
for _ in $(seq 1 180); do
    if curl -fsS "http://$BIND_IP:$PORT/healthz" 2>/dev/null; then echo; exit 0; fi
    if [[ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]]; then break; fi
    sleep 2
done
echo "service did not become healthy; last log lines:" >&2
docker logs --tail 50 "$NAME" >&2
exit 1
REMOTE

token=$(ssh "$HOST" "sed -n 's/^GRANOLA_ASR_TOKEN=//p' ~/.config/granola-asr/env")
# Ollama loads gpt-oss (tagged gpt-oss:latest on this host) with an 8k context, and its
# OpenAI-compatible API cannot raise num_ctx per request, so a long transcript would be
# silently truncated. ollama/granola-gpt-oss.Modelfile is an additive alias with the model's
# full 128k context; it shares the same weights and `ollama create` is idempotent. Measured
# with the ASR service loaded: 23.6 GB of 32 GB VRAM total, 100% on GPU (README, "LLM").
ssh "$HOST" "ollama create granola-gpt-oss -f $REMOTE_DIR/ollama/granola-gpt-oss.Modelfile >/dev/null"
llm_model="${GRANOLA_LLM_MODEL:-granola-gpt-oss}"
(
    umask 077
    cat > .env.local <<EOF
GRANOLA_ASR_URL=ws://$BIND_IP:$PORT/v1/listen
GRANOLA_ASR_TOKEN=$token
GRANOLA_LLM_BASE_URL=http://$BIND_IP:$PORT/v1
GRANOLA_LLM_MODEL=$llm_model
EOF
)
echo "deployed; client settings written to $(pwd)/.env.local"
