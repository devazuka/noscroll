import { DB as Database } from "https://deno.land/x/sqlite/mod.ts"
// TODO: switch to -> import { Database } from "https://deno.land/x/sqlite3@0.10.0/mod.ts"

const S = 1000
const M = 60*S
const H = 60*M
const D = 24*H

const decode = text => {
  try { return decodeURIComponent(text) }
  catch { return text }
}

const parseMetaProps = text => {
  let i = -1
  const max = text.length
  const props = {}
  main: while (++i < max) {
    if (text[i] === ' ') continue
    // parse key
    let j = i
    let key = ''
    while (j < max) {
      const c = text[j]
      if (c === '=') break
      if (c === ' ') {
        props[key] = true
        i = j
        continue main
      }
      key += c
      ++j
    }
    // find starting quote
    while (++j < max) {
      if (text[j] === '"' || text[j] === "'") break
    }
    const quote = text[j]
    i = ++j
    while (j < max) {
      // end quote
      if (text[++j] !== quote) continue
      props[key] = decode(text.slice(i, j))
      i = j
      continue main
    }
  }
  return props
}

const parseHTMLTags = (html, url) => {
  let i = -1
  const metas = []
  const max = html.length
  let title
  while (++i < max) {
    const c = html[i]

    // start of tag parse
    if (c !== '<') continue
    let j = i + 1
    let tag = ''
    while (j < max) {
      const lc = html[j].toLowerCase()
      if (lc < 'a' || lc > 'z') break
      tag += lc
      ++j
    }
    if (tag === 'meta') {
      i = j
      while (html[j] !== '>' && j < max) ++j
      metas.push(parseMetaProps(html.slice(i, j)))
    } else if (tag === 'title' && j < max) {
      if (!title) {
        while (html[j] !== '>' && j < max) ++j
        i = ++j
        while (html[j] !== '<' && j < max) ++j
        title = decode(html.slice(i, j))
      }
      i = j
    } else {
      i = j
      continue
    }
    i = j
  }

  const props = {}
  const meta = { title, url }
  const rest = []
  for (const m of metas) {
    if (m.itemprop) {
      props[m.itemprop.toLowerCase()] = m.content
      continue
    }

    if (!m.content) continue

    const type = (m.property && 'property') || (m.name && 'name')
    if (!type) {
      rest.push(m)
      continue
    }

    const nested = m[type].indexOf(':')
    if (nested < 0) {
      props[m[type]] = m.content
      continue
    }

    props[m[type].slice(nested + 1)] = m.content
  }

  // limit to only usefull meta: title, url, description and image
  meta.image = props.image
  props.title && (meta.title = props.title)
  props.description && (meta.description = props.description)

  return meta
}

const isValidImageUrl = async imageUrl => {
  const controller = new AbortController()
  const signal = controller.signal
  const { ok, headers } = await fetch(imageUrl, { signal })
  // we don't want to actually load up all the image, so we abort here
  controller.abort()
  return ok && headers.get('content-type').startsWith('image/')
}

const fetchMeta = async url => {
  if (!url) return {}
  try {
    const res = await fetch(url)
    const text = await res.text()
    const meta = parseHTMLTags(text, res.url)
    if (meta.image) {
      try {
        let imageUrl = new URL(meta.image, res.url)
        if (!(await isValidImageUrl(imageUrl))) {
          imageUrl = new URL(`${imageUrl.pathname}${imageUrl.search}${imageUrl.hash}`, res.url)
          if (!(await isValidImageUrl(imageUrl))) {
            console.log('invalid meta image url:', imageUrl.href)
            throw Error('failed to find valid image')
          }
        }
        meta.image = imageUrl.href
      } catch {
        // TODO: generate svg / AI image for that case ?
        meta.image = undefined
      }
    }
    return meta
  } catch {
    return {}
  }
}

