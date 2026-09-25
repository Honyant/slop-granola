// Captures every major screen with data matching the reference screenshots,
// for side-by-side comparison. Needs test/visual/.private/fixture.json (gitignored,
// it holds real names) and writes to $SHOT_DIR.
import { test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from '../e2e/harness'
import { startFakeAsr } from '../e2e/fake-asr'

const FIXTURE = join(import.meta.dirname, '.private/fixture.json')
const OUT = process.env.SHOT_DIR ?? '/tmp'

interface Fixture {
  profile: { name: string; email: string }
  workspace: string
  helper: object
  notes: { title: string; daysAgo: number; time: string; attendees: { name: string; email: string }[] }[]
}

test.skip(!existsSync(FIXTURE), 'private fixture missing')

test('capture reference screens', async () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture
  const me = { ...fixture.profile, isSelf: true }
  const asr = await startFakeAsr((i) => (i === 0 ? ['Infrastructure work.'] : []), 2500)
  const wav = (name: string) => join(import.meta.dirname, '../fixtures', name)
  const { app, page, close } = await launch({
    settings: {
      profile: fixture.profile,
      workspace: { name: fixture.workspace },
      transcription: { url: asr.url, token: '', language: 'en' },
    },
    helperFixture: { ...fixture.helper, capture: { mic: wav('me.wav') } },
    seed: ({ notes }) => {
      for (const n of fixture.notes) {
        const d = new Date()
        d.setDate(d.getDate() - n.daysAgo)
        const [h, m] = n.time.split(':').map(Number)
        d.setHours(h!, m!, 0, 0)
        notes.create(
          { title: n.title, meetingAt: d.getTime(), attendees: [me, ...n.attendees.map((a) => ({ ...a, isSelf: false }))] },
          d.getTime(),
        )
      }
    },
  })
  const shot = async (name: string) => {
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(OUT, `${name}.png`) })
  }
  await page.getByText(fixture.notes[0]!.title).first().waitFor()
  await shot('home')
  await page.getByRole('button', { name: 'Shared with me' }).click()
  await shot('shared')
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await shot('chat')
  await page.getByRole('button', { name: 'People', exact: true }).click()
  await shot('people')
  await page.getByRole('button', { name: 'Companies' }).click()
  await shot('companies')
  await page.getByRole('button', { name: 'Recipes' }).click()
  await shot('recipes')
  await page.getByRole('button', { name: 'Home', exact: true }).click()
  await page.getByText(fixture.notes[0]!.title).first().hover()
  await page.getByRole('button', { name: 'More' }).first().click()
  await shot('row-menu')
  await page.keyboard.press('Escape')
  await page.locator('[class*=account]').first().click()
  await shot('account-menu')
  await page.getByRole('menuitem', { name: /Settings/ }).click()
  await page.getByRole('button', { name: 'Calendar' }).click()
  await shot('settings-calendar')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.getByRole('button', { name: 'New note' }).click()
  await page.getByPlaceholder('New note').waitFor()
  await page.mouse.move(5, 400)
  await shot('note')
  await page.getByRole('button', { name: 'Show transcript' }).click()
  await page.getByText('Infrastructure work.').waitFor({ timeout: 20_000 })
  await shot('note-panel')

  // Overlay: appears when the recording app loses focus; expands on click.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.blur())
  const overlay = await app.waitForEvent('window', { predicate: (w) => w.url().includes('overlay') })
  await overlay.getByRole('button', { name: 'Show transcript' }).click()
  await overlay.getByText('Infrastructure work.').waitFor()
  await overlay.waitForTimeout(400)
  await overlay.screenshot({ path: join(OUT, 'overlay.png') })
  await close()
  await asr.close()
})
