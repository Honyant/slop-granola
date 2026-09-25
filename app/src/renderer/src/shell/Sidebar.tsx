import { useRef, useState } from 'react'
import { Building2, ChevronsUpDown, House, Lock, MessageCircle, Search, SquareSlash, User, Users } from 'lucide-react'
import type { Route } from '@shared/routes'
import { Avatar } from '@/components/Avatar'
import { IconButton } from '@/components/controls'
import { SidebarIcon } from '@/components/icons'
import { useSettings } from '@/lib/queries'
import { navigate, useRoute } from '@/lib/router'
import { useUi } from '@/lib/ui'
import { AccountMenu } from './AccountMenu'
import styles from './Sidebar.module.css'

const ICON = { size: 15, strokeWidth: 1.75 }

export function Sidebar() {
  const route = useRoute()
  const settings = useSettings().data
  const toggleSidebar = useUi((s) => s.toggleSidebar)
  const setSearchOpen = useUi((s) => s.setSearchOpen)
  const accountRef = useRef<HTMLButtonElement>(null)
  const [accountOpen, setAccountOpen] = useState(false)
  const name = settings?.profile.name ?? ''
  const workspace = settings?.workspace.name ?? ''

  const item = (target: Route, icon: React.ReactNode, label: string, tile = false) => (
    <button
      type="button"
      className={styles.item}
      data-active={isActive(route, target) || undefined}
      data-tile={tile || undefined}
      onClick={() => navigate(target)}
    >
      <span className={styles.itemIcon}>{icon}</span>
      <span className={styles.itemLabel}>{label}</span>
    </button>
  )

  return (
    <nav className={styles.sidebar} aria-label="Sidebar">
      <div className={`${styles.chrome} drag`}>
        <IconButton label="Toggle sidebar" onClick={toggleSidebar} size={28}>
          <SidebarIcon size={17} />
        </IconButton>
        <IconButton label="Search" onClick={() => setSearchOpen(true)} size={28}>
          <Search {...ICON} />
        </IconButton>
      </div>

      <div className={styles.section}>
        {item({ name: 'home' }, <House {...ICON} />, 'Home')}
        {item({ name: 'shared' }, <Users {...ICON} />, 'Shared with me')}
        {item({ name: 'chat' }, <MessageCircle {...ICON} />, 'Chat')}
      </div>

      <div className={styles.heading}>Spaces</div>
      <div className={styles.section}>
        {item(
          { name: 'space', space: 'private' },
          <span className={styles.tile}>
            <Lock size={11} strokeWidth={2.2} />
          </span>,
          'My notes',
          true,
        )}
        {item(
          { name: 'space', space: 'workspace' },
          <Avatar name={workspace} src={settings?.workspace.avatar} size={20} shape="square" />,
          workspace,
          true,
        )}
      </div>

      <div className={styles.spacer} />

      <div className={styles.tools}>
        <IconButton label="Recipes" active={route.name === 'recipes'} onClick={() => navigate({ name: 'recipes' })}>
          <SquareSlash {...ICON} />
        </IconButton>
        <IconButton label="People" active={route.name === 'people'} onClick={() => navigate({ name: 'people' })}>
          <User {...ICON} />
        </IconButton>
        <IconButton label="Companies" active={route.name === 'companies'} onClick={() => navigate({ name: 'companies' })}>
          <Building2 {...ICON} />
        </IconButton>
      </div>

      <button
        ref={accountRef}
        type="button"
        className={styles.account}
        data-open={accountOpen || undefined}
        onClick={() => setAccountOpen((open) => !open)}
      >
        <Avatar name={name} src={settings?.profile.avatar} size={20} shape="square" />
        <span className={styles.accountName}>{name}</span>
        <ChevronsUpDown size={13} strokeWidth={1.8} className={styles.chevrons} />
      </button>
      <AccountMenu anchor={accountRef} open={accountOpen} onClose={() => setAccountOpen(false)} />
    </nav>
  )
}

function isActive(current: Route, target: Route): boolean {
  if (current.name !== target.name) return false
  if (current.name === 'space' && target.name === 'space') return current.space === target.space
  return true
}
