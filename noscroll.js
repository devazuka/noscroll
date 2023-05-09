import { Database } from 'bun:sqlite'

const M = 1000*60
const H = 60*M

const db = new Database('entries.sqlite')
db.run(`
CREATE TABLE IF NOT EXISTS entry (
  id TEXT PRIMARY KEY, -- id (ex: h:33912060, r:zjxusx)
  content TEXT NOT NULL, -- variable depend on type
  title TEXT NOT NULL,
  source TEXT NOT NULL, -- subreddit | hackernews
  type TEXT NOT NULL CHECK(type IN ('image', 'video', 'link', 'text')),
  image TEXT, -- image url
  score INTEGER, -- metric count (upvotes ?)
  at INTEGER -- timestamp of the created time
)`)
db.run('PRAGMA vacuum')
db.run('PRAGMA journal_mode = WAL')
db.run('PRAGMA synchronous = off')
db.run('PRAGMA temp_store = memory')

const get = q => q.get.bind(q)
const all = q => q.all.bind(q)
const getById = get(db.query(`SELECT id FROM entry WHERE id = ? LIMIT 1`))
const getLastId = get(db.query(`
  SELECT id
  FROM entry
  ORDER BY rowid DESC
  LIMIT 1`))

const getRowIdOf = get(db.query(`
  SELECT rowid
  FROM entry
  WHERE id = ?
  LIMIT 1
`))
const getLast25 = all(db.query(`
  SELECT *
  FROM entry
  WHERE rowid <= ?
  ORDER BY rowid DESC
  LIMIT 25
`))

const videoExt = new Set(['mp4','webm','mov'])
const imageExt = new Set(['jpg','webp','gif', 'png', 'avif', 'jpeg'])
const getUrl = url => { try { return new URL(url) } catch {} }

const getContentAndType = data => {
  if (data.is_video) return { type: 'video', content: data.media?.reddit_video?.hls_url || '???' }
  const previewImage = data.preview?.images?.[0]
  if (previewImage) {
    if (data.domain === 'gfycat.com' || data.url.endsWith('.gifv')) {
      return { type: 'image', content: data.url }
    }
    return { type: 'image', content: previewImage.source.url }
  }
  const mediaImage = data.media_metadata && Object.values(data.media_metadata)[0]
  if (mediaImage) return { type: 'image', content: mediaImage.s.u }
  const content = data.url_overridden_by_dest || data.url
  const url = getUrl(content)
  if (!url) return { type: 'text', content: `https://reddit.com${data.permalink}` }
  const ext = url.pathname.split('.').at(-1)
  if (imageExt.has(ext)) return { type: 'image', content }
  if (videoExt.has(ext)) return { type: 'video', content }
  if (url.hostname === 'www.reddit.com') return { type: 'text', content }
  return { type: 'link', content }
}

const updateScore = db.query(`UPDATE entry SET score = ? WHERE id = ?`)
const insertEntry = db.query(`
  INSERT INTO entry (id, title, type, content, image, score, source, at)
  VALUES            ( ?,     ?,    ?,       ?,     ?,      ?,     ?,  ?)
`)

const fetchReddit = async ({ sub, threshold }) => {
  let after = ''
  main: while (true) {
    // - fetch top post of the day
    const params = new URLSearchParams({
      include_unadvertisable: 1, // ?? not sure if needed
      after,
      include_over_18: 1,
      raw_json: 1,
      sort: 'top',
      t: 'day',
    })

    console.log(sub, { after })
    const headers = { 'User-Agent': 'clembot' }
    const res = await fetch(`https://www.reddit.com${sub}/top.json?${params}`, { headers })
    const result = await res.json()
    after = result.data.after
    for (const { data } of result.data.children) {
      let image = data.thumbnail
      if (data.score < threshold) break main
      let { content, type } = getContentAndType(data)
      const id = `r:${data.id}`
      if (getById(id)) {
        updateScore.run(id, data.score)
        continue
      }
      if (type === 'link') {
        const res = await fetch('https://api.peekalink.io', {
          headers: { 'X-API-Key':  Bun.env.PEEKALINK_KEY },
          method: 'POST',
          body: JSON.stringify({ link: content }),
        })
        const meta = await res.json()
        const url = meta.redirected ? meta.redirectionUrl : meta.url
        content = [url, (meta.title || '').replaceAll('\n', ' '), (meta.description || '')].join('\n')
        meta.image?.url && (image = meta.image.url)
      }
      insertEntry.run(
        id,               // id
        data.title,       // title
        type,             // type
        content,          // content
        image,            // image
        data.score,       // score
        data.subreddit,   // source
        data.created_utc, // at
      )
    }
  }
}

