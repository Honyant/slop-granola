// A typed in-memory router. The app has no URLs worth sharing (deep links are
// handled by the main process), so a history stack of Route values is all we need.
import { create } from 'zustand'
import type { Route } from '@shared/routes'

interface RouterState {
  stack: Route[]
  navigate(route: Route): void
  replace(route: Route): void
  back(): void
}

const MAX_HISTORY = 50

export const useRouter = create<RouterState>((set) => ({
  stack: [{ name: 'home' }],
  navigate: (route) => set(({ stack }) => (sameRoute(stack.at(-1)!, route) ? { stack } : { stack: [...stack, route].slice(-MAX_HISTORY) })),
  replace: (route) => set(({ stack }) => ({ stack: [...stack.slice(0, -1), route] })),
  back: () => set(({ stack }) => ({ stack: stack.length > 1 ? stack.slice(0, -1) : [{ name: 'home' }] })),
}))

export const useRoute = (): Route => useRouter((s) => s.stack.at(-1)!)
export const usePreviousRoute = (): Route | null => useRouter((s) => s.stack.at(-2) ?? null)
export const navigate = (route: Route): void => useRouter.getState().navigate(route)

export function sameRoute(a: Route, b: Route): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
