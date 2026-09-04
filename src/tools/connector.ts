import { z } from "zod/v4";
import { SITE_NAME_DESCRIPTION } from "./site-param.js";
import { applyExtractFields } from "@us-all/mcp-toolkit";
import { connectorClient } from "../connector-client.js";
import { resolveConnectorContext, resolveSiteEntry } from "../helpers/resolver.js";
import { extractFieldsDescription } from "./extract-fields.js";

const ef = z.string().optional().describe(extractFieldsDescription);

// --- Helper: site-scoped GET ---

async function siteGet<T = unknown>(name: string, subPath: string, params?: Record<string, string | number | boolean | undefined>) {
  // Let it throw: the SiteResolutionError extractor in utils.ts marshals the
  // status, so this does not need re-doing per tool.
  const ctx = await resolveConnectorContext(name);
  const data = await connectorClient.get<T>(ctx.hostId, `network/integration/v1/sites/${ctx.localSiteId}/${subPath}`, params);
  return { site: ctx.displayName, ...data as object };
}

// --- Helper: host-scoped GET (no siteId needed) ---

async function hostGet<T = unknown>(name: string, path: string, params?: Record<string, string | number | boolean | undefined>) {
  const host = await resolveSiteEntry(name);
  return connectorClient.get<T>(host.hostId, `network/integration/${path}`, params);
}

// ============================================
// Application Info
// ============================================

export const getAppInfoSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function getAppInfo(params: z.infer<typeof getAppInfoSchema>) {
  return hostGet(params.name, "v1/info");
}

// ============================================
// Sites
// ============================================

export const listLocalSitesSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function listLocalSites(params: z.infer<typeof listLocalSitesSchema>) {
  return hostGet(params.name, "v1/sites");
}

// ============================================
// Devices
// ============================================

export const getDeviceDetailsSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function getDeviceDetails(params: z.infer<typeof getDeviceDetailsSchema>) {
  return siteGet(params.name, "devices");
}

export const getDeviceByIdSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
  deviceId: z.string().describe("Device ID"),
});
export async function getDeviceById(params: z.infer<typeof getDeviceByIdSchema>) {
  return siteGet(params.name, `devices/${params.deviceId}`);
}

export const getDeviceStatisticsSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
  deviceId: z.string().describe("Device ID"),
});
export async function getDeviceStatistics(params: z.infer<typeof getDeviceStatisticsSchema>) {
  return siteGet(params.name, `devices/${params.deviceId}/statistics/latest`);
}

export const listPendingDevicesSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function listPendingDevices(params: z.infer<typeof listPendingDevicesSchema>) {
  return hostGet(params.name, "v1/pending-devices");
}

// ============================================
// Clients
// ============================================

export const listSiteClientsSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
  limit: z.coerce.number().optional().default(50).describe("Max clients to return (default: 50)"),
  extractFields: ef,
});
export async function listSiteClients(params: z.infer<typeof listSiteClientsSchema>) {
  const result = await siteGet(params.name, "clients", { limit: params.limit });
  if (params.extractFields || (result as { error?: string }).error) return result;
  return applyExtractFields(
    result,
    "site,data.*.id,data.*.macAddress,data.*.name,data.*.ipAddress,data.*.connectedAt,data.*.type",
  );
}

export const getClientDetailsSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
  clientId: z.string().describe("Client ID"),
});
export async function getClientDetails(params: z.infer<typeof getClientDetailsSchema>) {
  return siteGet(params.name, `clients/${params.clientId}`);
}

// ============================================
// Networks
// ============================================

export const listNetworksSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function listNetworks(params: z.infer<typeof listNetworksSchema>) {
  return siteGet(params.name, "networks");
}

export const getNetworkDetailsSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
  networkId: z.string().describe("Network ID"),
});
export async function getNetworkDetails(params: z.infer<typeof getNetworkDetailsSchema>) {
  return siteGet(params.name, `networks/${params.networkId}`);
}

export const getNetworkReferencesSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
  networkId: z.string().describe("Network ID"),
});
export async function getNetworkReferences(params: z.infer<typeof getNetworkReferencesSchema>) {
  return siteGet(params.name, `networks/${params.networkId}/references`);
}

// ============================================
// WiFi Broadcasts
// ============================================

export const listWifiBroadcastsSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function listWifiBroadcasts(params: z.infer<typeof listWifiBroadcastsSchema>) {
  return siteGet(params.name, "wifi/broadcasts");
}

export const getWifiBroadcastDetailsSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
  broadcastId: z.string().describe("WiFi Broadcast ID"),
});
export async function getWifiBroadcastDetails(params: z.infer<typeof getWifiBroadcastDetailsSchema>) {
  return siteGet(params.name, `wifi/broadcasts/${params.broadcastId}`);
}

// ============================================
// Hotspot (Vouchers)
// ============================================

