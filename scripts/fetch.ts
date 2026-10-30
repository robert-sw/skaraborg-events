#!/usr/bin/env bun
/**
 * Fetch upcoming events in Skaraborg's 15 kommuner and write data/events.json.
 *
 * Sources:
 *   - vastsverige.com public API (CC BY-SA 4.0), one calendar feed per kommun.
 *     /api/get/<settings>?searchTypes=Event        all events in the feed
 *     same with filter=[{"ID":247,"Cat":[248]}]    the ones marked Barnvänligt (not in the hits)
 *     Spec: https://www.vastsverige.com/swagger/v1/swagger.json
 *   - gotene.se evenemangskalender: library and culture items that are not on vastsverige.
 *     The date is in the title, time and place are on the detail page.
 *
 * Only facts are kept: title, dates, time, place, kommun, coordinates, categories and a link to
 * the source page. No images and no descriptions.
 *
 * Exit code is 0 when at least one source worked; failed sources are listed in meta.sources_failed.
 *
 * Usage: bun scripts/fetch.ts [--settings <id,id>] [--no-gotene] [--dry-run]
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"

const ROOT = join(dirname(import.meta.path), "..")
const DATA_DIR = join(ROOT, "data")
const OUT = join(DATA_DIR, "events.json")
const GEO_CACHE = join(DATA_DIR, "geocode-cache.json")
const UA = "skaraborg-events/1.0 (+https://github.com/robert-sw/skaraborg-events)"

// vastsverige Location category id -> kommun
const KOMMUN_BY_LOCATION: Record<number, string> = {
  27: "Essunga", 28: "Falköping", 29: "Grästorp", 30: "Gullspång", 33: "Götene", 35: "Hjo",
  37: "Karlsborg", 39: "Lidköping", 41: "Mariestad", 46: "Skara", 47: "Skövde", 49: "Tibro",
  50: "Tidaholm", 53: "Töreboda", 55: "Vara",
}

// settings id per kommun feed, taken from each kommun's evenemang page on vastsverige.com
const FEEDS: { settings: number; label: string }[] = [
  { settings: 23267, label: "Lidköping + Götene" },
  { settings: 3362, label: "Skara" },
  { settings: 11429, label: "Skövde" },
  { settings: 11474, label: "Mariestad" },
  { settings: 40003, label: "Vara" },
  { settings: 3229, label: "Falköping" },
  { settings: 4029, label: "Grästorp" },
  { settings: 32470, label: "Essunga" },
  { settings: 5502, label: "Tidaholm" },
  { settings: 3297, label: "Hjo" },
  { settings: 22312, label: "Töreboda" },
  { settings: 18823, label: "Karlsborg" },
  { settings: 19304, label: "Gullspång" },
  { settings: 12711, label: "Tibro" },
]

const EVENT_CATEGORY: Record<number, string> = {
  254: "Båtturer", 186: "Festival", 187: "Film", 188: "Natur och friluftsliv", 189: "Guidade turer",
  195: "Musik", 191: "Konst och kultur", 192: "Kurser och föreläsningar", 193: "Marknader och loppisar",
  194: "Mat och dryck", 197: "På scen", 198: "Sport och hälsa", 199: "Teknik och motor",
  207: "Utställningar och mässor",
}
const KID_FILTER = [{ ID: 247, Cat: [248] }] // "Fler filter" > "Barnvänligt"
const KID_WORDS = /\b(barn\w*|knatte\w*|familj\w*|sagostund|sagoläsning|nalle\w*|bamse|kids|lov\w*aktivitet\w*|pyssel\w*|skattjakt|troll)\b/i
const RACE_WORDS = /(lopp(et)?\b|marat(h)?on|stafett|terräng|motionslopp|cykellopp|galopp)/i

export interface Event {
  id: string
  source: "vastsverige" | "gotene"
  title: string
  url: string
  kommun: string
  place: string | null
  lat: number | null
  lng: number | null
  start: string        // ISO, first listed date
  end: string | null   // ISO, last day it runs, when known
  next: string         // ISO, next date on or after today (today for ongoing)
  ongoing: boolean
  time_text: string | null
  categories: string[]
  kid_friendly: boolean
  race: boolean
  unlisted?: boolean   // seen on an earlier run, gone from the source now
}

const CARRY_DAYS = 2

/**
 * gotene.se removes an event page on the day of the event, so a fresh fetch misses same-day
 * events. Events from the previous run that are gone from the source are kept while their date
 * is today or within CARRY_DAYS, marked unlisted. Ones further out are treated as cancelled.
 */
