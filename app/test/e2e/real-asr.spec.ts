// Full pipeline against the real transcription server (and optionally the real
// LLM): app → WebSocket over the tailnet → GPU models → transcript in the UI.
// Opt-in: reads ../server/.env.local; skipped when it is absent.
import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, type Launched } from './harness'

const ENV_FILE = join(import.meta.dirname, '../../../server/.env.local')
const FIXTURES = join(import.meta.dirname, '../fixtures')

function serverEnv(): Record<string, string> {
  return Object.fromEntries(
    readFileSync(ENV_FILE, 'utf8')
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
  )
}

test.skip(!existsSync(ENV_FILE) || !process.env.GRANOLA_REAL, 'set GRANOLA_REAL=1 with server/.env.local present')

let app: Launched | null = null
test.afterEach(async () => {
  await app?.close()
  app = null
})

test('real server: two speakers transcribed, attributed, and enhanced', async () => {
  test.setTimeout(300_000)
  const env = serverEnv()
  app = await launch({
    settings: {
      transcription: { url: env.GRANOLA_ASR_URL!, token: env.GRANOLA_ASR_TOKEN!, language: 'en' },
      llm: { baseUrl: env.GRANOLA_LLM_BASE_URL!, model: env.GRANOLA_LLM_MODEL!, apiKey: env.GRANOLA_ASR_TOKEN! },
    },
    helperFixture: { capture: { mic: join(FIXTURES, 'me.wav'), system: join(FIXTURES, 'them.wav') } },
  })
  const { page } = app
  await page.getByRole('button', { name: 'New note' }).click()
  await page.getByRole('button', { name: 'Show transcript' }).click()
  const panel = page.getByRole('region', { name: 'Transcript' })

  // Speech from the "system" fixture must be attributed to them, the mic fixture to me.
  const them = panel.locator('[data-source="system"][data-final]')
  const me = panel.locator('[data-source="mic"][data-final]')
  await expect(them.filter({ hasText: /Airbus/i })).toHaveCount(1, { timeout: 60_000 })
  await expect(them.filter({ hasText: /Cleveland Clinic/i })).toHaveCount(1)
  await expect(me.filter({ hasText: /pricing details/i })).toHaveCount(1, { timeout: 60_000 })
  await expect(me.filter({ hasText: /security questionnaire/i })).toHaveCount(1, { timeout: 60_000 })
  await expect(them.filter({ hasText: /October/i })).toHaveCount(1, { timeout: 60_000 })
  expect(await me.filter({ hasText: /Airbus/i }).count()).toBe(0)

  const transcript = (await panel.locator('[data-final]').allTextContents()).join('\n')
  console.log(`--- transcript ---\n${transcript}`)

  await page.getByRole('button', { name: 'Minimize' }).click()
  await page.getByRole('button', { name: 'Stop transcription' }).click()
  await expect(page.getByRole('tab', { name: 'Enhanced' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Enhancing notes…')).toHaveCount(0, { timeout: 180_000 })
  await expect(page.locator('[class*=enhanced]')).toContainText(/Airbus/i)
  await expect(page.getByPlaceholder('New note')).not.toHaveValue('', { timeout: 30_000 })
  console.log(`--- enhanced ---\n${await page.locator('[class*=enhanced]').innerText()}`)
  console.log(`--- title --- ${await page.getByPlaceholder('New note').inputValue()}`)
})
