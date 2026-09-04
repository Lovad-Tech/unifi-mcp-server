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

## Verified

Against the live fleet, with the built `dist/`:

```
index entries: 86
sites on the UOS console: 60
distinct localSiteIds resolved for 60 UOS sites: 60 (failures: 0)
```

Unit tests use synthetic fixtures only (`tests/fixtures/fleet.ts`) — this fork is
public, so no customer names are committed. The fixtures copy the API *shapes*
verbatim, including the `meta.name`/`internalReference` flip that the join
depends on.

## Upstream

`upstream` remote is configured. Nothing here is Lovad-specific, so the site-index
work is a reasonable PR back to `us-all` if they want it.
