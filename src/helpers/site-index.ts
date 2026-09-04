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
 * The fix rests on one join, verified against a live 60-site console with a 100%
 * hit rate: Site Manager's `meta.name` (an opaque slug) is the same value the
 * local Network API returns as `internalReference`. The human-readable name
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

interface SiteResponse {
  siteId: string;
  hostId: string;
  meta?: { name?: string; desc?: string; timezone?: string };
}

interface LocalSiteResponse {
  id: string;
  name?: string;
  internalReference?: string;
}

const INDEX_TTL_MS = 5 * 60_000;
const LOCAL_SITES_TTL_MS = 5 * 60_000;

/** The local Network API caps `limit` at 200 and defaults to 25. */
const LOCAL_SITES_PAGE_LIMIT = 200;

// Module-global, which is correct ONLY because this process serves a single
// UniFi account: the API key comes from config at import time and never varies
// per request. If this ever takes a per-caller key, these caches must be keyed
// by it -- an unkeyed cache would serve one tenant's fleet to another.
let indexCache: { at: number; entries: SiteEntry[] } | null = null;
const localSitesCache = new Map<
  string,
  { at: number; byRef: Map<string, string> }
>();

/**
 * A console that just failed is very likely to fail again. Without this, one
 * fan-out over a 60-site console spends 60 of the Cloud Connector's 100
 * requests/minute budget re-asking a box already known to be down -- and the
 * rate-limit response that follows looks like yet another distinct failure.
 * Short enough that a console coming back is picked up within seconds.
 */
const NEGATIVE_TTL_MS = 30_000;
const negativeCache = new Map<string, { at: number; err: SiteResolutionError }>();

/** Shared in-flight build, so N concurrent callers cause one fetch pair. */
let inFlightIndex: Promise<SiteEntry[]> | null = null;

export function clearSiteIndexCache(): void {
  indexCache = null;
  inFlightIndex = null;
  localSitesCache.clear();
  negativeCache.clear();
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

export async function buildSiteIndex(): Promise<SiteEntry[]> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) {
    return indexCache.entries;
  }
  if (inFlightIndex) return inFlightIndex;

  const build = (async () => {
    // /sites is REQUIRED: it carries every site and every customer name, and an
    // empty index would report every real site as "not found". /hosts is
    // optional -- it only supplies the fallback label for a site called
    // "Default", so losing it degrades naming, not reach.
    const [hostsResult, sitesResp] = await Promise.all([
      unifiClient
        .get<{ data: HostResponse[] }>("/hosts")
        .catch(() => ({ data: [] as HostResponse[] })),
      unifiClient.get<{ data: SiteResponse[] }>("/sites"),
    ]);

    const hostNames = new Map<string, string>();
    for (const h of hostsResult.data ?? []) {
      hostNames.set(
        h.id,
        h.reportedState?.hostname ?? h.reportedState?.name ?? "unknown",
      );
    }

    const entries: SiteEntry[] = (sitesResp.data ?? []).map((s) => {
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

    indexCache = { at: Date.now(), entries };
    return entries;
  })();

  inFlightIndex = build;
  try {
    return await build;
  } finally {
    if (inFlightIndex === build) inFlightIndex = null;
  }
}

/**
 * Rank candidates for a free-text query. Pure and synchronous so the matching
 * rules can be tested without touching the network.
 *
 * Returns EVERY match, best first. Narrowing many candidates down to one is a
 * policy decision and deliberately does not live here -- see `select-site.ts`.
 */
export function matchSites(index: SiteEntry[], query: string): SiteEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const scored: Array<{ entry: SiteEntry; rank: number }> = [];

  for (const entry of index) {
    const display = entry.displayName.toLowerCase();
    const host = entry.hostName.toLowerCase();
    const slug = entry.slug.toLowerCase();

    let rank: number | null = null;

    if (display === q) rank = 0;
    else if (host === q) rank = 1;
    else if (slug === q || entry.cloudSiteId.toLowerCase() === q) rank = 1;
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

function isConnectorError(
  err: unknown,
): err is { status?: number; message?: string } {
  return typeof err === "object" && err !== null && "status" in err;
}

async function loadLocalSites(hostId: string): Promise<Map<string, string>> {
  const cached = localSitesCache.get(hostId);
  if (cached && Date.now() - cached.at < LOCAL_SITES_TTL_MS)
    return cached.byRef;

  // A console that just refused is very likely to refuse again. Checked
  // BEFORE the socket, or the cache saves nothing.
  const failed = negativeCache.get(hostId);
  if (failed && Date.now() - failed.at < NEGATIVE_TTL_MS) throw failed.err;

  let resp: { data?: LocalSiteResponse[] };
  try {
    resp = await connectorClient.get<{ data?: LocalSiteResponse[] }>(
      hostId,
      "network/integration/v1/sites",
      { limit: LOCAL_SITES_PAGE_LIMIT },
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

  const byRef = new Map<string, string>();
  for (const s of resp.data ?? []) {
    if (s.internalReference) byRef.set(s.internalReference, s.id);
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
export async function siteLabelsBySiteId(): Promise<Map<string, string>> {
  const index = await buildSiteIndex();
  return new Map(
    index.filter((e) => e.cloudSiteId).map((e) => [e.cloudSiteId, e.displayName]),
  );
}
