// Screenshots for the README, from made-up data only:
//   SHOT_DIR=../docs/screenshots npx playwright test readme --project visual
import { test } from '@playwright/test'
import { join } from 'node:path'
import { launch } from '../e2e/harness'
import { startFakeAsr } from '../e2e/fake-asr'

const OUT = process.env.SHOT_DIR ?? '/tmp'
const DAY = 86_400_000
const at = (daysAgo: number, hour: number, minute = 0) => {
  const d = new Date(Date.now() - daysAgo * DAY)
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}
const iso = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()
const me = { name: 'Sam Lee', email: 'sam@example.com', isSelf: true }
const person = (name: string, email: string) => ({ name, email, isSelf: false })

const ENHANCED = `### Where they are today
- Ada runs a four-person data platform team at Acme; they moved off Airflow last quarter
- Pain point: nightly batch jobs miss the 7am report window about once a week

### What they want
- Streaming ingestion for the three largest sources before the Q1 board meeting
- Budget approved for one vendor, decision by November 15

### Next steps
- [ ] Sam: send pricing and the security questionnaire by Friday
- [ ] Ada: share current pipeline diagrams`

test('readme screenshots', async () => {
  const asr = await startFakeAsr(
    (i) =>
      i === 0
        ? ['How are the nightly jobs holding up?', 'Got it. I will send pricing and the security questionnaire by Friday.']
        : [
            'Honestly, they work 90% of the time, but the other 10% is painful.',
            'We miss the 7am report window about once a week.',
            'Sounds good. I will share our pipeline diagrams.',
          ],
    1200,
  )
  const fixtures = join(import.meta.dirname, '../fixtures')
  let enhancedId = ''
  const { page, app, close } = await launch({
    settings: {
      transcription: { url: asr.url, token: '', language: 'en' },
      profile: { name: me.name, email: me.email },
      workspace: { name: 'Northwind' },
    },
    helperFixture: {
      calendars: [{ id: 'w', title: 'Work', color: '#c179e0', source: 'Google', allows_modify: true, is_default: true }],
      events: [
        { id: 'e1', calendar_id: 'w', title: 'Design review', start: iso(1), end: iso(31), url: 'https://meet.google.com/xtf-eqnb-nks' },
        { id: 'e2', calendar_id: 'w', title: 'Hiring sync', start: iso(180), end: iso(210), url: 'https://zoom.us/j/123456789' },
      ],
      capture: { mic: join(fixtures, 'me.wav'), system: join(fixtures, 'them.wav') },
      micApps: [{ afterMs: 60_000, apps: [{ pid: 7, name: 'zoom.us', bundle_id: 'us.zoom.xos' }] }],
    },
    seed: ({ notes }) => {
      notes.create({
        title: 'Weekly product sync',
        meetingAt: at(1, 10),
        attendees: [me, person('Grace Hopper', 'grace@acme.dev'), person('Linus Ng', 'linus@acme.dev')],
      })
      notes.create({ title: 'Roadmap review', meetingAt: at(1, 15, 30), attendees: [me, person('Katherine Johnson', 'kj@orbital.io')] })
      notes.create({
        title: 'Candidate interview: backend',
        meetingAt: at(2, 11),
        attendees: [me, person('Alan Turing', 'alan@example.org')],
      })
      notes.create({ title: 'Board prep', meetingAt: at(3, 9), attendees: [me, person('Radia Perlman', 'radia@example.net')] })
      enhancedId = notes.create({
        title: 'Acme data platform intro',
        meetingAt: at(0, 9, 30),
        attendees: [me, person('Ada Park', 'ada@acme.dev')],
      })
      notes.update(enhancedId, { enhanced: ENHANCED, view: 'enhanced' })
    },
  })
  const shot = async (name: string) => {
    await page.mouse.move(5, 300)
    await page.waitForTimeout(700)
    await page.screenshot({ path: join(OUT, `${name}.png`) })
  }
  await page.getByText('Weekly product sync').waitFor()
  await shot('home')

  const prompt =
    app.windows().find((w) => w.url().includes('prompt')) ??
    (await app.waitForEvent('window', { predicate: (w) => w.url().includes('prompt') }))
  await prompt.getByText('Join Google Meet').waitFor()
  await prompt.waitForTimeout(500)
  await prompt.screenshot({ path: join(OUT, 'prompt.png') })

  await page.getByText('Acme data platform intro').first().click()
  await page.getByText('Where they are today').waitFor()
  await shot('enhanced')

  await page
    .getByRole('button', { name: 'Resume' })
    .or(page.getByRole('button', { name: 'Transcribe' }))
    .first()
    .click()
  await page.getByRole('button', { name: 'Show transcript' }).click()
  await page.getByText('Sounds good. I will share our pipeline diagrams.').waitFor({ timeout: 30_000 })
  await shot('transcript')

  await close()
  await asr.close()
})
