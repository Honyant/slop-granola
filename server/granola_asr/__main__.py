"""Entry point: `python -m granola_asr`. Loads models (tens of seconds), then serves."""

from __future__ import annotations

import logging

import uvicorn

from .app import create_app
from .config import Settings
from .engine import InferenceEngine
from .llm_proxy import LlmProxy
from .recognizers import WithFallback, load_recognizer
from .vad import SileroVad


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = Settings.from_env()
    interim = load_recognizer(settings.interim_model, settings.device)
    # One model can serve both roles (the Mac setup does); load it once.
    final = (
        interim
        if settings.final_model == settings.interim_model
        else WithFallback(load_recognizer(settings.final_model, settings.device), fallback=interim)
    )
    engine = InferenceEngine(interim=interim, final=final)
    app = create_app(
        token=settings.token,
        engine=engine,
        new_detector=SileroVad().detector,
        llm_proxy=LlmProxy(settings.llm_upstream),
        device=settings.device,
        max_sessions=settings.max_sessions,
    )
    # wsproto: uvicorn's websockets-sansio backend logs a spurious ERROR for every 401 denial response.
    uvicorn.run(app, host=settings.host, port=settings.port, ws="wsproto", log_level="info")


if __name__ == "__main__":
    main()
