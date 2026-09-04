/**
 * Fleet-wide site index.
 *
 * Upstream addressed everything by CONSOLE: `resolveHostByName` matched a host's
 * hostname exactly, then `resolveConnectorContext` took `data[0]` of that
 * console's local site list. On a fleet where one UniFi OS Server carries a site
 * per customer, that resolves every single customer to the console's first site
 * -- which is the empty "Default" placeholder. It is not that the other sites
 * were unreachable; they were being answered with another site's data.
 *
 * The fix rests on one join, verified against a live multi-site console with a
 * 100% hit rate: Site Manager's `meta.name` (an opaque slug) is the same value
 * the local Network API returns as `internalReference`. The human-readable name
 * lives in Site Manager's `meta.desc` and in the local API's `name` -- the two
 * feeds carry the same two strings under swapped keys.
 *
 * Cost model: the searchable index is built from two cloud calls and NO
 * connector calls, because `meta.desc` already carries the customer name. A
 * connector round trip happens only once a specific site has been chosen, and is
 * cached per console -- which matters, since the Cloud Connector is rate limited
 * to 100 requests per minute per console.
 */

import { unifiClient } from "../client.js";
import { connectorClient } from "../connector-client.js";

export interface SiteEntry {
  /** Site Manager's site id. Not accepted by the local Network API. */
  cloudSiteId: string;
  hostId: string;
  /** Console hostname. On a UniFi OS Server this is a bare hex id, not a name. */
  hostName: string;
  /** `meta.name` cloud-side, `internalReference` local-side. The join key. */
  slug: string;
  /** The name a human would search for. */
  displayName: string;
  timezone?: string;
}

/**
 * The index plus how much of it is trustworthy.
 *
 * `degraded` is not decoration. `/hosts` supplies the console hostname, which is
 * ALSO the display name of every single-site console (their `meta.desc` is the
 * useless literal "Default"). So losing `/hosts` does not merely degrade
 * labelling -- it makes every single-site console unfindable by name, and the
 * resulting "no site matches" is indistinguishable from a typo. Carrying the
 * reason alongside the entries is what lets a caller tell those two apart.
 */
export interface SiteIndex {
  entries: readonly SiteEntry[];
  /** Empty when the index is complete. One human-readable line per gap. */
  degraded: readonly string[];
}

/**
 * Why a resolution failed, kept apart from the fact that it did. Upstream
 * returned bare `null` for all four, so an outage read as a typo.
 */
export const RESOLUTION = {
  /** Several sites match; the caller must narrow down. */
  AMBIGUOUS: 300,
  /** Nothing matched, or the console has no such site. */
  NOT_FOUND: 404,
  /** The console did not answer. Not the operator's mistake. */
  UNREACHABLE: 502,
} as const;

export class SiteResolutionError extends Error {
  status: number;

  constructor(message: string, status: number, cause?: unknown) {
    // Standard ES2022 cause, not a shadowing class field of the same name.
    super(message, { cause });
    this.name = "SiteResolutionError";
    this.status = status;
  }
}

interface HostResponse {
  id: string;
  reportedState?: { hostname?: string; name?: string };
}

/**
 * Site Manager's per-site statistics block.
 *
 * One definition. It was written three times -- `SiteStatistics` in analysis.ts
 * and analytics.ts, `SiteStats` in aggregations.ts -- differing only in which
 * fields each had bothered to declare.
 */
export interface SiteStatistics {
  counts?: { totalDevice?: number; offlineDevice?: number };
  gateway?: { shortname?: string };
  percentages?: { wanUptime?: number };
  wans?: Record<string, { wanUptime?: number; externalIp?: string }>;
}

export interface SiteResponse {
  siteId: string;
  hostId: string;
  meta?: { name?: string; desc?: string; timezone?: string };
  statistics?: SiteStatistics;
}

interface LocalSiteResponse {
  id: string;
  name?: string;
  internalReference?: string;
}

const INDEX_TTL_MS = 5 * 60_000;
const LOCAL_SITES_TTL_MS = 5 * 60_000;

/**
 * A degraded index is cached far more briefly than a complete one. It is still
 * cached -- a `/hosts` outage must not turn every lookup into a retry storm --
 * but five minutes of unfindable consoles is a long time to serve an answer we
 * already know is wrong.
 */
const DEGRADED_INDEX_TTL_MS = 30_000;

