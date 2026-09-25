// Text-level echo suppression.
//
// Without headphones the far side's voice comes out of the laptop speakers and
// into the microphone, so the same words would be transcribed twice: once
// (correctly) as "them" from system audio and once (wrongly) as "me". Apple's
// voice processing removes most of it acoustically; this is the backstop for
// what leaks through. It compares a mic segment against system segments that
// overlap it in time and flags it when the words substantially match.

export interface TimedText {
  startMs: number
  endMs: number
  text: string
}

/** How far apart in time the two transcriptions of one utterance may start/end. */
export const ECHO_WINDOW_MS = 1500
/** Fraction of the mic segment's words that must appear, in order, on the system side. */
const MATCH_THRESHOLD = 0.6
/** Short utterances ("yeah", "okay") match by chance; also require strong time overlap. */
const SHORT_UTTERANCE_WORDS = 3
const SHORT_UTTERANCE_OVERLAP = 0.5

export function isEcho(mic: TimedText, system: readonly TimedText[]): boolean {
  const micWords = words(mic.text)
  if (micWords.length === 0) return false
  const nearby = system
    .filter((s) => s.endMs >= mic.startMs - ECHO_WINDOW_MS && s.startMs <= mic.endMs + ECHO_WINDOW_MS)
    .sort((a, b) => a.startMs - b.startMs)
  if (nearby.length === 0) return false

  const systemWords = nearby.flatMap((s) => words(s.text))
  const score = lcsLength(micWords, systemWords) / micWords.length
  if (score < MATCH_THRESHOLD) return false
  if (micWords.length >= SHORT_UTTERANCE_WORDS) return true

  const duration = Math.max(mic.endMs - mic.startMs, 1)
  const overlap = nearby.reduce((sum, s) => sum + Math.max(0, Math.min(s.endMs, mic.endMs) - Math.max(s.startMs, mic.startMs)), 0)
  return overlap / duration >= SHORT_UTTERANCE_OVERLAP
}

export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []
}

/** Longest common subsequence length, O(n·m) time, O(m) memory. Inputs are one utterance long. */
export function lcsLength(a: readonly string[], b: readonly string[]): number {
  const row = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(above, row[j - 1]!)
      diagonal = above
    }
  }
  return row[b.length]!
}
