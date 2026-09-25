import { useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Search, X } from 'lucide-react'
import { relativeDay } from '@shared/time'
import { Avatar } from '@/components/Avatar'
import { CompanyLogo } from '@/components/CompanyLogo'
import { NoteList } from '@/components/NoteList'
import { useCompanies, useNotes, usePeople } from '@/lib/queries'
import { navigate } from '@/lib/router'
import { useNow } from '@/lib/useNow'
import page from './page.module.css'
import styles from './PeopleView.module.css'

type SortKey = 'lastNote' | 'notes'

interface Row {
  key: string
  name: string
  detail: string
  avatar: ReactNode
  lastNoteAt: number
  noteCount: number
  onOpen(): void
}

interface DirectoryProps {
  title: string
  column: string
  filters: [string, string]
  rows: (filter: 0 | 1) => Row[]
}

/** The People and Companies tables share one layout. */
function Directory({ title, column, filters, rows }: DirectoryProps) {
  const now = useNow()
  const [filter, setFilter] = useState<0 | 1>(0)
  const [query, setQuery] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'lastNote', desc: true })
  const q = query?.trim().toLowerCase() ?? ''
  const visible = rows(filter)
    .filter((r) => !q || r.name.toLowerCase().includes(q) || r.detail.toLowerCase().includes(q))
    .sort((a, b) => {
      const d = sort.key === 'lastNote' ? a.lastNoteAt - b.lastNoteAt : a.noteCount - b.noteCount
      return sort.desc ? -d : d
    })
  const sortBy = (key: SortKey) => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))
  const arrow = (key: SortKey) =>
    sort.key === key && (sort.desc ? <ArrowDown size={13} strokeWidth={1.8} /> : <ArrowUp size={13} strokeWidth={1.8} />)

  return (
    <div className={styles.page}>
      <div className={page.tableHeader}>
        <h1 className={page.tableTitle}>{title}</h1>
        <div className={styles.controls}>
          {query === null ? (
            <button type="button" className={styles.searchButton} aria-label="Search" onClick={() => setQuery('')}>
              <Search size={14} strokeWidth={1.8} />
            </button>
          ) : (
            <label className={styles.searchField}>
              <Search size={14} strokeWidth={1.8} />
              <input autoFocus value={query} placeholder="Search" onChange={(e) => setQuery(e.target.value)} />
              <button type="button" aria-label="Close search" onClick={() => setQuery(null)}>
                <X size={13} />
              </button>
            </label>
          )}
          {filters.map((label, i) => (
            <button
              key={label}
              type="button"
              className={styles.filter}
              data-active={filter === i || undefined}
              onClick={() => setFilter(i as 0 | 1)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.table} role="table">
        <div className={styles.columns} role="row">
          <span className={styles.personColumn}>{column}</span>
          <button type="button" className={styles.lastColumn} onClick={() => sortBy('lastNote')}>
            Last note {arrow('lastNote')}
          </button>
          <button type="button" className={styles.countColumn} onClick={() => sortBy('notes')}>
            {arrow('notes')} Notes
          </button>
        </div>
        <div className={styles.rows}>
          {visible.map((r) => (
            <button key={r.key} type="button" role="row" className={styles.row} onClick={r.onOpen}>
              {r.avatar}
              <span className={styles.who}>
                <span className={styles.name}>{r.name}</span>
                <span className={styles.detail}>{r.detail}</span>
              </span>
              <span className={styles.last}>{relativeDay(r.lastNoteAt, now)}</span>
              <span className={styles.count}>{r.noteCount}</span>
            </button>
          ))}
          {visible.length === 0 && (
            <div className={styles.empty}>
              {q ? 'No matches' : `${title} from your meetings will appear here once you have notes with attendees.`}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function PeopleView() {
  const people = usePeople().data ?? []
  return (
    <Directory
      title="People"
      column="Person"
      filters={['Everyone', 'People I met']}
      rows={(filter) =>
        people
          .filter((p) => filter === 0 || !p.isSelf)
          .map((p) => ({
            key: p.email,
            name: p.isSelf ? `${p.name} (me)` : p.name,
            detail: p.email,
            avatar: <Avatar name={p.name} seed={p.email} size={32} />,
            lastNoteAt: p.lastNoteAt,
            noteCount: p.noteCount,
            onOpen: () => navigate({ name: 'person', email: p.email }),
          }))
      }
    />
  )
}

export function CompaniesView() {
  const companies = useCompanies().data ?? []
  const now = useNow()
  return (
    <Directory
      title="Companies"
      column="Company"
      filters={['All companies', 'Companies I met']}
      rows={(filter) =>
        companies
          .filter((c) => filter === 0 || c.lastNoteAt <= now)
          .map((c) => ({
            key: c.domain,
            name: c.name,
            detail: c.domain,
            avatar: <CompanyLogo domain={c.domain} name={c.name} size={32} />,
            lastNoteAt: c.lastNoteAt,
            noteCount: c.noteCount,
            onOpen: () => navigate({ name: 'company', domain: c.domain }),
          }))
      }
    />
  )
}

/** Notes with one person or anyone from one company. */
export function AttendeeNotesView(props: { email: string } | { domain: string }) {
  const now = useNow()
  const notes = (useNotes().data ?? []).filter((n) =>
    n.attendees.some((a) => ('email' in props ? a.email === props.email : a.email?.endsWith(`@${props.domain}`) && !a.isSelf)),
  )
  const person = usePeople().data?.find((p) => 'email' in props && p.email === props.email)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const title = 'email' in props ? (person?.name ?? props.email) : props.domain
  return (
    <div className={page.scroll}>
      <div className={page.column}>
        <h1 className={`${page.heading} ${styles.personHeading} display`}>
          <Avatar
            name={title}
            seed={'email' in props ? props.email : props.domain}
            size={34}
            shape={'email' in props ? 'circle' : 'square'}
          />
          {title}
        </h1>
        <NoteList
          notes={notes}
          now={now}
          selected={selected}
          onToggleSelected={(id) =>
            setSelected((prev) => {
              const next = new Set(prev)
              if (!next.delete(id)) next.add(id)
              return next
            })
          }
        />
      </div>
    </div>
  )
}
