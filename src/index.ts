#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startMcpServer } from "@us-all/mcp-toolkit/runtime";
import { inferToolAnnotations } from "@us-all/mcp-toolkit";
import { validateConfig, isConnectorAvailable, isLocalAvailable } from "./config.js";
import { wrapToolHandler } from "./tools/utils.js";
import { runDoctor } from "./doctor.js";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const { version: pkgVersion } = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };

if (process.argv.includes("--doctor")) {
  const { exitCode } = await runDoctor();
  process.exit(exitCode);
}

// Raw API tools
import { listHostsSchema, listHosts, getHostSchema, getHost } from "./tools/hosts.js";
import { listSitesSchema, listSites, listSiteIndexSchema, listSiteIndex } from "./tools/sites.js";
import { listDevicesSchema, listDevices } from "./tools/devices.js";
import { getIspMetricsSchema, getIspMetrics, queryIspMetricsSchema, queryIspMetrics } from "./tools/isp-metrics.js";
import {
  listSdwanConfigsSchema, listSdwanConfigs,
  getSdwanConfigSchema, getSdwanConfig,
  getSdwanConfigStatusSchema, getSdwanConfigStatus,
} from "./tools/sdwan.js";

// Analysis tools
import {
  listSitesOverviewSchema, listSitesOverview,
  analyzeSiteHealthSchema, analyzeSiteHealth,
  detectRecentRebootsSchema, detectRecentReboots,
} from "./tools/analysis.js";

// Analytics tools (cross-site aggregation)
import {
  compareSitesSchema, compareSites,
  firmwareInventorySchema, firmwareInventory,
  wanUptimeTrendSchema, wanUptimeTrend,
  topClientsByBandwidthSchema, topClientsByBandwidth,
} from "./tools/analytics.js";

// Connector tools (requires owner key)
import * as C from "./tools/connector.js";

import { registry, searchToolsSchema, searchTools, type Category } from "./tool-registry.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import {
  summarizeSiteSchema, summarizeSite,
  siteHealthTimelineSchema, siteHealthTimeline,
} from "./tools/aggregations.js";
import {
  getPortErrorsSchema, getPortErrors,
  listPortFlapSummarySchema, listPortFlapSummary,
} from "./tools/local-ports.js";

validateConfig();

const server = new McpServer({
  name: "unifi",
  version: pkgVersion,
});

// --- Tool registration with category filtering (UNIFI_TOOLS / UNIFI_DISABLE) ---
let currentCategory: Category = "analysis";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tool(name: string, description: string, schema: any, handler: any, annotations?: any): void {
  registry.register(name, description, currentCategory);
  if (registry.isEnabled(currentCategory)) {
    server.tool(name, description, schema, inferToolAnnotations(name, annotations), handler);
  }
}

// === Analysis Tools (semantic) ===
currentCategory = "analysis";

tool("list-sites-overview",
  "Get a health overview of all UniFi sites with status, issues, and device counts",
  listSitesOverviewSchema.shape, wrapToolHandler(listSitesOverview));

tool("analyze-site-health",
  "Analyze health of a specific site by name (e.g., 'USM'). Returns device status, WAN info, reboot detection",
  analyzeSiteHealthSchema.shape, wrapToolHandler(analyzeSiteHealth));

tool("detect-recent-reboots",
  "Detect devices that rebooted within a time window. Checks all sites by default",
  detectRecentRebootsSchema.shape, wrapToolHandler(detectRecentReboots));

tool("compare-sites",
  "Side-by-side comparison of all (or selected) sites: device count, online %, WAN avg/min uptime, gateway. Use to spot fleet outliers.",
  compareSitesSchema.shape, wrapToolHandler(compareSites));

tool("firmware-inventory",
  "Group all devices by firmware version + model and surface outdated devices. Helps detect fleet inconsistency and pending upgrades.",
  firmwareInventorySchema.shape, wrapToolHandler(firmwareInventory));

tool("wan-uptime-trend",
  "Aggregate WAN uptime across all sites with severity flagging (default threshold 95%). Returns per-WAN sorted by lowest uptime first.",
  wanUptimeTrendSchema.shape, wrapToolHandler(wanUptimeTrend));