export function carryForward(prev: Event[], current: Map<string, Event>, today: string): Event[] {
  const out: Event[] = []
  const horizon = new Date(Date.parse(today) + CARRY_DAYS * 86400_000).toISOString().slice(0, 10)
  for (const e of prev) {
    if (current.has(e.id)) continue
    const nextDay = dayOf(new Date(e.next))
    const lastDay = e.end ? dayOf(new Date(e.end)) : nextDay
    if (lastDay < today || nextDay > horizon) continue
    const ongoing = nextDay < today
    out.push({ ...e, unlisted: true, ongoing: e.ongoing || ongoing, next: ongoing ? `${today}T00:00:00` : e.next })
  }
  return out
}

/**
 * When a source fails, keep its upcoming events from the previous run so that kommun does not
 * go empty for a day. A vastsverige feed label names the kommuner it covers.
 */
export function keepFailed(prev: Event[], failedSources: string[], current: Map<string, Event>, today: string): Event[] {
  const goteneFailed = failedSources.includes("gotene.se")
  const vsLabels = failedSources.filter(s => s.startsWith("vastsverige:"))
  return prev.filter(e => {
    if (current.has(e.id)) return false
    const lastDay = dayOf(new Date(e.end ?? e.next))
    if (lastDay < today) return false
    if (e.source === "gotene") return goteneFailed
    return vsLabels.some(l => l.includes(e.kommun))
  })
}

const args = process.argv.slice(2)
const flag = (n: string) => args.includes(n)
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }

const log = (...a: unknown[]) => console.error("[events]", ...a)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function get(url: string, kind: "json" | "text"): Promise<any> {
  let last: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: kind === "json" ? "application/json" : "text/html" },
        signal: AbortSignal.timeout(45_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (kind === "text") return await res.text()
      const j = await res.json()
      // the list endpoint returns the JSON document as a JSON string
      return typeof j === "string" ? JSON.parse(j) : j
    } catch (e) {
      last = e
      await sleep(1500)
    }
  }
  throw last
}

/** Calendar day in Stockholm, YYYY-MM-DD. */
function dayOf(d: Date): string {
  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" })
}

// vastsverige

const VS = "https://www.vastsverige.com"

interface VsTime { Start?: string; End?: string }
interface VsDate { Date: string; EndDate?: string | null; Times?: VsTime[] | null }

/** Next relevant day for a vastsverige record, or null when it is over. */
export function nextOccurrence(start: string, end: string | null, dates: VsDate[] | null, today: string):
  { next: string; ongoing: boolean; last: string } | null {
  const spans: { from: string; to: string }[] = []
  for (const d of dates ?? []) {
    if (!d?.Date) continue
    spans.push({ from: d.Date, to: d.EndDate ?? d.Date })
  }
  if (spans.length === 0) spans.push({ from: start, to: end ?? start })
  // one listed date with a later End is a long-running event (exhibitions)
  if (spans.length === 1 && end && end > spans[0].to) spans[0].to = end
  let best: { next: string; ongoing: boolean } | null = null
  let last = ""
  for (const s of spans) {
    const fromDay = dayOf(new Date(s.from)), toDay = dayOf(new Date(s.to))
    if (toDay > last) last = toDay
    if (toDay < today) continue
    const cand = fromDay >= today ? { next: s.from, ongoing: false } : { next: `${today}T00:00:00`, ongoing: true }
    if (!best || cand.next < best.next) best = cand
  }
  return best ? { ...best, last } : null
}

/** "18:30" or "12:00-20:00" for the listed date on the event's next day, null when not listed. */
export function timeText(dates: VsDate[] | null | undefined, next: string, ongoing: boolean): string | null {
  if (ongoing) return null
  const day = dayOf(new Date(next))
  const d = (dates ?? []).find(d => d?.Date && dayOf(new Date(d.Date)) === day)
  const t = d?.Times?.find(t => t?.Start)
  if (!t?.Start) return null
  return t.End ? `${t.Start}-${t.End}` : t.Start
}

