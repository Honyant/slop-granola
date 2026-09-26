import { useEffect } from 'react'
import type { Route } from '@shared/routes'
import { useEvent } from '@/lib/api'
import { useLiveInvalidation, useSettings } from '@/lib/queries'
import { navigate, useRoute } from '@/lib/router'
import { useUi } from '@/lib/ui'
import { SearchPalette } from '@/shell/SearchPalette'
import { Sidebar } from '@/shell/Sidebar'
import { TopBar } from '@/shell/TopBar'
import { ChatView } from '@/views/ChatView'
import { HomeView } from '@/views/home/HomeView'
import { NoteView } from '@/views/note/NoteView'
import { AttendeeNotesView, CompaniesView, PeopleView } from '@/views/PeopleView'
import { TrashView } from '@/views/TrashView'
import { RecipesView } from '@/views/RecipesView'
import { SettingsView } from '@/views/settings/SettingsView'
import { SharedView } from '@/views/SharedView'
import { FolderView, SpaceView } from '@/views/SpaceView'
import styles from './App.module.css'

/** Width reserved for the traffic lights when no sidebar is shown. */
const TRAFFIC_LIGHT_INSET = 79

export function App() {
  useLiveInvalidation()
  useThemeClass()
  const route = useRoute()
  const { sidebarCollapsed, toggleSidebar, setSearchOpen, toast } = useUi()

  useEvent('navigate', navigate)
  useEvent('command', (command) => {
    if (command === 'toggleSidebar') toggleSidebar()
    else setSearchOpen(true)
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSearchOpen])

  // Notes and settings take over the window with their own navigation.
  const showSidebar = !sidebarCollapsed && route.name !== 'note' && route.name !== 'settings'

  return (
    <div className={styles.app}>
      {showSidebar && <Sidebar />}
      {route.name === 'settings' && <SettingsView.Sidebar section={route.section} />}
      <main className={styles.main}>
        <TopBar
          leftInset={showSidebar || route.name === 'settings' ? 0 : TRAFFIC_LIGHT_INSET}
          title={route.name === 'settings' ? 'Settings' : undefined}
        />
        <View route={route} />
      </main>
      <SearchPalette />
      {toast && (
        <div key={toast.id} className={styles.toast} role="status">
          {toast.text}
        </div>
      )}
    </div>
  )
}

function View({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <HomeView />
    case 'shared':
      return <SharedView />
    case 'chat':
      return <ChatView threadId={route.threadId ?? null} />
    case 'note':
      return <NoteView key={route.id} id={route.id} />
    case 'space':
      return <SpaceView space={route.space} />
    case 'folder':
      return <FolderView key={route.id} id={route.id} />
    case 'people':
      return <PeopleView />
    case 'person':
      return <AttendeeNotesView key={route.email} email={route.email} />
    case 'companies':
      return <CompaniesView />
    case 'company':
      return <AttendeeNotesView key={route.domain} domain={route.domain} />
    case 'recipes':
      return <RecipesView />
    case 'trash':
      return <TrashView />
    case 'settings':
      return <SettingsView section={route.section} />
  }
}

function useThemeClass(): void {
  const appearance = useSettings().data?.appearance ?? 'dark'
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = appearance === 'dark' || (appearance === 'system' && media.matches)
      document.documentElement.classList.toggle('dark', dark)
      document.documentElement.classList.toggle('light', !dark)
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [appearance])
}