tool("top-clients-by-bandwidth",
  "Top N clients by bandwidth on a site (combined / tx-only / rx-only). Requires Cloud Connector (UNIFI_API_KEY_OWNER).",
  topClientsByBandwidthSchema.shape, wrapToolHandler(topClientsByBandwidth));

// === Raw API Tools (Site Manager) ===
currentCategory = "raw";

tool("list-hosts",
  "List all UniFi console hosts (UDM, UDM Pro, Cloud Key, etc.)",
  listHostsSchema.shape, wrapToolHandler(listHosts));

tool("get-host",
  "Get detailed information about a specific host by ID",
  getHostSchema.shape, wrapToolHandler(getHost));

tool("list-sites",
  "List all sites with statistics (device counts, WAN status, ISP info)",
  listSitesSchema.shape, wrapToolHandler(listSites));

tool("find-site",
  "Find sites by CUSTOMER name, console name, or slug. Use this first when a request "
  + "names a customer rather than a console: on a UniFi OS Server every customer is a "
  + "site on one shared console, so the customer name is not a host name. Returns every "
  + "match so an ambiguous name can be narrowed.",
  listSiteIndexSchema.shape, wrapToolHandler(listSiteIndex));

tool("list-devices",
  "List all devices across hosts (switches, APs, gateways, cameras)",
  listDevicesSchema.shape, wrapToolHandler(listDevices));

tool("get-isp-metrics",
  "Get ISP performance metrics. May be unavailable depending on account",
  getIspMetricsSchema.shape, wrapToolHandler(getIspMetrics));

tool("query-isp-metrics",
  "Query ISP metrics with filters. May be unavailable depending on account",
  queryIspMetricsSchema.shape, wrapToolHandler(queryIspMetrics));

tool("list-sdwan-configs",
  "List all SD-WAN configurations",
  listSdwanConfigsSchema.shape, wrapToolHandler(listSdwanConfigs));

tool("get-sdwan-config",
  "Get a specific SD-WAN configuration by ID",
  getSdwanConfigSchema.shape, wrapToolHandler(getSdwanConfig));

tool("get-sdwan-config-status",
  "Get the status of a specific SD-WAN configuration",
  getSdwanConfigStatusSchema.shape, wrapToolHandler(getSdwanConfigStatus));

// === Connector Tools (requires UNIFI_API_KEY_OWNER) ===

