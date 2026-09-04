import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { unifiClient } from "./client.js";
import { resolveDeviceHostEntry, resolveAllDevices } from "./helpers/resolver.js";
import { soleSite } from "./helpers/select-site.js";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "ui");
const SUMMARIZE_SITE_HTML = readFileSync(join(UI_DIR, "summarize-site.html"), "utf-8");

/**
 * MCP Resources for hot UniFi entities.
 * URI scheme: `unifi://`
 *   - unifi://site/{name}                   — site overview by customer/site name
 *   - unifi://site/{hostName}/devices       — devices for a site, by customer/site name
 *   - unifi://devices                       — all devices across all sites
 *   - unifi://hosts                         — all UniFi consoles
 *   - unifi://reboots/recent                — recent reboot events (24h) across all sites
 */

function hoursAgo(isoTime: string | null): number | null {
  if (!isoTime) return null;
  const diff = Date.now() - new Date(isoTime).getTime();
  return diff / (1000 * 60 * 60);
}

type Severity = "healthy" | "info" | "warning" | "critical" | "unknown";

function asJson(uri: string, data: unknown) {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(data, null, 2),
    }],
  };
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    "site",
    new ResourceTemplate("unifi://site/{name}", { list: undefined }),
    {
      title: "UniFi Site",
      description: "Site overview by customer or site name — devices + statistics",
      mimeType: "application/json",
    },
    async (uri, vars) => {
      const name = decodeURIComponent(String(vars.name));
      try {
        const { host, devices } = await resolveDeviceHostEntry(name);
        // Name it as what it is: one site when the query picked one out, the
        // console when it named the console.
        const label = soleSite(host)?.displayName ?? host.hostName;
        return asJson(uri.toString(), { site: label, ...(devices ?? {}) });
      } catch (err) {
        return asJson(uri.toString(), {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  server.registerResource(
    "site-devices",
    new ResourceTemplate("unifi://site/{hostName}/devices", { list: undefined }),
    {
      title: "UniFi Site Devices",
      description: "Devices for a site, by customer or site name — compact device list",
      mimeType: "application/json",
    },
    async (uri, vars) => {
      const hostName = decodeURIComponent(String(vars.hostName));
      let entry;
      try {
        entry = (await resolveDeviceHostEntry(hostName)).devices;
      } catch (err) {
        return asJson(uri.toString(), {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!entry) {
        return asJson(uri.toString(), { error: `no device inventory for '${hostName}'` });
      }
      return asJson(uri.toString(), {
        hostName: entry.hostName,
        hostId: entry.hostId,
        updatedAt: entry.updatedAt,
        count: entry.devices.length,
        devices: entry.devices,
      });
    },
  );

  server.registerResource(
    "devices",
    "unifi://devices",
    {
      title: "UniFi Devices (all sites)",
      description: "All devices across all sites with status, model, firmware",
      mimeType: "application/json",
    },
    async (uri) => {
      const data = await unifiClient.get("/devices");
      return asJson(uri.toString(), data);
    },
  );

  server.registerResource(
    "reboots-recent",
    "unifi://reboots/recent",
    {
      title: "UniFi Recent Reboots",
      description: "Recent reboot events (last 24h) across all reachable sites",
      mimeType: "application/json",
    },
    async (uri) => {
      const lookbackHours = 24;
      try {
        const allDevices = await resolveAllDevices();
        const reboots: Array<{
          site: string;
          device: string;
          model: string;
          severity: Severity;
          startupTime: string;
          hoursAgo: number;
        }> = [];

        for (const host of allDevices) {
          for (const device of host.devices) {
            const hours = hoursAgo(device.startupTime);
            if (hours !== null && hours < lookbackHours) {
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

        reboots.sort((a, b) => a.hoursAgo - b.hoursAgo);

        return asJson(uri.toString(), {
          checkedAt: new Date().toISOString(),
          threshold: `${lookbackHours}h`,
          count: reboots.length,
          reboots,
        });
      } catch (error) {
        return asJson(uri.toString(), {
          checkedAt: new Date().toISOString(),
          threshold: `${lookbackHours}h`,
          error: error instanceof Error ? error.message : String(error),
          reboots: [],
        });
      }
    },
  );

  server.registerResource(
    "hosts",
    "unifi://hosts",
    {
      title: "UniFi Hosts (consoles)",
      description: "All UniFi consoles (UDM, UDM Pro, Cloud Key) with status",
      mimeType: "application/json",
    },
    async (uri) => {
      const data = await unifiClient.get("/hosts");
      return asJson(uri.toString(), data);
    },
  );

  // --- Apps SDK UI templates (ui:// scheme) ---
  // Rendered by ChatGPT / Apps SDK clients via _meta["openai/outputTemplate"].
  // Claude clients ignore the metadata and use the tool's text content instead.
  server.registerResource(
    "summarize-site-card",
    "ui://widget/summarize-site.html",
    {
      title: "Site Summary card",
      description: "Apps SDK UI template rendered with summarize-site tool output",
      mimeType: "text/html+skybridge",
      _meta: {
        "openai/outputTemplate": "ui://widget/summarize-site.html",
        "ui.resourceUri": "ui://widget/summarize-site.html",
      },
    },
    async (uri) => ({
      contents: [{
        uri: uri.toString(),
        mimeType: "text/html+skybridge",
        text: SUMMARIZE_SITE_HTML,
      }],
    }),
  );
}