const db = new Database('entries.sqlite')
db.query(`
CREATE TABLE IF NOT EXISTS entry (
  id TEXT PRIMARY KEY, -- id (ex: h:33912060, r:zjxusx)
  content TEXT NOT NULL, -- variable depend on type
  title TEXT NOT NULL,
  source TEXT NOT NULL, -- subreddit | hackernews
  type TEXT NOT NULL, -- image | video | link | text | gallery
  image TEXT, -- image url
  score INTEGER, -- metric count (upvotes ?)
  at INTEGER -- timestamp of the created time
)`)
db.query(`
CREATE TABLE IF NOT EXISTS raw (
  id TEXT PRIMARY KEY, -- id (ex: h:33912060, r:zjxusx)
  data TEXT NOT NULL -- JSON response body for debug
)
`)
db.query('PRAGMA vacuum')
db.query('PRAGMA journal_mode = WAL') // ignored by deno fs limitations
db.query('PRAGMA synchronous = off')
db.query('PRAGMA temp_store = memory')

const bind = (obj, method) => obj[method].bind(obj)
const exec = q => bind(db.prepareQuery(q), 'execute')
const get = q => bind(db.prepareQuery(q), 'firstEntry')
const all = q => bind(db.prepareQuery(q), 'allEntries')
const getById = get(`SELECT id FROM entry WHERE id = ? LIMIT 1`)
const getLastId = get(`
  SELECT id
  FROM entry
  ORDER BY rowid DESC
  LIMIT 1`)

const getRowIdOf = get(`
  SELECT rowid
  FROM entry
  WHERE id = ?
  LIMIT 1
`)
const getEntry = get(`
  SELECT *
  FROM entry
  WHERE id = ?
  LIMIT 1
`)
const getLast25 = all(`
  SELECT *
  FROM entry
  WHERE rowid <= ?
  ORDER BY rowid DESC
  LIMIT 25
`)
const getRawData = get(`
  SELECT data
  FROM raw
  WHERE id = ?
  LIMIT 1
`)

const videoExt = new Set(['mp4','webm','mov','m3u8'])
const imageExt = new Set(['jpg','webp','gif','png','avif','jpeg'])
const getUrl = url => { try { return new URL(url) } catch {} }

const getContentAndType = data => {
  if (data.is_video) return { type: 'video', content: data.media?.reddit_video?.hls_url || '???' }

  if (data.gallery_data?.items?.length > 1) {
    return {
      type: 'gallery',
      content: data.gallery_data.items.map(({ media_id }) => data.media_metadata[media_id].s.u).join('\n'),
    }
  }

  const previewVideo = data.reddit_video_preview
  if (previewVideo) return { type: 'video', content: previewVideo.hls_url }

  const previewImage = data.preview?.images?.[0]
  if (previewImage) {
    if (data.domain === 'gfycat.com' || data.url.endsWith('.gifv')) {
      return { type: 'image', content: data.url }
    }
    if (previewImage.variants?.mp4) {
      return { type: 'video', content: previewImage.variants.mp4.source.url }
    }
    return { type: 'image', content: previewImage.source.url }
  }
  const mediaImage = data.media_metadata && Object.values(data.media_metadata)[0]
  if (mediaImage) return { type: 'image', content: mediaImage.s.u }
  const content = data.url || data.url_overridden_by_dest
  const url = getUrl(content)
  if (!url) return { type: 'text', content: `https://reddit.com${data.permalink}` }
  const ext = url.pathname.split('.').at(-1)
  if (imageExt.has(ext)) return { type: 'image', content }
  if (videoExt.has(ext)) return { type: 'video', content }
  if (url.hostname === 'www.reddit.com') {
    return { type: 'text', content: data.selftext || content }
  }
  return { type: 'link', content }
}

const updateScore = exec(`UPDATE entry SET score = ? WHERE id = ?`)
const insertEntry = exec(`
  INSERT INTO entry (id, title, type, content, image, score, source, at)
  VALUES            ( ?,     ?,    ?,       ?,     ?,      ?,     ?,  ?)
`)

