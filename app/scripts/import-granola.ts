// Imports a Granola transcript export without opening the app. Same code path as
// Settings → Preferences → Import from Granola.
//
//   npx tsx --tsconfig tsconfig.node.json scripts/import-granola.ts ~/Downloads/meetings.txt
//
// Optional second argument: the app's data folder (default: ~/Library/Application Support/Granola Clone).
// The app must be closed, so the two never write to the database at once.
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AppContext } from '../src/main/context'
import { Db } from '../src/main/db/database'
import { importGranolaExport } from '../src/main/services/granolaImport'

const [file, dataDir = join(homedir(), 'Library/Application Support/Granola Clone')] = process.argv.slice(2)
if (!file) {
  console.error('usage: import-granola.ts <export.txt> [data folder]')
  process.exit(2)
}
const lock = join(dataDir, 'SingletonLock')
if (existsSync(lock) || lstatSafe(lock)) {
  console.error('Granola Clone is running; quit it first.')
  process.exit(1)
}

const ctx = new AppContext(new Db(join(dataDir, 'granola.db')), () => {})
const result = importGranolaExport(ctx, readFileSync(file, 'utf8'))
console.log(`imported ${result.imported.length}, already present ${result.skipped.length}`)
for (const title of result.imported) console.log(`  + ${title}`)
for (const title of result.skipped) console.log(`  = ${title}`)

/** SingletonLock is a symlink to a host-pid name that does not exist as a file, so existsSync misses it. */
function lstatSafe(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
