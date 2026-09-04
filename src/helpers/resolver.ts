import { unifiClient } from "../client.js";
import type { SiteEntry } from "./site-index.js";
import { RESOLUTION } from "./site-index.js";
import {
  buildSiteIndex,
  matchSites,
  resolveLocalSiteId,
  SiteResolutionError,
} from "./site-index.js";
import { selectSite } from "./select-site.js";

interface HostInfo {
  id: string;
  hostName: string;
  siteId: string;
}

interface SiteInfo {
  siteId: string;
  hostId: string;
  hostName: string;
}

interface HostResponse {
  id: string;
  reportedState?: { hostname?: string };
}

interface SiteResponse {
  siteId: string;
  hostId: string;
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

export async function resolveAllSites(): Promise<SiteInfo[]> {
  const [hosts, sitesResp] = await Promise.all([
    unifiClient.get<{ data: HostResponse[] }>("/hosts"),
    unifiClient.get<{ data: SiteResponse[] }>("/sites"),
  ]);

  const hostMap = new Map<string, string>();
  for (const h of hosts.data) {
    hostMap.set(h.id, h.reportedState?.hostname ?? "unknown");
  }

  return sitesResp.data.map((s) => ({
    siteId: s.siteId,
    hostId: s.hostId,
    hostName: hostMap.get(s.hostId) ?? "unknown",
  }));
}

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
 * Resolve a free-text name to exactly one site, or refuse with a typed reason.
 *
 * The single entry point for "which site did they mean?". Everything that needs
 * a site goes through here, so the ambiguity policy cannot be bypassed.
 */
export async function resolveSiteEntry(name: string): Promise<SiteEntry> {
  const index = await buildSiteIndex();
  const selection = selectSite(matchSites(index, name), name);

  if (!selection.chosen) {
    // 300 when the caller must narrow down, 404 when nothing matched at all.
    const status =
      selection.candidates.length > 1 ? RESOLUTION.AMBIGUOUS : RESOLUTION.NOT_FOUND;
    throw new SiteResolutionError(
      selection.reason ?? `'${name}' did not match any site or console.`,
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
 */
export async function resolveDeviceHostEntry(
  name: string,
): Promise<{ entry: SiteEntry; devices: DeviceHostEntry | null }> {
  const entry = await resolveSiteEntry(name);
  const all = await resolveAllDevices();
  return { entry, devices: all.find((h) => h.hostId === entry.hostId) ?? null };
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