const insertRaw = exec(`
  INSERT INTO raw (id, data)
  VALUES          ( ?,    ?)
`)

let redditAuth
const updateRedditToken = async () => {
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Deno.env.get('REDDIT_BOT')}=`,
      'User-Agent': 'deno:_YkJcDPK6Wa3plOM0cH49w:v2024.01.25 (by /u/kigiri)',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=password&username=kigiri&password=${Deno.env.get('REDDIT_PWD')}`,
  })
  if (!res.ok) throw Error(res.statusText)
  const auth = await res.json()
  redditAuth = `${auth.token_type} ${auth.access_token}`
  setTimeout(updateRedditToken, auth.expires_in*S - 1*M)
  // TODO: cache in localStorage ?
}
await updateRedditToken()

const fetchReddit = async ({ sub, threshold }) => {
  let after = ''
  main: while (true) {
    // - fetch top post of the day
    const params = new URLSearchParams({
      t: 'week',
      after, // fullname of a thing
      //before, // fullname of a thing
      //count, // a positive integer (default: 0)
      limit: 100, // the maximum number of items desired (default: 25, maximum: 100)
      //show,  // (optional) the string all
      //sr_detail, // (optional) expand subreddits ?
    })

    console.log(sub, 'after', after)
    const headers = {
      Authorization: redditAuth,
      'User-Agent': 'deno:_YkJcDPK6Wa3plOM0cH49w:v2024.01.25 (by /u/kigiri)',
    }
    const res = await fetch(`https://oauth.reddit.com${sub}/top?${params}`, { headers })
    const result = await res.json()
    after = result.data.after
    for (const { data } of result.data.children) {
      let image = data.thumbnail
      if (data.score < threshold) break main
      let { content, type } = getContentAndType(data)
      const id = `r:${data.id}`
      if (getById([id])) {
        updateScore([id, data.score])
        continue
      }
      if (type === 'link') {
        const meta = await fetchMeta(content)
        content = [meta.url, (meta.title || '').replaceAll('\n', ' '), (meta.description || '')].join('\n')
        meta.image && (image = meta.image)
      }
      insertEntry([
        id,               // id
        data.title,       // title
        type,             // type
        content,          // content
        image,            // image
        data.score,       // score
        data.subreddit,   // source
        data.created_utc, // at
      ])
      insertRaw([id, JSON.stringify(data)])
    }
  }
}

const fetchHN = async ({ threshold }) => {
  const params = new URLSearchParams({ numericFilters: `points>=${threshold}`, hitsPerPage: '500' })
  const res = await fetch(`https://hn.algolia.com/api/v1/search_by_date?${params}`)
  for (const data of (await res.json()).hits) {
    const id = `hn:${data.objectID}`
    if (getById([id])) {
      updateScore([id, data.points])
      continue
    }

    const meta = await fetchMeta(data.url || `https://news.ycombinator.com/item?id=${data.objectID}`)
    const content = [meta.url, (meta.title || '').replaceAll('\n', ' '), (meta.description || '')].join('\n')
    const image = meta.image || ''
    insertEntry([
      id,                // id
      data.title,        // title
      'link',            // type
      content,           // content
      image,             // image
      data.points,       // score
      'hackernews',      // source
      data.created_at_i, // at
    ])
  }
}

const sources = {
  '/r/rance':           { interval: 12*H, threshold:    500 },
  '/r/ProgrammerHumor': { interval:  3*H, threshold: 12_000 },
  '/r/rienabranler':    { interval: 12*H, threshold:    150 },
  '/r/olkb':            { interval: 12*H, threshold:    200 },
  '/r/all':             { interval: 15*M, threshold: 30_000 },
  hackernews:           { interval:  2*H, threshold:    250 },
}

