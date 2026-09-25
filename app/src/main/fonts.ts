// Granola's typefaces, used when Granola itself is installed on this Mac.
//
// Granola sets its UI in KMR Melange Grotesk and its titles in Quadrant Notepad.
// Both are commercial and are not in this repository. An installed Granola.app
// already carries them, and Electron's fs reads inside .asar archives, so the
// renderer loads them from there through a read-only `granola-font:` scheme.
// Without Granola every request 404s and the CSS falls back to Inter Tight and
// IBM Plex Serif (styles/tokens.css).
import { protocol } from 'electron'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const FONT_SCHEME = 'granola-font'

const GRANOLA_ASSETS = '/Applications/Granola.app/Contents/Resources/app.asar/dist-app/assets'

/** Face name (the URL host) → file name pattern. File names carry a content hash that changes per release. */
const FACES: Record<string, RegExp> = {
  'melange-light': /^kmrmelangegrotesk-light-[\w-]+\.woff2$/,
  'melange-regular': /^kmrmelangegrotesk-regular-[\w-]+\.woff2$/,
  'melange-book': /^kmrmelangegrotesk-book-[\w-]+\.woff2$/,
  'melange-medium': /^kmrmelangegrotesk-medium-[\w-]+\.woff2$/,
  'melange-semibold': /^kmrmelangegrotesk-semibold-[\w-]+\.woff2$/,
  'melange-italic': /^kmrmelangegrotesk-italic-[\w-]+\.woff2$/,
  'melange-semibolditalic': /^kmrmelangegrotesk-semibolditalic-[\w-]+\.woff2$/,
  'quadrant-regular': /^QuadrantNotepad-Regular-[\w-]+\.woff2$/,
}

/** Must run before the app is ready: fonts need a standard, CORS-enabled scheme. */
export function registerFontScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: FONT_SCHEME, privileges: { standard: true, secure: true, corsEnabled: true } }])
}

export function serveGranolaFonts(log: (message: string) => void): void {
  const files = locateFaces()
  log(files.size ? `fonts: using ${files.size} faces from Granola.app` : 'fonts: Granola.app not found; using fallback fonts')
  protocol.handle(FONT_SCHEME, (request) => {
    const file = files.get(new URL(request.url).hostname)
    if (!file) return new Response(null, { status: 404 })
    return new Response(readFileSync(file), { headers: { 'content-type': 'font/woff2', 'access-control-allow-origin': '*' } })
  })
}

function locateFaces(): Map<string, string> {
  let names: string[]
  try {
    names = readdirSync(GRANOLA_ASSETS)
  } catch {
    return new Map()
  }
  const faces = new Map<string, string>()
  for (const [face, pattern] of Object.entries(FACES)) {
    const name = names.find((n) => pattern.test(n))
    if (name) faces.set(face, join(GRANOLA_ASSETS, name))
  }
  return faces
}
