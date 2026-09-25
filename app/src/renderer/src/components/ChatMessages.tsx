import { useState } from 'react'
import type { ChatMessage } from '@shared/types'
import { useEvent } from '@/lib/api'
import { Markdown } from './Markdown'
import styles from './ChatMessages.module.css'

/**
 * Message list. Streaming content arrives through `chat:message` events (at
 * ~20 Hz) and is overlaid on the stored messages so the text grows smoothly
 * without refetching the thread for every token.
 */
export function ChatMessages({ messages }: { messages: ChatMessage[] }) {
  const [live, setLive] = useState<Record<string, { content: string; status: ChatMessage['status'] }>>({})
  useEvent('chat:message', ({ messageId, content, status }) => {
    if (messages.some((m) => m.id === messageId)) setLive((prev) => ({ ...prev, [messageId]: { content, status } }))
  })

  return (
    <div className={styles.list}>
      {messages.map((m) => {
        const current = live[m.id] && m.status === 'streaming' ? { ...m, ...live[m.id] } : m
        if (current.role === 'user') {
          return (
            <div key={m.id} className={styles.user}>
              {current.content}
            </div>
          )
        }
        return (
          <div key={m.id} className={styles.assistant} data-status={current.status}>
            {current.content ? <Markdown>{current.content}</Markdown> : <Thinking />}
          </div>
        )
      })}
    </div>
  )
}

function Thinking() {
  return (
    <span className={styles.thinking} aria-label="Thinking">
      <span />
      <span />
      <span />
    </span>
  )
}
