import { JIRA_TOKEN } from './env.ts'
import * as db from './db.ts'
import { syncFactory, rateLimit } from "./sync.ts";


// db.run(`DROP TABLE IF EXISTS issue`)
db.run(`
-- Jira Issues
CREATE TABLE IF NOT EXISTS issue (
  id TEXT PRIMARY KEY -- PROJECT-111
  , summary TEXT NOT NULL
  , status TEXT NOT NULL
  , reporter TEXT
  , assignee TEXT
  , created INTEGER NOT NULL
  , updated INTEGER NOT NULL
  , priority TEXT CHECK(priority IN ('HIGH', 'MEDIUM', 'LOW'))
  , type TEXT NOT NULL
  , FOREIGN KEY (reporter) REFERENCES user(jira)
  , FOREIGN KEY (assignee) REFERENCES user(jira)
);

-- Issue Links Types
CREATE TABLE IF NOT EXISTS issue_link_type (
  type TEXT PRIMARY KEY
  , inward TEXT NOT NULL
  , outward TEXT NOT NULL
);

-- Issue Links
CREATE TABLE IF NOT EXISTS issue_link (
  type TEXT NOT NULL -- relates to | resolve etc...
  , inward TEXT NOT NULL
  , outward TEXT NOT NULL
  , PRIMARY KEY (inward, outward, type)
  , FOREIGN KEY (type) REFERENCES issue_link_type(type)
  , FOREIGN KEY (inward) REFERENCES issue(id)
  , FOREIGN KEY (outward) REFERENCES issue(id)
);

-- Issue Components
CREATE TABLE IF NOT EXISTS component (
  id TEXT NOT NULL
  , issue TEXT NOT NULL
  , PRIMARY KEY (id, issue)
  , FOREIGN KEY (issue) REFERENCES issue(id)
);
`)

type Issue = {
  id: string
  summary: string
  type: string,
  status: string
  reporter: string
  assignee?: string
  created: number
  updated: number
}
const upsertIssue = db.prepare.exec<Issue>(`
INSERT INTO issue(id, summary, type, status, priority, reporter, assignee, created, updated)
VALUES(:id, :summary, :type, :status, :priority, :reporter, :assignee, :created, :updated)
  ON CONFLICT(id) DO UPDATE SET summary = excluded.summary
    , type = excluded.type
    , status = excluded.status
    , priority = excluded.priority
    , reporter = excluded.reporter
    , assignee = excluded.assignee
    , updated = excluded.updated
    , created = excluded.created
`)

const upsertUser = db.prepare.exec<{
  jira: string
  name: string
  tz: string
}>(`
INSERT INTO user(jira, name, tz)
VALUES(:jira, :name, :tz)
  ON CONFLICT(jira) DO UPDATE SET name = excluded.name
    , tz = excluded.tz
`)

const upsertIssueLinkType = db.prepare.exec<{
  outward: string
  inward: string
  type: string
}>(`
INSERT INTO issue_link_type(type, inward, outward)
VALUES(:type, :inward, :outward)
  ON CONFLICT(type) DO UPDATE SET type = excluded.type
    , inward = excluded.inward
    , outward = excluded.outward
`)

const deleteIssueLink = db.prepare.exec<{ issue: string }>(`
DELETE FROM issue_link WHERE (inward = :issue OR outward = :issue)
`)
const insertLink = db.prepare.exec<{
  outward: string
  inward: string
  type: string
}>(`
INSERT INTO issue_link(inward, outward, type)
VALUES(:inward, :outward, :type)
`)

const deleteIssueComponent = db.prepare.exec<{ issue: string }>(`
DELETE FROM component WHERE (issue = :issue)
`)
const insertComponent = db.prepare.exec<{ id: string, issue: string }>(`
INSERT INTO component(id, issue)
VALUES(:id, :issue)
`)

const headers = {
  authorization: `Basic ${btoa(`clement@01talent.com:${JIRA_TOKEN}`)}`,
  accept: 'application/json',
  'content-type': 'application/json',
}

const jira = rateLimit(1000, async (path: string, payload: unknown) => {
  const res = await fetch(
    `https://01talent.atlassian.net/${path}`,
    { headers, method: 'POST', body: JSON.stringify(payload) },
  )
  if (!res.ok) {
    const body = await res.text()
    try {
      console.log(JSON.parse(body))
    } catch {
      console.log(body)
      console.log(res.headers)
    }
    throw Error(`${res.statusText} (${res.status})`)
  }
  return res.json()
})

type SearchResults = {
  expand: string
  startAt: number
  maxResults: number
  total: number
  issues: JiraIssue[]
}