if (isConnectorAvailable()) {
  // App Info
  currentCategory = "devices";
  tool("get-app-info",
    "Get UniFi Network application info for a host",
    C.getAppInfoSchema.shape, wrapToolHandler(C.getAppInfo));

  // Sites (local)
  currentCategory = "raw";
  tool("list-local-sites",
    "List local sites on a specific console",
    C.listLocalSitesSchema.shape, wrapToolHandler(C.listLocalSites));

  // Devices
  currentCategory = "devices";
  tool("get-device-details",
    "List all devices with details (firmware, features) for a site",
    C.getDeviceDetailsSchema.shape, wrapToolHandler(C.getDeviceDetails));

  tool("get-device-by-id",
    "Get detailed info for a specific device by ID",
    C.getDeviceByIdSchema.shape, wrapToolHandler(C.getDeviceById));

  tool("get-device-statistics",
    "Get latest statistics for a specific device",
    C.getDeviceStatisticsSchema.shape, wrapToolHandler(C.getDeviceStatistics));

  tool("list-pending-devices",
    "List devices pending adoption on a host",
    C.listPendingDevicesSchema.shape, wrapToolHandler(C.listPendingDevices));

  // Clients
  currentCategory = "clients";
  tool("list-site-clients",
    "List connected clients for a site (default limit: 50)",
    C.listSiteClientsSchema.shape, wrapToolHandler(C.listSiteClients));

  tool("get-client-details",
    "Get detailed info for a specific client by ID",
    C.getClientDetailsSchema.shape, wrapToolHandler(C.getClientDetails));

  // Networks
  currentCategory = "networks";
  tool("list-networks",
    "List network configurations (VLANs, subnets) for a site",
    C.listNetworksSchema.shape, wrapToolHandler(C.listNetworks));

  tool("get-network-details",
    "Get detailed info for a specific network by ID",
    C.getNetworkDetailsSchema.shape, wrapToolHandler(C.getNetworkDetails));

  tool("get-network-references",
    "Get references for a specific network (what uses this network)",
    C.getNetworkReferencesSchema.shape, wrapToolHandler(C.getNetworkReferences));

  // WiFi
  currentCategory = "networks";
  tool("list-wifi-broadcasts",
    "List WiFi broadcast configurations (SSIDs) for a site",
    C.listWifiBroadcastsSchema.shape, wrapToolHandler(C.listWifiBroadcasts));

  tool("get-wifi-broadcast-details",
    "Get detailed info for a specific WiFi broadcast",
    C.getWifiBroadcastDetailsSchema.shape, wrapToolHandler(C.getWifiBroadcastDetails));

  // Hotspot
  currentCategory = "networks";
  tool("list-vouchers",
    "List hotspot vouchers for a site",
    C.listVouchersSchema.shape, wrapToolHandler(C.listVouchers));

  tool("get-voucher-details",
    "Get details for a specific voucher",
    C.getVoucherDetailsSchema.shape, wrapToolHandler(C.getVoucherDetails));

  // Firewall
  currentCategory = "firewall";
  tool("list-firewall-zones",
    "List firewall zones for a site",
    C.listFirewallZonesSchema.shape, wrapToolHandler(C.listFirewallZones));

  tool("get-firewall-zone",
    "Get details for a specific firewall zone",
    C.getFirewallZoneSchema.shape, wrapToolHandler(C.getFirewallZone));

  tool("list-firewall-policies",
    "List firewall policies for a site",
    C.listFirewallPoliciesSchema.shape, wrapToolHandler(C.listFirewallPolicies));

  tool("get-firewall-policy",
    "Get details for a specific firewall policy",
    C.getFirewallPolicySchema.shape, wrapToolHandler(C.getFirewallPolicy));

  tool("get-firewall-policy-ordering",
    "Get the ordering of user-defined firewall policies",
    C.getFirewallPolicyOrderingSchema.shape, wrapToolHandler(C.getFirewallPolicyOrdering));

  // ACL
  currentCategory = "firewall";
  tool("list-acl-rules",
    "List access control (ACL) rules for a site",
    C.listAclRulesSchema.shape, wrapToolHandler(C.listAclRules));

  tool("get-acl-rule",
    "Get details for a specific ACL rule",
    C.getAclRuleSchema.shape, wrapToolHandler(C.getAclRule));

  tool("get-acl-rule-ordering",
    "Get the ordering of user-defined ACL rules",
    C.getAclRuleOrderingSchema.shape, wrapToolHandler(C.getAclRuleOrdering));

  // DNS
  currentCategory = "firewall";
  tool("list-dns-policies",
    "List DNS policies for a site",
    C.listDnsPoliciesSchema.shape, wrapToolHandler(C.listDnsPolicies));

  tool("get-dns-policy",
    "Get details for a specific DNS policy",
    C.getDnsPolicySchema.shape, wrapToolHandler(C.getDnsPolicy));

  // Traffic Matching
  currentCategory = "firewall";
  tool("list-traffic-matching-lists",
    "List traffic matching lists for a site",
    C.listTrafficMatchingListsSchema.shape, wrapToolHandler(C.listTrafficMatchingLists));

  tool("get-traffic-matching-list",
    "Get details for a specific traffic matching list",
    C.getTrafficMatchingListSchema.shape, wrapToolHandler(C.getTrafficMatchingList));

  // Supporting Resources (WAN/VPN/RADIUS)
  currentCategory = "wan";
  tool("list-wans",
    "List WAN interfaces for a site",
    C.listWansSchema.shape, wrapToolHandler(C.listWans));

  tool("list-vpn-tunnels",
    "List site-to-site VPN tunnels",
    C.listVpnTunnelsSchema.shape, wrapToolHandler(C.listVpnTunnels));

  tool("list-vpn-servers",
    "List VPN servers for a site",
    C.listVpnServersSchema.shape, wrapToolHandler(C.listVpnServers));

  tool("list-radius-profiles",
    "List RADIUS profiles for a site",
    C.listRadiusProfilesSchema.shape, wrapToolHandler(C.listRadiusProfiles));

  currentCategory = "reference";
  tool("list-device-tags",
    "List device tags for a site",
    C.listDeviceTagsSchema.shape, wrapToolHandler(C.listDeviceTags));

  // DPI & Reference
  tool("list-dpi-categories",
    "List DPI application categories",
    C.listDpiCategoriesSchema.shape, wrapToolHandler(C.listDpiCategories));

  tool("list-dpi-applications",
    "List DPI applications",
    C.listDpiApplicationsSchema.shape, wrapToolHandler(C.listDpiApplications));

  tool("list-countries",
    "List countries (reference data)",
    C.listCountriesSchema.shape, wrapToolHandler(C.listCountries));

  console.error("[UniFi] Connector tools enabled (33 tools, owner key detected)");
} else {
  console.error("[UniFi] Connector tools disabled (no UNIFI_API_KEY_OWNER)");
}

