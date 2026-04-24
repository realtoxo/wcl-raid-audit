# Windfury CPM Method

Use this method when the user asks for:

- overall Windfury CPM including trash
- per-encounter Windfury CPM
- enhancement shaman twisting summaries
- future timestamp-based Windfury gap analysis

This metric should be sourced from Warcraft Logs when the user wants report-wide, trash-inclusive values. Parseforge does not currently expose a trash-inclusive overall aggregate.

Current skill support:

- `scripts/raid_audit.mjs` reports per-encounter WF / Grace casts and CPM from Parseforge by default
- `scripts/raid_audit.mjs` computes overall WF / Grace CPM including trash from WCL v1 when a WCL API key is available
- `scripts/raid_audit.mjs` detects Windfury gaps `>10s` from WCL cast timestamps for overall and per-encounter reporting

## Metric Definition

### Numerator

Count `Windfury Totem` cast events by the enhancement shaman.

For per-encounter WF CPM:

- count only cast events inside that encounter/pull

For overall WF CPM including trash:

- count all `Windfury Totem` cast events across all combat pulls in the report, including trash pulls and boss pulls

### Denominator

Use **combat time**, not wall-clock report duration.

For per-encounter WF CPM:

- denominator = `ReportFight.endTime - ReportFight.startTime`

For overall WF CPM including trash:

- denominator = sum of `(fight.endTime - fight.startTime)` for every combat pull where the shaman was present

Then:

```text
WF CPM = total Windfury Totem casts / total combat minutes
```

## Why This Denominator

Do **not** use:

- report upload span
- time between pulls
- total time from first pull to last pull

Those include downtime, drinking, loot, breaks, and movement between packs. The denominator should reflect only time spent in combat pulls.

## Data Sources

### Parseforge

Good for:

- per-encounter `Windfury Totem` cast counts
- per-encounter `Windfury Totem` CPM
- per-encounter `Grace of Air Totem` cast counts

Not sufficient for:

- overall WF CPM including trash
- exact timestamp gap analysis

### Warcraft Logs

Use WCL for:

- report-wide Windfury Totem cast event counting
- combat-pull duration summation across boss and trash pulls
- future exact `>10s` downtime checks between casts

## Current Implemented Method

The current skill uses WCL v1 report endpoints for overall WF CPM because they work with API-key auth and are enough for this metric:

- `/v1/report/fights/{code}`
- `/v1/report/events/casts/{code}`

Environment variables used by the skill:

- `WARCRAFTLOGS_API_KEY`
- `WCL_API_KEY`
- fallback aliases: `WARCRAFTLOGS_CLIENT_SECRET`, `WCL_CLIENT_SECRET`

Method:

1. Fetch `/report/fights/{code}` to get all combat pulls in the report.
2. Match enhancement shaman names from Parseforge to WCL `friendlies`.
3. For each pull and enhancement shaman, fetch `/report/events/casts/{code}` filtered by `sourceid`, `start`, and `end`.
4. Treat a pull as active for that shaman if at least one cast event exists in the pull.
5. Count `Windfury Totem` casts via `ability.guid == 25587`.
6. Sum active-pull combat durations and compute:

```text
overall WF CPM = total WF casts / active combat minutes
```

This is the path currently used in the skill.

Gap detection:

1. collect `Windfury Totem` cast timestamps per pull
2. sort timestamps ascending
3. compute deltas between consecutive timestamps
4. count any delta `> 10000 ms`
5. track the longest such gap

## Future WCL GraphQL Method

### 1. Authenticate

Use Warcraft Logs OAuth 2.0.

- Public API: client credentials flow
- Endpoint family: `/api/v2/client`
- Private reports require user auth under `/api/v2/user`
- Environment variables used by this skill:
  - `WARCRAFTLOGS_CLIENT_ID`
  - `WARCRAFTLOGS_CLIENT_SECRET`
  - aliases: `WCL_CLIENT_ID`, `WCL_CLIENT_SECRET`, `WARCRAFTLOGS_CLIENT_KEY`

Official docs:

- https://www.warcraftlogs.com/api/docs

### 2. Resolve the report

Query the report by code and retrieve:

- `startTime`
- `endTime`
- `fights`
- `masterData { actors }`

The official schema docs show:

- `Report.events(...)`
- `Report.fights(...)`
- `Report.masterData(...)`

Docs:

- https://classic.warcraftlogs.com/v2-api-docs/warcraft/report.doc.html
- https://classic.warcraftlogs.com/v2-api-docs/warcraft/reportfight.doc.html
- https://classic.warcraftlogs.com/v2-api-docs/warcraft/reportmasterdata.doc.html

### 3. Identify enhancement shamans

Preferred order:

1. Use known enhancement shaman names from Parseforge or raid roster context.
2. Match those names to WCL `ReportActor.id` values from `masterData.actors`.

Do not rely on class alone if multiple shamans are present.

### 4. Build the denominator

Use `fights()` and sum durations only for pulls where the player participated.

Use:

- `fight.startTime`
- `fight.endTime`
- `fight.friendlyPlayers`

Recommended rule:

- include every `ReportFight` where the shaman's actor ID is in `friendlyPlayers`

This naturally includes both:

- boss fights
- trash pulls

and excludes out-of-combat time between pulls.

### 5. Build the numerator

Query `events(...)` filtered to:

- `dataType: Casts`
- `sourceID: <enh shaman actor id>`
- `abilityID: <Windfury Totem ability id>`
- `startTime: report.startTime`
- `endTime: report.endTime`

Paginate using `ReportEventPaginator.nextPageTimestamp` until exhausted.

The paginator docs show:

- `data`
- `nextPageTimestamp`

Docs:

- https://classic.warcraftlogs.com/v2-api-docs/warcraft/reporteventpaginator.doc.html

### 6. Compute metrics

For each enhancement shaman:

```text
overall_wf_cpm = total_wf_casts / (total_combat_ms / 60000)
```

For each encounter:

```text
encounter_wf_cpm = wf_casts_in_fight / ((fight.endTime - fight.startTime) / 60000)
```

## Recommended Output

For a leadership summary:

```md
Windfury / Twisting
- Tyronequante: overall WF 5.1 CPM incl trash; Gruul 4.8 CPM; Mag 3.4 CPM
- Pestilian: overall WF 6.0 CPM incl trash; Gruul 6.1 CPM; Mag 6.6 CPM
```

Optional additions:

- `Grace of Air Totem` CPM
- `twist pairs = min(WF casts, Grace casts)`
- comparison to best shaman in raid

## Future Extension: Gap Analysis

Once timestamped WCL casts are being pulled, exact downtime checks become possible:

1. sort `Windfury Totem` cast timestamps
2. compute deltas between casts
3. flag gaps `> 10000 ms`

That should be implemented only after the CPM method is working.
