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
#   GRANOLA_LLM_BACKEND  vllm (default) or ollama; the LLM the /v1 pass-through forwards to
#   GRANOLA_LLM_REPO     vLLM checkpoint (default: Qwen3.8-27B, NVFP4 build sized for a 32 GB RTX 5090)
#   GRANOLA_LLM_REASONING_EFFORT  xhigh (default), medium or low; added to requests that set none
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
LLM_BACKEND="${GRANOLA_LLM_BACKEND:-vllm}"
LLM_REPO="${GRANOLA_LLM_REPO:-gittensor-model-hub/Qwen3.8-27B-NVFP4-RTX5090}"
LLM_SERVED="${GRANOLA_LLM_SERVED_NAME:-qwen3.8-27b}"
LLM_EFFORT="${GRANOLA_LLM_REASONING_EFFORT:-xhigh}"
LLM_PORT=8001 # vLLM listens on loopback only; clients reach it through the authenticated pass-through
case "$LLM_BACKEND" in
    vllm) LLM_UPSTREAM="http://127.0.0.1:$LLM_PORT/v1" ;;
    ollama) LLM_UPSTREAM="http://127.0.0.1:11434/v1" LLM_EFFORT="" ;;
    *) echo "GRANOLA_LLM_BACKEND must be vllm or ollama" >&2; exit 1 ;;
esac

rsync -a --delete \
    --exclude .venv --exclude .venv-local --exclude .env.local --exclude deploy.env --exclude __pycache__ --exclude .pytest_cache --exclude "*.egg-info" \
    ./ "$HOST:$REMOTE_DIR/"

if [[ "$LLM_BACKEND" == vllm ]]; then
    ssh "$HOST" LLM_REPO="$LLM_REPO" LLM_SERVED="$LLM_SERVED" LLM_PORT="$LLM_PORT" bash -s <<'LLM'
set -euo pipefail
name=granola-llm
image=vllm/vllm-openai:v0.29.0
mkdir -p "$HOME/.cache/huggingface" "$HOME/.cache/granola-llm"
# Memory: the checkpoint is 17.9 GB; 0.72 of the 32.6 GB card leaves ~9 GB for the ASR models
# (6.7 GB measured) and the display server. FP8 KV costs ~32 KB/token here (16 of 64 layers
# are attention), so a 64k window is cheap; two sequences cover enhancement plus a chat.
args=(
    "$LLM_REPO" --served-model-name "$LLM_SERVED" --host 127.0.0.1 --port "$LLM_PORT"
    --quantization modelopt --kv-cache-dtype fp8
    --max-model-len 65536 --max-num-seqs 2 --gpu-memory-utilization 0.72
    --reasoning-parser qwen3 --limit-mm-per-prompt '{"image":0,"video":0}'
)
config=$(printf '%s\n' "$image" "${args[@]}" | sha256sum | cut -c1-16)
if [[ "$(docker inspect -f '{{index .Config.Labels "granola.config"}}' "$name" 2>/dev/null)" == "$config" ]] &&
    [[ "$(docker inspect -f '{{.State.Running}}' "$name")" == true ]]; then
    echo "$name is already running this configuration"
else
    hf_offline=0
    [[ -d "$HOME/.cache/huggingface/hub/models--${LLM_REPO//\//--}/snapshots" ]] && hf_offline=1
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" --label "granola.config=$config" \
        --restart unless-stopped --network host --ipc host --device nvidia.com/gpu=all \
        -e HF_HUB_OFFLINE="$hf_offline" -e MAX_JOBS=2 \
        -v "$HOME/.cache/huggingface:/root/.cache/huggingface" \
        -v "$HOME/.cache/granola-llm:/root/.cache/granola-llm" \
        -e VLLM_CACHE_ROOT=/root/.cache/granola-llm/vllm -e FLASHINFER_WORKSPACE_BASE=/root/.cache/granola-llm \
        "$image" "${args[@]}" >/dev/null
fi
echo "waiting for $name (first boot compiles FP4 kernels; several minutes) ..."
for _ in $(seq 1 450); do
    if curl -fsS "http://127.0.0.1:$LLM_PORT/health" >/dev/null 2>&1; then echo "$name ready"; exit 0; fi
    if [[ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]]; then break; fi
    sleep 2
done
echo "$name did not become healthy; last log lines:" >&2
docker logs --tail 60 "$name" >&2
exit 1
LLM
fi

ssh "$HOST" BIND_IP="$BIND_IP" PORT="$PORT" REMOTE_DIR="$REMOTE_DIR" NAME="$NAME" \
    LLM_UPSTREAM="$LLM_UPSTREAM" LLM_EFFORT="$LLM_EFFORT" bash -s <<'REMOTE'
set -euo pipefail
conf_dir="$HOME/.config/granola-asr"
env_file="$conf_dir/env"
mkdir -p "$conf_dir" "$HOME/.cache/huggingface" "$HOME/.cache/granola-asr-compile"
chmod 700 "$conf_dir"
if [[ ! -f "$env_file" ]]; then
    (umask 077 && printf 'GRANOLA_ASR_TOKEN=%s\n' "$(openssl rand -hex 32)" > "$env_file")
fi
# Host/port live in the env file too so a manual `docker run --env-file` matches deploys.
grep -v -E '^GRANOLA_(ASR_HOST|ASR_PORT|LLM_UPSTREAM|LLM_REASONING_EFFORT)=' "$env_file" > "$env_file.tmp" || true
printf 'GRANOLA_ASR_HOST=%s\nGRANOLA_ASR_PORT=%s\nGRANOLA_LLM_UPSTREAM=%s\n' "$BIND_IP" "$PORT" "$LLM_UPSTREAM" >> "$env_file.tmp"
[[ -n "$LLM_EFFORT" ]] && printf 'GRANOLA_LLM_REASONING_EFFORT=%s\n' "$LLM_EFFORT" >> "$env_file.tmp"
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
if [[ "$LLM_BACKEND" == ollama ]]; then
    ssh "$HOST" "ollama create granola-gpt-oss -f $REMOTE_DIR/ollama/granola-gpt-oss.Modelfile >/dev/null"
    llm_model="${GRANOLA_LLM_MODEL:-granola-gpt-oss}"
else
    llm_model="$LLM_SERVED"
fi
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
