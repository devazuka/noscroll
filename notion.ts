import Holidays from 'npm:date-holidays'
import * as db from './db.ts'
import { levensthein } from './levensthein.ts'
import { NOTION_TOKEN } from './env.ts'
import { normalize } from 'https://deno.land/std@0.187.0/path/win32.ts'
`
-- Date
CREATE TABLE IF NOT EXISTS date (
  id TEXT PRIMARY KEY -- notion object id
  , user TEXT NOT NULL
  , start INTEGER
  , end INTEGER
  , FOREIGN KEY(user) REFERENCES user(notion)
);
`

const API_HEADERS = {
	Authorization: `Bearer ${NOTION_TOKEN}`,
	"Content-Type": "application/json",
	"Notion-Version": "2021-08-16",
}


const API = async (path, data) => {
	const body = data && JSON.stringify(data)
	const params = { method: "POST", headers: API_HEADERS, body }
	const res = await fetch(`https://api.notion.com/v1/${path}`, params)

	if (res.status < 200 || res.status > 299) {
		const body = await res.text()
		if (res.status === 204) return
		try {
			const { code, message } = JSON.parse(body)
			console.log(path, data, { status: res.status, code, message })
			const err = Error(`API Error: ${code} - ${message}`) as Error & { status: number }
			err.status = res.status
			throw err
		} catch {
			console.log(path, data, body)
			const err = Error(`API Error: ${res.status} - ${res.statusText}`) as Error & { status: number }
			err.status = res.status
			throw err
		}
	}

	return res.json()
}

const getText = item => item.title?.[0]?.plain_text
const getName = item => item.name
const fetchDatabase = async (databaseId, cursor) => {
	const params = { start_cursor: cursor, page_size: 100 }
	const response = await API(`databases/${databaseId}/query`, params)
	if (!response.next_cursor) return response.results
	return [
		...response.results,
		...(await fetchDatabase(databaseId, response.next_cursor)),
	]
}

const findNotionUser = db.prepare.one<[], {count: number}, [number, string]>(`
SELECT count(*) as count
  FROM user
 WHERE notion = ? OR (google = ? AND google IS NOT NULL)`)
const findPotentialUsers = db.prepare.all<[], {jira: string, name: string}>(`
SELECT jira, name
  FROM user
 WHERE notion IS NULL
   AND name IS NOT NULL
   AND jira IS NOT NULL`)

const updateUser = db.prepare.exec(`
UPDATE user
   SET notion = :notion, google = :google
 WHERE jira = :jira`)

const insertUser = db.prepare.exec(`
INSERT INTO user (notion, google, name)
VALUES (:notion, :google, :name)
`)

const updateUser2 = db.prepare.exec(`
UPDATE user
   SET name = :name, google = :google
 WHERE notion = :notion`)

//const pages = await fetchDatabase("2457f6e6834648bc8d82d0abdb16c7fa")
//Deno.writeTextFileSync('./tmp.json', JSON.stringify(pages))
const pages = JSON.parse(Deno.readTextFileSync('./tmp.json'))

console.log(Holidays)


db.prepare.exec(`UPDATE user
   SET notion = null, google = null
 WHERE notion IS NOT NULL`)()

db.prepare.exec(`
DELETE FROM user
 WHERE jira IS NULL`)()

const normalize = s => s.toUpperCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
const byDistance = (a, b) => a.distance - b.distance
for (const page of pages) {
	if (page.object !== 'page') continue // only handle pages, should not happen
	if (page.archived) {
		// check if we have to remove something
		continue
	}
	const created = new Date(page.created_time)
	const updated = new Date(page.last_edited_time)
	
	// properties:
	const { properties } = page
	// - type
	const type = properties.Type.select?.name
	const user = properties.Person.people[0]
	if (!user?.name || !type) continue // misc pages like public holidays
	// - dates
	const start = new Date(properties.Dates.date.start)
	const end = new Date(properties.Dates.date.end)
	// find matching user:
	const google = user.person?.email?.replace('@01talent.com', '') || null
	if (!findNotionUser([user.id, google]).count) {
		const potentials = findPotentialUsers()
		for (const potential of potentials) {
			const fullName = normalize(potential.name)
			const [first, last] = fullName.split(' ')
			potential.fullName = fullName
			potential.first = first
			potential.last = last
		}
		const fullName = normalize(user.name)
		const [first, last] = fullName.split(' ')
		const match =
	       potentials.find(p => fullName === p.fullName)
			|| potentials.find(p => first === p.first)
			|| potentials.find(p => last === p.first)
			|| potentials.find(p => last && (last === p.first))
			|| potentials.find(p => last && (last === p.last))

		if (match) {
			console.log('match', user.name, 'with', match.name)
			updateUser({ jira: match.jira, notion: user.id, google })
		} else {
			insertUser({ name: user.name, notion: user.id, google })
		}
	}
		// find if user.id match user.notion
		// if no matches:
		// look for users with names and without notion matches
		// in those find the one with the highest similiarity
		// if high, choose him
		// if no names close enough, create new user

	// user.id
	// user.name
	// user.person.email
//	console.log({
//		start, end, created, updated, type, user
//	})

}



