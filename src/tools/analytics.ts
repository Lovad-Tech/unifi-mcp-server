import { z } from "zod/v4";
import { SITE_NAME_DESCRIPTION } from "./site-param.js";
import { buildSiteIndex, matchSites, siteLabelsBySiteId } from "../helpers/site-index.js";
import { unifiClient } from "../client.js";
import { connectorClient } from "../connector-client.js";
import {
  resolveAllDevices,
  resolveAllSites,
  resolveConnectorContext,
} from "../helpers/resolver.js";
import { isConnectorAvailable } from "../config.js";
import { extractFieldsDescription } from "./extract-fields.js";

const ef = z.string().optional().describe(extractFieldsDescription);

/**
 * Cross-site analytics tools.
 * Build on top of raw Site Manager + Cloud Connector APIs to surface
 * fleet-wide patterns that single-site tools cannot.
 */

interface SiteStatistics {
  counts?: { totalDevice?: number; offlineDevice?: number };
  gateway?: { shortname?: string };
  percentages?: { wanUptime?: number };
  wans?: Record<string, { wanUptime?: number; externalIp?: string }>;
}

// --- Tool: compare-sites -------------------------------------------------

export const compareSitesSchema = z.object({
  names: z.array(z.string()).optional().describe(`Sites to compare. ${SITE_NAME_DESCRIPTION} Omit to compare all.`),
  extractFields: ef,
});

