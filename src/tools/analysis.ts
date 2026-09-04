import { z } from "zod/v4";
import { SITE_NAME_DESCRIPTION } from "./site-param.js";
import {
  resolveDeviceHostEntry,
  resolveAllDevices,
  type DeviceEntry,
} from "../helpers/resolver.js";
import { fetchSitesCached, SiteResolutionError, siteLabelsBySiteId } from "../helpers/site-index.js";
import { siteScopeCaveat, soleSite } from "../helpers/select-site.js";
import { extractFieldsDescription } from "./extract-fields.js";

const ef = z.string().optional().describe(extractFieldsDescription);

// --- Types ---

type Severity = "healthy" | "info" | "warning" | "critical" | "unknown";

interface Issue {
  severity: Severity;
  type: string;
  device: string;
  detail: string;
  actionHint: string;
}

interface SiteOverviewEntry {
  name: string;
  status: Severity;
  summary: string;
  gateway: string;
  devices: { total: number; online: number; offline: number };
  wan: Record<string, string>;
  issues: Issue[];
}

// --- Helpers ---

function hoursAgo(isoTime: string | null): number | null {
  if (!isoTime) return null;
  const diff = Date.now() - new Date(isoTime).getTime();
  return diff / (1000 * 60 * 60);
}

function evaluateDeviceIssues(device: DeviceEntry): Issue[] {
  const issues: Issue[] = [];
  const label = `${device.name} (${device.model})`;

  if (device.status !== "online") {
    issues.push({
      severity: "critical",
      type: "device_offline",
      device: label,
      detail: `Device is ${device.status}`,
      actionHint: "Check physical connectivity and power",
    });
    return issues;
  }

  const hours = hoursAgo(device.startupTime);
  if (hours !== null) {
    if (hours < 1) {
      issues.push({
        severity: "critical",
        type: "recent_reboot",
        device: label,
        detail: `Rebooted ${hours.toFixed(1)}h ago (${device.startupTime})`,
        actionHint: "Device just rebooted — check logs via Local API",
      });
    } else if (hours < 24) {
      issues.push({
        severity: "warning",
        type: "recent_reboot",
        device: label,
        detail: `Rebooted ${hours.toFixed(1)}h ago (${device.startupTime})`,
        actionHint: "Check device stability and logs via Local API",
      });
    } else if (hours < 72) {
      issues.push({
        severity: "info",
        type: "recent_reboot",
        device: label,
        detail: `Rebooted ${hours.toFixed(1)}h ago (${device.startupTime})`,
        actionHint: "Monitor for repeat reboots",
      });
    }
  }

  return issues;
}

function evaluateWanIssues(
  wans: Record<string, { wanUptime?: number; externalIp?: string }>,
): Issue[] {
  const issues: Issue[] = [];
  for (const [name, wan] of Object.entries(wans)) {
    const uptime = wan.wanUptime;
    if (uptime === undefined || uptime === null) continue;
    if (uptime < 90) {
      issues.push({
        severity: "critical",
        type: "wan_down",
        device: name,
        detail: `${name} uptime is ${uptime}%`,
        actionHint: "Check ISP connection and failover",
      });
    } else if (uptime < 95) {
      issues.push({
        severity: "warning",
        type: "wan_unstable",
        device: name,
        detail: `${name} uptime is ${uptime}%`,
        actionHint: "Monitor ISP stability",
      });
    }
  }
  return issues;
}

function worstSeverity(issues: Issue[]): Severity {
  if (issues.length === 0) return "healthy";
  const order: Severity[] = ["critical", "warning", "info", "unknown", "healthy"];
  for (const level of order) {
    if (issues.some((i) => i.severity === level)) return level;
  }
  return "healthy";
}

function summarizeIssues(issues: Issue[]): string {
  if (issues.length === 0) return "All systems operational";
  const critical = issues.filter((i) => i.severity === "critical").length;
  const warning = issues.filter((i) => i.severity === "warning").length;
  const info = issues.filter((i) => i.severity === "info").length;
  const parts: string[] = [];
  if (critical > 0) parts.push(`${critical} critical`);
  if (warning > 0) parts.push(`${warning} warning`);
  if (info > 0) parts.push(`${info} info`);
  return `${issues.length} issue(s): ${parts.join(", ")}`;
}

// --- Tool: list-sites-overview ---

