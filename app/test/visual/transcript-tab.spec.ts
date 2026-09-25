import { test } from '@playwright/test'
import { join } from 'node:path'
import { launch } from '../e2e/harness'
import { startFakeAsr } from '../e2e/fake-asr'

test('transcript tab screenshot', async () => {
  const asr = await startFakeAsr(
    (i) =>
      i === 0
        ? [
            'Infrastructure work.',
            'Can you send me the pricing details by Friday?',
            'Great, I will follow up with the security questionnaire.',
          ]
        : [
            'We work with organizations like Airbus, Ferrari, and hospitals like the Cleveland Clinic.',
            'Next, I will pass it to our product lead to talk about the roadmap.',
            'The launch is planned for October 15 and the budget is $200,000.',
          ],
    1500,
  )
  const fixtures = join(import.meta.dirname, '../fixtures')
  const { page, close } = await launch({
    settings: { transcription: { url: asr.url, token: '', language: 'en' } },
    helperFixture: { capture: { mic: join(fixtures, 'me.wav'), system: join(fixtures, 'them.wav') } },
  })
  await page.getByRole('button', { name: 'New note' }).click()
  await page.getByPlaceholder('New note').fill('Vendor sync')
  await page.getByRole('tab', { name: 'Transcript' }).click()
  await page.getByText('Great, I will follow up').waitFor({ timeout: 20_000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(process.env.SHOT_DIR ?? '/tmp', 'transcript-tab.png') })
  await close()
  await asr.close()
})