/**
 * How long the OPTIONAL `/hosts` leg may hold up the whole index.
 *
 * It must stay well under DEGRADED_INDEX_TTL_MS, and the reason is not taste.
 * `client.ts` wraps every request in `withRetry`: 4 attempts at a 30 s timeout
 * plus ~7 s of backoff, and `isRetryableError` treats a bare network error as
 * retryable. So a HANGING `/hosts` takes ~127 s to reach the `.catch` that
 * degrades -- longer than the 30 s TTL that then rebuilds it. Every rebuild
 * re-pays the ladder, a build is therefore always in flight, and `memoAsync`
 * makes callers wait on it rather than serving the expired entry. A partial
 * outage of the optional feed became a total latency outage of every semantic
 * tool -- the exact opposite of what degrading is for.
 */
const HOSTS_DEADLINE_MS = 5_000;

/** The local Network API caps `limit` at 200 and defaults to 25. */
const LOCAL_SITES_PAGE_LIMIT = 200;

/** Stops a bad `totalCount` from paging forever. 20 * 200 = 4000 sites. */
const LOCAL_SITES_MAX_PAGES = 20;

// Module-global, which is correct ONLY because this process serves a single
// UniFi account: the API key comes from config at import time and never varies
// per request. If this ever takes a per-caller key, these caches must be keyed
// by it -- an unkeyed cache would serve one tenant's fleet to another.
const localSitesCache = new Map<
  string,
  { at: number; byRef: Map<string, string> }
>();

/**
 * TTL cache + in-flight dedupe, written once.
 *
 * Both feeds need the identical seven-line dance, including the `inFlight ===
 * running` guard that is easy to get subtly wrong. `generation` is what makes
 * `clear()` honest: without it, a build already in flight when the cache is
 * cleared still writes its stale result on settle, so the clear silently undoes
 * itself and the next five minutes serve exactly what was discarded.
 */
function memoAsync<T>(load: () => Promise<T>, ttlOf: (value: T) => number) {
  let cache: { at: number; value: T } | null = null;
  let inFlight: Promise<T> | null = null;
  let generation = 0;

  return {
    async get(): Promise<T> {
      if (cache && Date.now() - cache.at < ttlOf(cache.value)) return cache.value;
      if (inFlight) return inFlight;

      const mine = generation;
      const running = load().then((value) => {
        if (generation === mine) cache = { at: Date.now(), value };
        return value;
      });
      inFlight = running;
      try {
        return await running;
      } finally {
        if (inFlight === running) inFlight = null;
      }
    },
    clear(): void {
      generation++;
      cache = null;
      inFlight = null;
    },
  };
}

const sitesFeed = memoAsync(async () => {
  const resp = await unifiClient.get<{ data: SiteResponse[] }>("/sites");
  return resp.data ?? [];
}, () => INDEX_TTL_MS);

/**
 * A console that just failed is very likely to fail again. Without this, one
 * fan-out over a large console spends most of the Cloud Connector's 100
 * requests/minute budget re-asking a box already known to be down -- and the
 * rate-limit response that follows looks like yet another distinct failure.
 * Short enough that a console coming back is picked up within seconds.
 */
const NEGATIVE_TTL_MS = 30_000;
const negativeCache = new Map<string, { at: number; err: SiteResolutionError }>();

export function clearSiteIndexCache(): void {
  indexFeed.clear();
  sitesFeed.clear();
  localSitesCache.clear();
  negativeCache.clear();
}

/**
 * The raw `/sites` payload, fetched at most once per TTL for the whole process.
 *
 * `buildSiteIndex` needs these rows and so do the analytics tools, which want
 * the `statistics` block the index deliberately drops. Before this existed each
 * of those tools issued its own `/sites` call alongside the index's, so a single
 * `compare-sites` cost two identical round trips.
 *
 * `T` is CONSTRAINED to `SiteResponse` rather than free. Unconstrained it was a
 * double cast through `unknown` and checked nothing: three callers declared
 * `statistics` as required on a row type where it is optional, so narrowing what
 * this caches would have compiled clean and thrown at runtime.
 */
export async function fetchSitesCached<T extends SiteResponse = SiteResponse>(): Promise<
  T[]
> {
  // A shallow copy, not the cached array. Handing out the live array lets one
  // caller's sort or splice reorder the rows every other caller and the index
  // itself are built from.
  return [...(await sitesFeed.get())] as T[];
}

/**
 * "Default" is what every single-site console calls its only site, so it
 * identifies nothing. The console's own name is the useful label there.
 */
function pickDisplayName(desc: string | undefined, hostName: string): string {
  const trimmed = (desc ?? "").trim();
  if (!trimmed || trimmed.toLowerCase() === "default") return hostName;
  return trimmed;
}

