import * as esbuild from 'https://deno.land/x/esbuild@v0.17.18/wasm.js'
import { extname } from "https://deno.land/std@0.187.0/path/mod.ts"
import { contentType } from "https://deno.land/std@0.187.0/media_types/content_type.ts"

import { PORT } from './env.ts'
import { getIssues } from './jira.ts'
import { getPullRequests } from './github.ts'
import { onChange, getChangedAt } from './sync.ts'
import { prepare } from './db.ts'

const selectUsers = prepare.all('SELECT * FROM user')

const tablesQueries = {
  issues: () => Object.values(getIssues()),
  prs: getPullRequests,
  users: selectUsers,
}

const getData = (table) => {
  if (!tablesQueries[table]) return
  const issues = tablesQueries[table]()
  const data = Object.values(issues)
  const json = JSON.stringify(data)
  return new TextEncoder().encode(json)
}

// esbuild script.ts --minify=false --bundle --format=esm --minify --outfile=bundle.min.js

const tableCache: Record<string, Uint8Array> = {}
onChange((changes) => {
  console.log(changes)
})

const handleRequest = async (req: Request) => {
  const url = new URL(req.url)
  const { pathname } = url
  if (pathname === '/data.json') {
    const headers = {
      'last-modified': new Date(getChangedAt()).toUTCString(),
      'content-type': 'application/json',
    }
    const table = url.searchParams.get('table')
    tableCache[table] || (tableCache[table] = getData(table))
    if (!tableCache[table]) {
      return new Response(`404: ${table} Not Found`, { status: 404 })
    }
    return new Response(tableCache[table], { headers, status: 200 })
  }
  if (pathname === '/ws') {
    // TODO: add websocket for live updates ! exciting ! fresh !
  }
  const filePath = pathname === '/' ? 'index.html' : `.${pathname}`
  let fileInfo: Deno.FileInfo
  try {
    fileInfo = await Deno.stat(filePath)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      await req.body?.cancel()
      return new Response(`404: ${pathname} Not Found`, { status: 404 })
    }
    throw err
  }

  if (fileInfo.isDirectory) {
    await req.body?.cancel()
    return new Response(`403: ${pathname} Forbidden`, { status: 403 })
  }

  const headers: Record<string, string> = {
    'cache-control': 'public, max-age=604800, immutable'
  }

  if (fileInfo.atime) {
    headers.date = fileInfo.atime.toUTCString()
  }

  // TODO: implement etag?
  // see: https://deno.land/std@0.187.0/http/file_server.ts?source#L168

  // Set last modified header if last modification timestamp is available
  if (fileInfo.mtime) {
    headers[`last-modified`] = fileInfo.mtime.toUTCString()
  }
  const fileSize = fileInfo.size
  headers['content-length'] = String(fileSize)

  if (pathname.endsWith('.ts')) {
    const file = await Deno.readFile(filePath)
    headers['content-type'] = 'application/javascript'
    try {
      const js = await esbuild.transform(file, { loader: 'ts' })
      esbuild.stop()
      return new Response(js.code, { headers, status: 200})
    } catch (err) {
      const errorLogCode = `console.log(${JSON.stringify(err.stack)})`
      return new Response(errorLogCode, { headers, status: 200})
    }
  }

  const type = contentType(extname(filePath))
  type && (headers['content-type'] = type)

  const file = await Deno.open(filePath)
  return new Response(file.readable, { headers, status: 200 })
}

const handleInternalServerErrors = (err: Error) => {
  console.log(err)
  return new Response(`500: ${err.message} Internal Server error`, { status: 500 })
}

const server = Deno.listen({ port: Number(PORT) })
console.log(`Server started at http://localhost:${PORT}`)
// Connections to the server will be yielded up as an async iterable.

const serveHttp = async (conn: Deno.Conn) => {
  // This "upgrades" a network connection into an HTTP connection.
  const httpConn = Deno.serveHttp(conn)
  // Each request sent over the HTTP connection will be yielded as an async
  // iterator from the HTTP connection.
  for await (const requestEvent of httpConn) {
    requestEvent.respondWith(handleRequest(requestEvent.request)
      .catch(handleInternalServerErrors))
  }
}

for await (const conn of server) serveHttp(conn)
