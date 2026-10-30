import { expect, test } from "bun:test"
import { carryForward, keepFailed, mapVastsverige, nextOccurrence, parseGoteneTitle, timeText, type Event } from "./fetch"

test("single date title", () => {
  expect(parseGoteneTitle("Barnklädbytardag - 4 oktober", "2026-10-02"))
    .toEqual({ title: "Barnklädbytardag", from: "2026-10-04", to: "2026-10-04" })
})

test("range title keeps both ends", () => {
  expect(parseGoteneTitle("Utställning: Vi och Unesco Biosfärområde - 22 september - 16 oktober", "2026-10-02"))
    .toEqual({ title: "Utställning: Vi och Unesco Biosfärområde", from: "2026-09-22", to: "2026-10-16" })
})

test("january listing read in december rolls to next year", () => {
  expect(parseGoteneTitle("Nyårskonsert - 6 januari", "2026-12-10")?.from).toBe("2027-01-06")
})

test("range across new year", () => {
  expect(parseGoteneTitle("Julutställning - 20 december - 6 januari", "2026-12-01"))
    .toEqual({ title: "Julutställning", from: "2026-12-20", to: "2027-01-06" })
})

test("title without a date is skipped", () => {
  expect(parseGoteneTitle("Kulturprogram hösten", "2026-10-02")).toBeNull()
})

test("long exhibition with one listed date is ongoing until End", () => {
  const r = nextOccurrence("2026-09-19T10:00:00+02:00", "2026-10-03T14:00:00+02:00",
    [{ Date: "2026-09-19T10:00:00+02:00", EndDate: null, Times: null }], "2026-10-02")
  expect(r?.ongoing).toBe(true)
  expect(r?.last).toBe("2026-10-03")
})

test("recurring event picks the next listed date", () => {
  const dates = ["2026-09-05", "2026-10-03", "2026-11-07"].map(d => ({ Date: `${d}T11:00:00+02:00`, EndDate: null, Times: null }))
  const r = nextOccurrence(dates[0].Date, null, dates, "2026-10-02")
  expect(r?.next.slice(0, 10)).toBe("2026-10-03")
  expect(r?.ongoing).toBe(false)
})

test("finished event is dropped", () => {
  expect(nextOccurrence("2026-09-01T10:00:00+02:00", "2026-09-30T18:00:00+02:00", null, "2026-10-02")).toBeNull()
})

const ev = (id: string, next: string, end: string | null = null): Event => ({
  id, source: "gotene", title: id, url: "", kommun: "Götene", place: null,
  lat: null, lng: null, start: next, end, next, ongoing: false,
  time_text: null, categories: [], kid_friendly: false, race: true,
})

test("same-day event removed by the source is kept", () => {
  const kept = carryForward([ev("bamseloppet", "2026-10-02T10:00:00")], new Map(), "2026-10-02")
  expect(kept.map(e => e.id)).toEqual(["bamseloppet"])
  expect(kept[0].unlisted).toBe(true)
})

test("still-listed events are not duplicated", () => {
  const cur = new Map([["a", ev("a", "2026-10-02T10:00:00")]])
  expect(carryForward([ev("a", "2026-10-02T10:00:00")], cur, "2026-10-02")).toEqual([])
})

test("past events and far-future vanished events are dropped", () => {
  const prev = [ev("past", "2026-10-01T10:00:00"), ev("cancelled", "2026-10-20T10:00:00")]
  expect(carryForward(prev, new Map(), "2026-10-02")).toEqual([])
})

test("a vanished exhibition still running is kept as ongoing", () => {
  const kept = carryForward([ev("x", "2026-09-30T10:00:00", "2026-10-05T23:59:00")], new Map(), "2026-10-02")
  expect(kept[0].ongoing).toBe(true)
  expect(kept[0].next.slice(0, 10)).toBe("2026-10-02")
})

const vs = (id: string, kommun: string, next: string): Event => ({ ...ev(id, next), source: "vastsverige", kommun, race: false })

test("a failed feed keeps its kommun's upcoming events", () => {
  const prev = [vs("a", "Lidköping", "2026-10-20T10:00:00"), vs("b", "Skara", "2026-10-20T10:00:00"), vs("c", "Götene", "2026-09-01T10:00:00")]
  const kept = keepFailed(prev, ["vastsverige:Lidköping + Götene"], new Map(), "2026-10-02")
  expect(kept.map(e => e.id)).toEqual(["a"])
})

test("nothing is kept when no source failed", () => {
  expect(keepFailed([vs("a", "Skara", "2026-10-20T10:00:00")], [], new Map(), "2026-10-02")).toEqual([])
})

const hit = (over: Record<string, unknown> = {}) => ({
  Id: 642106, Heading: "Bibliotekets filmklubb", Tagline: "Filmvisning", City: "Lidköping",
  Url: "/lackokinnekulle/evenemang/bibliotekets-filmklubb/",
  Start: "2026-10-08T00:00:00+02:00", End: "2026-12-03T23:00:00+01:00",
  Position: { lat: 58.5047, lng: 13.1537 },
  Categories: { Event: [187, 73, 0], Location: [39, 22, 2] },
  Dates: [
    { Date: "2026-10-08T00:00:00+02:00", Times: [{ Start: "18:30" }] },
    { Date: "2026-11-05T00:00:00+01:00", Times: [{ Start: "18:30", End: "20:30" }] },
  ],
  ...over,
})

test("api hit maps to an event", () => {
  const e = mapVastsverige(hit(), new Set(), "2026-10-30")!
  expect(e.id).toBe("vs-642106")
  expect(e.url).toBe("https://www.vastsverige.com/lackokinnekulle/evenemang/bibliotekets-filmklubb/")
  expect(e.kommun).toBe("Lidköping")
  expect(e.categories).toEqual(["Film"])
  expect([e.lat, e.lng]).toEqual([58.5047, 13.1537])
  expect(e.next.slice(0, 10)).toBe("2026-11-05")
  expect(e.time_text).toBe("18:30-20:30")
  expect(e.kid_friendly).toBe(false)
})

test("position 0,0 is no position", () => {
  const e = mapVastsverige(hit({ Position: { lat: 0, lng: 0 } }), new Set(), "2026-10-30")!
  expect([e.lat, e.lng]).toEqual([null, null])
})

test("kid flag comes from the filtered id set", () => {
  expect(mapVastsverige(hit(), new Set([642106]), "2026-10-30")!.kid_friendly).toBe(true)
})

test("hit outside skaraborg is skipped", () => {
  expect(mapVastsverige(hit({ Categories: { Location: [999] } }), new Set(), "2026-10-30")).toBeNull()
})

test("no time when the date has none or the event is ongoing", () => {
  expect(timeText([{ Date: "2026-11-05T00:00:00+01:00", Times: [] }], "2026-11-05T00:00:00+01:00", false)).toBeNull()
  expect(timeText([{ Date: "2026-10-30T00:00:00+01:00", Times: [{ Start: "10:00" }] }], "2026-10-30T00:00:00", true)).toBeNull()
})
