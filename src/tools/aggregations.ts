import { z } from "zod/v4";
import { SITE_NAME_DESCRIPTION } from "./site-param.js";
import { aggregate } from "@us-all/mcp-toolkit";
import { unifiClient } from "../client.js";
import { connectorClient } from "../connector-client.js";
import { resolveConnectorContext, resolveDeviceHostEntry } from "../helpers/resolver.js";
import { SiteResolutionError } from "../helpers/site-index.js";
import { isConnectorAvailable } from "../config.js";
import { extractFieldsDescription } from "./extract-fields.js";

const ef = z.string().optional().describe(extractFieldsDescription);

type StabilityScore = "stable" | "intermittent" | "unstable";
type WanStatus = "healthy" | "warning" | "critical";

function hoursAgo(isoTime: string | null | undefined): number | null {
  if (!isoTime) return null;
  const diff = Date.now() - new Date(isoTime).getTime();
  return diff / (1000 * 60 * 60);
}

function classifyReboots(count: number): StabilityScore {
  if (count < 1) return "stable";
  if (count <= 3) return "intermittent";
  return "unstable";
}

function classifyWan(uptimePct: number | null): WanStatus {
  if (uptimePct === null) return "healthy";
  if (uptimePct < 90) return "critical";
  if (uptimePct < 95) return "warning";
  return "healthy";
}

/**
 * `summarize-site` — deep aggregated site view.
 * Goes beyond `analyze-site-health` by adding (when owner key available)
 * client list, networks, WiFi broadcasts, and firewall summary in one call.
 */

export const summarizeSiteSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
  includeClients: z.boolean().optional().default(false).describe("Include connected clients (requires owner key)"),
  clientLimit: z.coerce.number().optional().default(50).describe("Max clients to fetch"),
  includeNetworks: z.boolean().optional().default(true).describe("Include network configs (requires owner key)"),
  includeWifi: z.boolean().optional().default(true).describe("Include WiFi broadcasts (requires owner key)"),
  extractFields: ef,
});

interface SiteWanInfo { wanUptime?: number; externalIp?: string }
interface SiteStats {
  counts?: { totalDevice?: number; offlineDevice?: number };
  gateway?: { shortname?: string };
  wans?: Record<string, SiteWanInfo>;
}

