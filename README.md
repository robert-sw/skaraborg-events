# skaraborg-events

Upcoming events in Skaraborg's 15 kommuner as one JSON file, updated daily.

The file holds facts only: title, dates, time, place, kommun, coordinates, categories and a link
to the event's own page. No images and no descriptions.

## Data

`data/events.json`:

```json
{
  "meta": { "generated_at": "...", "today": "2026-10-09", "total": 956, "by_kommun": { "Skövde": 207 }, "attribution": ["..."] },
  "events": [
    {
      "id": "vs-642863",
      "source": "vastsverige",
      "title": "...",
      "url": "https://www.vastsverige.com/...",
      "kommun": "Lidköping",
      "place": "Lidköping",
      "lat": 58.50, "lng": 13.15,
      "start": "2026-10-10T19:00:00+02:00",
      "end": "2026-10-10T23:59:00",
      "next": "2026-10-10T19:00:00+02:00",
      "ongoing": false,
      "time_text": null,
      "categories": ["Musik"],
      "kid_friendly": false,
      "race": false
    }
  ]
}
```

- `next` is the next date on or after today; events are sorted by it.
- `ongoing` is true for things already running (exhibitions); `next` is then today.
- `unlisted` appears on events the source removed in the last day or two (gotene.se removes a page
  on the day of the event), so the link may be dead.

## Run

```sh
bun scripts/fetch.ts                    # all sources, writes data/events.json
bun scripts/fetch.ts --dry-run          # print the summary only
bun scripts/fetch.ts --no-gotene        # skip gotene.se
bun scripts/fetch.ts --settings 3362    # only some vastsverige feeds
bun test scripts/
```

Exit code is 0 when at least one source worked. A failed source is listed in
`meta.sources_failed` and its events from the previous run are kept.

The GitHub Action in `.github/workflows/update.yml` runs the tests and the fetch every night
at 03:17 UTC and commits `data/` when it changed. It can also be started by hand from the
Actions tab.

## Sources

- [vastsverige.com](https://www.vastsverige.com/), the calendar feed for each Skaraborg kommun
- [gotene.se](https://www.gotene.se/), Götene kommun's evenemangskalender
- Places from gotene.se are geocoded with [Nominatim](https://nominatim.openstreetmap.org/),
  cached in `data/geocode-cache.json`. Map data © OpenStreetMap contributors.

Anything that shows this data should credit these sources and link each event to its `url`.