export const listSitesOverviewSchema = z.object({
  extractFields: ef,
});

export async function listSitesOverview() {
  const [sites, devicesData, labelsResult] = await Promise.all([
    fetchSitesCached(),
    resolveAllDevices(),
    siteLabelsBySiteId(),
  ]);
  const { labels, degraded } = labelsResult;

  // Devices are HOST-scoped, so key them by hostId. Keyed by hostName, the 60
  // sites of one console all mapped to a single bucket.
  const hostDevices = new Map<string, DeviceEntry[]>();
  for (const d of devicesData) {
    hostDevices.set(d.hostId, d.devices);
  }

  const siteEntries: SiteOverviewEntry[] = [];

  for (const site of sites) {
    // Reuse the index's label rule rather than re-deriving it here: falling
    // back to meta.name yields the SLUG ("default"), not a name anyone knows.
    const hostName = labels.get(site.siteId) ?? "unknown";
    const devices = hostDevices.get(site.hostId) ?? [];
    // `/sites` may omit statistics entirely; the three inline copies of this
    // type all declared it required, which hid that.
    const stats = site.statistics ?? {};

    const issues: Issue[] = [];

    // Evaluate each device
    for (const device of devices) {
      issues.push(...evaluateDeviceIssues(device));
    }

    // Evaluate WAN
    if (stats.wans) {
      issues.push(...evaluateWanIssues(stats.wans));
    }

    const online = devices.filter((d) => d.status === "online").length;
    const offline = devices.filter((d) => d.status !== "online").length;

    const wanSummary: Record<string, string> = {};
    if (stats.wans) {
      for (const [name, wan] of Object.entries(stats.wans)) {
        wanSummary[name] = `${wan.wanUptime ?? "?"}%`;
      }
    }

    siteEntries.push({
      name: hostName,
      status: worstSeverity(issues),
      summary: summarizeIssues(issues),
      gateway: stats.gateway?.shortname ?? "unknown",
      devices: { total: devices.length, online, offline },
      wan: wanSummary,
      issues,
    });
  }

  const allIssues = siteEntries.flatMap((s) => s.issues);

  return {
    checkedAt: new Date().toISOString(),
    // A fleet listing built from a partial index labels whole consoles
    // "unknown". Saying why beats leaving the reader to guess.
    ...(degraded.length ? { degraded } : {}),
    totalSites: siteEntries.length,
    status: worstSeverity(allIssues),
    summary: summarizeIssues(allIssues),
    sites: siteEntries,
  };
}

// --- Tool: analyze-site-health ---

export const analyzeSiteHealthSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
  extractFields: ef,
});

export async function analyzeSiteHealth(params: z.infer<typeof analyzeSiteHealthSchema>) {
  // Was resolveDevicesByHostName -- an exact match on console hostname, which no
  // customer on a shared console can satisfy, so this returned "not found" for
  // every site on the UOS console before any analysis could run.
  let resolved;
  try {
    resolved = await resolveDeviceHostEntry(params.name);
  } catch (err) {
    return {
      site: params.name,
      status: "unknown" as Severity,
      summary: err instanceof SiteResolutionError ? err.message : String(err),
      issues: [],
    };
  }

  // Reasons a section is missing, kept apart from `issues` -- which describes
  // the NETWORK's health, not the lookup's. Folding the two together reports a
  // gap in our own visibility as a fault at the customer site.
  const caveats: string[] = [];
  const devices = resolved.devices?.devices ?? [];
  const issues: Issue[] = [];

  for (const device of devices) {
    issues.push(...evaluateDeviceIssues(device));
  }

  // Find gateway
  const gateway = devices.find((d) => d.isConsole);
  const online = devices.filter((d) => d.status === "online").length;
  const offline = devices.filter((d) => d.status !== "online").length;

  // Get WAN info from sites API
  let wanInfo: Record<string, string> = {};
  try {
    const siteRows = await fetchSitesCached();
    // By site id. `find(hostId)` returns the console's FIRST site, which on a
    // large shared console is the empty Default one -- so WAN stats were read
    // from the wrong site for every customer sharing that console.
    //
    // `soleSite` is null when the name picked out a CONSOLE rather than one
    // site. There is no such thing as "the console's WAN uptime" on a shared
    // box, so the section is omitted with a caveat rather than filled from an
    // arbitrary tenant's statistics.
    const site = soleSite(resolved.host);
    const siteMatch = site
      ? siteRows.find((s) => s.siteId === site.cloudSiteId)
      : undefined;
    const scopeCaveat = siteScopeCaveat(resolved.host, params.name);
    if (scopeCaveat) caveats.push(scopeCaveat);
    if (siteMatch?.statistics?.wans) {
      issues.push(...evaluateWanIssues(siteMatch.statistics?.wans ?? {}));
      for (const [name, wan] of Object.entries(siteMatch.statistics?.wans ?? {})) {
        wanInfo[name] = `${wan.wanUptime ?? "?"}% (${wan.externalIp ?? "no IP"})`;
      }
    }
  } catch {
    // WAN info optional
  }

  return {
    site: params.name,
    status: worstSeverity(issues),
    summary: summarizeIssues(issues),
    gateway: gateway
      ? {
          model: gateway.model,
          ip: gateway.ip,
          version: gateway.version,
          upSince: gateway.startupTime,
        }
      : null,
    devices: {
      total: devices.length,
      online,
      offline,
      list: devices.map((d) => ({
        name: d.name,
        model: d.model,
        status: d.status,
        ip: d.ip,
        startupTime: d.startupTime,
      })),
    },
    wan: wanInfo,
    issues,
    ...(caveats.length ? { caveats } : {}),
    checkedAt: new Date().toISOString(),
  };
}

