// End-to-end tests: the real built app, driven through its UI, with the native
// helper, transcription server and LLM replaced by protocol-level fakes.
import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { TranscriptRepo } from '../../src/main/db/repos'
import { startFakeAsr, type FakeAsr } from './fake-asr'
import { ENHANCED_MARKDOWN, GENERATED_TITLE, startFakeLlm, type FakeLlm } from './fake-llm'
import { launch, type Launched } from './harness'

const FIXTURES = join(import.meta.dirname, '../fixtures')
const ada = { name: 'Ada Lovelace', email: 'ada@example.com', isSelf: true }

let app: Launched | null = null
let asr: FakeAsr | null = null
let llm: FakeLlm | null = null

test.afterEach(async ({}, testInfo) => {
  if (app && (testInfo.status !== testInfo.expectedStatus || testInfo.duration > 12_000))
    console.log(`--- main process log ---\n${app.logs()}`)
  await app?.close()
  await asr?.close()
  await llm?.close()
  app = asr = llm = null
})

/** Absolute ISO time `minutes` from now (relative "today HH:MM" fixtures break across midnight). */
function clockIn(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

test('records a meeting: live two-channel transcript, echo suppression, enhanced notes', async () => {
  // Connection 0 is the mic stream, 1 the system stream (the session opens them in that order).
  // Mic line 2 repeats system line 2 at the same time: the far side leaking into the mic.
  asr = await startFakeAsr((i) =>
    i === 0
      ? ['Infrastructure work.', 'We work with Airbus and Ferrari.', 'Can you send the pricing by Friday?']
      : ['Hello everyone.', 'We work with Airbus and Ferrari.', 'The launch is October fifteenth.'],
  )
  llm = await startFakeLlm()
  app = await launch({
    settings: {
      transcription: { url: asr.url, token: '', language: 'en' },
      llm: { baseUrl: llm.baseUrl, model: 'fake', apiKey: '' },
    },
    helperFixture: { capture: { mic: join(FIXTURES, 'me.wav'), system: join(FIXTURES, 'them.wav') } },
  })
  const { page } = app

  await page.getByRole('button', { name: 'New note' }).click()
  await expect(page.getByPlaceholder('New note')).toBeVisible()
  await page.getByRole('button', { name: 'Show transcript' }).click()
  const panel = page.getByRole('region', { name: 'Transcript' })

  await expect(panel.getByText('Can you send the pricing by Friday?')).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByText('The launch is October fifteenth.')).toBeVisible()
  await expect(panel.locator('[data-source="mic"]', { hasText: 'Infrastructure work.' })).toBeVisible()
  // The echoed line is shown once, attributed to the other side.
  await expect(panel.getByText('We work with Airbus and Ferrari.')).toHaveCount(1)
  await expect(panel.locator('[data-source="system"]', { hasText: 'We work with Airbus' })).toBeVisible()

  await page.getByRole('button', { name: 'Minimize' }).click()
  await page.getByRole('button', { name: 'Stop transcription' }).click()

  // Stopping triggers enhancement; the generated title replaces the empty one.
  await expect(page.getByRole('tab', { name: 'Enhanced' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Partnership with Airbus and Ferrari')).toBeVisible()
  await expect(page.getByPlaceholder('New note')).toHaveValue(GENERATED_TITLE)

  const enhanceRequest = llm.requests.find((r) => r.messages[0]!.content.includes('turn a user'))!
  const prompt = enhanceRequest.messages[1]!.content
  // Lines are labelled with what the notes should say: the user's name, and "Other participant".
  expect(prompt).toContain('Ada Lovelace: Infrastructure work.')
  expect(prompt).toContain('Other participant: Hello everyone.')
  // The suppressed echo never reaches the model as something the user said.
  expect(prompt).not.toMatch(/Ada Lovelace: [^\n]*Airbus/)

  await page.getByRole('tab', { name: 'My notes' }).click()
  // The placeholder is drawn with ::before, so assert on the attribute that feeds it.
  await expect(page.locator('.ProseMirror p[data-placeholder="Write notes, or press \'/\' for templates"]')).toBeVisible()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByText(GENERATED_TITLE)).toBeVisible()
  expect(ENHANCED_MARKDOWN).toContain('Airbus')
})

test('calendar events open notes with attendees, feeding People and Companies', async () => {
  app = await launch({
    helperFixture: {
      calendars: [{ id: 'work', title: 'Work', color: '#c179e0', source: 'Google', allows_modify: true, is_default: true }],
      events: [
        {
          id: 'ev1',
          calendar_id: 'work',
          title: 'Design review',
          start: clockIn(90),
          end: clockIn(120),
          attendees: [
            { name: 'Grace Hopper', email: 'grace@navy.mil', status: 'accepted', is_self: false },
            { name: 'Ada Lovelace', email: 'ada@example.com', status: 'accepted', is_self: true },
          ],
        },
      ],
    },
  })
  const { page } = app
  await page.getByText('Design review').click()
  await expect(page.getByPlaceholder('New note')).toHaveValue('Design review')
  await expect(page.getByRole('button', { name: /Grace/ })).toBeVisible()

  await page.getByRole('button', { name: 'Back' }).click()
  await page.getByRole('button', { name: 'People', exact: true }).click()
  await expect(page.getByRole('row', { name: /Grace Hopper/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /Ada Lovelace \(me\)/ })).toBeVisible()
  await page.getByRole('button', { name: 'Companies' }).click()
  await expect(page.getByRole('row', { name: /navy\.mil/ })).toBeVisible()
  // Opening the event again reuses its note instead of creating a duplicate.
  await page.getByRole('button', { name: 'Home', exact: true }).click()
  await page.getByText('Design review').first().click()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('button', { name: /Design review/ })).toHaveCount(2) // event row + one note row
})

test('organizes notes: folders, spaces, multi-select trash', async () => {
  app = await launch({
    seed: ({ notes }) => {
      notes.create({ title: 'Alpha sync', meetingAt: Date.now() - 3_600_000, attendees: [ada] })
      notes.create({ title: 'Beta planning', meetingAt: Date.now() - 7_200_000, attendees: [ada] })
    },
  })
  const { page } = app
  await page.getByText('Alpha sync').hover()
  await page.getByRole('button', { name: 'More' }).first().click()
  await page.getByRole('menuitem', { name: 'Add to folder' }).click()
  await page.getByRole('button', { name: 'New folder' }).click()
  await page.getByPlaceholder('Folder name').fill('Research')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Added to Research')).toBeVisible()

  await page.getByRole('button', { name: 'My notes' }).click()
  await page.getByRole('button', { name: /Research\s*1/ }).click()
  await expect(page.getByText('Alpha sync')).toBeVisible()
  await expect(page.getByText('Beta planning')).toHaveCount(0)

  await page.getByRole('button', { name: 'Home', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Select Alpha sync' }).click()
  await page.getByRole('checkbox', { name: 'Select Beta planning' }).click()
  const bar = page.getByRole('toolbar', { name: 'Selected notes' })
  await expect(bar).toContainText('2')
  await bar.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Move to trash' }).click()
  await expect(page.getByText('Your notes will show up here.')).toBeVisible()
})

test('search finds notes by transcript text', async () => {
  app = await launch({
    seed: ({ notes, db }) => {
      const id = notes.create({ title: 'Vendor call', attendees: [ada] })
      new TranscriptRepo(db).insert(
        { id: 't1', noteId: id, source: 'system', startMs: 0, endMs: 1000, text: 'The zeppelin shipment lands Tuesday.' },
        false,
      )
      notes.reindex(id)
    },
  })
  const { page } = app
  await page.keyboard.press('Meta+k')
  await page.getByPlaceholder('Search notes and transcripts').fill('zeppel')
  await expect(page.getByRole('dialog', { name: 'Search notes' }).getByText('Vendor call')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByPlaceholder('New note')).toHaveValue('Vendor call')
})

test('ask anything streams an answer grounded in notes', async () => {
  llm = await startFakeLlm()
  app = await launch({
    settings: { llm: { baseUrl: llm.baseUrl, model: 'fake', apiKey: '' } },
    seed: ({ notes }) => {
      notes.create({ title: 'Airbus kickoff', attendees: [ada] })
    },
  })
  const { page } = app
  await page.getByPlaceholder('Ask anything').fill('what happened with airbus')
  await page.keyboard.press('Enter')
  const drawer = page.getByRole('region', { name: 'Chat' })
  await expect(drawer.getByText(/Airbus/).last()).toBeVisible()
  await expect(drawer.getByText('came up in your meetings')).toBeVisible()
  // The note was retrieved into the model's context.
  expect(llm.requests.at(-1)!.messages[0]!.content).toContain('Airbus kickoff')

  await drawer.getByRole('button', { name: 'Open in Chat' }).click()
  await expect(page.getByRole('heading', { name: 'what happened with airbus' })).toBeVisible()
})

test('settings: profile, theme and calendar preferences persist', async () => {
  app = await launch({
    helperFixture: {
      calendars: [
        { id: 'a', title: 'Primary', color: '#c179e0', source: 'Google', allows_modify: true, is_default: true },
        { id: 'b', title: 'Holidays', color: '#16a765', source: 'Google', allows_modify: false, is_default: false },
      ],
    },
  })
  const { page } = app
  await page
    .getByRole('button', { name: /Ada Lovelace/ })
    .last()
    .click()
  await page.getByRole('menuitem', { name: /Settings/ }).click()
  await page.getByRole('button', { name: 'Profile' }).click()
  const name = page.getByLabel('Name')
  await name.fill('Ada King')
  await name.press('Enter')
  await expect(page.locator('nav[aria-label="Settings"]')).toContainText('Ada King')

  await page.getByRole('button', { name: 'Preferences' }).click()
  await page.getByLabel('Theme').selectOption('light')
  await expect(page.locator('html')).toHaveClass(/light/)

  await page.getByRole('button', { name: 'Calendar' }).click()
  await expect(page.getByRole('switch', { name: 'Primary' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('switch', { name: 'Holidays' })).toHaveAttribute('aria-checked', 'false')
  await page.getByRole('switch', { name: 'Holidays' }).click()
  await expect(page.getByRole('switch', { name: 'Holidays' })).toHaveAttribute('aria-checked', 'true')

  // A fresh renderer reads everything back from the main process's database.
  await page.reload()
  await expect(page.locator('html')).toHaveClass(/light/)
  await expect(page.getByRole('button', { name: /Ada King/ }).last()).toBeVisible()
  await page
    .getByRole('button', { name: /Ada King/ })
    .last()
    .click()
  await page.getByRole('menuitem', { name: /Settings/ }).click()
  await page.getByRole('button', { name: 'Calendar' }).click()
  await expect(page.getByRole('switch', { name: 'Holidays' })).toHaveAttribute('aria-checked', 'true')
})

test('voice input dictates into the chat composer', async () => {
  asr = await startFakeAsr(() => ['What did we decide about pricing?'], 1200)
  app = await launch({
    settings: { transcription: { url: asr.url, token: '', language: 'en' } },
    helperFixture: { capture: { mic: join(FIXTURES, 'me.wav') } },
  })
  const { page } = app
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await page.getByRole('button', { name: 'Voice input' }).click()
  await expect(page.getByPlaceholder('What did we talk about yesterday?')).toHaveValue('What did we decide about pricing?', {
    timeout: 15_000,
  })
  await page.getByRole('button', { name: 'Stop voice input' }).click()
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
})

test('transcript survives leaving the note, and the Transcript tab shows all of it', async () => {
  asr = await startFakeAsr((i) =>
    i === 0 ? ['First thing I said.', 'Second thing I said.', 'Third thing I said.'] : ['They opened.', 'They replied.', 'They closed.'],
  )
  app = await launch({
    settings: { transcription: { url: asr.url, token: '', language: 'en' } },
    helperFixture: { capture: { mic: join(FIXTURES, 'me.wav'), system: join(FIXTURES, 'them.wav') } },
  })
  const { page } = app
  await page.getByRole('button', { name: 'New note' }).click()
  await page.getByRole('button', { name: 'Show transcript' }).click()
  await expect(page.getByText('First thing I said.')).toBeVisible({ timeout: 15_000 })

  // Leave while the meeting is still being transcribed; the rest arrives off-screen.
  await page.getByRole('button', { name: 'Back' }).click()
  await page.waitForTimeout(4000)
  await page
    .getByRole('button', { name: /New note/ })
    .filter({ hasText: 'Me' })
    .first()
    .click()

  await page.getByRole('tab', { name: 'Transcript' }).click()
  const doc = page.getByRole('region', { name: 'Full transcript' })
  for (const line of [
    'First thing I said.',
    'Second thing I said.',
    'Third thing I said.',
    'They opened.',
    'They replied.',
    'They closed.',
  ]) {
    await expect(doc.getByText(line)).toBeVisible({ timeout: 10_000 })
  }
  await expect(doc.getByText('Me', { exact: true }).first()).toBeVisible()
  await expect(doc.getByText('Them', { exact: true }).first()).toBeVisible()

  // Search narrows the document.
  await doc.getByPlaceholder('Search transcript').fill('replied')
  await expect(doc.getByText('They replied.')).toBeVisible()
  await expect(doc.getByText('First thing I said.')).toHaveCount(0)
})

test('meeting detection: a mic-using app prompts, and Take notes records into the matching calendar event', async () => {
  asr = await startFakeAsr(() => ['Hello from the call.'])
  app = await launch({
    settings: { transcription: { url: asr.url, token: '', language: 'en' } },
    helperFixture: {
      calendars: [{ id: 'work', title: 'Work', color: '#c179e0', source: 'Google', allows_modify: true, is_default: true }],
      events: [
        {
          id: 'standup',
          calendar_id: 'work',
          title: 'Vendor call',
          start: clockIn(1),
          end: clockIn(31),
          url: 'https://us02web.zoom.us/j/123',
          attendees: [{ name: 'Grace Hopper', email: 'grace@navy.mil', status: 'accepted', is_self: false }],
        },
      ],
      micApps: [{ afterMs: 1500, apps: [{ pid: 4242, name: 'zoom.us', bundle_id: 'us.zoom.xos' }] }],
      capture: { mic: join(FIXTURES, 'me.wav') },
    },
  })
  // The join prompt for the upcoming event may already have opened the window.
  const prompt =
    app.app.windows().find((w) => w.url().includes('prompt')) ??
    (await app.app.waitForEvent('window', { predicate: (w) => w.url().includes('prompt'), timeout: 15_000 }))
  await expect(prompt.getByText('Meeting detected')).toBeVisible()
  await expect(prompt.getByText('Vendor call · zoom.us')).toBeVisible()
  await prompt.getByRole('button', { name: 'Take notes' }).click()

  const { page } = app
  await expect(page.getByPlaceholder('New note')).toHaveValue('Vendor call', { timeout: 10_000 })
  await expect(page.getByRole('button', { name: 'Stop transcription' })).toBeVisible()
  // The invite's attendees become the note's people and companies.
  await page.getByRole('button', { name: 'Stop transcription' }).click()
  await page.getByRole('button', { name: 'Back' }).click()
  await page.getByRole('button', { name: 'Companies' }).click()
  await expect(page.getByRole('row', { name: /navy\.mil/ })).toBeVisible()
})

test('an unanswered prompt fills its countdown bar over 15 s, then slides away', async () => {
  test.setTimeout(40_000)
  const launched = (app = await launch({
    helperFixture: { micApps: [{ afterMs: 500, apps: [{ pid: 7, name: 'Arc', bundle_id: 'company.thebrowser.Browser' }] }] },
  }))
  const prompt =
    launched.app.windows().find((w) => w.url().includes('prompt')) ??
    (await launched.app.waitForEvent('window', { predicate: (w) => w.url().includes('prompt'), timeout: 10_000 }))
  await expect(prompt.getByText('Meeting detected')).toBeVisible()
  const barWidth = () => prompt.locator('[class*=countdown]').evaluate((el) => el.getBoundingClientRect().width)
  const early = await barWidth()
  await prompt.waitForTimeout(3000)
  expect(await barWidth()).toBeGreaterThan(early + 40) // grows from the left, not shrinking
  const promptVisible = () =>
    launched.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes('prompt') && w.isVisible()),
    )
  await expect.poll(promptVisible, { timeout: 16_000, intervals: [500] }).toBe(false)
})