export async function compareSites(params: z.infer<typeof compareSitesSchema>) {
  const [sitesResp, devicesData, labels] = await Promise.all([
    unifiClient.get<{ data: Array<{ siteId: string; hostId: string; statistics: SiteStatistics }> }>("/sites"),
    resolveAllDevices(),
    siteLabelsBySiteId(),
  ]);
  const index = await buildSiteIndex();

  // Label and filter on the SITE, not the console. Keyed on hostName, all 60
  // sites of a shared console carried one label and a customer-name filter
  // matched nothing.
  const filterSet = params.names
    ? new Set(
        params.names.flatMap((n) =>
          matchSites(index, n).map((e) => e.cloudSiteId),
        ),
      )
    : null;

  const rows = sitesResp.data
    .map((site) => {
      const hostName = labels.get(site.siteId) ?? "unknown";
      if (filterSet && !filterSet.has(site.siteId)) return null;

      const devices = devicesData.find((d) => d.hostId === site.hostId)?.devices ?? [];
      const online = devices.filter((d) => d.status === "online").length;
      const offline = devices.length - online;
      const onlinePct = devices.length === 0 ? 0 : Math.round((online / devices.length) * 1000) / 10;

      const wanUptimes = Object.values(site.statistics.wans ?? {}).map((w) => w.wanUptime ?? 0);
      const minWan = wanUptimes.length === 0 ? null : Math.min(...wanUptimes);
      const avgWan = wanUptimes.length === 0 ? null : Math.round(wanUptimes.reduce((a, b) => a + b, 0) / wanUptimes.length * 10) / 10;

      return {
        site: hostName,
        gateway: site.statistics.gateway?.shortname ?? "unknown",
        devices: { total: devices.length, online, offline, onlinePct },
        wan: { min: minWan, avg: avgWan, count: wanUptimes.length },
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  rows.sort((a, b) => a.site.localeCompare(b.site));

  const totalDevices = rows.reduce((s, r) => s + r.devices.total, 0);
  const totalOnline = rows.reduce((s, r) => s + r.devices.online, 0);

  return {
    checkedAt: new Date().toISOString(),
    totalSites: rows.length,
    fleetOnlinePct: totalDevices === 0 ? 0 : Math.round((totalOnline / totalDevices) * 1000) / 10,
    totalDevices,
    sites: rows,
  };
}

// --- Tool: firmware-inventory --------------------------------------------

export const firmwareInventorySchema = z.object({
  groupBy: z.enum(["version", "model", "version-and-model"]).optional().default("version-and-model")
    .describe("Grouping mode (default: version-and-model)"),
});

export async function firmwareInventory(params: z.infer<typeof firmwareInventorySchema>) {
  const allDevices = await resolveAllDevices();
  const flat = allDevices.flatMap((host) =>
    host.devices.map((d) => ({
      site: host.hostName,
      name: d.name,
      model: d.model,
      version: d.version,
      firmwareStatus: d.firmwareStatus,
      status: d.status,
    })),
  );

  const groups = new Map<string, typeof flat>();
  for (const dev of flat) {
    const key =
      params.groupBy === "version" ? dev.version
      : params.groupBy === "model" ? dev.model
      : `${dev.model} @ ${dev.version}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(dev);
  }

  const inventory = Array.from(groups.entries())
    .map(([key, devices]) => ({
      key,
      count: devices.length,
      sample: devices.slice(0, 3).map((d) => `${d.site}/${d.name}`),
      sites: Array.from(new Set(devices.map((d) => d.site))).sort(),
      anyOutdated: devices.some((d) => d.firmwareStatus && d.firmwareStatus !== "upToDate"),
    }))
    .sort((a, b) => b.count - a.count);

  const outdated = flat.filter((d) => d.firmwareStatus && d.firmwareStatus !== "upToDate");

  return {
    checkedAt: new Date().toISOString(),
    totalDevices: flat.length,
    uniqueGroups: inventory.length,
    outdatedCount: outdated.length,
    outdated: outdated.map((d) => ({ site: d.site, name: d.name, model: d.model, version: d.version, status: d.firmwareStatus })),
    inventory,
  };
}

// --- Tool: wan-uptime-trend ----------------------------------------------

export const wanUptimeTrendSchema = z.object({
  threshold: z.coerce.number().optional().default(95)
    .describe("Uptime % threshold below which WAN is flagged (default: 95)"),
});

export async function wanUptimeTrend(params: z.infer<typeof wanUptimeTrendSchema>) {
  const [labels, sitesResp] = await Promise.all([
    siteLabelsBySiteId(),
    unifiClient.get<{
      data: Array<{ siteId: string; hostId: string; statistics: SiteStatistics }>;
    }>("/sites"),
  ]);

  const rows: Array<{
    site: string;
    wan: string;
    uptime: number;
    externalIp: string;
    severity: "healthy" | "warning" | "critical";
  }> = [];

  for (const s of sitesResp.data) {
    const hostName = labels.get(s.siteId) ?? "unknown";
    const wans = s.statistics.wans ?? {};
    for (const [wanName, wan] of Object.entries(wans)) {
      const uptime = wan.wanUptime ?? 0;
      let severity: "healthy" | "warning" | "critical" = "healthy";
      if (uptime < 90) severity = "critical";
      else if (uptime < params.threshold) severity = "warning";
      rows.push({
        site: hostName,
        wan: wanName,
        uptime,
        externalIp: wan.externalIp ?? "",
        severity,
      });
    }
  }

  rows.sort((a, b) => a.uptime - b.uptime);

  const flagged = rows.filter((r) => r.severity !== "healthy");
  const critical = rows.filter((r) => r.severity === "critical").length;
  const warning = rows.filter((r) => r.severity === "warning").length;
  const avgUptime = rows.length === 0
    ? null
    : Math.round((rows.reduce((s, r) => s + r.uptime, 0) / rows.length) * 10) / 10;

  return {
    checkedAt: new Date().toISOString(),
    threshold: params.threshold,
    totalWans: rows.length,
    avgUptime,
    flagged: flagged.length,
    summary: flagged.length === 0
      ? `All ${rows.length} WAN(s) above ${params.threshold}% uptime`
      : `${flagged.length} WAN(s) below threshold: ${critical} critical, ${warning} warning`,
    wans: rows,
  };
}

// --- Tool: top-clients-by-bandwidth (requires owner key) -----------------

interface ConnectorClient {
  id?: string;
  name?: string;
  hostname?: string;
  ipAddress?: string;
  macAddress?: string;
  type?: string;
  isWired?: boolean;
  uplink?: { txRate?: number; rxRate?: number };
  txBytes?: number;
  rxBytes?: number;
  rxRate?: number;
  txRate?: number;
}

export const topClientsByBandwidthSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
  topN: z.coerce.number().optional().default(10).describe("Number of top clients to return (default: 10)"),
  metric: z.enum(["combined", "tx", "rx"]).optional().default("combined")
    .describe("Bandwidth metric: combined (tx+rx), tx-only, rx-only"),
  limit: z.coerce.number().optional().default(200).describe("Max clients to fetch from API (default: 200)"),
});

export async function topClientsByBandwidth(params: z.infer<typeof topClientsByBandwidthSchema>) {
  if (!isConnectorAvailable()) {
    return {
      site: params.name,
      error: "Cloud Connector unavailable. Set UNIFI_API_KEY_OWNER to enable per-client bandwidth analysis.",
      clients: [],
    };
  }

  const ctx = await resolveConnectorContext(params.name);

  const resp = await connectorClient.get<{ data: ConnectorClient[] }>(
    ctx.hostId,
    `network/integration/v1/sites/${ctx.localSiteId}/clients`,
    { limit: params.limit },
  );

  const clients = resp.data ?? [];
  const ranked = clients
    .map((c) => {
      const tx = c.uplink?.txRate ?? c.txRate ?? 0;
      const rx = c.uplink?.rxRate ?? c.rxRate ?? 0;
      const combined = tx + rx;
      const value = params.metric === "tx" ? tx : params.metric === "rx" ? rx : combined;
      const typeStr = typeof c.type === "string" ? c.type : "";
      return {
        name: c.name ?? c.hostname ?? c.macAddress ?? c.id ?? "unknown",
        ip: c.ipAddress ?? "",
        mac: c.macAddress ?? "",
        type: typeStr,
        // Derive isWired from `type` when boolean field is absent — UniFi
        // connector clients usually expose only the type discriminator.
        isWired: typeof c.isWired === "boolean" ? c.isWired : typeStr.toUpperCase() === "WIRED",
        txBps: tx,
        rxBps: rx,
        combinedBps: combined,
        value,
      };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, params.topN);

  const totalBps = clients.reduce((s, c) => {
    const tx = c.uplink?.txRate ?? c.txRate ?? 0;
    const rx = c.uplink?.rxRate ?? c.rxRate ?? 0;
    return s + tx + rx;
  }, 0);

  return {
    site: ctx.displayName,
    checkedAt: new Date().toISOString(),
    metric: params.metric,
    totalClients: clients.length,
    totalBpsAcrossSite: totalBps,
    topN: ranked.length,
    clients: ranked,
  };
}