/**
 * `/hosts`, or an empty list and the reason, within a fixed deadline.
 *
 * Returns the problem rather than pushing it into a shared array: a slow fetch
 * that loses the race still settles later, and a late `.push` would mutate the
 * `degraded` array of an index that has already been built and cached, silently
 * growing duplicate lines minutes afterwards. Returning a value cannot do that.
 */
async function fetchHostsWithin(
  ms: number,
): Promise<{ hosts: HostResponse[]; problem: string | null }> {
  const fetched = unifiClient.get<{ data: HostResponse[] }>("/hosts").then(
    (resp) => ({ hosts: resp.data ?? [], problem: null }),
    (err: unknown) => ({
      hosts: [] as HostResponse[],
      // Status line only -- never a response body, which can echo a 401 payload.
      // This string rides the tool SUCCESS path, which does not pass through
      // the toolkit's redaction.
      problem: err instanceof Error ? err.message : String(err),
    }),
  );

  const deadline = new Promise<{ hosts: HostResponse[]; problem: string }>(
    (resolve) => {
      // unref: a pending timer must not hold the process (or a test run) open
      // after the fetch has already won the race.
      setTimeout(
        () => resolve({ hosts: [], problem: `no answer within ${ms} ms` }),
        ms,
      ).unref();
    },
  );

  return Promise.race([fetched, deadline]);
}

async function loadSiteIndex(): Promise<SiteIndex> {
  const degraded: string[] = [];

  // /sites is REQUIRED: it carries every site and every customer name, and an
  // empty index would report every real site as "not found", so a failure
  // here propagates. /hosts is degradable -- but NOT cosmetic, see SiteIndex.
  const [hostsResult, siteRows] = await Promise.all([
    fetchHostsWithin(HOSTS_DEADLINE_MS),
    sitesFeed.get().catch((err: unknown) => {
      // Without this the raw client error escapes the SiteResolutionError
      // taxonomy entirely, and every caller's `err instanceof
      // SiteResolutionError ? ... : String(err)` reports an outage as a typo.
      throw new SiteResolutionError(
        `Site list unavailable: ${err instanceof Error ? err.message : String(err)}`,
        RESOLUTION.UNREACHABLE,
        err,
      );
    }),
  ]);

  if (hostsResult.problem) {
    degraded.push(
      `Console list unavailable (${hostsResult.problem}). Consoles cannot be ` +
        `found by name right now, and single-site consoles are listed as ` +
        `"unknown".`,
    );
  }

  const hostNames = new Map<string, string>();
  for (const h of hostsResult.hosts) {
    hostNames.set(
      h.id,
      h.reportedState?.hostname ?? h.reportedState?.name ?? "unknown",
    );
  }

  const entries: SiteEntry[] = siteRows.map((s) => {
    // A site whose hostId is absent from /hosts is real -- one was present in
    // the live fleet. Keep it: it is still addressable by name.
    const hostName = hostNames.get(s.hostId) ?? "unknown";
    return {
      cloudSiteId: s.siteId,
      hostId: s.hostId,
      hostName,
      slug: s.meta?.name ?? "",
      displayName: pickDisplayName(s.meta?.desc, hostName),
      timezone: s.meta?.timezone,
    };
  });

  // A console with no Network sites (a standalone Protect NVR, say) still
  // needs to be addressable for host-scoped endpoints that take no site id.
  const hostsWithSites = new Set(entries.map((e) => e.hostId));
  for (const [hostId, hostName] of hostNames) {
    if (hostsWithSites.has(hostId)) continue;
    entries.push({
      cloudSiteId: "",
      hostId,
      hostName,
      slug: "",
      displayName: hostName,
    });
  }

  reportIndexHealth(degraded);
  return { entries, degraded };
}

/**
 * The only operator-visible signal that the fleet index is incomplete.
 *
 * Without it the sole evidence is a "no site matches" reaching whoever happens
 * to be asking the AI, which is indistinguishable from a typo -- there is no
 * other log, metric or health surface in this process.
 *
 * Logged on TRANSITION only. A degraded index is rebuilt every 30 s by design,
 * so logging each rebuild would print through the night and be filtered out,
 * which is the same as not logging. Recovery is logged too: an operator needs
 * to know it cleared without watching for an absence.
 */
let lastDegraded: string | null = null;

