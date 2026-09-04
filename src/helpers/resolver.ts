import { unifiClient } from "../client.js";
import type { SiteEntry } from "./site-index.js";
import { RESOLUTION } from "./site-index.js";
import {
  buildSiteIndex,
  matchSites,
  resolveLocalSiteId,
  SiteResolutionError,
} from "./site-index.js";
import type { HostGroup } from "./select-site.js";
import { selectHost, selectSite } from "./select-site.js";

interface SiteInfo {
  siteId: string;
  hostId: string;
  hostName: string;
}

interface DeviceHostEntry {
  hostId: string;
  hostName: string;
  devices: DeviceEntry[];
  updatedAt: string;
}

export interface DeviceEntry {
  id: string;
  mac: string;
  name: string;
  model: string;
  shortname: string;
  ip: string;
  productLine: string;
  status: string;
  version: string;
  firmwareStatus: string;
  isConsole: boolean;
  startupTime: string | null;
}

/**
 * Every site with its console name. Served from the shared index, which already
 * holds exactly this join -- it used to issue its own `/hosts` + `/sites` pair
 * alongside the index's, so any tool calling both paid for four requests.
 *
 * Host-only rows (a console carrying no Network site) are dropped: this returns
 * SITES, and adding a row with an empty `siteId` would silently widen it.
 */
export async function resolveAllSites(): Promise<SiteInfo[]> {
  const { entries } = await buildSiteIndex();
  return entries
    .filter((e) => e.cloudSiteId)
    .map((e) => ({
      siteId: e.cloudSiteId,
      hostId: e.hostId,
      hostName: e.hostName,
    }));
}

/**
 * Fleet device inventory.
 *
 * Deliberately NOT cached, unlike the site index. The field that matters here is
 * `status` -- a tech asking "is it online?" during triage is asking about right
 * now, and a cached "online" for a box that dropped a minute ago is worse than
 * the round trip it saves. The index caches identity, which does not change; this
 * carries state, which does.
 */
export async function resolveAllDevices(): Promise<DeviceHostEntry[]> {
  const response = await unifiClient.get<{ data: DeviceHostEntry[] }>(
    "/devices",
  );
  return response.data;
}

// --- Connector resolution helpers ---

export interface ConnectorContext {
  hostId: string;
  hostName: string;
  localSiteId: string;
  /** The customer-facing name. On a UOS console `hostName` is a bare hex id. */
  displayName: string;
}

/**
 * Append why the index is incomplete, when it is.
 *
 * A "no site matches" built from a partial feed is a different claim from one
 * built from a whole feed, and the caller cannot tell them apart otherwise --
 * which is how a `/hosts` outage came to look exactly like a typo.
 */
function withIndexHealth(message: string, degraded: readonly string[]): string {
  return degraded.length ? `${message} NOTE: ${degraded.join(" ")}` : message;
}

/**
 * Resolve a free-text name to exactly one SITE, or refuse with a typed reason.
 *
 * The single entry point for "which site did they mean?". Everything needing a
 * site id goes through here, so the ambiguity policy cannot be bypassed.
 */
export async function resolveSiteEntry(name: string): Promise<SiteEntry> {
  const index = await buildSiteIndex();
  const selection = selectSite(matchSites(index.entries, name), name);

  if (!selection.chosen) {
    // 300 when the caller must narrow down, 404 when nothing matched at all.
    const status =
      selection.candidates.length > 1
        ? RESOLUTION.AMBIGUOUS
        : RESOLUTION.NOT_FOUND;
    throw new SiteResolutionError(
      withIndexHealth(
        selection.reason ?? `'${name}' did not match any site or console.`,
        index.degraded,
      ),
      status,
    );
  }

  return selection.chosen;
}

/**
 * Resolve a free-text name to exactly one CONSOLE.
 *
 * For host-scoped endpoints only. Every site on a console returns the same
 * host-scoped answer, so a name matching many sites of ONE console is not
 * ambiguous here -- routing these callers through `resolveSiteEntry` made a
 * console with many sites permanently unreachable by its own name, while the
 * parameter description told the model that name was valid input.
 */
export async function resolveHostEntry(name: string): Promise<HostGroup> {
  const index = await buildSiteIndex();
  const selection = selectHost(matchSites(index.entries, name), name);

  if (!selection.chosen) {
    const status =
      selection.groups.length > 1 ? RESOLUTION.AMBIGUOUS : RESOLUTION.NOT_FOUND;
    throw new SiteResolutionError(
      withIndexHealth(
        selection.reason ?? `'${name}' did not match any site or console.`,
        index.degraded,
      ),
      status,
    );
  }

  return selection.chosen;
}

/**
 * Device inventory for whatever console a name resolves to.
 *
 * `/devices` is HOST-scoped, so every site on a shared console reports the same
 * inventory -- that is the API's shape, not a bug here. What was a bug is
 * reaching it by exact hostname match, which no customer on a shared console
 * could ever satisfy.
 *
 * `host.sites` carries every site the name matched. A caller wanting a
 * SITE-scoped figure alongside the inventory must use `soleSite`, which returns
 * null when the name picked out a console rather than one site -- reporting one
 * arbitrary site's statistics under a console's name is the original bug.
 */
export async function resolveDeviceHostEntry(
  name: string,
): Promise<{ host: HostGroup; devices: DeviceHostEntry | null }> {
  // Independent: `resolveAllDevices` takes no argument. Serialised, a cold
  // cache paid /hosts+/sites THEN /devices on the hot path of nearly every
  // semantic tool. Promise.all attaches a handler to both, so a rejection from
  // either surfaces normally rather than becoming an unhandled rejection.
  const [host, all] = await Promise.all([
    resolveHostEntry(name),
    resolveAllDevices(),
  ]);
  return { host, devices: all.find((h) => h.hostId === host.hostId) ?? null };
}

/**
 * Resolve a free-text site or console name to a connector-addressable context.
 *
 * Was: match the console hostname exactly, then take `data[0]` of its site list.
 * On a console carrying one site per customer that resolves everyone to the
 * empty "Default" site. Now goes through the fleet-wide index, which searches
 * customer names as well as console names and joins to the correct local site id
 * on `internalReference`.
 *
 * SITE-scoped, so it keeps the strict policy: a connector call acts on one site.
 *
 * Throws `SiteResolutionError` rather than returning null, so "no such site"
 * (404), "console unreachable" (502) and "ambiguous" (300) stay distinguishable.
 */
export async function resolveConnectorContext(
  name: string,
): Promise<ConnectorContext> {
  const entry = await resolveSiteEntry(name);
  const localSiteId = await resolveLocalSiteId(entry);

  return {
    hostId: entry.hostId,
    hostName: entry.hostName,
    localSiteId,
    displayName: entry.displayName,
  };
}

