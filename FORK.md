# Fork notes — Lovad-Tech/unifi-mcp-server

Forked from [us-all/unifi-mcp-server](https://github.com/us-all/unifi-mcp-server) at v1.13.3 (MIT).

## Why

Upstream addresses everything by **console**. `resolveHostByName` matched a
console's hostname with an exact string comparison, and `resolveConnectorContext`
then took `data[0]` of that console's local site list.

That holds on a homelab with one console and one site. It does not hold on an MSP
fleet. On the fleet this fork was built against:

| | |
|---|---|
| Consoles (hosts) | 26 |
| Sites | 84 |
| Sites on a single UniFi OS Server | **60** |

Those 60 are one site per customer on one shared console whose hostname is a bare
hex id. So:

- **No customer was addressable.** There is no `Tailspin Tire - South` console; the
  name lives in `meta.desc`, which upstream's resolver dropped when mapping.
- **Every customer resolved to the same site.** `data[0]` on that console is the
  empty `Default` placeholder, so 60 customers' tools answered from one empty
  site — silently, with no error.
- **Failures were indistinguishable.** `catch { return null }` collapsed a 403, a
  connector timeout and a typo into one "not found".

## What changed

`src/helpers/site-index.ts` (new) builds a fleet-wide index and resolves against
it. It rests on one join, verified at 100% across a live 60-site console:

> Site Manager's `meta.name` (opaque slug) == the local Network API's
> `internalReference`. The human name is `meta.desc` cloud-side and `name`
> local-side — the same two strings under swapped keys.

- `buildSiteIndex()` — every site on every host, plus hosts with no Network sites.
  Two cloud calls, **zero** connector calls: `meta.desc` already has the name.
- `matchSites()` — pure, ranked, returns *every* candidate. Matches customer
  name, console name, slug and site id; exact beats partial.
- `resolveLocalSiteId()` — one connector call per console, cached, joined on
  `internalReference`. Never positional. Asks for `limit=200` (the local API
  defaults to 25).
- `SiteResolutionError` — carries a status: `404` no such site, `502` console
  unreachable, `300` ambiguous.

`src/helpers/select-site.ts` (new) isolates the ambiguity policy — what to do
when one query matches four branches of the same customer. Deliberately the only
decision point, kept out of the index so it can change without touching lookup.

Also: `list-sites` is now trimmed by default (it returned ~150 KB untrimmed, while
the adjacent `list-hosts` already trimmed); new `find-site` tool for searching the
fleet by customer name.

## Also fixed, because the first pass missed them

Four review passes (reuse / simplification / efficiency / altitude) found the fix
was applied unevenly. Recorded because each is a place the same bug could return:

- **Six call sites still matched console hostnames exactly** — including
  `siteHealthTimeline`, where the old call had been replaced with a *verbatim
  inline copy* of the same exact-hostname match while its parameter advertised
  customer names. `tests/no-exact-host-match.test.ts` now fails on the pattern
  anywhere in `src/`.
- **Four fleet listings were keyed on hostId**, so all 60 sites of the shared
  console carried one label and `listSitesOverview` bucketed them into one row.
  They join on `siteId` now, via `siteLabelsBySiteId()`.
- **`SiteResolutionError` is a `wrapToolHandler` extractor**, not a per-tool
  catch. The fallback branch keeps only `message`, so any tool that forgot to
  catch silently lost the status this fork exists to preserve.
- **The drift guard had two holes** — it scanned only `src/tools/`, missing
  `prompts.ts` (7 params, plus body text telling the model to "call `list-hosts`
  to enumerate consoles"), and its regex anchored on a prefix so
  `"Specific site host names to compare"` passed vacuously.

## Operational notes

- 30 s **negative cache** on connector failures: a dead console costs 1 call, not
  60, against a 100 req/min per-console limit.
- A shared **in-flight promise** for the index, so N concurrent tools cause one
  fetch pair rather than N.
- `/hosts` is **optional** — `/sites` alone carries every customer name, so
  losing `/hosts` degrades the fallback label, not reach. `/sites` failing is
  fatal by design: an empty index would report every real site as "not found".

## Verified

Against the live fleet, with the built `dist/`:

```
index entries: 86  (84 sites + 2 consoles with no Network sites)
59 UOS customer sites -> 59 distinct localSiteIds, 0 failures
listings: 82 distinct labels across 84 rows, no "default"/"unknown"
"Advanced Tire"              -> asks, naming all 5 branches
"Advanced Tire - Ocala East" -> resolves directly, 8 devices
```

Over real MCP, through supergateway, from a container on `mcp-net`: 55 tools,
`find-site` registered, ambiguous queries return `isError` with the candidate
list, exact names resolve.

71 unit tests. Nine guards mutation-checked (deleted, confirmed red, restored).
Unit tests use synthetic fixtures only (`tests/fixtures/fleet.ts`) — this fork is
public, so no customer names are committed. The fixtures copy the API *shapes*
verbatim, including the `meta.name`/`internalReference` flip the join depends on.

## Known gaps

- `analytics.ts` / `analysis.ts` refetch `/sites` that `buildSiteIndex` just
  fetched, and `/devices` is uncached with three new callers. Flagged by the
  efficiency review; not addressed.
- `firmwareInventory` still labels by console: `/devices` is host-scoped, so on a
  shared console there is genuinely no per-site attribution to be had.
- **Fabrics are not readable by anyone.** All three official OpenAPI specs
  (Network v10.4.57, Site Manager v1.0.0, Carrier Fabric v1.0.0) contain zero
  `fabric` endpoints; "Carrier Fabric" is ISP subscriber billing, unrelated. A
  site that is Fabric-managed may therefore be invisible to `/v1/sites` entirely
  — unconfirmed, and not something this fork can work around.

## Upstream

`upstream` remote is configured. Nothing here is Lovad-specific, so the site-index
work is a reasonable PR back to `us-all` if they want it.
