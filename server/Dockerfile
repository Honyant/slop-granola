# CUDA comes from the torch cu130 wheels (nvidia-* packages) and the driver is injected by
# the NVIDIA CDI device, so a plain Python base image is enough.
FROM python:3.12-slim

# gcc: Triton builds a small C launcher the first time torch.compile runs (static-cache decoding).
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.12.18 /uv /usr/local/bin/uv

WORKDIR /app
COPY requirements.lock .
RUN uv pip install --system --no-cache --torch-backend cu130 -r requirements.lock

COPY granola_asr ./granola_asr

ENV PYTHONUNBUFFERED=1 \
    HF_HOME=/hf \
    TORCHINDUCTOR_CACHE_DIR=/compile-cache/inductor \
    TRITON_CACHE_DIR=/compile-cache/triton \
    HOME=/tmp
CMD ["python", "-m", "granola_asr"]
