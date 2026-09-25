// Generates AI-enhanced notes (and a title for untitled notes) after a meeting.
import type { AppContext } from '../context'
import { complete, llmConfig, streamChat, type LlmConfig } from '../llm/client'
import { enhanceMessages, titleMessages } from '../llm/prompts'
import { meetingContext } from './meeting'

/** Progress events are throttled; the renderer re-renders markdown on each. */
const PROGRESS_INTERVAL_MS = 80

export class Enhancer {
  private readonly running = new Map<string, AbortController>()

  constructor(
    private readonly ctx: AppContext,
    /** Called when a note's enhanced notes have been generated and saved. */
    private readonly onReady: (noteId: string, title: string) => void = () => {},
  ) {}

  isRunning(noteId: string): boolean {
    return this.running.has(noteId)
  }

  /** Starts (or restarts) enhancement for a note. Resolves when finished; never rejects. */
  async run(noteId: string): Promise<void> {
    const { ctx } = this
    const meeting = meetingContext(ctx, noteId)
    const note = ctx.notes.get(noteId)
    if (!meeting || !note) return
    this.running.get(noteId)?.abort()
    const controller = new AbortController()
    this.running.set(noteId, controller)
    const settings = ctx.settings.get()
    const llm: LlmConfig = llmConfig(settings)

    const template =
      ctx.catalog.templates().find((t) => t.id === (note.templateId ?? settings.notes.defaultTemplateId)) ?? ctx.catalog.templates()[0]!

    const title = note.title.trim()
      ? Promise.resolve(null)
      : complete(llm, titleMessages(meeting), controller.signal)
          .then(
            (t) =>
              t
                .trim()
                .replace(/^["']|["'.]$/g, '')
                .slice(0, 120) || null,
          )
          .catch(() => null)

    let markdown = ''
    let lastEmit = 0
    // Show progress immediately: the first token can be many seconds away (model load,
    // and reasoning models think before they write).
    ctx.emit('enhance:progress', { noteId, markdown, status: 'streaming' })
    try {
      for await (const delta of streamChat(llm, enhanceMessages(meeting, template, settings.profile.name), controller.signal)) {
        markdown += delta
        if (Date.now() - lastEmit >= PROGRESS_INTERVAL_MS) {
          lastEmit = Date.now()
          ctx.emit('enhance:progress', { noteId, markdown, status: 'streaming' })
        }
      }
      markdown = cleanMarkdown(markdown)
      const generatedTitle = await title
      ctx.notes.update(noteId, {
        enhanced: markdown,
        view: 'enhanced',
        ...(generatedTitle && !ctx.notes.get(noteId)?.title.trim() ? { title: generatedTitle } : {}),
      })
      ctx.emit('enhance:progress', { noteId, markdown, status: 'done' })
      ctx.emit('notes:changed', { ids: [noteId] })
      this.onReady(noteId, ctx.notes.get(noteId)?.title || 'Your meeting')
    } catch (error) {
      if (controller.signal.aborted) return
      const message = (error as Error).message
      ctx.log(`enhance ${noteId}: ${message}`)
      ctx.emit('enhance:progress', { noteId, markdown, status: 'error', error: message })
    } finally {
      if (this.running.get(noteId) === controller) this.running.delete(noteId)
    }
  }
}

/**
 * Models sometimes wrap the answer in a code fence, or echo the meeting header
 * ("Title: …", "Date: …") before the notes. Everything before the first
 * section heading is preamble, and the notes themselves start at `###`.
 */
export function cleanMarkdown(markdown: string): string {
  let text = markdown.trim()
  const fenced = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(text)
  if (fenced) text = fenced[1]!.trim()
  const firstSection = text.search(/^#{2,4}\s/m)
  if (firstSection > 0) text = text.slice(firstSection)
  return text.replace(/^#\s+.*\n+/, '').trim()
}
