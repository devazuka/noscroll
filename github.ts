import { GITHUB_TOKEN } from './env.ts'
import * as db from './db.ts'
import { syncFactory, rateLimit } from './sync.ts'

// db.run(`DROP TABLE pr`);
db.run(`
-- Pull Request
CREATE TABLE IF NOT EXISTS pr (
  id TEXT PRIMARY KEY -- org/repo-111
  , user TEXT NOT NULL
  , title TEXT NOT NULL
  , created INTEGER NOT NULL
  , updated INTEGER NOT NULL
  , additions INTEGER NOT NULL
  , deletions INTEGER NOT NULL
  , issue TEXT          -- 
  , merged INTEGER      -- merge date (null -> not merged)
  , state TEXT CHECK(state IN ('DRAFT', 'OPEN', 'CLOSED'))
  , FOREIGN KEY(user) REFERENCES user(github)
  , FOREIGN KEY(issue) REFERENCES issue(id)
);
`)

export type PullRequest = {
  id: string
  user: string
  created: number
  updated: number
  merged?: number
  additions: number
  deletions: number
  issue: string
  state: 'DRAFT' | 'OPEN' | 'CLOSED'
}

const upsertPullRequest = db.prepare.exec<PullRequest>(`
INSERT INTO pr(id, user, created, updated, merged, additions, deletions, issue, state)
VALUES(:id, :user, :created, :updated, :merged, :additions, :deletions, :issue, :state)
  ON CONFLICT(id) DO UPDATE SET user = excluded.user
    , created = excluded.created
    , updated = excluded.updated
    , merged = excluded.merged
    , additions = excluded.additions
    , deletions = excluded.deletions
    , issue = excluded.issue
    , state = excluded.state
`)

type GraphQLError = {
  message: string
  type: string
  line: number
  column: number
}

type GraphQLResult<T> = {
  data: T,
  errors?: GraphQLError[]
  message?: string
  documentation_url?: string
}

const headers = {
  accept: 'application/vnd.github.shadow-cat-preview+json',
  'content-type': 'application/json',
  Authorization: `bearer ${GITHUB_TOKEN}`,
}

const getFirstProp = obj => Object.values(obj || {})[0]

const graphql = rateLimit(1000, async (query: string, variables?: Record<string, unknown>) => {
  const res = await fetch('https://api.github.com/graphql', {
    headers,
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  })
  const { data, errors, ...error } = await res.json() as GraphQLResult<unknown>
  if (data) return data
  const { message, ...details } = errors?.[0] || error
  const err = Error(message)
  Object.assign(err, details)
  throw err
})

type GithubRepo = {
  name: string
  pushedAt: string
}

const getRepos = async (variables: Record<string, unknown>) => graphql(`
query getRepos($org: String!, $first: Int!, $after: String) {
  organization(login: $org) {
    repositories(
      first: $first,
      after: $after,
      isLocked: false,
      orderBy: { field: PUSHED_AT, direction: DESC }
    ) {
      pageInfo {
        endCursor
        hasNextPage
      }
      nodes {
        name
        pushedAt
      }
    }
  }
}`, variables)


type GithubPr = {
  author: { login: string }
  number: number
  isDraft: boolean
  updated: string
  created: string
  additions: number
  deletions: number
  merged: string | null
  state: "MERGED" | "OPEN" | "CLOSED"
  branch: string
}

const getPR = async (variables: Record<string, unknown>) => graphql(`
query getPR($repo: String!, $first: Int!, $after: String) {
  repository(owner: "01-edu" name: $repo) {
    pullRequests(
      first: $first
      after: $after
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      pageInfo {
        endCursor
        hasNextPage
      }
      nodes {
        author { login }
        number
        isDraft
        updated: updatedAt
        created: publishedAt
        additions
        deletions
        merged: mergedAt
        state
        branch: headRefName
      }
    }
  }
}
`, variables)

type PaginatedResult = {
  nodes: unknown[]
  pageInfo: {
    endCursor: string
    hasNextPage: boolean
  }
}

const allPages = async (query: typeof getPR, first: number, variables: Record<string, unknown>, handler: Function) => {
  let after
  let count = 0
  while (true) {
    const data = await query({ ...variables, first, after })
    let result = getFirstProp(data) as PaginatedResult
    while (result) {
      if (result.pageInfo && result.nodes) break
      result = getFirstProp(result) as PaginatedResult
    }
    if (!result) throw Error('missing pageInfo from result')
    const { nodes, pageInfo } = result as PaginatedResult
    after = pageInfo.endCursor
    if (!nodes.length) return
    count += nodes.length
    console.log(variables, count)
    for (const node of nodes) {
      const break_loop = await handler(node)
      if (break_loop) return
    }
  }
}

const sync = syncFactory('github', async (latest, start) => {
  const minElapsed = Math.floor((start - latest) / 60_000)
  if (minElapsed < 1) return false
  const pageSize = Math.max(5, Math.min(100, minElapsed))
  const refs: string[] = []
  await allPages(getRepos, pageSize, { org: '01-edu'}, async (repo: GithubRepo) => {
    const pushedAt = new Date(repo.pushedAt).getTime()
    if (pushedAt < latest) return true // break the loop
    await allPages(getPR, pageSize, { repo: repo.name }, (pr: GithubPr) => {
      const updated = new Date(pr.updated).getTime()
      if (updated < latest) return true // break the loop
      const id = `01-edu/${repo.name}:${pr.number}`
      refs.push(id)
      upsertPullRequest({
        id,
        user: pr.author.login,
        created: new Date(pr.created).getTime(),
        updated,
        merged: pr.merged ? new Date(pr.merged).getTime() : undefined,
        additions: pr.additions,
        deletions: pr.deletions,
        issue: pr.branch.split(/^(DEV-[0-9]+)/)[1],
        state: pr.state === 'OPEN' ? (pr.isDraft ? 'DRAFT' : 'OPEN') : 'CLOSED',
      })
    })
  })

  return refs
})

sync.start()

const selectPr = db.prepare.all('SELECT * FROM pr')

export const getPullRequests = (): PullRequest[] => selectPr()