export async function summarizeSite(params: z.infer<typeof summarizeSiteSchema>) {
  const name = params.name;

  // Resolve through the fleet index FIRST. This used to call
  // resolveDevicesByHostName, an exact match on console hostname, and bail
  // before any of the site resolution below could run -- so every customer on a
  // multi-site console got "site not found" from right here.
  let entry;
  let hostEntry;
  try {
    ({ entry, devices: hostEntry } = await resolveDeviceHostEntry(name));
  } catch (err) {
    return {
      site: name,
      error: err instanceof SiteResolutionError ? err.message : String(err),
      summary: { found: false },
    };
  }

  const sitesResp = await unifiClient.get<{ data: Array<{ siteId: string; hostId: string; statistics: SiteStats }> }>("/sites").catch(() => ({ data: [] }));
  // By site id, not by host id: a console carrying many sites returns many rows here
  // and `find(hostId)` takes whichever is first -- the empty Default site.
  const siteData = sitesResp.data.find((s) => s.siteId === entry.cloudSiteId);

  const caveats: string[] = [];

  let connectorCtx = null;
  if (isConnectorAvailable() && (params.includeClients || params.includeNetworks || params.includeWifi)) {
    // Record why the connector view is missing. Swallowing it made an outage,
    // a permissions problem and a typo look identical in the output.
    connectorCtx = await resolveConnectorContext(name).catch((err) => {
      caveats.push(`connector context unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
  }

  const ctx = connectorCtx;
  const { clients, networks, wifi } = await aggregate(
    {
      clients: ctx && params.includeClients
        ? () => connectorClient.get(ctx.hostId, `network/integration/v1/sites/${ctx.localSiteId}/clients`, { limit: params.clientLimit })
        : () => Promise.resolve(null),
      networks: ctx && params.includeNetworks
        ? () => connectorClient.get(ctx.hostId, `network/integration/v1/sites/${ctx.localSiteId}/networks`)
        : () => Promise.resolve(null),
      wifi: ctx && params.includeWifi
        ? () => connectorClient.get(ctx.hostId, `network/integration/v1/sites/${ctx.localSiteId}/wifi-broadcasts`)
        : () => Promise.resolve(null),
    },
    caveats,
  );

  // Slim each device to drop noise fields (uidb icon blob, adoptionTime,
  // isManaged, note) that bloat the response without aiding LLM analysis.
  // Callers needing full device payload should use list-devices directly.
  // A console can be absent from /devices (it reports only hosts the key owns
  // devices for). That is an empty device list, not a failed lookup.
  if (!hostEntry) caveats.push(`no device inventory returned for console ${entry.hostName}`);
  const devices = (hostEntry?.devices ?? []).map((d) => ({
    id: d.id,
    mac: d.mac,
    name: d.name,
    model: d.model,
    shortname: d.shortname,
    ip: d.ip,
    productLine: d.productLine,
    status: d.status,
    version: d.version,
    firmwareStatus: d.firmwareStatus,
    isConsole: d.isConsole,
    startupTime: d.startupTime,
  }));
  const onlineDevices = devices.filter((d) => d.status === "online").length;
  const wans = siteData?.statistics.wans ?? {};
  const minWanUptime = Object.values(wans).reduce<number | null>((acc, w) => {
    const u = w.wanUptime ?? null;
    if (u === null) return acc;
    return acc === null ? u : Math.min(acc, u);
  }, null);

  return {
    site: name,
    hostId: entry.hostId,
    devices: { total: devices.length, online: onlineDevices, offline: devices.length - onlineDevices, list: devices },
    wan: wans,
    clients,
    networks,
    wifiBroadcasts: wifi,
    summary: {
      gateway: siteData?.statistics.gateway?.shortname ?? "unknown",
      deviceOnlinePct: devices.length === 0 ? 0 : Math.round((onlineDevices / devices.length) * 1000) / 10,
      minWanUptime,
      // connectorAvailable reflects the owner-key capability, independent of
      // whether this call requested any connector-backed includeX flag.
      connectorAvailable: isConnectorAvailable(),
      // connectorResolved reports whether we actually fetched a connector
      // context for this call (false when no includeX flag was set).
      connectorResolved: !!connectorCtx,
      clientsIncluded: !!clients,
    },
    caveats,
  };
}

/**
 * `site-health-timeline` — per-site health snapshot over a window.
 * Replaces 5+ sequential calls (devices → wan → reboots → optional clients).
 *
 * Strategy:
 *  - Resolve devices via hostName once.
 *  - Run all secondary fetches with Promise.allSettled so one failure
 *    does not poison the whole response (caveats[] surfaces partial-data).
 *  - WAN uptime sourced from `/sites.statistics.wans` — the same surface
 *    `wan-uptime-trend` uses. This is current/lifetime state, NOT a
 *    true time-bounded series; lookback is reflected in reboot detection.
 *  - Optional connector data (clients) only when isConnectorAvailable().
 */

export const siteHealthTimelineSchema = z.object({
  hostName: z.string().describe(SITE_NAME_DESCRIPTION),
  lookbackDays: z.coerce.number().int().min(1).max(90).optional().default(7)
    .describe("Window for reboot detection in days (1-90, default 7)"),
  extractFields: ef,
});

interface DeviceTimelineEntry {
  id: string;
  name: string;
  model: string;
  status: string;
  startupTime: string | null;
  rebootsInWindow: number;
  stabilityScore: StabilityScore;
}

interface RebootSummary {
  deviceId: string;
  deviceName: string;
  severity: "critical" | "warning" | "info";
  hoursAgo: number;
}

export async function siteHealthTimeline(params: z.infer<typeof siteHealthTimelineSchema>) {
  const lookbackDays = params.lookbackDays ?? 7;
  const lookbackHours = lookbackDays * 24;
  const now = new Date();
  const start = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  const period = {
    start: start.toISOString(),
    end: now.toISOString(),
    lookbackDays,
  };

  const caveats: string[] = [];

  // Routed through the index like every other site tool. Left as an exact
  // hostname match, this one tool kept the exact behaviour the fork removes --
  // while its own parameter told the model to pass a customer name.
  let timelineEntry;
  try {
    timelineEntry = await resolveDeviceHostEntry(params.hostName);
  } catch (err) {
    return {
      hostName: params.hostName,
      hostId: null,
      period,
      devices: [] as DeviceTimelineEntry[],
      reboots: [],
      clients: null,
      caveats: [err instanceof SiteResolutionError ? err.message : String(err)],
    };
  }
  const hostEntry = timelineEntry.devices;
  if (!hostEntry) {
    return {
      hostName: params.hostName,
      hostId: null,
      period,
      devices: [] as DeviceTimelineEntry[],
      reboots: [] as RebootSummary[],
      wan: { uptimePct: null, samples: 0, status: "healthy" as WanStatus },
      clients: { connector: "unavailable" as const, count: null },
      caveats: [`site '${params.hostName}' not found`],
    };
  }

  const connectorAvailable = isConnectorAvailable();

  const { sites, connectorContext } = await aggregate(
    {
      sites: () =>
        unifiClient.get<{ data: Array<{ hostId: string; statistics: { wans?: Record<string, { wanUptime?: number; externalIp?: string }> } }> }>("/sites"),
      connectorContext: connectorAvailable ? () => resolveConnectorContext(params.hostName) : () => Promise.resolve(null),
    },
    caveats,
  );

  // --- WAN aggregation (current / lifetime state from /sites) ---
  let wanUptimePct: number | null = null;
  let wanSamples = 0;
  if (sites) {
    const siteData = sites.data.find((s) => s.hostId === hostEntry.hostId);
    const wans = siteData?.statistics.wans ?? {};
    const uptimes = Object.values(wans)
      .map((w) => w.wanUptime)
      .filter((u): u is number => typeof u === "number");
    wanSamples = uptimes.length;
    if (uptimes.length > 0) {
      wanUptimePct = Math.round((uptimes.reduce((a, b) => a + b, 0) / uptimes.length) * 10) / 10;
    }
  }
  caveats.push("wan.uptimePct is sourced from /sites.statistics (current/lifetime state); the lookback window applies only to reboot detection");

  // --- Devices + reboot detection (reuses logic from detect-recent-reboots) ---
  const deviceEntries: DeviceTimelineEntry[] = [];
  const rebootList: RebootSummary[] = [];

  for (const d of hostEntry.devices) {
    const hours = hoursAgo(d.startupTime);
    const rebootedInWindow = hours !== null && hours < lookbackHours;
    // The Site Manager API exposes only the last startupTime, so reboots
    // within the window can only ever be 0 or 1 per device. Surface this
    // limitation in caveats below rather than fabricating a higher count.
    const rebootsInWindow = rebootedInWindow ? 1 : 0;

    deviceEntries.push({
      id: d.id,
      name: d.name,
      model: d.model,
      status: d.status,
      startupTime: d.startupTime,
      rebootsInWindow,
      stabilityScore: classifyReboots(rebootsInWindow),
    });

    if (rebootedInWindow && hours !== null) {
      let severity: RebootSummary["severity"] = "info";
      if (hours < 1) severity = "critical";
      else if (hours < 24) severity = "warning";
      rebootList.push({
        deviceId: d.id,
        deviceName: d.name,
        severity,
        hoursAgo: Math.round(hours * 10) / 10,
      });
    }
  }
  rebootList.sort((a, b) => a.hoursAgo - b.hoursAgo);
  caveats.push("rebootsInWindow is at most 1 per device — Site Manager API exposes only the most recent startupTime, not full reboot history");

  // --- Optional connector clients ---
  let clientsBlock: { connector: "available" | "unavailable"; count: number | null };
  if (!connectorAvailable) {
    clientsBlock = { connector: "unavailable", count: null };
    caveats.push("UNIFI_API_KEY_OWNER not set — client count omitted");
  } else if (!connectorContext) {
    clientsBlock = { connector: "unavailable", count: null };
    caveats.push(`connector context unavailable for '${params.hostName}'`);
  } else {
    const ctx = connectorContext;
    const clientsResp = await connectorClient.get<{ data: unknown[] }>(
      ctx.hostId,
      `network/integration/v1/sites/${ctx.localSiteId}/clients`,
      { limit: 1000 },
    ).catch((err: unknown) => {
      caveats.push(`connector clients fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (clientsResp && Array.isArray(clientsResp.data)) {
      clientsBlock = { connector: "available", count: clientsResp.data.length };
    } else {
      clientsBlock = { connector: "available", count: null };
    }
  }

  return {
    hostName: hostEntry.hostName,
    hostId: hostEntry.hostId,
    period,
    devices: deviceEntries,
    reboots: rebootList,
    wan: {
      uptimePct: wanUptimePct,
      samples: wanSamples,
      status: classifyWan(wanUptimePct),
    },
    clients: clientsBlock,
    caveats,
  };
}
