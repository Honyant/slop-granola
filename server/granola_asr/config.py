"""Service settings, read once from the environment (see deploy.sh for the production values)."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    token: str
    host: str
    port: int
    interim_model: str
    final_model: str
    llm_upstream: str
    max_sessions: int
    device: str

    @staticmethod
    def from_env() -> Settings:
        token = os.environ.get("GRANOLA_ASR_TOKEN", "")
        if len(token) < 16:
            raise SystemExit("GRANOLA_ASR_TOKEN must be set (>= 16 characters)")
        return Settings(
            token=token,
            host=os.environ.get("GRANOLA_ASR_HOST", "127.0.0.1"),
            port=int(os.environ.get("GRANOLA_ASR_PORT", "8765")),
            interim_model=os.environ.get("GRANOLA_ASR_INTERIM_MODEL", "nvidia/parakeet-tdt-0.6b-v3"),
            final_model=os.environ.get("GRANOLA_ASR_FINAL_MODEL", "ibm-granite/granite-speech-4.1-2b"),
            llm_upstream=os.environ.get("GRANOLA_LLM_UPSTREAM", "http://127.0.0.1:11434/v1").rstrip("/"),
            max_sessions=int(os.environ.get("GRANOLA_ASR_MAX_SESSIONS", "8")),
            device=os.environ.get("GRANOLA_ASR_DEVICE", "cuda:0"),
        )