type Named = { name: string }
type JiraIssue = {
  key: string
  fields: {
    summary: string
    status: Named
    reporter: JiraUser
    components: Named[]
    created: string
    updated: string
    assignee?: JiraUser
    issuelinks: {
      id: string
      type: { name: string, inward: string, outward: string }
      outwardIssue?: JiraIssue
      inwardIssue?: JiraIssue
    }[]
  }
}

type JiraUser = {
  displayName: string
  accountId: string
  timeZone: string
}

const toUser = (user?: JiraUser) => {
  if (!user) return
  upsertUser({ jira: user.accountId, name: user.displayName, tz: user.timeZone })
  return user.accountId
}
const toStr = <T>(unk: unknown, fallback: T) => typeof unk === 'string' ? unk : fallback
const toJiraDate = (time: string | number | Date) => {
  const d = new Date(time)
  const yyyy = d.getUTCFullYear()
  const MM = d.getUTCMonth() + 1
  const dd = d.getUTCDate()
  const HH = (d.getUTCHours() + 1) % 24
  const mm = d.getUTCMinutes()
  return `${yyyy}/${MM}/${dd} ${HH}:${mm}`
}

const syncIssues = async (latestTs, startTs, id) => {
  const latest = toJiraDate(latestTs)
  const start = toJiraDate(startTs)
  if (start === latest) return false
  const jql = `project IN (DEV, SUP) AND updated >= "${latest}" ORDER BY created DESC`
  const fields = [
    'summary',
    'status',
    'assignee',
    'reporter',
    'created',
    'updated',
    'components',
    'issuelinks',
    'issuetype',
    'priority',
  ]
  let startAt = 0
  const refs = []
  while (true) {
    const params = { startAt, jql, expand: [], fields }
    const { issues, maxResults, total } = (await jira('rest/api/3/search', params)) as SearchResults
    startAt += issues.length
    if (!issues.length) return
    if (startAt < total) {
      console.log((startAt / total * 100).toFixed(2)+'%', { at: startAt, max: total, id })
    }
    for (const { fields, key } of issues) {
      refs.push(key)
      upsertIssue({
        id: key,
        summary: toStr(fields.summary, ''),
        status: toStr(fields.status?.name, ''),
        assignee: toUser(fields.assignee as JiraUser),
        reporter: toStr(toUser(fields.reporter as JiraUser), 'unk'),
        created: new Date(toStr(fields.created, 0)).getTime(),
        updated: new Date(toStr(fields.updated, 0)).getTime(),
        priority: fields.priority?.name.toUpperCase(),
        type: fields.issuetype.name.toUpperCase(),
      })
      deleteIssueComponent({ issue: key })
      for (const { name } of fields.components) {
        insertComponent({ id: name, issue: key })
      }
      deleteIssueLink({ issue: key })
      for (const { type, outwardIssue, inwardIssue } of fields.issuelinks) {
        upsertIssueLinkType({ type: type.name, outward: type.outward, inward: type.inward })
        if (outwardIssue) {
          insertLink({ outward: outwardIssue.key, inward: key, type: type.name })
        } else if (inwardIssue) {
          insertLink({ outward: key, inward: inwardIssue.key, type: type.name })
        }
      }
    }
    if (issues.length < maxResults) break
  }
  return refs
}

const resyncAll = () => syncIssues(0, Date.now())
const sync = syncFactory('jira', syncIssues)
sync.start()

const selectIssues = db.prepare.all(`
SELECT * FROM issue
`)

type Component = { id: string, issue: string }
const selectComponents = db.prepare.all(`
SELECT * FROM component
`)

type IssueLink = { type: string, outward: string, inward: string}
const selectIssueLinks = db.prepare.all(`
SELECT * FROM issue_link
`)

type IssueLinkType = IssueLink
const selectIssueLinksTypes = db.prepare.all(`
SELECT * FROM issue_link_type
`)

type Link = { type: string, to: string }
type PopulateIssue = Issue & { components: string[], links: Link[] }

export const getIssues = () => {
  const linkTypes: Record<string, IssueLinkType> = {}
  for (const linkType of selectIssueLinksTypes() as IssueLinkType[]) {
    linkTypes[linkType.type] = linkType
  }
  const issues: Record<string, PopulateIssue> = {}
  for (const issue of selectIssues() as PopulateIssue[]) {
    issues[issue.id] = issue
    issue.components = []
    issue.links = []
  }

  for (const component of selectComponents() as Component[]) {
    issues[component.issue]?.components.push(component.id)
  }

  for (const link of selectIssueLinks() as IssueLink[]) {
    const type = linkTypes[link.type]
    if (!type) continue
    issues[link.outward]?.links.push({ type: type.outward, to: link.inward })
    issues[link.inward]?.links.push({ type: type.inward, to: link.outward })
  }
  return issues
}
