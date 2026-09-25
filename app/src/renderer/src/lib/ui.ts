// Ephemeral UI state shared across distant components.
import { create } from 'zustand'

interface UiState {
  sidebarCollapsed: boolean
  searchOpen: boolean
  /** Chat thread shown in the drawer above the "Ask anything" bar. */
  drawerThreadId: string | null
  drawerOpen: boolean
  toast: { id: number; text: string } | null
  toggleSidebar(): void
  setSearchOpen(open: boolean): void
  openDrawer(threadId: string): void
  closeDrawer(): void
  showToast(text: string): void
}

let toastId = 0

export const useUi = create<UiState>((set) => ({
  sidebarCollapsed: false,
  searchOpen: false,
  drawerThreadId: null,
  drawerOpen: false,
  toast: null,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  openDrawer: (drawerThreadId) => set({ drawerThreadId, drawerOpen: true }),
  closeDrawer: () => set({ drawerOpen: false }),
  showToast: (text) => {
    const id = ++toastId
    set({ toast: { id, text } })
    setTimeout(() => set((s) => (s.toast?.id === id ? { toast: null } : s)), 2400)
  },
}))