// --- Tool: detect-recent-reboots ---

interface RebootEntry {
  site: string;
  device: string;
  model: string;
  severity: Severity;
  startupTime: string;
  hoursAgo: number;
}

export const detectRecentRebootsSchema = z.object({
  name: z.string().optional().describe(`${SITE_NAME_DESCRIPTION} Omit to check every site.`),
  hours: z.coerce.number().optional().default(24).describe("Look back period in hours (default: 24)"),
  extractFields: ef,
});

export async function detectRecentReboots(params: z.infer<typeof detectRecentRebootsSchema>) {
  const allDevices = await resolveAllDevices();

  // Resolve through the index rather than filtering on console hostname: on a
  // shared console no customer name equals a hostname, so this filtered to
  // nothing for every site the fork exists to reach.
  let entries = allDevices;
  if (params.name) {
    // A bare catch reported an ambiguous name, a /sites outage and a real typo
    // identically as "not found" -- discarding the whole point of the status
    // taxonomy at the last step.
    let resolveError: string | null = null;
    const { host } = await resolveDeviceHostEntry(params.name).catch(
      (err: unknown) => {
        resolveError = err instanceof Error ? err.message : String(err);
        return { host: null };
      },
    );
    if (resolveError !== null) {
      return {
        checkedAt: new Date().toISOString(),
        threshold: `${params.hours}h`,
        sites: [],
        caveats: [resolveError as string],
      };
    }
    entries = host ? allDevices.filter((h) => h.hostId === host.hostId) : [];
  }

  if (entries.length === 0 && params.name) {
    return {
      checkedAt: new Date().toISOString(),
      threshold: `${params.hours}h`,
      status: "unknown" as Severity,
      summary: `Site '${params.name}' not found`,
      reboots: [],
    };
  }

  const reboots: RebootEntry[] = [];

  for (const host of entries) {
    for (const device of host.devices) {
      const hours = hoursAgo(device.startupTime);
      if (hours !== null && hours < params.hours) {
        let severity: Severity = "info";
        if (hours < 1) severity = "critical";
        else if (hours < 24) severity = "warning";

        reboots.push({
          site: host.hostName,
          device: device.name,
          model: device.model,
          severity,
          startupTime: device.startupTime!,
          hoursAgo: Math.round(hours * 10) / 10,
        });
      }
    }
  }

  // Sort by most recent first
  reboots.sort((a, b) => a.hoursAgo - b.hoursAgo);

  return {
    checkedAt: new Date().toISOString(),
    threshold: `${params.hours}h`,
    status: reboots.length === 0 ? "healthy" as Severity : worstSeverity(reboots.map((r) => ({ severity: r.severity } as Issue))),
    summary: reboots.length === 0
      ? `No reboots detected in the last ${params.hours}h`
      : `${reboots.length} device(s) rebooted in the last ${params.hours}h`,
    reboots,
  };
}