/** One API hit to an Event, or null when it is over, outside Skaraborg or has no title. */
export function mapVastsverige(h: any, kidIds: Set<number>, today: string): Event | null {
  const occ = nextOccurrence(h.Start, h.End, h.Dates, today)
  if (!occ) return null
  const locs: number[] = h.Categories?.Location ?? []
  const kommun = locs.map(l => KOMMUN_BY_LOCATION[l]).find(Boolean)
  if (!kommun) return null
  const title = String(h.Heading ?? "").trim()
  if (!title) return null
  // 0,0 means no position was entered
  const p = h.Position
  const hasPos = p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0)
  const categories = (h.Categories?.Event ?? []).map((id: number) => EVENT_CATEGORY[id]).filter(Boolean)
  const text = `${h.Heading} ${h.Tagline ?? ""}`
  return {
    id: `vs-${h.Id}`,
    source: "vastsverige",
    title,
    url: VS + h.Url,
    kommun,
    place: h.City ?? null,
    lat: hasPos ? p.lat : null,
    lng: hasPos ? p.lng : null,
    start: h.Start,
    end: occ.last ? `${occ.last}T23:59:00` : h.End ?? null,
    next: occ.next,
    ongoing: occ.ongoing,
    time_text: timeText(h.Dates, occ.next, occ.ongoing),
    categories,
    kid_friendly: kidIds.has(h.Id) || KID_WORDS.test(text),
    race: RACE_WORDS.test(h.Heading ?? "") && !/loppis/i.test(h.Heading ?? ""),
  }
}

async function fetchVastsverige(settings: number, today: string) {
  const base = `${VS}/api/get/${settings}?searchTypes=Event&lang=sv&take=1000`
  const all = await get(`${base}&includeCategories=true`, "json")
  const hits: any[] = all?.Hits ?? []
  if (!Array.isArray(hits) || hits.length === 0) throw new Error(`no hits (TotalCount=${all?.TotalCount})`)
  if (all.TotalCount > hits.length) throw new Error(`got ${hits.length} of ${all.TotalCount} hits`)
  await sleep(400)
  const kid = await get(`${base}&idOnly=true&filter=${encodeURIComponent(JSON.stringify(KID_FILTER))}`, "json")
  const kidIds = new Set<number>(kid?.IDs ?? (kid?.Hits ?? []).map((h: any) => h.Id))

  const out: Event[] = []
  for (const h of hits) {
    const e = mapVastsverige(h, kidIds, today)
    if (e) out.push(e)
  }
  return out
}

// gotene.se

const GOTENE = "https://www.gotene.se"
const GOTENE_CAL = `${GOTENE}/upplevaochgora/kulturochevenemang/evenemang/evenemangskalender.6339.html`
const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"]

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&shy;/g, "")
}
const stripTags = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()

/**
 * "Barnklädbytardag - 4 oktober" -> { title, from: "2026-10-04", to: "2026-10-04" }
 * "Utställning: X - 22 september - 16 oktober" -> a range. The year is the one that puts the
 * date nearest today going forward.
 */
export function parseGoteneTitle(raw: string, today: string): { title: string; from: string; to: string } | null {
  const re = /\s+-\s+(\d{1,2})\s+([a-zåäö]+)(?:\s+-\s+(\d{1,2})\s+([a-zåäö]+))?\s*$/i
  const m = raw.match(re)
  if (!m) return null
  const m1 = MONTHS.indexOf(m[2].toLowerCase())
  if (m1 < 0) return null
  const m2 = m[4] ? MONTHS.indexOf(m[4].toLowerCase()) : m1
  if (m2 < 0) return null
  const ty = Number(today.slice(0, 4))
  const iso = (y: number, mo: number, d: number) => `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`
  let y1 = ty
  let to = iso(y1 + (m2 < m1 ? 1 : 0), m2, Number(m[3] ?? m[1]))
  // ended more than ~4 months ago -> next year's listing
  if (Date.parse(to) < Date.parse(today) - 120 * 86400_000) {
    y1++
    to = iso(y1 + (m2 < m1 ? 1 : 0), m2, Number(m[3] ?? m[1]))
  }
  return { title: raw.slice(0, m.index).trim(), from: iso(y1, m1, Number(m[1])), to }
}

