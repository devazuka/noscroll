//import type * as _ from 'https://deno.land/x/deno@v1.9.0/cli/dts/lib.dom.d.ts'
import * as AG from 'https://cdn.jsdelivr.net/npm/ag-grid-community@29.3.4/dist/ag-grid-community.esm.min.js'

const $ = document.querySelector.bind(document)
// const $$ = (q) => [...document.querySelectorAll(q)]

const picker = (async () => {
  const dataFetch = fetch('https://cdn.jsdelivr.net/npm/@emoji-mart/data')
  const { Picker } = await import('https://cdn.jsdelivr.net/npm/emoji-mart@5.5.2/+esm')
  const data = await (await dataFetch).json()

  const pickerOptions = { onEmojiSelect: console.log, data }
  return new Picker(pickerOptions)
})()

const emojis = {
  'Open': '❔',
  'Reopened': '❓',
  'Closed': '🔒',
  'Backlog': '📜',
  'In Review': '🔬',
  'Under review': '🔬',
  'Done': '✅',
  'In Progress': '🚧',
  'To-be deployed': '🚀',
  'Acknowledged': '🏳️',
  'Pending information': '💬',
  'Ready for Review': '📦',
  'Ready for Dev': '💻',
  'Review Approved': '👍',
  'To Do': '📜',
  'Changes Requested': '💬',
  'Canceled': '🔒',
  'Proposed': '🙋',
  'Awaiting Elaboration': '⏳',
  'Elaborating': '👩‍🔬',
  'Implementing': '🐥',
  'Implement Next': '🐣',
  'Implement Later': '🥚',
}
// TODO: toolbar
// hide columns
// apply global filter
// issues actions:
// - current sprint
// - component quick filters
// - sup | dev quick filter
// user actions:
// - show reported issues
// - show assigned issues
// pr actions:
// - all active PRs
// editable icon with emoji picker

const icons = Object.fromEntries([...$('template').content.children].map(e => [e.dataset.value, e]))

const clear = el => {
  while (el.firstChild) el.firstChild.remove()
}

class BaseComponent {
  init(params) {
    this.eGui = document.createElement('div')
    this.setData(params)
  }
  getGui() { return this.eGui }
  refresh(params) {
    // set value into cell again
    clear(this.eGui)
    this.setData(params)
    return true
  }
  // destroy() {}
}

class Icon extends BaseComponent {
  setData(params) {
    const icon = icons[params.value] || icons.DEFAULT
    this.eGui.title = params.value
    this.eGui.append(icon.cloneNode(true))
    // const { field } = params.colDef
    this.eGui.className = params.value
  }
}

class Emoji extends BaseComponent {
  setData(params) {
    const emoji = emojis[params.value] || '⬛'
    this.eGui.title = params.value
    this.eGui.append(emoji, ` ${params.value}`)
    // const { field } = params.colDef
    this.eGui.className = emoji
  }
}

const User = property => class User extends BaseComponent {
  setData(params) {
    if (!params.value) return
    const user = grids.users[property]?.[params.value]
    if (!user) {
      this.eGui.append(params.value)
    } else {
      const a = document.createElement('a')
      a.href = `/#users/${user.id}`
      // TODO: make link to user
      if (user.name) {
        a.title = user.name
        const [firstname] = user.name.split(' ')
        a.append(firstname)
      } else {
        a.append(user.id)
      }
      
      this.eGui.append(a)
    }
  }
}

// TODO: add link to issue in jira
const Link = getHref => class Link extends BaseComponent {
  setData(params) {
    const href = getHref(params.data)
    if (!href) return
    const a = document.createElement('a')
    a.append(params.value)
    a.href = href
    this.eGui.append(a)
  }
}

class PrLinks extends BaseComponent {
  setData(params) {
    const linkedPrs = grids.prs.byIssue[params.data.id]
    if (!linkedPrs) return
    for (const pr of linkedPrs) {
      const href = `#prs/${pr.id}`
      if (!href) return
      const a = document.createElement('a')
      a.append(`${pr.repo}/${pr.number}`)
      a.href = href
      this.eGui.append(a, ' ')
    }
  }
}

const DAY = 86400000
const units = [
  [DAY * 365, 'year'],
  [(DAY * 365) / 12, 'month'],
  [DAY * 7, 'week'],
  [DAY, 'day'],
  [3600000, 'hour'],
  [60000, 'minute'],
  [1000, 'second'],
]
const pad0 = s => String(s).padStart(2, '0')
const rtf = new Intl.RelativeTimeFormat('en', { style:'short' })
class RelativeDate extends BaseComponent {
  setData(params) {
    const now = Date.now()
    if (!params.value) return
    const date = new Date(params.value)
    const elapsed = now - date.getTime()
    const formatedDate = `${pad0(date.getDate())}/${pad0(date.getMonth()+1)}/${date.getFullYear()}`
    for (const [amount, unit] of units) {
      if (Math.abs(elapsed) <= amount && unit !== 'second') continue
      const relativeDate = rtf.format(Math.round(-elapsed/amount), unit)
      if (elapsed > (DAY * 8)) {
        this.eGui.append(formatedDate)
        this.eGui.title = relativeDate
      } else {
        this.eGui.append(relativeDate)
        this.eGui.title = formatedDate
      }
      break
    }
  }
}

