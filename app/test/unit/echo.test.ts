import { describe, expect, it } from 'vitest'
import { isEcho, lcsLength } from '../../src/main/transcription/echo'

const seg = (startMs: number, endMs: number, text: string) => ({ startMs, endMs, text })

describe('isEcho', () => {
  const system = [seg(10_000, 14_000, 'We work with organizations like Airbus, Ferrari, and hospitals.')]

  it('flags a mic segment that repeats the far side, despite ASR differences', () => {
    expect(isEcho(seg(10_100, 14_200, 'we work with organisations like airbus ferrari and hospitals'), system)).toBe(true)
  })

  it('keeps genuinely different speech in the same window', () => {
    expect(isEcho(seg(10_100, 12_000, 'sorry can you repeat the last part'), system)).toBe(false)
  })

  it('ignores system speech far away in time', () => {
    expect(isEcho(seg(30_000, 34_000, 'we work with organizations like airbus'), system)).toBe(false)
  })

  it('requires time overlap for short utterances that could match by chance', () => {
    const them = [seg(20_000, 20_400, 'Yeah.')]
    expect(isEcho(seg(20_050, 20_400, 'yeah'), them)).toBe(true)
    expect(isEcho(seg(21_000, 21_300, 'yeah'), them)).toBe(false)
  })

  it('never flags empty text', () => {
    expect(isEcho(seg(10_000, 11_000, '...'), system)).toBe(false)
  })
})

describe('lcsLength', () => {
  it('computes subsequence length', () => {
    expect(lcsLength(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd'])).toBe(3)
    expect(lcsLength([], ['a'])).toBe(0)
  })
})
