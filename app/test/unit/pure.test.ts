import { describe, expect, it } from 'vitest'
import { docToMarkdown, docToText, markdownToEditorHtml } from '@shared/doc'
import { parseDeepLink } from '@shared/routes'
import type { TranscriptSegment } from '@shared/types'
import { FrameDecoder, encodeFrame } from '../../src/main/audio/frames'
import { SseParser } from '../../src/main/llm/client'
import { chatMessages, enhanceMessages, formatTranscript } from '../../src/main/llm/prompts'
import { cleanMarkdown } from '../../src/main/services/enhance'
import { counterparty, speakerLabel } from '@shared/speakers'

const seg = (source: 'mic' | 'system', startMs: number, text: string): TranscriptSegment => ({
  id: `${source}${startMs}`,
  noteId: 'n',
  source,
  startMs,
  endMs: startMs + 1000,
  text,
  final: true,
})

describe('SseParser', () => {
  it('reassembles events split across chunks and ignores comments', () => {
    const p = new SseParser()
    expect(p.push(': keepalive\n\ndata: {"a"')).toEqual([])
    expect(p.push(':1}\n\ndata: [DONE]\r\n\r\n')).toEqual(['{"a":1}', '[DONE]'])
  })
})

describe('markdownToEditorHtml', () => {
  it('turns GFM task items into TipTap task lists and leaves other lists alone', () => {
    const html = markdownToEditorHtml('### Next steps\n- [ ] Sam: send **pricing**\n- [x] Ada: share diagrams\n\n### Notes\n- plain')
    expect(html).toContain('<ul data-type="taskList">')
    expect(html).toContain('<li data-type="taskItem" data-checked="false">Sam: send <strong>pricing</strong></li>')
    expect(html).toContain('<li data-type="taskItem" data-checked="true">Ada: share diagrams</li>')
    expect(html).not.toContain('<input')
    expect(html).toContain('<ul>\n<li>plain</li>')
  })
})

describe('formatTranscript', () => {
  it('labels speakers, merges consecutive turns and stamps time from the meeting start', () => {
    const t = formatTranscript([seg('system', 1000, 'Hello.'), seg('system', 3000, 'How are you?'), seg('mic', 65_000, 'Good.')], 0, 10_000)
    expect(t).toBe('[00:01] Them: Hello. How are you?\n[01:05] Me: Good.')
  })

  it('names the far side when it is one known person', () => {
    const t = formatTranscript([seg('system', 0, 'All right.'), seg('mic', 2000, 'Great.')], 0, 10_000, { me: 'Me', them: 'Ada Park' })
    expect(t).toBe('[00:00] Ada Park: All right.\n[00:02] Me: Great.')
  })

  it('elides the middle when over budget, keeping opening and conclusion', () => {
    const segments = Array.from({ length: 200 }, (_, i) => seg(i % 2 ? 'mic' : 'system', i * 1000, `line ${i}`))
    const t = formatTranscript(segments, 0, 400)
    expect(t.length).toBeLessThanOrEqual(400)
    expect(t).toContain('line 0')
    expect(t).toContain('line 199')
    expect(t).toContain('truncated')
  })
})

describe('counterparty', () => {
  const person = (name: string, isSelf = false, email: string | null = null) => ({ name, email, isSelf })
  it('is the one other attendee on a 1:1', () => {
    expect(counterparty([person('Me', true), person('Ada Park')])).toBe('Ada Park')
    expect(counterparty([person('', false, 'ada@acme.dev')])).toBe('ada@acme.dev')
  })
  it('is unknown with no other attendees or several', () => {
    expect(counterparty([person('Me', true)])).toBeNull()
    expect(counterparty([person('A'), person('B'), person('Me', true)])).toBeNull()
  })
  it('labels sides', () => {
    expect(speakerLabel('mic', 'Ada Park')).toBe('Me')
    expect(speakerLabel('system', 'Ada Park')).toBe('Ada Park')
    expect(speakerLabel('system', null)).toBe('Them')
  })
})

