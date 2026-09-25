import { useEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, ChevronRight, LayoutGrid, Mic, Paperclip, SquareSlash } from 'lucide-react'
import type { Recipe } from '@shared/types'
import { relativeDay } from '@shared/time'
import { ChatMessages } from '@/components/ChatMessages'
import { Popover, MenuItem } from '@/components/Popover'
import { api, errorMessage, useEvent } from '@/lib/api'
import { keys, queryClient, useRecipes, useSettings, useThread } from '@/lib/queries'
import { navigate, useRouter } from '@/lib/router'
import { useUi } from '@/lib/ui'
import { useQuery } from '@tanstack/react-query'
import page from './page.module.css'
import styles from './ChatView.module.css'

const FEATURED_RECIPES = ['list-recent-todos', 'coach-me', 'streamline-my-calendar', 'write-weekly-recap', 'write-prd']

export function ChatView({ threadId }: { threadId: string | null }) {
  const settings = useSettings().data
  const recipes = useRecipes().data ?? []
  const thread = useThread(threadId).data
  const threads = useQuery({ queryKey: keys.threads, queryFn: () => api.chat.threads() }).data ?? []
  const replace = useRouter((s) => s.replace)
  const showToast = useUi((s) => s.showToast)
  const scroller = useRef<HTMLDivElement>(null)
  const replying = thread?.messages.at(-1)?.status === 'streaming'

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [thread?.messages.length])

  const send = async (text: string, recipe?: Recipe) => {
    try {
      const result = await api.chat.send({ threadId, text, noteId: null, recipeId: recipe?.id ?? null })
      await queryClient.invalidateQueries({ queryKey: keys.thread(result.threadId) })
      if (result.threadId !== threadId) replace({ name: 'chat', threadId: result.threadId })
    } catch (error) {
      showToast(errorMessage(error))
    }
  }

  if (thread) {
    return (
      <div className={styles.threadPage}>
        <div ref={scroller} className={page.scroll}>
          <div className={page.column}>
            <h1 className={`${styles.threadTitle} display`}>{thread.title}</h1>
            <ChatMessages messages={thread.messages} />
          </div>
        </div>
        <div className={styles.threadComposer}>
          <Composer
            placeholder={replying ? 'Replying...' : 'Ask a follow up'}
            disabled={replying}
            onSend={(t) => void send(t)}
            model={settings?.llm.model}
          />
        </div>
      </div>
    )
  }

  const firstName = settings?.profile.name.split(/\s+/)[0] ?? ''
  const featured = FEATURED_RECIPES.map((slug) => recipes.find((r) => r.slug === slug)).filter((r): r is Recipe => !!r)

  return (
    <div className={page.scroll}>
      <div className={styles.landing}>
        <h1 className={`${styles.greeting} display`}>Hi {firstName}, ask anything</h1>
        <Composer placeholder="What did we talk about yesterday?" onSend={(t) => void send(t)} model={settings?.llm.model} />
        <div className={styles.recipesLabel}>Recipes</div>
        <div className={styles.chips}>
          {featured.map((recipe) => (
            <button key={recipe.id} type="button" className={styles.chip} onClick={() => void send('', recipe)}>
              <SquareSlash size={15} strokeWidth={1.7} />
              {recipe.title}
            </button>
          ))}
          <button type="button" className={styles.chip} onClick={() => navigate({ name: 'recipes' })}>
            <LayoutGrid size={15} strokeWidth={1.7} />
            See all
            <ChevronRight size={15} strokeWidth={1.7} />
          </button>
        </div>
        {threads.length > 0 && (
          <>
            <div className={styles.recipesLabel}>Recent chats</div>
            <div className={styles.threads}>
              {threads.slice(0, 8).map((t) => (
                <button key={t.id} type="button" className={styles.threadRow} onClick={() => navigate({ name: 'chat', threadId: t.id })}>
                  <span className={styles.threadRowTitle}>{t.title}</span>
                  <span className={styles.threadRowDate}>{relativeDay(t.createdAt, Date.now())}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

interface ComposerProps {
  placeholder: string
  disabled?: boolean
  model: string | undefined
  onSend(text: string): void
}

function Composer({ placeholder, disabled, model, onSend }: ComposerProps) {
  const [text, setText] = useState('')
  const dictation = useDictation((spoken) => setText((t) => (t.trim() ? `${t.trimEnd()} ${spoken}` : spoken)))
  const modelAnchor = useRef<HTMLButtonElement>(null)
  const [modelOpen, setModelOpen] = useState(false)
  const submit = () => {
    if (!text.trim() || disabled) return
    onSend(text)
    setText('')
  }
  return (
    <div className={styles.composer}>
      <textarea
        className={styles.textarea}
        rows={1}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className={styles.composerFooter}>
        <button type="button" className={styles.footerIcon} aria-label="Attach notes" title="Your notes are included automatically">
          <Paperclip size={15} strokeWidth={1.7} />
        </button>
        <button ref={modelAnchor} type="button" className={styles.model} onClick={() => setModelOpen((o) => !o)}>
          Auto <ChevronDown size={12} strokeWidth={1.8} />
        </button>
        <Popover anchor={modelAnchor} open={modelOpen} onClose={() => setModelOpen(false)}>
          <MenuItem trailing="✓" onSelect={() => setModelOpen(false)}>
            Auto{model ? ` · ${model}` : ''}
          </MenuItem>
        </Popover>
        <span className={styles.flex} />
        {dictation.interim && <span className={styles.interim}>{dictation.interim}</span>}
        {text.trim() && !dictation.listening ? (
          <button type="button" className={styles.sendButton} aria-label="Send" onClick={submit}>
            <ArrowUp size={16} strokeWidth={2} />
          </button>
        ) : (
          <button
            type="button"
            className={styles.micButton}
            data-listening={dictation.listening || undefined}
            aria-label={dictation.listening ? 'Stop voice input' : 'Voice input'}
            onClick={dictation.toggle}
          >
            <Mic size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>
    </div>
  )
}

/** Voice input through the transcription server; finals are handed to `onText`. */
function useDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const showToast = useUi((s) => s.showToast)
  useEvent('dictation:text', (event) => {
    if (event.error) showToast(event.error)
    if (event.done) {
      setListening(false)
      setInterim('')
      return
    }
    if (event.final) {
      setInterim('')
      if (event.text.trim()) onText(event.text.trim())
    } else {
      setInterim(event.text)
    }
  })
  useEffect(() => () => void api.dictation.stop(), [])
  const toggle = async () => {
    if (listening) {
      await api.dictation.stop()
      return
    }
    try {
      await api.dictation.start()
      setListening(true)
    } catch (error) {
      showToast(errorMessage(error))
    }
  }
  return { listening, interim, toggle: () => void toggle() }
}
