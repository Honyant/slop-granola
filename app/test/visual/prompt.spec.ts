import { test } from '@playwright/test'
import { join } from 'node:path'
import { launch } from '../e2e/harness'

const OUT = process.env.SHOT_DIR ?? '/tmp'
const iso = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()

test('prompt screenshots', async () => {
  const app = await launch({
    helperFixture: {
      calendars: [{ id: 'w', title: 'Work', color: '#c179e0', source: 'Google', allows_modify: true, is_default: true }],
      events: [
        { id: 'e', calendar_id: 'w', title: 'Design review', start: iso(1), end: iso(31), url: 'https://meet.google.com/xtf-eqnb-nks' },
      ],
      micApps: [{ afterMs: 4000, apps: [{ pid: 7, name: 'Arc', bundle_id: 'company.thebrowser.Browser' }] }],
    },
  })
  const find = async () =>
    app.app.windows().find((w) => w.url().includes('prompt')) ??
    (await app.app.waitForEvent('window', { predicate: (w) => w.url().includes('prompt') }))
  const prompt = await find()
  await prompt.getByText('Join Google Meet').waitFor()
  await prompt.waitForTimeout(400)
  await prompt.screenshot({ path: join(OUT, 'prompt-upcoming.png') })
  await prompt.getByText('Meeting detected').waitFor({ timeout: 10_000 })
  await prompt.waitForTimeout(400)
  await prompt.screenshot({ path: join(OUT, 'prompt-detected.png') })
  await prompt.getByRole('button', { name: 'More options' }).click()
  await prompt.waitForTimeout(400)
  await prompt.screenshot({ path: join(OUT, 'prompt-menu.png') })
  await app.close()
})
