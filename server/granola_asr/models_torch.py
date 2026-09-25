"""The GPU models (PyTorch + transformers). Choice and measurements: README, "Model choice".

Both are only ever called from the engine's single worker thread.
"""

from __future__ import annotations

import warnings

import numpy as np
import torch
from transformers import AutoModelForSpeechSeq2Seq, AutoModelForTDT, AutoProcessor

from .recognizers import SAMPLE_RATE, DegenerateOutput
from .text import sentence_case

# Parakeet's generate() derives a correct max_length from the encoder length but warns on every call.
warnings.filterwarnings("ignore", message="Using the model-agnostic default `max_length`")


class ParakeetTdt:
    """NVIDIA Parakeet-TDT (FastConformer + token-and-duration transducer). Cased and punctuated."""

    def __init__(self, model_id: str, device: str) -> None:
        self.name = model_id
        self._processor = AutoProcessor.from_pretrained(model_id)
        self._model = AutoModelForTDT.from_pretrained(model_id, dtype=torch.bfloat16, device_map=device).eval()

    @torch.inference_mode()
    def transcribe(self, audio: np.ndarray) -> str:
        inputs = self._processor([audio], sampling_rate=SAMPLE_RATE)
        inputs.to(self._model.device, dtype=self._model.dtype)
        out = self._model.generate(**inputs, return_dict_in_generate=True)
        return self._processor.decode(out.sequences, skip_special_tokens=True)[0].strip()


class GraniteSpeech:
    """IBM Granite Speech (conformer CTC encoder + q-former + Granite LLM), prompted for punctuation."""

    PROMPT = "<|audio|>transcribe the speech with proper punctuation and capitalization."
    # Output budget per second of audio. Dense speech is ~3-4 tokens/s (measured: 96 tokens for
    # 29 s of earnings-call audio), so reaching 8/s means a repetition loop ("uh, uh, uh, ...");
    # the budget also caps how long such a loop can hold the GPU.
    TOKENS_PER_SECOND = 8
    MIN_TOKENS = 16

    def __init__(self, model_id: str, device: str) -> None:
        self.name = model_id
        self._device = device
        self._processor = AutoProcessor.from_pretrained(model_id)
        self._tokenizer = self._processor.tokenizer
        self._model = AutoModelForSpeechSeq2Seq.from_pretrained(
            model_id, dtype=torch.bfloat16, device_map=device
        ).eval()
        chat = [{"role": "user", "content": self.PROMPT}]
        self._prompt = self._tokenizer.apply_chat_template(chat, tokenize=False, add_generation_prompt=True)

    @torch.inference_mode()
    def transcribe(self, audio: np.ndarray) -> str:
        wav = torch.from_numpy(audio)[None]
        inputs = self._processor(self._prompt, wav, device=self._device, return_tensors="pt").to(self._device)
        budget = self.MIN_TOKENS + int(self.TOKENS_PER_SECOND * len(audio) / SAMPLE_RATE)
        out = self._model.generate(
            **inputs,
            max_new_tokens=budget,
            do_sample=False,
            num_beams=1,
            # Static cache lets generate() compile the decoder step: 3.5x faster than the dynamic cache here.
            cache_implementation="static",
        )
        new_tokens = out[0, inputs["input_ids"].shape[-1] :]
        if len(new_tokens) >= budget:
            raise DegenerateOutput(f"{budget} tokens for {len(audio) / SAMPLE_RATE:.1f} s of audio")
        # Granite leaves 43% of AMI meeting utterances (>= 6 words) with no punctuation at all;
        # sentence_case cuts its AMI formatted WER from 23.1 to 18.0 (README, "Model choice").
        return sentence_case(self._tokenizer.decode(new_tokens, skip_special_tokens=True))


FACTORIES = {
    "nvidia/parakeet-tdt-0.6b-v3": ParakeetTdt,
    "ibm-granite/granite-speech-4.1-2b": GraniteSpeech,
}