function reportIndexHealth(degraded: readonly string[]): void {
  const now = degraded.length ? degraded.join(" ") : null;
  if (now === lastDegraded) return;
  lastDegraded = now;
  console.error(
    now
      ? `[UniFi] site index DEGRADED: ${now}`
      : "[UniFi] site index recovered: complete fleet visible again",
  );
}

/**
 * A known-incomplete index expires fast; a complete one is held for the full
 * window. The rule lives with the cache rather than at the call site, so it
 * cannot be forgotten by a future caller.
 *
 * Considered and rejected: giving `/hosts` its own short failure TTL and
 * dropping this rule. It does not work. The JOINED index is what gets cached,
 * so a recovered `/hosts` feed is invisible until THIS entry expires --- the
 * index TTL dominates, and the degradation is a property of the join, not of
 * either feed.
 */
const indexFeed = memoAsync(loadSiteIndex, (index) =>
  index.degraded.length ? DEGRADED_INDEX_TTL_MS : INDEX_TTL_MS,
);

export function buildSiteIndex(): Promise<SiteIndex> {
  return indexFeed.get();
}

/**
 * Rank candidates for a free-text query. Pure and synchronous so the matching
 * rules can be tested without touching the network.
 *
 * Returns EVERY match, best first. Narrowing many candidates down to one is a
 * policy decision and deliberately does not live here -- see `select-site.ts`.
 */
export function matchSites(
  entries: readonly SiteEntry[],
  query: string,
): SiteEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const scored: Array<{ entry: SiteEntry; rank: number }> = [];

  for (const entry of entries) {
    const display = entry.displayName.toLowerCase();
    const host = entry.hostName.toLowerCase();

    let rank: number | null = null;

    if (display === q) rank = 0;
    else if (host === q) rank = 1;
    // Every identifier an error message may hand back must be resolvable here,
    // or the "retry with the id" it offers is a dead end. Shared list, so that
    // is structural rather than a promise in a comment.
    else if (exactKeys(entry).some((k) => k.toLowerCase() === q)) rank = 1;
    else if (display.includes(q)) rank = 2;
    else if (host.includes(q)) rank = 3;

    if (rank !== null) scored.push({ entry, rank });
  }

  return scored
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.entry.displayName.localeCompare(b.entry.displayName),
    )
    .map((s) => s.entry);
}

/**
 * The identifiers that resolve this entry exactly.
 *
 * `matchSites` matches on these and `selectorFor` (select-site.ts) prints the
 * first of them, so the two cannot drift apart: an id a refusal offers is by
 * construction an id the resolver accepts. Keeping them as separate lists cost
 * a real bug -- the first version printed ids `matchSites` did not take.
 *
 * Order matters: the first is what gets printed, so the fleet-unique
 * `cloudSiteId` leads. `slug` is unique only within a console.
 */
export function exactKeys(entry: SiteEntry): string[] {
  return [entry.cloudSiteId, entry.slug, entry.hostId].filter(Boolean);
}

function isConnectorError(
  err: unknown,
): err is { status?: number; message?: string } {
  return typeof err === "object" && err !== null && "status" in err;
}

interface LocalSitesPage {
  data?: LocalSiteResponse[];
  totalCount?: number;
}

