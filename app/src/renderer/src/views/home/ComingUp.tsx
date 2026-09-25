import { useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, SlidersHorizontal } from 'lucide-react'
import { addDays, startOfDay } from '@shared/time'
import type { CalendarEvent } from '@shared/types'
import { IconButton } from '@/components/controls'
import { FolderPicker } from '@/components/FolderPicker'
import { TimeRange } from '@/components/Time'
import { useCalendarEvents } from '@/lib/queries'
import { noteActions } from '@/lib/noteActions'
import { navigate } from '@/lib/router'
import styles from './ComingUp.module.css'

const DAYS_SHOWN = 2
/** Granola keeps the card compact: five events in total, at least one per day. */
const EVENT_BUDGET = 5

/** The "Coming up" calendar card: two days at a time, paged with the arrows. */
export function ComingUp({ now }: { now: number }) {
  const [page, setPage] = useState(0)
  const [expandedDays, setExpandedDays] = useState<ReadonlySet<number>>(new Set())
  const first = addDays(startOfDay(now), page * DAYS_SHOWN)
  const last = addDays(first, DAYS_SHOWN)
  const events = useCalendarEvents(new Date(first).toISOString(), new Date(last).toISOString()).data ?? []
  const days = Array.from({ length: DAYS_SHOWN }, (_, i) => addDays(first, i))
  let shownBefore = 0

  return (
    <section className={styles.section}>
      <header className={styles.header}>
        <h1 className={`${styles.heading} display`}>Coming up</h1>
        <div className={styles.nav}>
          <IconButton
            label="Calendar settings"
            size={24}
            className={styles.filter}
            onClick={() => navigate({ name: 'settings', section: 'calendar' })}
          >
            <SlidersHorizontal size={14} strokeWidth={1.7} />
          </IconButton>
          <IconButton label="Previous days" size={24} disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft size={16} strokeWidth={1.7} />
          </IconButton>
          <IconButton label="Next days" size={24} onClick={() => setPage((p) => p + 1)}>
            <ChevronRight size={16} strokeWidth={1.7} />
          </IconButton>
        </div>
      </header>
      <div className={styles.card}>
        {days.map((day) => {
          const dayEvents = events.filter(
            (e) => startOfDay(Date.parse(e.start)) === day && (day !== startOfDay(now) || Date.parse(e.end) > now),
          )
          const budget = Math.max(1, EVENT_BUDGET - shownBefore)
          const shown = expandedDays.has(day) ? dayEvents : dayEvents.slice(0, budget)
          shownBefore += shown.length
          const hidden = dayEvents.length - shown.length
          return (
            <div key={day} className={styles.day}>
              <DateLabel day={day} today={day === startOfDay(now)} />
              <div className={styles.events}>
                {dayEvents.length === 0 ? (
                  <div className={styles.empty}>{day === startOfDay(now) ? 'No more events today' : 'No events'}</div>
                ) : (
                  shown.map((event) => <EventRow key={`${event.id}|${event.start}`} event={event} now={now} />)
                )}
                {hidden > 0 && (
                  <button type="button" className={styles.more} onClick={() => setExpandedDays((d) => new Set(d).add(day))}>
                    {hidden} more
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function DateLabel({ day, today }: { day: number; today: boolean }) {
  const d = new Date(day)
  return (
    <div className={styles.date}>
      <span className={`${styles.dayNumber} display`}>{d.getDate()}</span>
      <span className={styles.dayText}>
        <span className={styles.month}>
          {d.toLocaleDateString('en-US', { month: 'long' })}
          {today && <span className={styles.todayDot} aria-label="Today" />}
        </span>
        <span className={styles.weekday}>{d.toLocaleDateString('en-US', { weekday: 'short' })}</span>
      </span>
    </div>
  )
}

function EventRow({ event, now }: { event: CalendarEvent; now: number }) {
  const start = Date.parse(event.start)
  const end = Date.parse(event.end)
  const live = start <= now && now < end
  const folderButton = useRef<HTMLButtonElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const withNote = async (fn: (id: string) => Promise<unknown>) => {
    const id = await noteActions.noteForEvent(event)
    if (id) await fn(id)
  }

  return (
    <div className={styles.event} data-open={pickerOpen || undefined}>
      <button type="button" className={styles.eventMain} onClick={() => void noteActions.openEvent(event, now)}>
        <span className={styles.bar} style={{ background: event.color }} />
        <span className={styles.eventText}>
          <span className={styles.eventTitle}>{event.title}</span>
          <span className={styles.eventTime} data-live={live || undefined}>
            {live && 'Now · '}
            <TimeRange start={start} end={end} />
          </span>
        </span>
      </button>
      <button ref={folderButton} type="button" className={styles.addToFolder} onClick={() => setPickerOpen((o) => !o)}>
        Add to folder <ChevronDown size={13} strokeWidth={1.8} />
      </button>
      <FolderPicker
        anchor={folderButton}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        placement="left-start"
        folderIds={[]}
        visibility="private"
        onToggleFolder={(folderId, member) => void withNote((id) => noteActions.setFolder([id], folderId, member))}
        onSetVisibility={(visibility) => void withNote((id) => noteActions.setVisibility([id], visibility))}
        onCreateFolder={(name) => void withNote((id) => noteActions.createFolder([id], name))}
      />
    </div>
  )
}
