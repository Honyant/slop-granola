import { test } from '@playwright/test'
import { join } from 'node:path'
import { launch } from '../e2e/harness'

test('light theme screens', async () => {
  const now = Date.now()
  const { page, close } = await launch({
    settings: { appearance: 'light' },
    helperFixture: {
      calendars: [{ id: 'a', title: 'Work', color: '#c179e0', source: 'Google', allows_modify: true, is_default: true }],
      events: [
        {
          id: 'e',
          calendar_id: 'a',
          title: 'Design review',
          start: new Date(now + 3.6e6).toISOString(),
          end: new Date(now + 7.2e6).toISOString(),
        },
      ],
    },
    seed: ({ notes }) => {
      notes.create({
        title: 'Quarterly planning',
        meetingAt: now - 8.64e7,
        attendees: [
          { name: 'Ada Lovelace', email: 'ada@example.com', isSelf: true },
          { name: 'Grace', email: 'grace@navy.mil', isSelf: false },
        ],
      })
    },
  })
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(process.env.SHOT_DIR ?? '/tmp', 'light-home.png') })
  await close()
})