async function loadLocalSites(hostId: string): Promise<Map<string, string>> {
  const cached = localSitesCache.get(hostId);
  if (cached && Date.now() - cached.at < LOCAL_SITES_TTL_MS)
    return cached.byRef;

  // A console that just refused is very likely to refuse again. Checked
  // BEFORE the socket, or the cache saves nothing.
  const failed = negativeCache.get(hostId);
  if (failed && Date.now() - failed.at < NEGATIVE_TTL_MS) throw failed.err;

  const byRef = new Map<string, string>();
  let offset = 0;

  // Paged, because `limit` is capped at 200 by the local API. A console past
  // that cap would otherwise return a partial map, and a site in the missing
  // tail would be reported as "no such site" -- a 404 asserting something the
  // console never said.
  for (let page = 0; page < LOCAL_SITES_MAX_PAGES; page++) {
    let resp: LocalSitesPage;
    try {
      resp = await connectorClient.get<LocalSitesPage>(
        hostId,
        "network/integration/v1/sites",
        { limit: LOCAL_SITES_PAGE_LIMIT, offset },
      );
    } catch (err) {
      const status =
        isConnectorError(err) && typeof err.status === "number"
          ? err.status
          : RESOLUTION.UNREACHABLE;
      const failure = new SiteResolutionError(
        `Cloud Connector could not reach console ${hostId}: ${
          isConnectorError(err) ? err.message : String(err)
        }`,
        status,
        err,
      );
      // Remember the failure for a moment: many sites on one console must not
      // become many retries against a box that just refused the first one.
      negativeCache.set(hostId, { at: Date.now(), err: failure });
      throw failure;
    }

    const rows = resp.data ?? [];
    for (const s of rows) {
      if (s.internalReference) byRef.set(s.internalReference, s.id);
    }

    offset += rows.length;

    // `rows.length < limit` is the one signal that does not depend on the
    // server's own arithmetic. Breaking on a missing or under-reported
    // `totalCount` cached a TRUNCATED map, and a site in the missing tail then
    // got a 404 quoting a site count the console never claimed -- exactly the
    // failure the pagination was added to prevent.
    if (rows.length < LOCAL_SITES_PAGE_LIMIT) break;

    if (page === LOCAL_SITES_MAX_PAGES - 1) {
      // Out of pages with rows still outstanding. Caching what we have would
      // turn "we stopped reading" into "the console does not have it".
      //
      // Realistically this fires because the console is IGNORING `offset` and
      // serving page 0 forever, not because it holds thousands of sites. The
      // evidence separating the two is already here: under a broken `offset`,
      // `byRef` stops growing while `offset` keeps climbing. Say which it is
      // rather than asserting a site count the console never claimed.
      const failure = new SiteResolutionError(
        `Console ${hostId} did not finish listing its sites: read ${offset} rows ` +
          `over ${LOCAL_SITES_MAX_PAGES} full pages but saw only ${byRef.size} ` +
          `distinct sites -- it either holds more than ${
            LOCAL_SITES_MAX_PAGES * LOCAL_SITES_PAGE_LIMIT
          } sites, or is ignoring 'offset'. Refusing to answer from a partial list.`,
        RESOLUTION.UNREACHABLE,
      );
      // Remembered like any other console failure. Without this the refusal
      // costs 20 connector calls EVERY attempt, against a 100 req/min per
      // console budget -- five retries exhaust it, and the 429s that follow
      // surface as a different and misleading fault. This is the one path the
      // negative cache did not cover and the one 20x more expensive than the
      // path it did.
      negativeCache.set(hostId, { at: Date.now(), err: failure });
      console.error(`[UniFi] ${failure.message}`);
      throw failure;
    }
  }

  localSitesCache.set(hostId, { at: Date.now(), byRef });
  return byRef;
}

/**
 * Map an indexed site to the id the LOCAL Network API expects.
 *
 * The cloud `siteId` is not accepted by the local API, which is why this step
 * exists at all. One connector call per console, cached.
 */
export async function resolveLocalSiteId(entry: SiteEntry): Promise<string> {
  if (!entry.slug) {
    // A console with no Network sites at all (a Protect-only NVR). Saying so
    // beats a 404 quoting an empty slug back at the caller.
    throw new SiteResolutionError(
      `'${entry.displayName}' is a console with no UniFi Network site, so it ` +
        `has nothing site-scoped to query.`,
      RESOLUTION.NOT_FOUND,
    );
  }

  const byRef = await loadLocalSites(entry.hostId);

  const localSiteId = byRef.get(entry.slug);
  if (!localSiteId) {
    // The console answered, so this is genuinely "no such site" -- not an
    // outage. 404, never the 502 that a transport failure raises above.
    throw new SiteResolutionError(
      `Console ${entry.hostName} has no site '${entry.slug}' (${entry.displayName}). ` +
        `It reported ${byRef.size} site(s).`,
      RESOLUTION.NOT_FOUND,
    );
  }

  return localSiteId;
}

/**
 * cloudSiteId -> the name a human would recognise.
 *
 * For the fleet-wide LISTING tools. They joined `/sites` rows to a console
 * hostname by hostId, so on a console holding many customer sites every row
 * came back labelled with the same bare hex id -- and anything bucketing by
 * that label collapsed those customers into one. `/sites` rows carry `siteId`,
 * which is unique per customer; that is the axis to label on.
 */
export async function siteLabelsBySiteId(): Promise<{
  labels: Map<string, string>;
  degraded: readonly string[];
}> {
  const { entries, degraded } = await buildSiteIndex();
  // `degraded` rides along rather than being discarded here. It was dropped,
  // so the fleet listings rendered every single-site console as "unknown" with
  // no caveat at all -- the one output where the degradation is most visible
  // was the one that explained it least.
  return {
    labels: new Map(
      entries.filter((e) => e.cloudSiteId).map((e) => [e.cloudSiteId, e.displayName]),
    ),
    degraded,
  };
}
