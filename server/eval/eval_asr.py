"""Candidate-model evaluation: WER, latency, VRAM and silence hallucination.

Run one model per process so peak-VRAM numbers are not polluted by earlier models:

    python eval/eval_asr.py --model parakeet-tdt-0.6b-v3 --out eval/results
    python eval/summarize.py eval/results

Data: seeded random samples from the AMI IHM and Earnings-22 test sets as packaged
by the Open ASR Leaderboard (`hf-audio/open-asr-leaderboard`). WER uses the Whisper
English normaliser, as the leaderboard does.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import statistics
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path

import jiwer
import librosa
import numpy as np
import soundfile as sf
import torch
from datasets import Audio, load_dataset
from whisper_normalizer.english import EnglishTextNormalizer

SAMPLE_RATE = 16_000
DATASET = "hf-audio/open-asr-leaderboard"
LATENCY_PROBE_SECONDS = (1.0, 3.0, 6.0, 12.0, 25.0)
LATENCY_PROBE_REPEATS = 5

Transcribe = Callable[[np.ndarray], str]


@dataclass(frozen=True)
class Sample:
    corpus: str
    id: str
    audio: np.ndarray
    reference: str


def load_samples(corpus: str, n: int, seed: int) -> list[Sample]:
    ds = load_dataset(DATASET, corpus, split="test")
    # decode=False + soundfile avoids a torchcodec/ffmpeg dependency just for eval.
    ds = ds.cast_column("audio", Audio(decode=False)).shuffle(seed=seed).select(range(n))
    return [Sample(corpus, row["id"], _decode(row["audio"]["bytes"]), row["text"]) for row in ds]


def _decode(data: bytes) -> np.ndarray:
    audio, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)
    if sr != SAMPLE_RATE:
        mono = librosa.resample(mono, orig_sr=sr, target_sr=SAMPLE_RATE)
    return mono.astype(np.float32)


# --- model adapters: each returns a bs=1 transcribe function (the streaming case) ---


def _whisper(model_id: str, device: str) -> Transcribe:
    from transformers import AutoProcessor, WhisperForConditionalGeneration

    processor = AutoProcessor.from_pretrained(model_id)
    model = WhisperForConditionalGeneration.from_pretrained(model_id, dtype=torch.float16).to(device)

    def run(audio: np.ndarray) -> str:
        feats = processor(audio, sampling_rate=SAMPLE_RATE, return_tensors="pt").input_features
        ids = model.generate(
            feats.to(device, torch.float16), language="en", task="transcribe", cache_implementation="static"
        )
        return processor.batch_decode(ids, skip_special_tokens=True)[0].strip()

    return run


def _parakeet(model_id: str, device: str) -> Transcribe:
    from transformers import AutoModelForTDT, AutoProcessor

    processor = AutoProcessor.from_pretrained(model_id)
    model = AutoModelForTDT.from_pretrained(model_id, dtype=torch.bfloat16, device_map=device)

    def run(audio: np.ndarray) -> str:
        inputs = processor([audio], sampling_rate=SAMPLE_RATE)
        inputs.to(model.device, dtype=model.dtype)
        out = model.generate(**inputs, return_dict_in_generate=True)
        return processor.decode(out.sequences, skip_special_tokens=True)[0].strip()

    return run


def _granite_ar(model_id: str, device: str) -> Transcribe:
    from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor

    processor = AutoProcessor.from_pretrained(model_id)
    tokenizer = processor.tokenizer
    model = AutoModelForSpeechSeq2Seq.from_pretrained(model_id, dtype=torch.bfloat16, device_map=device)
    chat = [{"role": "user", "content": "<|audio|>transcribe the speech with proper punctuation and capitalization."}]
    prompt = tokenizer.apply_chat_template(chat, tokenize=False, add_generation_prompt=True)

    def run(audio: np.ndarray) -> str:
        inputs = processor(prompt, torch.from_numpy(audio)[None], device=device, return_tensors="pt").to(device)
        out = model.generate(**inputs, max_new_tokens=400, do_sample=False, num_beams=1, cache_implementation="static")
        new = out[0, inputs["input_ids"].shape[-1] :]
        return tokenizer.decode(new, skip_special_tokens=True).strip()

    return run


def _granite_ctc(model_id: str, device: str) -> Transcribe:
    from transformers import AutoModelForCTC, AutoProcessor

    processor = AutoProcessor.from_pretrained(model_id)
    model = AutoModelForCTC.from_pretrained(model_id, dtype=torch.bfloat16, device_map=device)

    def run(audio: np.ndarray) -> str:
        inputs = processor([audio], sampling_rate=SAMPLE_RATE, device=model.device)
        inputs.to(model.device, dtype=model.dtype)
        return processor.batch_decode(model.generate(**inputs), skip_special_tokens=True)[0].strip()

    return run


def _qwen3_asr(model_id: str, device: str) -> Transcribe:
    from transformers import AutoModelForMultimodalLM, AutoProcessor

    processor = AutoProcessor.from_pretrained(model_id)
    model = AutoModelForMultimodalLM.from_pretrained(model_id, dtype=torch.bfloat16, device_map=device)

    def run(audio: np.ndarray) -> str:
        inputs = processor.apply_transcription_request(audio=audio, language="English")
        inputs = inputs.to(model.device, model.dtype)
        out = model.generate(**inputs, max_new_tokens=400, do_sample=False, cache_implementation="static")
        new = out[:, inputs["input_ids"].shape[1] :]
        return processor.decode(new, return_format="transcription_only")[0].strip()

    return run


MODELS: dict[str, tuple[str, Callable[[str, str], Transcribe]]] = {
    "whisper-large-v3-turbo": ("openai/whisper-large-v3-turbo", _whisper),
    "whisper-large-v3": ("openai/whisper-large-v3", _whisper),
    "parakeet-tdt-0.6b-v2": ("nvidia/parakeet-tdt-0.6b-v2", _parakeet),
    "parakeet-tdt-0.6b-v3": ("nvidia/parakeet-tdt-0.6b-v3", _parakeet),
    "granite-speech-4.1-2b": ("ibm-granite/granite-speech-4.1-2b", _granite_ar),
    "granite-speech-5.0-470m-turboctc": ("ibm-granite/granite-speech-5.0-470m-turboctc", _granite_ctc),
    "qwen3-asr-1.7b": ("Qwen/Qwen3-ASR-1.7B-hf", _qwen3_asr),
    "qwen3-asr-0.6b": ("Qwen/Qwen3-ASR-0.6B-hf", _qwen3_asr),
}


@dataclass(frozen=True)
class Result:
    model: str
    model_id: str
    n_utterances: dict[str, int]
    wer: dict[str, float]
    wer_all: float
    formatted_wer: dict[str, float]
    rtfx: float
    latency_ms_by_seconds: dict[str, float]
    utterance_latency_ms_p50: float
    utterance_latency_ms_p90: float
    peak_vram_gib: float
    weights_vram_gib: float
    frac_hyps_with_uppercase: float
    frac_hyps_with_punctuation: float
    silence_output: str
    noise_output: str
    hypotheses: list[dict[str, str]]


def timed(fn: Transcribe, audio: np.ndarray) -> tuple[str, float]:
    torch.cuda.synchronize()
    t0 = time.perf_counter()
    text = fn(audio)
    torch.cuda.synchronize()
    return text, time.perf_counter() - t0


def evaluate(name: str, samples: list[Sample]) -> Result:
    model_id, factory = MODELS[name]
    torch.cuda.reset_peak_memory_stats()
    run = factory(model_id, "cuda:0")
    weights_gib = torch.cuda.memory_allocated() / 2**30

    for _ in range(3):  # warm-up: CUDA context, kernels, allocator
        run(samples[0].audio)

    normalizer = EnglishTextNormalizer()
    hyps: list[str] = []
    latencies: list[float] = []
    for s in samples:
        text, dt = timed(run, s.audio)
        hyps.append(text)
        latencies.append(dt)

    per_corpus: dict[str, float] = {}
    formatted: dict[str, float] = {}
    counts: dict[str, int] = {}
    for corpus in sorted({s.corpus for s in samples}):
        idx = [i for i, s in enumerate(samples) if s.corpus == corpus]
        refs, corpus_hyps = [samples[i].reference for i in idx], [hyps[i] for i in idx]
        per_corpus[corpus] = _wer(refs, corpus_hyps, normalizer)
        formatted[corpus] = _formatted_wer(refs, corpus_hyps)
        counts[corpus] = len(idx)

    # Fixed-length probes built by concatenating eval audio: latency as a function of segment length.
    pool = np.concatenate([s.audio for s in samples[:200]])
    by_len: dict[str, float] = {}
    for seconds in LATENCY_PROBE_SECONDS:
        clip = pool[: int(seconds * SAMPLE_RATE)]
        by_len[f"{seconds:g}s"] = 1000 * statistics.median(timed(run, clip)[1] for _ in range(LATENCY_PROBE_REPEATS))

    rng = np.random.default_rng(0)
    silence = np.zeros(3 * SAMPLE_RATE, dtype=np.float32)
    noise = (0.01 * rng.standard_normal(3 * SAMPLE_RATE)).astype(np.float32)

    audio_seconds = sum(len(s.audio) for s in samples) / SAMPLE_RATE
    lat_sorted = sorted(latencies)
    return Result(
        model=name,
        model_id=model_id,
        n_utterances=counts,
        wer=per_corpus,
        wer_all=_wer([s.reference for s in samples], hyps, normalizer),
        formatted_wer=formatted,
        rtfx=audio_seconds / sum(latencies),
        latency_ms_by_seconds=by_len,
        utterance_latency_ms_p50=1000 * lat_sorted[len(lat_sorted) // 2],
        utterance_latency_ms_p90=1000 * lat_sorted[int(len(lat_sorted) * 0.9)],
        peak_vram_gib=torch.cuda.max_memory_allocated() / 2**30,
        weights_vram_gib=weights_gib,
        frac_hyps_with_uppercase=_frac(hyps, lambda h: any(c.isupper() for c in h)),
        frac_hyps_with_punctuation=_frac(hyps, lambda h: any(c in ".,?!" for c in h)),
        silence_output=run(silence),
        noise_output=run(noise),
        hypotheses=[
            {"id": s.id, "corpus": s.corpus, "ref": s.reference, "hyp": h} for s, h in zip(samples, hyps, strict=True)
        ],
    )


def _wer(refs: list[str], hyps: list[str], normalizer: EnglishTextNormalizer) -> float:
    pairs = [(normalizer(r), normalizer(h)) for r, h in zip(refs, hyps, strict=True)]
    pairs = [(r, h) for r, h in pairs if r.strip()]  # leaderboard convention: skip empty references
    return 100 * jiwer.wer([r for r, _ in pairs], [h for _, h in pairs])


def _formatted_wer(refs: list[str], hyps: list[str]) -> float:
    """Case- and punctuation-sensitive WER: punctuation marks count as words. Measures readability."""

    def tokens(text: str) -> str:
        return " ".join(re.findall(r"[\w'-]+|[.,?!]", text))

    pairs = [(tokens(r), tokens(h)) for r, h in zip(refs, hyps, strict=True) if r.strip()]
    return 100 * jiwer.wer([r for r, _ in pairs], [h for _, h in pairs])


def _frac(hyps: list[str], pred: Callable[[str], bool]) -> float:
    non_empty = [h for h in hyps if h]
    return sum(map(pred, non_empty)) / max(1, len(non_empty))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, choices=sorted(MODELS))
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--ami", type=int, default=300)
    parser.add_argument("--earnings22", type=int, default=200)
    parser.add_argument("--seed", type=int, default=1234)
    args = parser.parse_args()

    samples = load_samples("ami", args.ami, args.seed) + load_samples("earnings22", args.earnings22, args.seed)
    result = evaluate(args.model, samples)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / f"{args.model}.json").write_text(json.dumps(asdict(result), indent=2))
    print(json.dumps({k: v for k, v in asdict(result).items() if k != "hypotheses"}, indent=2))


if __name__ == "__main__":
    main()