// === Local Controller Tools (requires UNIFI_LOCAL_URL/USER/PASS, LAN access) ===
if (isLocalAvailable()) {
  currentCategory = "local";
  tool("get-port-errors",
    "Per-port rx/tx errors, dropped, link state, flap counters (linkDownCount, stpChangeCount, anomalies), and SFP DDM (Rx/Tx Power dBm, temperature, voltage, TX/RX fault) for a switch. Source: legacy /stat/device port_table. Requires LAN-reachable controller.",
    getPortErrorsSchema.shape, wrapToolHandler(getPortErrors));

  tool("list-port-flap-summary",
    "Fleet-wide port instability ranking: iterates all switches on the local controller and ranks ports by flap score (linkDownCount*2 + stpChangeCount + rx/tx errors). Surfaces unstable cables/transceivers across the site. Counters reset on switch reboot.",
    listPortFlapSummarySchema.shape, wrapToolHandler(listPortFlapSummary));

  console.error("[UniFi] Local controller tools enabled (2 tools, LAN access detected)");
} else {
  console.error("[UniFi] Local controller tools disabled (no UNIFI_LOCAL_URL/USER/PASS)");
}

// === Aggregation tools (round-trip elimination) ===
currentCategory = "analysis";

// Card-aware wrapper: see datadog `slo-compliance-snapshot` for the same pattern.
const SUMMARIZE_SITE_CARD_URI = "ui://widget/summarize-site.html";
const wrappedSummarizeSite = wrapToolHandler(summarizeSite);
async function summarizeSiteWithCard(args: Parameters<typeof wrappedSummarizeSite>[0]) {
  const result = await wrappedSummarizeSite(args);
  if (result.isError) return result;
  try {
    const structured = JSON.parse(result.content[0].text);
    return {
      ...result,
      structuredContent: structured,
      _meta: {
        "openai/outputTemplate": SUMMARIZE_SITE_CARD_URI,
        "ui.resourceUri": SUMMARIZE_SITE_CARD_URI,
      },
    };
  } catch { return result; }
}

tool("summarize-site",
  "Deep aggregated site view: devices + WAN status + (opt) clients + networks + WiFi broadcasts in one call. Replaces 4-5 round-trips. Connector-dependent fields auto-skip when owner key absent. Renders an Apps SDK card on ChatGPT clients (Claude clients receive the same JSON text).",
  summarizeSiteSchema.shape, summarizeSiteWithCard);

tool("site-health-timeline",
  "Per-site health snapshot over a lookback window: devices with stability scores, reboots, WAN uptime, optional client count. Replaces 5+ sequential calls (devices + wan + reboots + clients). Caveats[] surfaces partial-data and API limitations.",
  siteHealthTimelineSchema.shape, wrapToolHandler(siteHealthTimeline));

// === Meta tools (always enabled) ===
currentCategory = "meta";

tool("search-tools",
  "Discover available tools by natural language query. Returns matching tool names + descriptions across all categories. Use this first to navigate the 54-tool surface efficiently.",
  searchToolsSchema.shape, wrapToolHandler(searchTools));

// === MCP Resources (unifi:// URI scheme) ===
registerResources(server);

// === MCP Prompts (workflow templates) ===
registerPrompts(server);

const baseCount = isConnectorAvailable() ? 54 : 19;
const toolCount = baseCount + (isLocalAvailable() ? 2 : 0);
console.error(`[UniFi] ${toolCount} tools loaded`);

startMcpServer(server).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
