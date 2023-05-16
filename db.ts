import { DB } from "https://deno.land/x/sqlite@v3.7.2/mod.ts"
import type { Row, RowObject, QueryParameterSet, PreparedQuery } from "https://deno.land/x/sqlite@v3.7.2/mod.ts"

const db = new DB('01.db')

db.execute(`
-- Settings
PRAGMA vacuum;
PRAGMA journal_mode = WAL; -- ignored by deno fs limitations
PRAGMA synchronous = off;
PRAGMA foreign_keys = off; -- help with order of insertion
PRAGMA temp_store = memory;

-- Users
CREATE TABLE IF NOT EXISTS user (
  icon TEXT PRIMARY KEY -- user emoji
  , google TEXT UNIQUE -- google workspace id (@01talent.com)
  , github TEXT UNIQUE
  , jira TEXT UNIQUE
  , notion TEXT UNIQUE
  , discord TEXT UNIQUE
  , name TEXT
  , tz TEXT
);
`)

export { db }
const bind = (key: keyof PreparedQuery) => <
  R extends Row = Row,
  O extends RowObject = RowObject,
  P extends QueryParameterSet = QueryParameterSet,
>(sql: string) => {
  const stmt = db.prepareQuery<R, O, P>(sql)
  return stmt[key].bind(stmt)
}

export const run = (sql: string) => db.execute(sql)
export const prepare = {
  allArray: bind('all'),
  one: bind('oneEntry'),
  all: bind('allEntries'),
  exec: <P extends QueryParameterSet,>(sql: string) => bind('execute')<unknown[], RowObject, P>(sql),
}