type GeoCache = Record<string, { lat: number; lng: number } | null>

function loadGeoCache(): GeoCache {
  try { return JSON.parse(readFileSync(GEO_CACHE, "utf8")) } catch { return {} }
}

// OSM Nominatim: results are cached in data/geocode-cache.json, at most one request per second
async function geocode(query: string, cache: GeoCache) {
  if (query in cache) return cache[query]
  await sleep(1100)
  try {
    const r = await get(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=se&q=${encodeURIComponent(query)}`, "json")
    cache[query] = r?.[0] ? { lat: Number(r[0].lat), lng: Number(r[0].lon) } : null
  } catch (e) {
    log("geocode failed", query, String(e))
    return null // not cached, retried next run
  }
  return cache[query]
}

async function fetchGotene(today: string, geo: GeoCache) {
  const html: string = await get(GOTENE_CAL, "text")
  const h1 = html.indexOf("<h1")
  const footer = html.indexOf("Till toppen av sidan", h1)
  const body = html.slice(h1, footer > 0 ? footer : undefined)
  const links = [...body.matchAll(/<a [^>]*href="(\/upplevaochgora\/(?:kulturochevenemang\/evenemang|bibliotek)\/[^"]+\.html)"[^>]*>([\s\S]*?)<\/a>/g)]
  const fallback = await geocode("Götene, Götene kommun", geo)
  const out: Event[] = []
  const seen = new Set<string>()
  for (const [, href, inner] of links) {
    if (seen.has(href)) continue
    seen.add(href)
    const rawTitle = stripTags(inner)
    const parsed = parseGoteneTitle(rawTitle, today)
    if (!parsed || parsed.to < today) continue
    let intro = "", place: string | null = null, timeText: string | null = null
    let childAge = false
    try {
      await sleep(300)
      const page: string = await get(GOTENE + href, "text")
      const i = page.indexOf("<h1")
      const stop = page.indexOf("Var det här informationen", i)
      // two layouts: "Plats: X" inline, or "Tid:" / "Plats:" / "Ålder:" with the value on the next line
      const lines = decode(page.slice(i, stop > 0 ? stop : i + 12000)
        .replace(/<script[\s\S]*?<\/script>/g, "")
        .replace(/<\/(p|div|h\d|li|dt|dd|span)>|<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, ""))
        .split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean)
      const field = (name: string) => {
        const k = lines.findIndex(l => new RegExp(`^${name}:`, "i").test(l))
        if (k < 0) return null
        const inline = lines[k].replace(new RegExp(`^${name}:\\s*`, "i"), "")
        return inline || lines[k + 1] || null
      }
      intro = lines[1] ?? "" // used for the kid check only, never written out
      place = field("Plats")
      const tid = field("Tid")
      timeText = (tid ?? lines.join(" ")).match(/(?:^|klockan\s*|kl\.?\s*)(\d{1,2}[.:]\d{2}(?:\s*[-–]\s*\d{1,2}[.:]\d{2})?)/i)?.[1] ?? null
      const age = field("Ålder")?.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})/)
      childAge = !!age && Number(age[1]) <= 12
    } catch (e) {
      log("gotene detail failed", href, String(e))
    }
    let c = fallback
    if (place) {
      const parts = place.split(",").map(s => s.trim()).filter(Boolean)
      c = (await geocode(`${place}, Götene kommun`, geo))
        ?? (parts.length > 1 ? await geocode(`${parts[parts.length - 1]}, Götene kommun`, geo) : null)
        ?? fallback
    }
    const hhmm = timeText?.match(/(\d{1,2})[.:](\d{2})/)
    const startIso = `${parsed.from}T${hhmm ? `${hhmm[1].padStart(2, "0")}:${hhmm[2]}` : "00:00"}:00`
    const ongoing = parsed.from < today
    out.push({
      id: `gotene-${href.match(/\.(\d+)\.html$/)?.[1] ?? href}`,
      source: "gotene",
      title: parsed.title,
      url: GOTENE + href,
      kommun: "Götene",
      place,
      lat: c?.lat ?? null,
      lng: c?.lng ?? null,
      start: startIso,
      end: parsed.to !== parsed.from ? `${parsed.to}T23:59:00` : null,
      next: ongoing ? `${today}T00:00:00` : startIso,
      ongoing,
      time_text: timeText,
      categories: href.includes("/bibliotek/") ? ["Bibliotek"] : href.includes("kulturprogram") ? ["Kulturprogram"] : [],
      kid_friendly: childAge || KID_WORDS.test(`${parsed.title} ${intro}`),
      race: RACE_WORDS.test(parsed.title) && !/loppis/i.test(parsed.title),
    })
  }
  if (out.length === 0) throw new Error("no upcoming events parsed")
  return out
}

// main

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "")

async function main() {
  const today = dayOf(new Date())
  const only = opt("--settings")?.split(",").map(Number)
  const feeds = only ? only.map(s => FEEDS.find(f => f.settings === s) ?? { settings: s, label: `settings ${s}` }) : FEEDS
  const ok: string[] = []
  const failed: { source: string; error: string }[] = []
  const byId = new Map<string, Event>()

  for (const f of feeds) {
    try {
      for (const e of await fetchVastsverige(f.settings, today)) byId.set(e.id, e)
      ok.push(`vastsverige:${f.label}`)
    } catch (e) {
      failed.push({ source: `vastsverige:${f.label}`, error: String(e) })
      log("feed failed", f.label, String(e))
    }
    await sleep(400)
  }

  if (!flag("--no-gotene")) {
    const geo = loadGeoCache()
    try {
      const evs = await fetchGotene(today, geo)
      const vsKeys = new Set([...byId.values()].map(e => `${norm(e.title)}|${dayOf(new Date(e.next))}`))
      let dupes = 0
      for (const e of evs) {
        if (vsKeys.has(`${norm(e.title)}|${dayOf(new Date(e.next))}`)) { dupes++; continue }
        byId.set(e.id, e)
      }
      ok.push("gotene.se")
      if (dupes) log(`gotene.se: ${dupes} already on vastsverige`)
    } catch (e) {
      failed.push({ source: "gotene.se", error: String(e) })
      log("gotene.se failed", String(e))
    }
    if (!flag("--dry-run")) {
      mkdirSync(DATA_DIR, { recursive: true })
      writeFileSync(GEO_CACHE, JSON.stringify(geo, null, 1) + "\n")
    }
  }

  try {
    const prev: Event[] = JSON.parse(readFileSync(OUT, "utf8"))?.events ?? []
    const held = keepFailed(prev, failed.map(f => f.source), byId, today)
    for (const e of held) byId.set(e.id, e)
    if (held.length) log(`kept ${held.length} event(s) from failed sources`)
    const kept = carryForward(prev, byId, today)
    for (const e of kept) byId.set(e.id, e)
    if (kept.length) log(`kept ${kept.length} event(s) no longer listed at the source`)
  } catch { /* first run */ }

  const events = [...byId.values()].sort((a, b) => a.next.localeCompare(b.next) || a.title.localeCompare(b.title, "sv"))
  const counts: Record<string, number> = {}
  for (const e of events) counts[e.kommun] = (counts[e.kommun] ?? 0) + 1
  const doc = {
    meta: {
      generated_at: new Date().toISOString(),
      today,
      sources_ok: ok,
      sources_failed: failed,
      total: events.length,
      by_kommun: counts,
      attribution: ["Turistrådet Västsverige (vastsverige.com), CC BY-SA 4.0", "gotene.se", "© OpenStreetMap contributors"],
    },
    events,
  }

  if (ok.length === 0) {
    log("all sources failed; events.json left untouched")
    process.exit(1)
  }
  if (flag("--dry-run")) {
    log(JSON.stringify(doc.meta, null, 1))
    return
  }
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(OUT + ".tmp", JSON.stringify(doc) + "\n")
  renameSync(OUT + ".tmp", OUT)
  log(`wrote ${events.length} events, ${ok.length} sources ok, ${failed.length} failed`)
}

if (import.meta.main) await main()
