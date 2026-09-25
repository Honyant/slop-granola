"""Render eval/results/*.json (from eval_asr.py) as the Markdown table in the README."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main(results_dir: Path) -> None:
    rows = [json.loads(p.read_text()) for p in sorted(results_dir.glob("*.json"))]
    rows.sort(key=lambda r: r["wer_all"])
    print(
        "| model | WER AMI | WER E22 | WER all | formatted WER AMI / E22 | latency 3 s / 6 s / 12 s / 25 s (ms) "
        "| RTFx | peak VRAM (GiB) | cased / punct. | on 3 s silence | on 3 s noise |"
    )
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    for r in rows:
        lat = r["latency_ms_by_seconds"]
        print(
            f"| {r['model']} | {r['wer']['ami']:.2f} | {r['wer']['earnings22']:.2f} | {r['wer_all']:.2f} "
            f"| {r['formatted_wer']['ami']:.1f} / {r['formatted_wer']['earnings22']:.1f} "
            f"| {lat['3s']:.0f} / {lat['6s']:.0f} / {lat['12s']:.0f} / {lat['25s']:.0f} | {r['rtfx']:.0f} "
            f"| {r['peak_vram_gib']:.1f} | {100 * r['frac_hyps_with_uppercase']:.0f}% / "
            f"{100 * r['frac_hyps_with_punctuation']:.0f}% | {r['silence_output']!r} | {r['noise_output']!r} |"
        )


if __name__ == "__main__":
    main(Path(sys.argv[1]))