export const listVouchersSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function listVouchers(params: z.infer<typeof listVouchersSchema>) {
  return siteGet(params.name, "hotspot/vouchers");
}

export const getVoucherDetailsSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
  voucherId: z.string().describe("Voucher ID"),
});
export async function getVoucherDetails(params: z.infer<typeof getVoucherDetailsSchema>) {
  return siteGet(params.name, `hotspot/vouchers/${params.voucherId}`);
}

// ============================================
// Firewall
// ============================================

export const listFirewallZonesSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function listFirewallZones(params: z.infer<typeof listFirewallZonesSchema>) {
  return siteGet(params.name, "firewall/zones");
}

export const getFirewallZoneSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
  zoneId: z.string().describe("Firewall Zone ID"),
});
export async function getFirewallZone(params: z.infer<typeof getFirewallZoneSchema>) {
  return siteGet(params.name, `firewall/zones/${params.zoneId}`);
}

export const listFirewallPoliciesSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function listFirewallPolicies(params: z.infer<typeof listFirewallPoliciesSchema>) {
  return siteGet(params.name, "firewall/policies");
}

export const getFirewallPolicySchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
  policyId: z.string().describe("Firewall Policy ID"),
});
export async function getFirewallPolicy(params: z.infer<typeof getFirewallPolicySchema>) {
  return siteGet(params.name, `firewall/policies/${params.policyId}`);
}

export const getFirewallPolicyOrderingSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function getFirewallPolicyOrdering(params: z.infer<typeof getFirewallPolicyOrderingSchema>) {
  return siteGet(params.name, "firewall/policies/ordering");
}

// ============================================
// Access Control (ACL Rules)
// ============================================

export const listAclRulesSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function listAclRules(params: z.infer<typeof listAclRulesSchema>) {
  return siteGet(params.name, "acl-rules");
}

export const getAclRuleSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
  ruleId: z.string().describe("ACL Rule ID"),
});
export async function getAclRule(params: z.infer<typeof getAclRuleSchema>) {
  return siteGet(params.name, `acl-rules/${params.ruleId}`);
}

export const getAclRuleOrderingSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function getAclRuleOrdering(params: z.infer<typeof getAclRuleOrderingSchema>) {
  return siteGet(params.name, "acl-rules/ordering");
}

// ============================================
// DNS Policies
// ============================================

export const listDnsPoliciesSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function listDnsPolicies(params: z.infer<typeof listDnsPoliciesSchema>) {
  return siteGet(params.name, "dns/policies");
}

export const getDnsPolicySchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
  policyId: z.string().describe("DNS Policy ID"),
});
export async function getDnsPolicy(params: z.infer<typeof getDnsPolicySchema>) {
  return siteGet(params.name, `dns/policies/${params.policyId}`);
}

// ============================================
// Traffic Matching Lists
// ============================================

export const listTrafficMatchingListsSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function listTrafficMatchingLists(params: z.infer<typeof listTrafficMatchingListsSchema>) {
  return siteGet(params.name, "traffic-matching-lists");
}

export const getTrafficMatchingListSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
  listId: z.string().describe("Traffic Matching List ID"),
});
export async function getTrafficMatchingList(params: z.infer<typeof getTrafficMatchingListSchema>) {
  return siteGet(params.name, `traffic-matching-lists/${params.listId}`);
}

// ============================================
// Supporting Resources
// ============================================

export const listWansSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function listWans(params: z.infer<typeof listWansSchema>) {
  return siteGet(params.name, "wans");
}

export const listVpnTunnelsSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function listVpnTunnels(params: z.infer<typeof listVpnTunnelsSchema>) {
  return siteGet(params.name, "vpn/site-to-site-tunnels");
}

export const listVpnServersSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function listVpnServers(params: z.infer<typeof listVpnServersSchema>) {
  return siteGet(params.name, "vpn/servers");
}

export const listRadiusProfilesSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function listRadiusProfiles(params: z.infer<typeof listRadiusProfilesSchema>) {
  return siteGet(params.name, "radius/profiles");
}

export const listDeviceTagsSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function listDeviceTags(params: z.infer<typeof listDeviceTagsSchema>) {
  return siteGet(params.name, "device-tags");
}

// ============================================
// DPI & Reference (host-scoped, no siteId)
// ============================================

export const listDpiCategoriesSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function listDpiCategories(params: z.infer<typeof listDpiCategoriesSchema>) {
  return hostGet(params.name, "v1/dpi/categories");
}

export const listDpiApplicationsSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function listDpiApplications(params: z.infer<typeof listDpiApplicationsSchema>) {
  return hostGet(params.name, "v1/dpi/applications");
}

export const listCountriesSchema = z.object({
  name: z.string().describe(SITE_NAME_DESCRIPTION),
});
export async function listCountries(params: z.infer<typeof listCountriesSchema>) {
  return hostGet(params.name, "v1/countries");
}