describe('prompts', () => {
  const meeting = {
    title: 'Sync',
    meetingAt: 0,
    attendees: [{ name: 'Ada', email: 'ada@x.com', isSelf: true }],
    myNotes: '- pricing',
    enhanced: null,
    transcript: [seg('mic', 0, 'We need pricing.')],
  }

  it('gives the enhancer the template, the user notes and the transcript', () => {
    const [system, user] = enhanceMessages(
      meeting,
      {
        id: 't',
        name: '1 on 1',
        description: '',
        body: '### Updates',
        builtin: true,
      },
      'Ada',
    )
    expect(system!.content).toContain('"Ada" is the user')
    expect(user!.content).toContain('### Updates')
    expect(user!.content).toContain('- pricing')
    // Labels are what the notes should say: models copy "Me"/"Them" into prose as if they were names.
    expect(user!.content).toContain('Ada: We need pricing.')
    expect(user!.content).not.toMatch(/\] (Me|Them): /)
  })

  it('grounds chat in the focused meeting and keeps history before the question', () => {
    const messages = chatMessages({ focus: meeting, related: [], now: 0, userName: 'Ada' }, [{ role: 'user', content: 'earlier' }], 'now?')
    expect(messages[0]!.content).toContain('# Current meeting')
    expect(messages.map((m) => m.content).slice(1)).toEqual(['earlier', 'now?'])
  })
})

describe('cleanMarkdown', () => {
  it('unwraps a fenced answer and drops a leading title', () => {
    expect(cleanMarkdown('```markdown\n# Notes\n### A\n- b\n```')).toBe('### A\n- b')
  })

  it('drops an echoed meeting header before the first section', () => {
    expect(cleanMarkdown('Untitled meeting\nDate: Thu\n\n### Key takeaways\n- x')).toBe('### Key takeaways\n- x')
  })
})

describe('doc conversion', () => {
  it('renders headings, nested lists, tasks and marks', () => {
    const doc = {
      type: 'doc' as const,
      content: [
        {
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: 'Next' }],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'ship', marks: [{ type: 'bold' }] }],
                },
                {
                  type: 'bulletList',
                  content: [
                    {
                      type: 'listItem',
                      content: [
                        {
                          type: 'paragraph',
                          content: [{ type: 'text', text: 'docs' }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'done' }],
                },
              ],
            },
          ],
        },
      ],
    }
    expect(docToMarkdown(doc)).toBe('### Next\n\n- **ship**\n  - docs\n\n- [x] done')
    expect(docToText(doc)).toBe('Next\n\nship\ndocs\n\ndone')
  })
})

describe('FrameDecoder', () => {
  it('decodes frames split at arbitrary byte boundaries', () => {
    const bytes = Buffer.concat([
      encodeFrame({ kind: 'event', event: { event: 'stopped' } }),
      encodeFrame({
        kind: 'audio',
        source: 'system',
        sampleIndex: 2 ** 40,
        pcm: new Int16Array([1, -2, 3]),
      }),
    ])
    const decoder = new FrameDecoder()
    const frames = [...bytes].flatMap((byte) => decoder.push(Buffer.from([byte])))
    expect(frames).toEqual([
      { kind: 'event', event: { event: 'stopped' } },
      {
        kind: 'audio',
        source: 'system',
        sampleIndex: 2 ** 40,
        pcm: new Int16Array([1, -2, 3]),
      },
    ])
  })

  it('rejects corrupt streams instead of misreading audio', () => {
    expect(() => new FrameDecoder().push(Buffer.from([0x07, 0, 0, 0, 0]))).toThrow(/unknown helper frame/)
    expect(() => new FrameDecoder().push(Buffer.from([0x01, 0xff, 0xff, 0xff, 0x7f]))).toThrow(/too large/)
  })
})

describe('parseDeepLink', () => {
  it('accepts note links only', () => {
    expect(parseDeepLink('granola-clone://note/abc-123')).toEqual({
      name: 'note',
      id: 'abc-123',
    })
    expect(parseDeepLink('granola-clone://note/a%20b')).toBeNull()
    expect(parseDeepLink('granola-clone://settings/x')).toBeNull()
    expect(parseDeepLink('https://note/abc')).toBeNull()
  })
})
