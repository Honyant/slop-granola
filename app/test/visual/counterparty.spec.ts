import { test } from '@playwright/test'
import { join } from 'node:path'
import { launch } from '../e2e/harness'
import { startFakeAsr } from '../e2e/fake-asr'

// A 1:1 meeting: the far side is labelled with the other attendee's name.
test('named counterparty screenshots', async () => {
  const asr = await startFakeAsr(
    (i) =>
      i === 0
        ? ['Great.', 'All right, thanks for talking to me. Bye.', 'They work 90% of the time, but not always.']
        : ['But yeah, sounds good. I will add you to our pipeline.', 'All right.', 'Okay.', 'Yeah, thanks for chatting. Bye.'],
    1200,
  )
  const fixtures = join(import.meta.dirname, '../fixtures')
  const out = process.env.SHOT_DIR ?? '/tmp'
  const { page, close } = await launch({
    settings: {
      transcription: { url: asr.url, token: '', language: 'en' },
      profile: { name: 'Sam', email: 'sam@example.com' },
    },
    helperFixture: {
      capture: {
        mic: join(fixtures, 'me.wav'),
        system: join(fixtures, 'them.wav'),
      },
    },
    seed: ({ notes }) => {
      notes.create(
        {
          title: 'Ada / Sam',
          meetingAt: Date.now(),
          attendees: [
            { name: 'Sam', email: 'sam@example.com', isSelf: true },
            {
              name: 'Ada Park',
              email: 'ada@acme.dev',
              isSelf: false,
            },
          ],
        },
        Date.now(),
      )
    },
  })
  await page.getByText('Ada / Sam').first().click()
  await page.getByRole('button', { name: 'Transcribe' }).click()
  await page.getByRole('button', { name: 'Show transcript' }).click()
  await page.getByText('Yeah, thanks for chatting. Bye.').waitFor({ timeout: 30_000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(out, 'counterparty-panel.png') })
  await page.getByRole('button', { name: 'Stop transcription' }).click()
  await page.getByRole('button', { name: 'Hide transcript' }).click()
  await page.getByRole('tab', { name: 'Transcript' }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(out, 'counterparty-tab.png') })
  await close()
  await asr.close()
})
