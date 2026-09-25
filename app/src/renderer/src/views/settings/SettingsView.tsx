import type { ReactNode } from 'react'
import {
  Bell,
  Building2,
  CalendarDays,
  ChartLine,
  CircleHelp,
  Command,
  CreditCard,
  Folders,
  Gift,
  LogOut,
  Search,
  SlidersHorizontal,
  User,
  Users,
} from 'lucide-react'
import type { SettingsSection } from '@shared/routes'
import { Avatar } from '@/components/Avatar'
import { IconButton } from '@/components/controls'
import { SidebarIcon } from '@/components/icons'
import { useSettings } from '@/lib/queries'
import { navigate, useRouter } from '@/lib/router'
import { useUi } from '@/lib/ui'
import page from '../page.module.css'
import {
  AnalyticsSection,
  BillingSection,
  CalendarSection,
  ConnectorsSection,
  GeneralSection,
  HelpSection,
  MembersSection,
  NotificationsSection,
  PreferencesSection,
  ProfileSection,
  ReferralsSection,
  SpacesSection,
} from './sections'
import styles from './Settings.module.css'

const ICON = { size: 16, strokeWidth: 1.6 }

const ACCOUNT: [SettingsSection, string, ReactNode][] = [
  ['preferences', 'Preferences', <SlidersHorizontal {...ICON} />],
  ['profile', 'Profile', <User {...ICON} />],
  ['calendar', 'Calendar', <CalendarDays {...ICON} />],
  ['notifications', 'Notifications', <Bell {...ICON} />],
  ['connectors', 'Connectors', <Command {...ICON} />],
  ['help', 'Get help', <CircleHelp {...ICON} />],
]

const WORKSPACE: [SettingsSection, string, ReactNode][] = [
  ['general', 'General', <Building2 {...ICON} />],
  ['members', 'Members', <Users {...ICON} />],
  ['spaces', 'Spaces', <Folders {...ICON} />],
  ['analytics', 'Analytics', <ChartLine {...ICON} />],
  ['billing', 'Billing', <CreditCard {...ICON} />],
  ['referrals', 'Referrals', <Gift {...ICON} />],
]

const TITLES = Object.fromEntries([...ACCOUNT, ...WORKSPACE].map(([id, title]) => [id, title])) as Record<SettingsSection, string>

export function SettingsView({ section }: { section: SettingsSection }) {
  return (
    <div className={page.scroll}>
      <div className={page.column}>
        <h1 className={`${page.heading} display`}>{section === 'help' ? 'Help' : TITLES[section]}</h1>
        <Section section={section} />
      </div>
    </div>
  )
}

function Section({ section }: { section: SettingsSection }) {
  switch (section) {
    case 'preferences':
      return <PreferencesSection />
    case 'profile':
      return <ProfileSection />
    case 'calendar':
      return <CalendarSection />
    case 'notifications':
      return <NotificationsSection />
    case 'connectors':
      return <ConnectorsSection />
    case 'help':
      return <HelpSection />
    case 'general':
      return <GeneralSection />
    case 'members':
      return <MembersSection />
    case 'spaces':
      return <SpacesSection />
    case 'analytics':
      return <AnalyticsSection />
    case 'billing':
      return <BillingSection />
    case 'referrals':
      return <ReferralsSection />
  }
}

SettingsView.Sidebar = function SettingsSidebar({ section }: { section: SettingsSection }) {
  const profile = useSettings().data?.profile
  const replace = useRouter((s) => s.replace)
  const showToast = useUi((s) => s.showToast)
  const setSearchOpen = useUi((s) => s.setSearchOpen)
  const item = ([id, label, icon]: [SettingsSection, string, ReactNode]) => (
    <button
      key={id}
      type="button"
      className={styles.navItem}
      data-active={id === section || undefined}
      onClick={() => replace({ name: 'settings', section: id })}
    >
      <span className={styles.navIcon}>{icon}</span>
      {label}
    </button>
  )
  return (
    <nav className={styles.sidebar} aria-label="Settings">
      <div className={`${styles.chrome} drag`}>
        <IconButton label="Close settings" onClick={() => navigate({ name: 'home' })}>
          <SidebarIcon size={17} />
        </IconButton>
        <IconButton label="Search" onClick={() => setSearchOpen(true)}>
          <Search size={15} strokeWidth={1.75} />
        </IconButton>
      </div>
      <button type="button" className={styles.profile} onClick={() => replace({ name: 'settings', section: 'profile' })}>
        <Avatar name={profile?.name ?? ''} src={profile?.avatar} size={32} />
        <span className={`${styles.profileName} display`}>{profile?.name}</span>
        <span className={styles.profileEmail}>{profile?.email || 'Add your email'}</span>
      </button>
      <div className={styles.navGroup}>{ACCOUNT.map(item)}</div>
      <div className={styles.navHeading}>Workspace</div>
      <div className={styles.navGroup}>{WORKSPACE.map(item)}</div>
      <div className={styles.flex} />
      <button
        type="button"
        className={styles.signOut}
        onClick={() => {
          showToast('This build keeps everything on this Mac — there is no account to sign out of')
          navigate({ name: 'home' })
        }}
      >
        <LogOut size={16} strokeWidth={1.7} />
        Sign out
      </button>
    </nav>
  )
}
