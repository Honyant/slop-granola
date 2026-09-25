import { useEffect, useRef } from 'react'
import { Maximize2, Minus } from 'lucide-react'
import type { ChatThread } from '@shared/types'
import { navigate } from '@/lib/router'
import { useUi } from '@/lib/ui'
import { IconButton } from './controls'
import { ChatMessages } from './ChatMessages'
import styles from './ChatDrawer.module.css'

/** Chat answers slide up above the "Ask anything" bar instead of leaving the page. */
export function ChatDrawer({ thread }: { thread: ChatThread }) {
  const closeDrawer = useUi((s) => s.closeDrawer)
  const scroller = useRef<HTMLDivElement>(null)
  const last = thread.messages.at(-1)

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [last?.content, thread.messages.length])

  return (
    <section className={styles.drawer} aria-label="Chat">
      <header className={styles.header}>
        <span className={styles.title}>{thread.title}</span>
        <IconButton
          label="Open in Chat"
          size={26}
          onClick={() => {
            closeDrawer()
            navigate({ name: 'chat', threadId: thread.id })
          }}
        >
          <Maximize2 size={14} strokeWidth={1.8} />
        </IconButton>
        <IconButton label="Minimize" size={26} onClick={closeDrawer}>
          <Minus size={16} strokeWidth={1.8} />
        </IconButton>
      </header>
      <div ref={scroller} className={styles.body}>
        <ChatMessages messages={thread.messages} />
      </div>
    </section>
  )
}
