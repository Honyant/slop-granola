// SQLite access through Node's built-in `node:sqlite`.
//
// Why node:sqlite over better-sqlite3: the same module loads in Electron's Node
// and in plain Node (unit tests) with no native rebuild for Electron's ABI, and
// its synchronous API matches how we use SQLite (short transactions on the main
// process, no ORM). The API is marked experimental, so it is confined to this
// file and the repositories.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { MIGRATIONS } from './migrations'

export type Row = Record<string, SQLInputValue>
export type Params = Record<string, SQLInputValue> | SQLInputValue[]

export class Db {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;')
    this.migrate()
  }

  all<T>(sql: string, params: Params = []): T[] {
    const stmt = this.stmt(sql)
    return (Array.isArray(params) ? stmt.all(...params) : stmt.all(params)) as T[]
  }

  get<T>(sql: string, params: Params = []): T | undefined {
    const stmt = this.stmt(sql)
    return (Array.isArray(params) ? stmt.get(...params) : stmt.get(params)) as T | undefined
  }

  run(sql: string, params: Params = []): { changes: number } {
    const stmt = this.stmt(sql)
    const result = Array.isArray(params) ? stmt.run(...params) : stmt.run(params)
    return { changes: Number(result.changes) }
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  /** Runs `fn` atomically. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.depth++
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.depth--
    }
  }

  close(): void {
    this.db.close()
  }

  private depth = 0
  private readonly cache = new Map<string, ReturnType<DatabaseSync['prepare']>>()

  private stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    let stmt = this.cache.get(sql)
    if (!stmt) {
      stmt = this.db.prepare(sql)
      this.cache.set(sql, stmt)
    }
    return stmt
  }

  private migrate(): void {
    const { user_version: current } = this.get<{ user_version: number }>('PRAGMA user_version')!
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.transaction(() => {
        MIGRATIONS[version]!(this)
        this.exec(`PRAGMA user_version = ${version + 1}`)
      })
    }
  }
}
