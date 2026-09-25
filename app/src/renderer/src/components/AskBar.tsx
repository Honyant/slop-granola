import { useState, type ReactNode } from 'react'
import { ArrowUp, SquareSlash } from 'lucide-react'
import type { Recipe } from '@shared/types'
import { api, errorMessage } from '@/lib/api'
import { keys, queryClient, useRecipes, useThread } from '@/lib/queries'
import { useUi } from '@/lib/ui'
import { ChatDrawer } from './ChatDrawer'
import styles from './AskBar.module.css'

interface AskBarProps {
  /** Scope questions to this note; null searches all notes. */
  noteId: string | null
  /** Recipe offered as a one-click chip at the right edge; null for none. */
  recipeSlug?: string | null
  /** Rendered to the left of the input (the note page puts recording controls here). */
  leading?: ReactNode
  className?: string
}

export function AskBar({ noteId, recipeSlug = 'list-recent-todos', leading, className }: AskBarProps) {
  const [text, setText] = useState('')
  const recipe = useRecipes().data?.find((r) => r.slug === recipeSlug)
  const { drawerThreadId, drawerOpen, openDrawer, showToast } = useUi()
  const thread = useThread(drawerOpen ? drawerThreadId : null).data
  // A thread belongs to the scope it was asked in; do not continue a global thread from a note.
  const activeThread = thread && thread.noteId === noteId ? thread : null
  const replying = activeThread?.messages.at(-1)?.status === 'streaming'

  const send = async (input: { text: string; recipe?: Recipe }) => {
    if (replying || (!input.text.trim() && !input.recipe)) return
    try {
      const { threadId } = await api.chat.send({
        threadId: activeThread?.id ?? null,
        text: input.text,
        noteId,
        recipeId: input.recipe?.id ?? null,
      })
      setText('')
      await queryClient.invalidateQueries({ queryKey: keys.thread(threadId) })
      openDrawer(threadId)
    } catch (error) {
      showToast(errorMessage(error))
    }
  }

  return (
    <div className={`${styles.dock} ${className ?? ''}`}>
      {activeThread && drawerOpen && <ChatDrawer thread={activeThread} />}
      <div className={styles.row}>
        {leading}
        <form
          className={styles.bar}
          onSubmit={(e) => {
            e.preventDefault()
            void send({ text })
          }}
        >
          <input
            className={styles.input}
            value={text}
            placeholder={replying ? 'Replying...' : 'Ask anything'}
            disabled={replying}
            onChange={(e) => setText(e.target.value)}
          />
          {text.trim() ? (
            <button type="submit" className={styles.send} aria-label="Send">
              <ArrowUp size={16} strokeWidth={2} />
            </button>
          ) : (
            recipe &&
            !replying && (
              <button type="button" className={styles.recipe} onClick={() => void send({ text: '', recipe })}>
                <SquareSlash size={15} strokeWidth={1.7} />
                {recipe.title}
              </button>
            )
          )}
        </form>
      </div>
    </div>
  )
}
