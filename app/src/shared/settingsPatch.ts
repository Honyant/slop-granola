// Patch semantics for settings, kept free of zod so the renderer can apply
// optimistic updates without bundling the schema.
import type { Settings } from './settings'

/** Deep-partial patch accepted by `settings.update`: one level of nesting is merged. */
export type SettingsPatch = { [K in keyof Settings]?: Partial<Settings[K]> | Settings[K] }

export function applyPatch(current: Settings, patch: SettingsPatch): Settings {
  const next: Record<string, unknown> = { ...current }
  // An undefined field means "leave as is", never "reset to the default".
  const defined = (entries: object) => Object.entries(entries).filter(([, v]) => v !== undefined)
  for (const [key, value] of defined(patch)) {
    const base = (current as Record<string, unknown>)[key]
    next[key] =
      value !== null && typeof value === 'object' && !Array.isArray(value) && typeof base === 'object'
        ? { ...(base as object), ...Object.fromEntries(defined(value as object)) }
        : value
  }
  return next as Settings
}
