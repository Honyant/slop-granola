#!/usr/bin/env node
// Test double for granola-helper that speaks docs/protocol-helper.md.
//
// Fixture (JSON, path in FAKE_HELPER_FIXTURE):
//   { calendars: [...], events: [...], devices: [...],
//     capture: { mic?: "<wav path>", system?: "<wav path>", realtime?: boolean } }
// Calendar events may use "start"/"end" as ISO strings or as
// { "today": "HH:MM" } / { "tomorrow": "HH:MM" } relative to the local date.
import { readFileSync } from 'node:fs'

const fixture = process.env.FAKE_HELPER_FIXTURE ? JSON.parse(readFileSync(process.env.FAKE_HELPER_FIXTURE, 'utf8')) : {}
const [command, ...args] = process.argv.slice(2)

const print = (value) => process.stdout.write(JSON.stringify(value))

function resolveTime(value) {
  if (typeof value === 'string') return value
  const [day, hm] = Object.entries(value)[0]
  const [h, m] = hm.split(':').map(Number)
  const d = new Date()
  d.setDate(d.getDate() + (day === 'tomorrow' ? 1 : day === 'yesterday' ? -1 : 0))
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

function arg(name) {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

switch (command) {
  case 'devices':
    print({ inputs: fixture.devices ?? [{ uid: 'BuiltInMicrophoneDevice', name: 'MacBook Pro Microphone', is_default: true }] })
    break
  case 'permissions':
    print({ microphone: 'granted', calendar: 'granted', system_audio: 'unknown' })
    break
  case 'calendar':
    if (args[0] === 'list') {
      print({ calendars: fixture.calendars ?? [] })
    } else {
      const from = Date.parse(arg('--from'))
      const to = Date.parse(arg('--to'))
      const ids = arg('--calendars')?.split(',')
      const events = (fixture.events ?? [])
        .map((e) => ({
          location: null,
          url: null,
          notes: null,
          all_day: false,
          organizer: null,
          attendees: [],
          ...e,
          start: resolveTime(e.start),
          end: resolveTime(e.end),
        }))
        .filter((e) => Date.parse(e.end) > from && Date.parse(e.start) < to && (!ids || ids.includes(e.calendar_id)))
      print({ events })
    }
    break
  case 'capture':
    capture()
    break
  case 'watch':
    watch()
    break
  default:
    print({ error: { code: 'invalid_arguments', message: `unknown command ${command}` } })
    process.exit(1)
}

function frame(type, payload) {
  const header = Buffer.alloc(5)
  header.writeUInt8(type, 0)
  header.writeUInt32LE(payload.length, 1)
  process.stdout.write(Buffer.concat([header, payload]))
}

const event = (e) => frame(0x02, Buffer.from(JSON.stringify(e)))

/** 16 kHz mono s16le samples from a canonical WAV (the fixtures are generated that way). */
function readPcm(path) {
  const wav = readFileSync(path)
  let offset = 12
  while (offset < wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'data') return new Int16Array(wav.buffer.slice(wav.byteOffset + offset + 8, wav.byteOffset + offset + 8 + size))
    offset += 8 + size
  }
  throw new Error(`no data chunk in ${path}`)
}

function capture() {
  let started = false
  let timer = null
  const stop = () => {
    if (timer) clearInterval(timer)
    event({ event: 'stopped' })
    process.exit(0)
  }
  process.stdin.setEncoding('utf8')
  let buffered = ''
  process.stdin.on('data', (chunk) => {
    buffered += chunk
    let newline
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      const cmd = JSON.parse(line)
      if (cmd.cmd === 'start' && !started) {
        started = true
        begin(cmd)
      } else if (cmd.cmd === 'stop') stop()
    }
  })
  process.stdin.on('end', stop)

  function begin(cmd) {
    const sources = []
    const spec = fixture.capture ?? {}
    if (cmd.mic?.enabled && spec.mic) sources.push({ id: 0, pcm: readPcm(spec.mic) })
    if (cmd.system?.enabled && spec.system) sources.push({ id: 1, pcm: readPcm(spec.system) })
    event({
      event: 'started',
      t0_unix_ms: Date.now(),
      mic: cmd.mic?.enabled
        ? { uid: 'BuiltInMicrophoneDevice', name: 'MacBook Pro Microphone', voice_processing: !!cmd.mic.voice_processing }
        : null,
      system: !!cmd.system?.enabled,
    })
    const chunk = 1600 // 100 ms
    const speed = spec.realtime === false ? 8 : 1
    let position = 0
    const total = Math.max(0, ...sources.map((s) => s.pcm.length))
    timer = setInterval(() => {
      for (let step = 0; step < speed; step++) {
        for (const s of sources) {
          // Past the end of a file the source keeps delivering silence, like a real device.
          const samples = new Int16Array(chunk)
          if (position < s.pcm.length) samples.set(s.pcm.subarray(position, Math.min(position + chunk, s.pcm.length)))
          const payload = Buffer.alloc(9 + chunk * 2)
          payload.writeUInt8(s.id, 0)
          payload.writeBigUInt64LE(BigInt(position), 1)
          Buffer.from(samples.buffer).copy(payload, 9)
          frame(0x01, payload)
        }
        position += chunk
      }
      if (position > total + 16000 * 30) clearInterval(timer)
    }, 100)
  }
}

/** Replays `fixture.micApps`: [{ afterMs, apps: [{ pid, name, bundle_id }] }], then idles until stdin closes. */
function watch() {
  const line = (apps) => process.stdout.write(`${JSON.stringify({ event: 'mic_apps', apps })}\n`)
  line([])
  for (const step of fixture.micApps ?? []) setTimeout(() => line(step.apps), step.afterMs)
  process.stdin.resume()
  process.stdin.on('end', () => process.exit(0))
}
