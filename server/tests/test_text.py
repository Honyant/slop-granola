import pytest

from granola_asr.text import clean_text, sentence_case


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("  Hello,\n  world. ", "Hello, world."), ("...", ""), (" ", ""), ("- ?", ""), ("42", "42")],
)
def test_clean_text(raw: str, expected: str) -> None:
    assert clean_text(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("well this is the icon by the way", "Well this is the icon by the way."),
        ("Is it?", "Is it?"),
        ("'cause I'm only gonna do this", "'cause I'm only gonna do this."),
        ("", ""),
    ],
)
def test_sentence_case(raw: str, expected: str) -> None:
    assert sentence_case(raw) == expected