class LinkedIssues extends BaseComponent {
  setData(params) {
    if (!Array.isArray(params.value)) return
    const issues = grids.issues.byId
    for (const { type, to } of params.value) {
      const issue = issues[to]
      const a = document.createElement('a')
      a.append(to)
      a.href = `#issues/${to}`
      a.title = `${type} ${to} ${issue?.summary || ''}`
      this.eGui.append(a, ' ')
    }
  }
}

const linkedIssueGetter = key => params => grids.issues.byId[params.data.issue]?.[key]
class IssueLink extends BaseComponent {
  setData(params) {
    const issue = grids.issues.byId[params.value]
    if (!issue) return
    const href = `#issues/${issue.id}`
    const a = document.createElement('a')
    a.className = `issue-link ${issue.type}`
    a.append(issue.id)
    a.href = href
    this.eGui.append(a)
  }
}

const grids = {
  issues: {
    byId: {},
    dataPreProcessing: (issues) => {
      const { byId } = grids.issues
      for (const issue of issues) {
        byId[issue.id] = issue
        const [project, number] = issue.id.split('-')
        issue.project = project
        issue.number = Number(number)
        issue.created = new Date(issue.created)
        issue.updated = new Date(issue.updated)
      }
      return issues
    },
    options: {
      defaultColDef: { sortable: true, filter: true, resizable: true },
      getRowId: ({ data }) => data.id,
      columnDefs: [
        {
          cellClass: 'compact',
          headerClass: 'compact',
          headerName: '',
          resizable: false,
          pinned: 'left',
          lockPosition: 'left',
          field: 'type',
          width: '30px',
          cellRenderer: Icon,
        },
        {
          cellClass: 'compact',
          headerClass: 'compact',
          headerName: '',
          field: 'project',
          width: '30px',
          pinned: 'left',
          lockPosition: 'left',
          resizable: false,
        },
        {
          headerName: '',
          headerClass: 'compact',
          cellClass: 'compact',
          field: 'number',
          resizable: false,
          type: 'numericColumn',
          pinned: 'left',
          lockPosition: 'left',
          width: '40px',
          cellRenderer: Link(data => `https://01talent.atlassian.net/browse/${data.id}`),
        },
        { field: 'summary',  width: '480px' },
        { field: 'status', cellRenderer: Emoji },
        { field: 'reporter', cellRenderer: User('byJira') },
        { field: 'assignee', cellRenderer: User('byJira') },
        { field: 'components' },
        { headerName: 'linked issues', cellRenderer: LinkedIssues },
        { headerName: 'linked PRs', cellRenderer: PrLinks },
        { field: 'created', filter: 'agDateColumnFilter', cellRenderer: RelativeDate, width: '90px' },
        { field: 'updated', filter: 'agDateColumnFilter', cellRenderer: RelativeDate, width: '90px' },
      ],
    },
  },
  prs: {
    byId: {},
    byIssue: {},
    dataPreProcessing: (pullRequests) => {
      const { byId, byIssue } = grids.prs
      for (const pr of pullRequests) {
        pr.created = new Date(pr.created)
        pr.updated = new Date(pr.updated)
        pr.merged && (pr.merged = new Date(pr.merged))
        const [org, rest] = pr.id.split('/')
        const [repo, number] = rest.split(':')
        pr.org = org
        pr.repo = repo
        pr.number = number
        byId[pr.id] = pr
        if (!pr.issue) continue
        byIssue[pr.issue]
          ? byIssue[pr.issue].push(pr)
          : (byIssue[pr.issue] = [pr])
      }
      return pullRequests
    },
    options: {
      defaultColDef: { sortable: true, filter: true, resizable: true },
      getRowId: ({ data }) => data.id,
      columnDefs: [
        {
          headerName: '#',
          valueGetter: p => p.data.number,
          resizable: false,
          pinned: 'left',
          lockPosition: 'left',
          width: '50px',
          headerClass: 'compact',
          cellClass: 'compact',
          type: 'numericColumn',
        },
        { field: 'org',
          width: '50px',
          pinned: 'left',
          lockPosition: 'left',
          headerClass: 'compact',
          cellClass: 'compact',
        },
        {
          field: 'repo',
          width: '150px',
          cellRenderer: Link(data => `https://github.com/${data.org}/${data.repo}/pull/${data.number}/files?diff=split&w=1`),
        },
        { headerName: '+', field: 'additions', type: 'numericColumn', headerClass: 'compact', cellClass: 'compact additions', width: '45px' },
        { headerName: '-', field: 'deletions', type: 'numericColumn', headerClass: 'compact', cellClass: 'compact deletions', width: '45px' },
        { field: 'user', cellRenderer: User('byGithub') },
        {
          headerName: 'Issue',
          children: [
            {
              valueGetter: linkedIssueGetter('type'),
              columnGroupShow: 'open',
              cellClass: 'compact',
              headerClass: 'compact',
              headerName: '',
              resizable: false,
              width: '30px',
              cellRenderer: Icon,
            },
            {
              headerName: '#',
              field: 'issue',
              width: '50px',
              cellRenderer: IssueLink,
              cellClass: 'compact',
              headerClass: 'compact',
            },
            { headerName: 'Summary', valueGetter: linkedIssueGetter('summary'), columnGroupShow: 'open' },
            { headerName: 'Status', valueGetter: linkedIssueGetter('status'), columnGroupShow: 'open' },
            { headerName: 'Components', valueGetter: linkedIssueGetter('components'), columnGroupShow: 'open' },
          ]
        },
        { field: 'merged', filter: 'agDateColumnFilter', cellRenderer: RelativeDate, width: '90px' },
        { field: 'created', filter: 'agDateColumnFilter', cellRenderer: RelativeDate, width: '90px' },
        { field: 'updated', filter: 'agDateColumnFilter', cellRenderer: RelativeDate, width: '90px' },
        { field: 'state' },
      ],
    },
  },
  users: {
    byGithub: {},
    byJira: {},
    dataPreProcessing: users => {
      // fun stats to add:
      // number of PR
      // number of jira ticket
      for (const user of users) {
        user.id = user.icon || user.github || user.jira
        user.github && (grids.users.byGithub[user.github] = user)
        user.jira && (grids.users.byJira[user.jira] = user)
      }
      return grids.users.data = users
    },
    options: {
      defaultColDef: { sortable: true, filter: true, resizable: true },
      getRowId: ({ data }) => data.id,
      columnDefs: [
        { headerName: '#', field: 'icon' },
        { field: 'google' },
        { field: 'github' },
        { field: 'jira' },
        { field: 'notion' },
        { field: 'name' },
      ],
    }
  }
}

