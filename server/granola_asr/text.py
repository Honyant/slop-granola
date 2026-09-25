"""Post-processing of recognizer output. Pure functions; no model dependencies."""

from __future__ import annotations


def clean_text(text: str) -> str:
    """Normalise whitespace; text without a single letter or digit (e.g. "." or "...") counts as empty."""
    text = " ".join(text.split())
    return text if any(c.isalnum() for c in text) else ""


def sentence_case(text: str) -> str:
    """Capitalise the first letter and end with terminal punctuation if there is none.

    VAD utterances are sentence-like, so this is the right default when a model returns an
    unpunctuated span; README "Model choice" has the measured effect.
    """
    text = text.strip()
    if not text:
        return text
    text = text[0].upper() + text[1:]
    return text if text[-1] in ".?!…" else text + "."
