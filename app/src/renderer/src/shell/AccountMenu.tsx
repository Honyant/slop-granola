import type { RefObject } from 'react'
import {
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  CircleHelp,
  LayoutGrid,
  Plus,
  Settings,
  Smartphone,
  TriangleAlert,
  UserPlus,
} from 'lucide-react'
import { Avatar } from '@/components/Avatar'
import { MenuItem, MenuSeparator, Popover } from '@/components/Popover'
import { api } from '@/lib/api'
import { useRecordingState, useSettings } from '@/lib/queries'
import { navigate } from '@/lib/router'
import { useUi } from '@/lib/ui'
import styles from './AccountMenu.module.css'

const ICON = { size: 15, strokeWidth: 1.7 }

export function AccountMenu({ anchor, open, onClose }: { anchor: RefObject<HTMLElement | null>; open: boolean; onClose(): void }) {
  const settings = useSettings().data
  const recording = useRecordingState()
  const showToast = useUi((s) => s.showToast)
  if (!settings) return null
  const go = (fn: () => void) => () => {
    onClose()
    fn()
  }

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="top-start" offset={4} className={styles.menu}>
      <div className={styles.header}>
        <Avatar name={settings.workspace.name} src={settings.workspace.avatar} size={28} shape="square" />
        <div>
          <div className={styles.workspace}>{settings.profile.name}</div>
          <div className={styles.members}>1 member</div>
        </div>
      </div>
      <button type="button" className={styles.invite} onClick={go(() => navigate({ name: 'settings', section: 'members' }))}>
        <UserPlus {...ICON} /> Invite teammates
      </button>
      <div className={styles.email}>
        <span>{settings.profile.email || 'No email set'}</span>
        <ArrowLeftRight size={14} strokeWidth={1.7} />
      </div>
      {recording && (
        <div className={styles.notice}>
          <TriangleAlert size={14} strokeWidth={1.7} />
          <span>You can't switch workspaces while in a meeting</span>
        </div>
      )}
      <MenuItem
        icon={<Avatar name={settings.workspace.name} src={settings.workspace.avatar} size={16} shape="square" />}
        trailing={<Check size={13} />}
        disabled={recording !== null}
      >
        {settings.workspace.name}
      </MenuItem>
      <MenuItem icon={<Plus {...ICON} />} disabled={recording !== null} onSelect={go(() => showToast('Workspaces are local to this Mac'))}>
        Add workspace
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<LayoutGrid {...ICON} />} onSelect={go(() => navigate({ name: 'recipes' }))}>
        Manage templates
      </MenuItem>
      <MenuItem icon={<Smartphone {...ICON} />} onSelect={go(() => void api.system.openExternal('https://www.granola.ai/download'))}>
        Get Granola for Mobile
      </MenuItem>
      <MenuItem
        icon={<CircleHelp {...ICON} />}
        trailing={<ArrowUpRight size={14} />}
        onSelect={go(() => void api.system.openExternal('https://docs.granola.ai'))}
      >
        Help center
      </MenuItem>
      <MenuItem
        icon={<Settings {...ICON} />}
        trailing={
          <>
            <kbd className={styles.kbd}>⌘</kbd>
            <kbd className={styles.kbd}>,</kbd>
          </>
        }
        onSelect={go(() => navigate({ name: 'settings', section: 'preferences' }))}
      >
        Settings
      </MenuItem>
    </Popover>
  )
}
