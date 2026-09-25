// Launches the built app against a throwaway profile, a seeded database and the
// fake helper. Every test gets a fresh profile, so tests are independent.
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Db } from '../../src/main/db/database'
import { NotesRepo } from '../../src/main/db/notes'
import { SettingsRepo } from '../../src/main/db/repos'
import type { SettingsPatch } from '../../src/shared/settings'

const APP_ROOT = resolve(import.meta.dirname, '../..')
const FAKE_HELPER = join(import.meta.dirname, 'fake-helper.mjs')

export interface LaunchOptions {
  /** Populates the database before the app opens it. */
  seed?(repos: { notes: NotesRepo; settings: SettingsRepo; db: Db }): void
  settings?: SettingsPatch
  helperFixture?: object
  env?: Record<string, string>
  /** Use the real granola-helper instead of the fake. */
  realHelper?: string
}

export interface Launched {
  app: ElectronApplication
  page: Page
  profile: string
  /** Main-process stdout/stderr so far, for diagnosing failures. */
  logs(): string
  close(): Promise<void>
}

export async function launch(options: LaunchOptions = {}): Promise<Launched> {
  const profile = mkdtempSync(join(tmpdir(), 'granola-e2e-'))
  const db = new Db(join(profile, 'granola.db'))
  const settings = new SettingsRepo(db)
  settings.update({ profile: { name: 'Ada Lovelace', email: 'ada@example.com' }, workspace: { name: 'Ada HQ' }, ...options.settings })
  options.seed?.({ notes: new NotesRepo(db), settings, db })
  db.close()

  const fixturePath = join(profile, 'helper-fixture.json')
  writeFileSync(fixturePath, JSON.stringify(options.helperFixture ?? {}))
  chmodSync(FAKE_HELPER, 0o755)

  const app = await electron.launch({
    args: [join(APP_ROOT, 'out/main/index.js')],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      GRANOLA_USER_DATA: profile,
      GRANOLA_HELPER: options.realHelper ?? FAKE_HELPER,
      FAKE_HELPER_FIXTURE: fixturePath,
      ...options.env,
    } as Record<string, string>,
  })
  let output = ''
  const capture = (chunk: Buffer) => {
    output += chunk.toString('utf8')
  }
  app.process().stdout?.on('data', capture)
  app.process().stderr?.on('data', capture)
  const page = await app.firstWindow()
  // Ready = the shell has rendered and its effects (key handlers, subscriptions) are attached.
  await page.getByRole('navigation', { name: 'Sidebar' }).waitFor()
  return {
    app,
    page,
    profile,
    logs: () => output,
    close: async () => {
      await app.close().catch(() => {})
      rmSync(profile, { recursive: true, force: true })
    },
  }
}
