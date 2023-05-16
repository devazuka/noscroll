import * as db from './db.ts'

// db.run(`DROP TABLE sync`);
db.run(`
-- Sync time table
CREATE TABLE IF NOT EXISTS sync (
  provider TEXT PRIMARY KEY
  , updated INTEGER NOT NULL
);`)

const selectSync = db.prepare.all<[number], { updated: number }, [string]>(`
SELECT updated FROM sync WHERE provider = ? LIMIT 1
`)

const selectLatestSync = db.prepare.all<[number], { updated: number }, []>(`
SELECT updated FROM sync ORDER BY updated DESC LIMIT 1
`)

const upsertSync = db.prepare.exec<{ provider: string, updated: number }>(`
INSERT INTO sync(provider, updated)
VALUES(:provider, :updated)
  ON CONFLICT(provider) DO UPDATE SET updated = excluded.updated
`)

type ChangeHandler = (change: Change) => unknown
const subs: Set<ChangeHandler> = new Set()
export const onChange = (handler: ChangeHandler) => {
  subs.add(handler)
  return () => subs.delete(handler)
}
const emitChange = (change: Change) => {
  for (const handler of subs) {
    try { handler(change) }
    catch (err) {
      console.log('error while running', { handler: String(handler), change }, err)
    }
  }
}

export const rateLimit = <T extends (...args: Parameters<T>) => ReturnType<T>>(delay = 1000, action: T) => {
  let count = -1
  const start = Date.now()
  const timerHandler = (s: Parameters<typeof setTimeout>[0]) => {
    const next = start + (++count * delay)
    setTimeout(s, Math.max(next - Date.now(), 0))
  }
  return async (...args: Parameters<T>) => {
    await new Promise(timerHandler)
    return action(...args)
  }
}

const CHANGES_MEMORY_CAP = 2000
type Change = { at: number, provider: string, refs: string[], prev?: Change, next?: Change }
let changesTail: Change | undefined
let changesHead: Change | undefined
let changesCount = 0
const processStarted = (selectLatestSync() as { updated: number }[])[0]?.updated
export const getChangedAt = () => changesHead?.at || processStarted
export const getChangesLimit = () => changesTail?.at || Date.now()
export const getChangesSince = (ts: number) => {
  const providers: Record<string, Set<string>> = {}
  let change = changesHead
  while (change) {
    if (change.at < ts) continue
    const set = (providers[change.provider] || (providers[change.provider] = new Set()))
    for (const ref of change.refs) set.add(ref)
    change = change.prev
  }
  return Object.entries(providers)
}

export const syncFactory = (provider: string, syncHandler: (latest: number, start: number) => Promise<false | string[]>) => {
  let id = Math.random().toString(36).slice(2)
  const sync = async () => {
    const latest = (selectSync([provider]) as { updated: number }[])[0]?.updated || 0
    const start = Date.now()
    const refs = await syncHandler(latest, start, id)
    if (!refs) return
    upsertSync({ provider, updated: start })
    console.log(provider, `updated ${refs.length} at`, start)
    if (!refs.length) return
    const change = { at: start, provider, refs, prev: changesHead }
    changesHead ? (changesHead.next = change) : (changesTail = change)
    changesHead = change
    emitChange(change)

    // drop the tail to avoid memory leak
    if (changesCount < CHANGES_MEMORY_CAP) return ++changesCount
    // @ts-ignore this is never undefined since we have changes
    changesTail = changesTail.prev // @ts-ignore next one 2 :)
    changesTail.next = undefined
  }

  let pending = false
  const initSync = async () => {
    if (pending) return
    try {
      pending = true
      await sync()
    } catch (err) {
      console.log(`failed to refresh ${provider}`, err)
    } finally {
      pending = false
    }
  }

  let interval = 0
  return {
    start(delay = 1000) {
      interval = setInterval(initSync, delay)
      return initSync()
    },
    stop() { clearInterval(interval) }
  }
}

