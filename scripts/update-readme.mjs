// Regenerates the live numbers in README.md from the npm registry and LeetCode.
//
// Run: node scripts/update-readme.mjs
// CI:  .github/workflows/update-readme.yml (daily)
//
// Design note: this script fails loudly rather than writing a plausible-looking
// wrong number. npm's API is behind Cloudflare and returns 429 under load; an
// earlier version caught that and substituted 0, which silently under-reported
// the monthly total by more than half. Anything short of complete data now
// throws, so a bad day at npm fails the Action instead of publishing a lie.

import { readFile, writeFile } from 'node:fs/promises'

const MAINTAINER = 'vishalmeena111'
const LEETCODE_USER = 'vishalmeena111'
const README = new URL('../README.md', import.meta.url)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Retries on 429 and 5xx with exponential backoff. Throws once attempts run out.
async function fetchRetry(url, init = {}, attempts = 5) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(2 ** i * 500) // 1s, 2s, 4s, 8s
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'user-agent': `${MAINTAINER}-readme-bot`, ...init.headers },
      })
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${res.status} on ${url}`)
        continue
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`)
      return res
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

const json = async (url, init) => (await fetchRetry(url, init)).json()

async function listPackages() {
  const { objects } = await json(
    `https://registry.npmjs.org/-/v1/search?text=maintainer:${MAINTAINER}&size=250`
  )
  const names = objects.map((o) => o.package.name)
  if (names.length === 0) throw new Error('npm search returned no packages')
  return names
}

// One bulk request per 50 packages instead of one request each — far less
// likely to trip the rate limiter than 18 parallel calls. A name missing from
// the response means the lookup failed, which is an error, not a zero.
async function downloadsFor(names) {
  const counts = new Map()

  for (let i = 0; i < names.length; i += 50) {
    const chunk = names.slice(i, i + 50)
    const data = await json(
      `https://api.npmjs.org/downloads/point/last-month/${chunk.join(',')}`
    )
    // A single-package request returns the record directly, not keyed by name.
    const byName = chunk.length === 1 ? { [chunk[0]]: data } : data

    for (const name of chunk) {
      const entry = byName?.[name]
      if (!entry || typeof entry.downloads !== 'number') {
        throw new Error(`no download data for ${name} — refusing to guess`)
      }
      counts.set(name, entry.downloads)
    }
  }

  return counts
}

// LeetCode blocks plain page requests, but its public GraphQL endpoint answers
// fine as long as a Referer is set.
async function leetcodeSolved() {
  const res = await fetchRetry('https://leetcode.com/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', referer: 'https://leetcode.com' },
    body: JSON.stringify({
      query: `query($u:String!){matchedUser(username:$u){submitStatsGlobal{acSubmissionNum{difficulty count}}}}`,
      variables: { u: LEETCODE_USER },
    }),
  })
  const stats = (await res.json()).data?.matchedUser?.submitStatsGlobal?.acSubmissionNum
  const all = stats?.find((s) => s.difficulty === 'All')?.count
  if (typeof all !== 'number') throw new Error('leetcode returned no solve count')
  return all
}

function replaceBlock(text, marker, body) {
  const re = new RegExp(`(<!-- ${marker}:START -->)[\\s\\S]*?(<!-- ${marker}:END -->)`)
  if (!re.test(text)) throw new Error(`marker ${marker} not found in README.md`)
  return text.replace(re, `$1\n${body}\n$2`)
}

const names = await listPackages()
const counts = await downloadsFor(names)
const total = [...counts.values()].reduce((sum, n) => sum + n, 0)
if (total === 0) throw new Error('every package reported 0 downloads — npm is degraded, not writing')

const solved = await leetcodeSolved()

const summary =
  `**${names.length}** npm packages · ` +
  `**${total.toLocaleString('en-US')}** downloads/month · ` +
  `**${solved}** LeetCode solved`

// The typing banner embeds the same three numbers inside its URL, so it has to
// be regenerated too — otherwise it keeps animating last month's figures.
const lines = [
  `${names.length} packages published on npm`,
  `${total.toLocaleString('en-US')} downloads every month`,
  `${solved} problems solved on LeetCode`,
]
const typing =
  '<img src="https://readme-typing-svg.demolab.com/?font=Fira+Code&weight=500&size=20' +
  '&duration=3200&pause=800&color=543DE0&center=true&vCenter=true&width=520&lines=' +
  lines.map((l) => encodeURIComponent(l).replace(/%20/g, '+')).join(';') +
  '" alt="Typing SVG">'

let text = await readFile(README, 'utf8')
text = replaceBlock(text, 'NPM_SUMMARY', summary)
text = replaceBlock(text, 'TYPING', typing)
await writeFile(README, text)

console.log(`updated: ${summary.replace(/\*\*/g, '')}`)