const fetchHN = async () => {
  const params = new URLSearchParams({ numericFilters: 'points>=250', hitsPerPage: '50' })
  const res = await fetch(`https://hn.algolia.com/api/v1/search_by_date?${params}`)
  for (const data of (await res.json()).hits) {
    const id = `hn:${data.objectID}`
    if (getById(id)) {
      updateScore.run(id, data.points)
      continue
    }

    const res = await fetch('https://api.peekalink.io', {
      headers: { 'X-API-Key':  Bun.env.PEEKALINK_KEY },
      method: 'POST',
      body: JSON.stringify({ link: data.url }),
    })
    const meta = await res.json()
    const url = meta.redirected ? meta.redirectionUrl : meta.url
    const content = [url, (meta.title || '').replaceAll('\n', ' '), (meta.description || '')].join('\n')
    const image = meta.image?.url || ''
    insertEntry.run(
      id,                // id
      data.title,        // title
      'link',            // type
      content,           // content
      image,             // image
      data.points,       // score
      'hackernews',      // source
      data.created_at_i, // at
    )
  }
}

for (const { handler, interval } of [
  { interval: 12*H, handler: () => fetchReddit({ sub: '/r/rance',           threshold:    500 }) },
  { interval:  3*H, handler: () => fetchReddit({ sub: '/r/ProgrammerHumor', threshold: 12_000 }) },
  { interval: 12*H, handler: () => fetchReddit({ sub: '/r/rienabranler',    threshold:    150 }) },
  { interval: 12*H, handler: () => fetchReddit({ sub: '/r/olkb',            threshold:    200 }) },
  { interval: 15*M, handler: () => fetchReddit({ sub: '/r/all',             threshold: 30_000 }) },
  { interval:  2*H, handler: fetchHN },
]) {
  const update = async () => {
    try {
      await handler()
    } catch (err) {
      console.error('handler failed', interval, err)
    } finally {
      setTimeout(update, interval)
    }
  }
  setTimeout(update, interval * Math.random())
}

const HTMLInit = {
  headers: new Headers({
    'Content-Type': 'text/html',
    'Cache-Control': 'max-age=31536000, immutable',
  }),
}
const JSONInit = {
  headers: new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'max-age=31536000, immutable',
  }),
}
const JSONInitNoCache = {
  headers: new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
  }),
}
const JS = String(() => {

const templates = {
  video: document.getElementById('video').content.firstElementChild,
  image: document.getElementById('image').content.firstElementChild,
  text: document.getElementById('text').content.firstElementChild,
  link: document.getElementById('link').content.firstElementChild,
}
const hashChar = (s,c) => Math.imul(31, s) + c.charCodeAt(0) | 0
const hash = str => Math.abs([...str].reduce(hashChar, 0x811c9dc5) % 36000) / 100
const makeElement = entry => {
  const li = templates[entry.type].cloneNode(true)
  const [content] = li.getElementsByClassName('content')
  const [score] = li.getElementsByClassName('score')
  const [title] = li.getElementsByClassName('title')
  const [link] = li.getElementsByClassName('link')

  const scoreHue = Math.round(Math.min(entry.score, 180_000) / 500)
  // TODO: probably use some kind of log scale for the colors ?

  title.textContent = entry.title
  link.textContent = entry.source
  link.href = entry.id.startsWith('r:')
    ? `https://libreddit.kutay.dev/r/${entry.source}/comments/${entry.id.slice(2)}?sort=top`
    : `https://news.ycombinator.com/item?id=${entry.id.slice(3)}`

  link.style.backgroundColor = `hsl(${hash(entry.source)}, 100%, 80%)`
  score.style.backgroundColor = `hsl(${scoreHue}, 100%, 70%)`
  score.textContent = entry.score > 1000 ? `${Math.round(entry.score / 1000)}k` : entry.score
  li.className = entry.source.toLowerCase()
  li.id = entry.id
  switch (entry.type) {
    case 'video': {
      const url = new URL(entry.content)
      if (url.pathname.endsWith('.m3u8')) {
        content.dataset.hls = entry.content
      } else {
        content.src = entry.content
      }
      break
    } case 'image': {
      content.src = entry.content
      break
    } case 'link': {
      const [url, title] = entry.content.split('\n')
      title.href = url
      title && (title.title = title)
      // pass-through
    } default: {
      li.style.backgroundImage = `url('${entry.image}')`
      break
    }
  }
  return li
}

if (initialEntries.length > 24) {
  const a = document.createElement('a')
  a.href = `/${initialEntries.at(-1).id}`
  a.textContent = 'next ->'
  document.querySelector('nav').append(a)
}
document.querySelector('ul').append(...initialEntries.slice(0, 24).map(makeElement))

fetch('https://cdn.jsdelivr.net/gh/libreddit/libreddit-instances@master/instances.json')
  .then(async res => {
    const { instances } = await res.json()

    const getInstanceVersionValue = ({ version }) => {
      const [major, minor = 0, patch = 0] = version.slice(1).split('.').map(Number)
      return major * 10000 + minor + (patch / 10000)
    }

    instances.sort((a, b) => getInstanceVersionValue(b) - getInstanceVersionValue(a))

    const controller = new AbortController()
    const latest = instances.filter(i => i.version === instances[0].version)
    const fastest = await Promise.race(latest.map(async ({ url }) => {
      await fetch(url, { mode: 'no-cors', signal: controller.signal })
      return url
    }))
    controller.abort()

    const domain = 'https://libreddit.kutay.dev'
    for (const a of document.getElementsByTagName('a')) {
      if (!a.href.startsWith(domain)) continue
      a.href = `${fastest}${a.href.slice(domain.length)}`
    }
  })

}).slice(7, -1)