/*
const getSprint = item => item?.multi_select.map(getName) || []
const formatFeature = data => ({
	id: data.id,
	url: data.url,
	createdAt: new Date(data.created_time).getTime(),
	updatedAt: new Date(data.last_edited_time).getTime(),
	title: getText(data.properties["Feature"]),
	owner: data.properties["Owner"]?.people.map(getName).filter(Boolean),
	sprints: [
		...new Set(
			data.properties["Linked sprints"]?.rollup?.array.flatMap(getSprint),
		),
	],
	archived: data.archived || undefined,
	type: "feature",
	linked: data.properties["Linked tasks"]?.rollup?.array
		.map(getText)
		.filter(Boolean),
})

const formatTask = data => ({
	id: data.id,
	url: data.url,
	createdAt: new Date(data.created_time).getTime(),
	updatedAt: new Date(data.last_edited_time).getTime(),
	title: getText(data.properties["Task"]),
	owner: data.properties["Owner"]?.people.map(getName).filter(Boolean),
	sprints: [
		...new Set(
			data.properties["Linked sprints"]?.rollup?.array.flatMap(getSprint),
		),
	],
	archived: data.archived || undefined,
	type: "task",
})

const formatBug = data => ({
	id: data.id,
	url: data.url,
	createdAt: new Date(data.created_time).getTime(),
	updatedAt: new Date(data.last_edited_time).getTime(),
	title: getText(data.properties["Issue"]),
	owner: data.properties["Owner"]?.people.map(getName).filter(Boolean),
	sprints: [
		...new Set(
			data.properties["Linked sprints"]?.rollup?.array.flatMap(getSprint),
		),
	],
	archived: data.archived || undefined,
	type: "bug",
})

// const HTML = await Deno.readTextFile(`${Deno.cwd()}/dashboard.html`)


const updateCache = async () => {
	const [bugs, tasks, features] = await Promise.all([
		fetchDatabase("734a0ee4c78f487fb66deede64addfff"),
		fetchDatabase("1aa5ea4440534585ab4ead4396d27725"),
		fetchDatabase("4dcfca5fe4d14df08ad14c24c41d8206"),
	])

	const tickets = JSON.stringify([
		...features.map(formatFeature),
		...tasks.map(formatTask),
		...bugs.map(formatBug),
	])

	const at = String(Date.now())
	const body = HTML.replace("window.$TICKETS", tickets).replace(
		"window.$CACHE_AT",
		at,
	)

	localStorage.at = at
	localStorage.tickets = tickets
	localStorage.body = body
	return { tickets, at, body }
}

const initOrLoadCache = () => {
	const at = Number(localStorage.at) || 0
	return at ? { at, tickets: localStorage.tickets } : updateCache()
}

const makeTicketResponse = ({ tickets, at }) =>
	new Response(localStorage.tickets, {
		headers: {
			"content-type": "application/json",
			"x-cache-at": localStorage.at,
		},
	})

const MIN = 1000 * 60
const handleRequest = async ({ request }) => {
	const type = request.headers.get("content-type")
	const cache = await initOrLoadCache()
	if (!type.includes("application/json")) return new Response(cache.body)

	// rate limit cache update
	return Date.now() - cache.at < MIN
		? makeTicketResponse()
		: updateCache().then(makeTicketResponse)
}

addEventListener("fetch", async event => {
	try {
		event.respondWith(await handleRequest(event))
	} catch (err) {
		event.respondWith(new Response(err.stack, { status: err.status || 500 }))
	}
})
*/