let initialUpdates = Promise.resolve()
for (const [type, source] of Object.entries(sources)) {
  const { interval, threshold } = source
  const update = async () => {
    localStorage[type] = (source.lastUpdate = Date.now())
    try {
      if (type.startsWith('/r/')) {
        await fetchReddit({ sub: type, threshold })
      } else if (type === 'hackernews') {
        await fetchHN({ threshold })
      }
    } catch (err) {
      console.error('handler failed', { interval, type, threshold }, err)
    } finally {
      setTimeout(update, interval)
    }
  }

  if (localStorage[type]) {
    source.lastUpdate = Number(localStorage[type])
    const diff = interval - (Date.now() - source.lastUpdate)
    diff < 0
      ? (initialUpdates = initialUpdates.then(update))
      : setTimeout(update, interval * Math.random())
  } else {
    initialUpdates = initialUpdates.then(update)
  }
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
  gallery: document.getElementById('gallery').content.firstElementChild,
  video: document.getElementById('video').content.firstElementChild,
  image: document.getElementById('image').content.firstElementChild,
  text: document.getElementById('text').content.firstElementChild,
  link: document.getElementById('link').content.firstElementChild,
}
const hashChar = (s,c) => Math.imul(31, s) + c.charCodeAt(0) | 0
const hash = str => Math.abs([...str].reduce(hashChar, 0x811c9dc5) % 36000) / 100
const timeUnits = [
  { label: 'y', size: 31536000 },
  { label: 'w', size: 604800 },
  { label: 'd', size: 86400 },
  { label: 'h', size: 3600 },
  { label: 'm', size: 60 },
  { label: 's', size: 1 },
]

const formatedDuration = seconds => {
  const parts = []
  for (const { label, size } of timeUnits) {
    const value = Math.floor(seconds / size)
    if (value !== 0) {
      parts.push(`${value}${label}`)
      seconds -= value * size
    }
  }
  if (seconds >= 1) {
    parts.push(`${Math.round(seconds)}s`)
  }
  return parts.slice(0, 2).join(' ') || '0s'
}

const parser = new DOMParser()
const decodeHTMLEntities = input => {
  return parser.parseFromString(input, "text/html").documentElement.textContent
}

