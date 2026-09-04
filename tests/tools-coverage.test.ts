/**
 * Path-regression smoke for the raw Site Manager API wrappers (sites, hosts,
 * devices, sd-wan, isp-metrics). One case per shape change worth catching.
 *
 * Existing files cover doctor/retry/extract-fields; this one fills the
 * actual API-path surface that audits flagged as untested.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock("../src/client.js", () => ({
  unifiClient: { get: mockGet, post: mockPost },
  UniFiError: class extends Error {},
}));

const { clearSiteIndexCache } = await import(
  "../src/helpers/site-index.js"
);
const sites = await import("../src/tools/sites.js");
const hosts = await import("../src/tools/hosts.js");
const devices = await import("../src/tools/devices.js");
const sdwan = await import("../src/tools/sdwan.js");
const ispMetrics = await import("../src/tools/isp-metrics.js");

beforeEach(() => {
  // listSites now shares the process-wide /sites cache, so without this a
  // second test in this file would assert against a request that never went
  // out. Order-dependence, not a passing test.
  clearSiteIndexCache();
  mockGet.mockReset();
  mockPost.mockReset();
});

describe("sites / hosts", () => {
  it("list-sites hits /sites", async () => {
    mockGet.mockResolvedValueOnce({ data: [] });
    await sites.listSites();
    expect(mockGet.mock.calls[0]![0]).toBe("/sites");
  });

  it("list-hosts hits /hosts", async () => {
    mockGet.mockResolvedValueOnce({ data: [] });
    await hosts.listHosts({});
    expect(mockGet.mock.calls[0]![0]).toBe("/hosts");
  });

  it("get-host hits /hosts/{id}", async () => {
    mockGet.mockResolvedValueOnce({ data: {} });
    await hosts.getHost({ id: "host-abc" });
    expect(mockGet.mock.calls[0]![0]).toBe("/hosts/host-abc");
  });
});

describe("devices", () => {
  it("list-devices hits /devices with optional hostId / type filter", async () => {
    mockGet.mockResolvedValueOnce({ data: [] });
    await devices.listDevices({ hostId: "h-1", type: "uap" });
    expect(mockGet).toHaveBeenCalledWith(
      "/devices",
      expect.objectContaining({ hostId: "h-1", type: "uap" }),
    );
  });

  it("list-devices omits filter params that aren't supplied", async () => {
    mockGet.mockResolvedValueOnce({ data: [] });
    await devices.listDevices({});
    const [, query] = mockGet.mock.calls[0]!;
    expect(query).toEqual({});
  });
});

describe("sd-wan", () => {
  it("list-sdwan-configs hits /sd-wan-configs", async () => {
    mockGet.mockResolvedValueOnce({ data: [] });
    await sdwan.listSdwanConfigs();
    expect(mockGet.mock.calls[0]![0]).toBe("/sd-wan-configs");
  });

  it("get-sdwan-config + get-sdwan-config-status hit the expected paths", async () => {
    mockGet.mockResolvedValueOnce({ data: {} });
    await sdwan.getSdwanConfig({ id: "cfg-1" });
    expect(mockGet.mock.calls[0]![0]).toBe("/sd-wan-configs/cfg-1");

    mockGet.mockResolvedValueOnce({ data: {} });
    await sdwan.getSdwanConfigStatus({ id: "cfg-1" });
    expect(mockGet.mock.calls[1]![0]).toBe("/sd-wan-configs/cfg-1/status");
  });
});

describe("isp-metrics", () => {
  it("get-isp-metrics hits /isp-metrics (GET, no args)", async () => {
    mockGet.mockResolvedValueOnce({ data: [] });
    await ispMetrics.getIspMetrics();
    expect(mockGet.mock.calls[0]![0]).toBe("/isp-metrics");
  });

  it("get-isp-metrics gracefully returns 'not available' on 404", async () => {
    mockGet.mockRejectedValueOnce(new Error("404"));
    const result = await ispMetrics.getIspMetrics();
    expect((result as { available: boolean }).available).toBe(false);
  });

  it("query-isp-metrics POSTs to /isp-metrics/query with only the params caller supplied", async () => {
    mockPost.mockResolvedValueOnce({ data: [] });
    await ispMetrics.queryIspMetrics({
      hostIds: ["h-1"],
      duration: "24h",
      metricType: "5m",
    });
    expect(mockPost.mock.calls[0]![0]).toBe("/isp-metrics/query");
    const body = mockPost.mock.calls[0]![1];
    expect(body).toEqual({ hostIds: ["h-1"], duration: "24h", metricType: "5m" });
  });
});
