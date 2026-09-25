// Who is speaking on each side of a recording. The mic is always the user; the
// speaker output carries everyone else, so it has a name only when exactly one
// other person is on the invite. With more, the far side is a mix of voices
// and stays "Them" rather than guessing.
import type { Attendee, AudioSource } from './types'

export function counterparty(attendees: Attendee[]): string | null {
  const others = attendees.filter((a) => !a.isSelf)
  if (others.length !== 1) return null
  const [other] = others as [Attendee]
  return other.name.trim() || other.email || null
}

export function speakerLabel(source: AudioSource, counterpartyName: string | null): string {
  return source === 'mic' ? 'Me' : (counterpartyName ?? 'Them')
}