// ColumnMovedEvent
// ColumnResizedEvent
// ColumnPinnedEvent
// ColumnVisibleEvent
// columnGroupOpened
// filterChanged


// modelUpdated


AG.ModuleRegistry.registerModules([AG.ClientSideRowModelModule])
const loadGrid = async (id: keyof grids) => {
  const grid = grids[id]
  if (grid.api) return grid
  const div = document.createElement('div')
  grid.div = div
  div.id = id
  const theme = matchMedia('(prefers-color-scheme:light)').matches ? '' : '-dark'
  div.className = `ag-theme-alpine${theme} grid`
  document.body.append(div)
  const stateKey = `${id}-column-state`
  let stateUpdate
  grid.options.onColumnMoved =
  grid.options.onModelUpdated =
  grid.options.onColumnResized =
  grid.options.onFilterChanged = () => {
    clearTimeout(stateUpdate)
    stateUpdate = setTimeout(() => {
      console.log('update state of', id)
      localStorage[stateKey] = JSON.stringify(grid.columnApi.getColumnState())
    }, 16)
  }
  const { gridOptions } = new AG.Grid(div, grid.options)
  grid.api = gridOptions.api
  grid.columnApi = gridOptions.columnApi
  const prevColumnState = localStorage[stateKey]
  if (prevColumnState) {
    try {
      const state = JSON.parse(prevColumnState)
      grid.columnApi.applyColumnState({ state })
    } catch (err) {
      localStorage[stateKey] = ''
    }
  }
  const data = await (await fetch(`./data.json?table=${div.id}`)).json()
  grid.api.setRowData(grid.dataPreProcessing ? grid.dataPreProcessing(data) : data)
  return grid
}

const loadActiveGrid = async () => {
  const [id, ...select] = location.hash.slice(1).split('/')
  document.body.dataset.grid = id
  localStorage.lastHash = `#${id}`
  const grid = grids[id]
  if (!grid) {
    const { lastHash } = localStorage
    location.hash = (lastHash && lastHash !== location.hash) ? lastHash : `#issues`
    return
  }
  await loadGrid(id)
  if (!select) return
  const selectId = select.join('/')
  grid.api.forEachNode(node => {
    const isSelected = node.data.id === selectId
    node.setSelected(isSelected)
    isSelected && grid.api.ensureIndexVisible(node.rowIndex, 'middle')
  })
}
addEventListener("hashchange", loadActiveGrid)

await loadActiveGrid()
await Promise.all(Object.keys(grids).map(loadGrid))

// refresh all after load finished
for (const { api } of Object.values(grids)) api.refreshCells({ force: true })

// const savedState = gridOptions.columnApi.getColumnState(); 
// 
// // restore the column state
// gridOptions.columnApi.applyColumnState({ state: savedState });

window.grids = grids

