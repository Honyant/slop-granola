// "Ask anything": grounded Q&A over the user's notes, streamed into a thread.
import type { ChatSendInput } from '@shared/ipc'
import type { AppContext } from '../context'
import { llmConfig, streamChat, type LlmMessage } from '../llm/client'
import { chatMessages, type MeetingContext } from '../llm/prompts'
import { meetingContext } from './meeting'

const STREAM_INTERVAL_MS = 50
const RELATED_BY_SEARCH = 6
const RECENT_WINDOW_MS = 14 * 24 * 3600 * 1000
const MAX_RECENT = 8

export class ChatService {
  private readonly running = new Map<string, AbortController>()

  constructor(private readonly ctx: AppContext) {}

  send(input: ChatSendInput): { threadId: string; messageId: string } {
    const { ctx } = this
    const recipe = input.recipeId ? ctx.catalog.recipe(input.recipeId) : null
    const text = input.text.trim()
    if (!text && !recipe) throw new Error('Nothing to send')

    const shown = recipe ? (text ? `${recipe.title}: ${text}` : recipe.title) : text
    const question = recipe ? `${recipe.prompt}${text ? `\n\nAdditional instructions: ${text}` : ''}` : text
    const threadId = input.threadId ?? ctx.chats.createThread(shown.slice(0, 80), input.noteId)
    const history = this.history(threadId)
    ctx.chats.addMessage(threadId, 'user', shown, 'done')
    const messageId = ctx.chats.addMessage(threadId, 'assistant', '', 'streaming')
    if (recipe) ctx.catalog.recordRecipeUse(recipe.id)

    void this.generate(threadId, messageId, input.noteId, history, question)
    return { threadId, messageId }
  }

  cancel(messageId: string): void {
    this.running.get(messageId)?.abort()
  }

  private async generate(
    threadId: string,
    messageId: string,
    noteId: string | null,
    history: LlmMessage[],
    question: string,
  ): Promise<void> {
    const { ctx } = this
    const controller = new AbortController()
    this.running.set(messageId, controller)
    const settings = ctx.settings.get()
    let content = ''
    let lastEmit = 0
    try {
      const messages = chatMessages(
        {
          focus: noteId ? meetingContext(ctx, noteId) : null,
          related: noteId ? [] : this.related(question),
          now: Date.now(),
          userName: settings.profile.name,
        },
        history,
        question,
      )
      for await (const delta of streamChat(llmConfig(settings), messages, controller.signal)) {
        content += delta
        if (Date.now() - lastEmit >= STREAM_INTERVAL_MS) {
          lastEmit = Date.now()
          ctx.emit('chat:message', { threadId, messageId, content, status: 'streaming' })
        }
      }
      ctx.chats.finishMessage(messageId, content, 'done')
      ctx.emit('chat:message', { threadId, messageId, content, status: 'done' })
    } catch (error) {
      const message = controller.signal.aborted ? content : content || (error as Error).message
      ctx.chats.finishMessage(messageId, message, controller.signal.aborted ? 'done' : 'error')
      ctx.emit('chat:message', { threadId, messageId, content: message, status: controller.signal.aborted ? 'done' : 'error' })
    } finally {
      this.running.delete(messageId)
    }
  }

  private history(threadId: string): LlmMessage[] {
    return (this.ctx.chats.thread(threadId)?.messages ?? [])
      .filter((m) => m.status === 'done' && m.content)
      .map((m) => ({ role: m.role, content: m.content }))
  }

  /** Notes that best match the question, then recent notes, without duplicates. */
  private related(question: string): MeetingContext[] {
    const now = Date.now()
    const ranked = this.ctx.search.rank(question, RELATED_BY_SEARCH)
    const recent = this.ctx.notes
      .list()
      .filter((n) => now - n.meetingAt <= RECENT_WINDOW_MS && n.meetingAt <= now)
      .slice(0, MAX_RECENT)
      .map((n) => n.id)
    return [...new Set([...ranked, ...recent])].map((id) => meetingContext(this.ctx, id)).filter((m): m is MeetingContext => m !== null)
  }
}