const generateIndex = initialEntries => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=0.75">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>📜</text></svg>">
  <title>Noscroll</title>
<style>
ul {
  font-familly: monospace;
}
body, li, ul { margin: 0 }
body, a { color: #a996c6 }
body {
  max-width: 840px;
  margin: 0 auto;
  background-color: #000;
  font-family: monospace;
}
nav { text-align: right }
ul, li { padding: 0 }
ul { list-decoration: none }
h2 {
  padding: 14px;
  background: #19171c;
  margin: 0;
}
nav > a {
  display: inline-block;
  font-size: 1.5em;
  padding-top: 1em;
}
.score, .link {
  padding: 1px 4px;
  background: #d191ff;
  border-radius: 10px;
  color: #000;
  text-decoration: none;
}
li {
  background-color: #3b3642;
  margin-top: 20px;
  border-radius: 10px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  outline: 2px solid #fff1;
  outline-offset: -2px;
}
body { padding: 50px }
video {
  max-height: 840px;
}
img {
  max-width: 100%;
  margin: 0 auto;
  display: block;
  max-height: calc(100vh - 50px);
}
.link { font-weight: normal; font-style: italic }
.link::before {
  content: '/r/';
  color: #0008;
  letter-spacing: -0.2em;
  margin-right: 0.2em;
}
</style>
</head>
<body>
<template id="link">
  <li>
    <h2><span class="score">0</span> <a class="link" href="">🔗</a> <a class="title" href=""> </a></h2>
  <li>
</template>
<template id="text">
  <li>
    <h2><span class="score">0</span> <a class="link" href="">🔗</a> <span class="title"> </span></h2>
  <li>
</template>
<template id="image">
  <li>
    <h2><span class="score">0</span> <a class="link" href="">🔗</a> <span class="title"> </span></h2>
    <img class="content" src="#">
  <li>
</template>
<template id="video">
  <li>
    <h2><span class="score">0</span> <a class="link" href="">🔗</a> <span class="title"> </span></h2>
    <video class="content" controls reload="none" src="#">
  <li>
</template>
<ul></ul>
<nav></nav>
<script>
const initialEntries = ${initialEntries}
${JS}</script>
</body>
<script type="module">
// import Hls from "https://cdn.skypack.dev/hls.js?min"
import Hls from 'https://cdn.skypack.dev/-/hls.js@v1.2.9-t6kzxjKYu3APlTyoQcrP/dist=es2019,mode=imports,min/optimized/hlsjs.js'

for (const video of document.querySelectorAll('video[data-hls]')) {
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = video.dataset.hls
  } else if (Hls.isSupported()) {
    const hls = new Hls()
    const url = new URL(video.dataset.hls)

    hls.loadSource(video.dataset.hls)
    hls.attachMedia(video)
  } else {
    // TODO: handle unable to play media
  }
}

</script>
</html>`

const _404 = new Response(null, { status: 404 })
const _500 = new Response(null, { status: 500 })
const handleRequest = pathname => {
  if (pathname[2] === ':') {
    const [id, action] = pathname.slice(1).split('/')
    const entry = getRowIdOf(id)
    if (!entry) return _404
    const entries = getLast25(entry.rowid)
    if (action === 'refresh') {
      return new Response(
        JSON.stringify(entries),
        entries.length > 24 ? JSONInit : JSONInitNoCache,
      )
    }
    const body = generateIndex(JSON.stringify(entries))
    return new Response(body, HTMLInit)
  }

  if (pathname === '/') {
    const lastId = getLastId()?.id
    return new Response(null, lastId
      ? { status: 302, headers: { Location: `/${lastId}` } }
      : { status: 204 })
  }

  return _404
}

export default {
  port: Bun.env.PORT,
  fetch(request) {
    try {
      if (request.method !== 'GET') return _404
      const { pathname } = new URL(request.url)
      console.log('GET', pathname)
      return handleRequest(pathname)
    } catch (err) {
      console.error(err)
      return _500
    }
  }
}