const makeElement = entry => {
  const li = templates[entry.type].cloneNode(true)
  const [content] = li.getElementsByClassName('content')
  const [score] = li.getElementsByClassName('score')
  const [title] = li.getElementsByClassName('title')
  const [link] = li.getElementsByClassName('link')

  const refreshAt = sources.refreshAt || Date.now()
  const { threshold } = sources[entry.source] || sources['/r/all']
  const elapsed = Math.round(Math.max(refreshAt / 1000 - entry.at, 60*60))
  const scorePerSec =  (entry.score / threshold) / (elapsed / 7e6)
  entry.elapsed = elapsed
  entry.threshold = threshold

  title.textContent = entry.title
  link.textContent = entry.source
  link.href = entry.id.startsWith('r:')
    ? `https://old.reddit.com/r/${entry.source}/comments/${entry.id.slice(2)}?sort=top`
    : `https://news.ycombinator.com/item?id=${entry.id.slice(3)}`

  link.style.backgroundColor = entry.source === 'hackernews'
    ? '#ff6600'
    : `hsl(${hash(entry.source)}, 100%, 80%)`

  score.style.backgroundColor = `hsl(${Math.min(scorePerSec, 220)}, 100%, 70%)`
  score.textContent = entry.score > 1000 ? `${Math.round(entry.score / 1000)}k` : entry.score
  score.title = formatedDuration(elapsed)
  li.className = entry.source.toLowerCase()
  li.id = entry.id
  switch (entry.type) {
    case 'text': {
      if (/^https?:\/\//.test(entry.content)) {
        // fetch text that wasn't properly saved before
        // TODO: update in db instead of doing this client side
        fetch(`/${entry.id}/debug`)
          .then(r => r.json())
          .then(({ selftext }) => selftext.length > 1
            ? content.append(selftext.trim())
            : Promise.reject(Error('missing selftext'))
          )
          .catch(() => content.remove())
      } else if (entry.content?.length > 1) {
        content.append(entry.content.trim())
      } else {
        content.remove()
      }
      break
    }
    case 'video': {
      const url = new URL(entry.content)
      if (url.pathname.endsWith('.m3u8')) {
        content.dataset.hls = entry.content
      } else {
        content.src = decodeHTMLEntities(entry.content)
      }
      break
    } case 'image': {
      content.src = decodeHTMLEntities(entry.content)
      break
    } case 'gallery': {
      content.append(
        ...entry.content.split('\n').map(src => {
          const img = document.createElement('img')
          img.src = decodeHTMLEntities(src)
          return img
        })
      )
      break
    } case 'link': {
      const [url, name, description] = entry.content.split('\n')
      let videoid
      try {
        const { host, searchParams } = new URL(url)
        if (host === 'www.youtube.com' || host === 'youtu.be') {
          videoid = searchParams.get('v')
        }
      } catch {}
      if (videoid) {
        const yt = document.createElement('lite-youtube')
        yt.videoid = videoid
        yt.style.backgroundImage = `url('https://i.ytimg.com/vi/${videoid}/hqdefault.jpg')`
        content.parentElement.append(yt)
        content.remove()
      } else if (entry.image) {
        content.src = decodeHTMLEntities(entry.image)
        description && (content.title = decodeHTMLEntities(description))
      } else if (description) {
        content.parentElement.classList.add('link-description')
        content.parentElement.append(decodeHTMLEntities(description))
        content.remove()
      } else {
        content.parentElement.remove()
      }
      title.href = url
      name && (title.title = decodeHTMLEntities(name))
    } default: {
      li.style.backgroundImage = `url('${decodeHTMLEntities(entry.image)}')`
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
:root { color-scheme: dark }
ul { font-familly: monospace }
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
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
body { padding-bottom: 50px }
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
.link .reddit-link {
  background-image: url('data:image/svg+xml,<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="%23FF4500" d="M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z"/></svg>');
}
.link::before {
  content: '/r/';
  color: #0008;
  letter-spacing: -0.2em;
  margin-right: 0.2em;
}
.link-description {
  padding: 1em;
}
div.content.text {
  padding: 1em;
  white-space: pre-wrap;
  text-wrap: pretty;
}
</style>
</head>
<body>
<template id="link">
  <li>
    <h2><span class="score">0</span> <a class="link" href="">🔗</a> <a class="title" href=""> </a></h2>
    <div><img class="content" onerror="console.log"></div>
  <li>
</template>
<template id="text">
  <li>
    <h2><span class="score">0</span> <a class="link" href="">🔗</a> <span class="title"> </span></h2>
    <div class="content text"></div>
  <li>
</template>
<template id="image">
  <li>
    <h2><span class="score">0</span> <a class="link" href="">🔗</a> <span class="title"> </span></h2>
    <img class="content" onerror="console.log">
  <li>
</template>
<template id="gallery">
  <li>
    <h2><span class="score">0</span> <a class="link" href="">🔗</a> <span class="title"> </span></h2>
    <div class="content"></div>
  <li>
</template>
<template id="video">
  <li>
    <h2><span class="score">0</span> <a class="link" href="">🔗</a> <span class="title"> </span></h2>
    <video class="content" controls reload="none">
  <li>
</template>
<ul></ul>
<nav></nav>
<script>
const sources = ${JSON.stringify(sources)}
const initialEntries = ${initialEntries}
const reloadNavigation = performance
  .getEntriesByType('navigation')
  .find((nav) => nav.type === 'reload')

if (reloadNavigation) {
  window.location.href = '/'
}

${JS}</script>
</body>
<script type="module">
import Hls from 'https://cdn.jsdelivr.net/npm/hls.js@v1.5.15/+esm'

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
<script type="module" src="https://cdn.jsdelivr.net/npm/@justinribeiro/lite-youtube@1.5.0"></script>
</html>`

const updateMeta = exec(`UPDATE entry SET content = ?, image = ? WHERE id = ?`)
const fixMissingMetadata = async entry => {
  if (entry.type !== 'link') return
  if (entry.image?.[0] === '/') {
    const url = entry.content.split('\n')[0]
    entry.image = `${new URL(url).origin}${entry.image}`
    updateMeta([entry.content, entry.image, entry.id])
    return
  }
  if (entry.content.trim()) return
  let url
  if (entry.id.startsWith('hn:')) {
    const res = await fetch(`https://hacker-news.firebaseio.com/v0/item/${entry.id.slice(3)}.json`)
    url = (await res.json()).url
  } else if (entry.id.startsWith('r:')) {
    const res = await fetch(`https://www.reddit.com/r/${entry.source}/comments/${entry.id.slice(2)}.json`)
    url = (await res.json())[0].children[0].data.url
  } else return
  const meta = await fetchMeta(url)
  entry.content = [meta.url || url, meta.title || '', meta.description || ''].join('\n')
  entry.image = meta.image || ''
  updateMeta([entry.content, entry.image, entry.id])
}

const _404 = new Response(null, { status: 404 })
const _500 = new Response(null, { status: 500 })
const handleRequest = async pathname => {
  if (pathname[2] === ':' || pathname[3] === ':') {
    const [id, action] = pathname.slice(1).split('/')
    const entry = getRowIdOf([id])
    if (!entry) return _404
    const entries = getLast25([entry.rowid])
    await Promise.allSettled(entries.map(fixMissingMetadata))
    if (action === 'refresh') {
      return new Response(
        JSON.stringify(entries),
        entries.length > 24 ? JSONInit : JSONInitNoCache,
      )
    }
    if (action === 'debug') {
      const entry = getEntry([id])
      if (!entry) return _404
      const data = getRawData([id])?.data
      if (!data) return new Response(JSON.stringify({ entry }), JSONInit)
      return new Response(JSON.stringify({ entry, ...JSON.parse(data) }), JSONInit)
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

  if (pathname === '/dump') {
    const dbFile = await Deno.open('./entries.sqlite', { read: true })
    const dbFileInfo = await dbFile.stat()
    const headers = {
      'Content-Disposition': `attachment; filename="${dbFileInfo.mtime.getTime()}-entries.sqlite"`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(dbFileInfo.size),
    }

    return new Response(dbFile.readable, { status: 200, headers })
  }

  return _404
}


Deno.serve({
  port: Deno.env.get('PORT'),
  onListen({ port, hostname }) {
    console.log(`Server started at http://${hostname || 'localhost'}:${port}`)
  },
  handler(request) {
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
})

// __THE 4 LAWS__:
// 1) Order of entries must be fixed
//    -> No FOMO
//
// 2) Quality must be assessed somehow (vote count, trusted source)
//    -> Stay conscious about the scrolling
//
// 3) Limit the display of elements
//    -> Stay conscious about the scrolling
//
// 4) Limit the update rate of elements
//    -> Spam refresh should not be rewarded      

// TODO:
// - Fix not playing videos
// - Fix not showing images
// - Generate thumbnails for website not showing
//   > if image do not exist & verify that the image is indeed, an image
//   > check if domain is different, if so, check if image exist when replacing the domain to the one of the link
//   > if still no image, use AI to generate a 3 line summary, ask it to generate an image for it lol.
// - Prev page navigation
// - Inline comments support
// - Add local metrics (ex: refresh / days, duration of window active / day)
// - Save everything (image, comments, video, even webpage)
// - Add a ladder to climb paywalls
// - Dump into meili and add a search bar
// - Image descriptions with AI
// - Video descriptions with AI
// - Vector search
// - Youtube Support
// - TikTok Support
