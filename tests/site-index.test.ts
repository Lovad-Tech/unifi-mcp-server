import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config.js", () => ({
  config: {
    apiKey: "x",
    ownerApiKey: "owner-key",
    baseUrl: "https://api.ui.com/v1",
    enabledCategories: null,
    disabledCategories: null,
    local: { url: "", user: "", pass: "", site: "default", insecure: false },
  },
  isConnectorAvailable: () => true,
  isLocalAvailable: () => false,
}));

vi.mock("../src/client.js", () => {
  const getMock = vi.fn();
  return { unifiClient: { get: getMock }, UniFiError: class extends Error {} };
});

vi.mock("../src/connector-client.js", () => {
  const getMock = vi.fn();
  class ConnectorError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status = 0, body: unknown = undefined) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }
  return {
    connectorClient: { get: getMock },
    ConnectorError,
    ConnectorUnavailableError: class extends Error {},
  };
});

import { unifiClient } from "../src/client.js";
import { connectorClient, ConnectorError } from "../src/connector-client.js";
import {
  buildSiteIndex,
  matchSites,
  resolveLocalSiteId,
  clearSiteIndexCache,
  SiteResolutionError,
} from "../src/helpers/site-index.js";
import {
  HOSTS_RESPONSE,
  SITES_RESPONSE,
  UOS_LOCAL_SITES_RESPONSE,
  UOS_HOST_ID,
  DUPLICATE_HOSTNAME,
} from "./fixtures/fleet.js";

const cloudGet = unifiClient.get as unknown as ReturnType<typeof vi.fn>;
const connGet = connectorClient.get as unknown as ReturnType<typeof vi.fn>;

function wireCloud() {
  cloudGet.mockImplementation((path: string) => {
    if (path === "/hosts") return Promise.resolve(HOSTS_RESPONSE);
    if (path === "/sites") return Promise.resolve(SITES_RESPONSE);
    throw new Error(`unexpected cloud path ${path}`);
  });
}

beforeEach(() => {
  clearSiteIndexCache();
  cloudGet.mockReset();
  connGet.mockReset();
  wireCloud();
});

describe("buildSiteIndex", () => {
  it("indexes every site on every host, not just one per host", async () => {
    const index = await buildSiteIndex();
    expect(index).toHaveLength(SITES_RESPONSE.data.length);
    expect(index.filter((e) => e.hostId === UOS_HOST_ID)).toHaveLength(5);
  });

  it("carries the human display name from meta.desc, which upstream discarded", async () => {
    const index = await buildSiteIndex();
    const entry = index.find((e) => e.slug === "slug0001");
    expect(entry?.displayName).toBe("Fabrikam Charter School");
  });

  it("costs two cloud calls and zero connector calls", async () => {
    await buildSiteIndex();
    expect(cloudGet).toHaveBeenCalledTimes(2);
    expect(connGet).not.toHaveBeenCalled();
  });

  it("falls back to the host name when a site has no meaningful description", async () => {
    const index = await buildSiteIndex();
    // Single-site consoles report desc "Default"; the console name is the useful label.
    const entry = index.find((e) => e.hostId === "host-udm-1");
    expect(entry?.displayName).toBe("Northwind-Clinic-UDM");
  });
});

describe("matchSites", () => {
  it("finds a site on a multi-site console by customer name", async () => {
    const index = await buildSiteIndex();
    const hits = matchSites(index, "Fabrikam Charter School");
    expect(hits).toHaveLength(1);
    expect(hits[0].slug).toBe("slug0001");
  });

  it("matches case-insensitively on a partial name", async () => {
    const index = await buildSiteIndex();
    expect(matchSites(index, "fabrikam")).toHaveLength(1);
  });

  it("returns every candidate when a query is ambiguous", async () => {
    const index = await buildSiteIndex();
    const hits = matchSites(index, "Tailspin Tire");
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.displayName).sort()).toEqual([
      "Tailspin Tire - East",
      "Tailspin Tire - North",
      "Tailspin Tire - South",
    ]);
  });

  it("ranks an exact match above the partial matches it contains", async () => {
    const index = await buildSiteIndex();
    const hits = matchSites(index, "Tailspin Tire - East");
    expect(hits[0].displayName).toBe("Tailspin Tire - East");
  });

  it("still resolves by console hostname, so existing callers keep working", async () => {
    const index = await buildSiteIndex();
    const hits = matchSites(index, "Contoso-Bakery-UDM-Pro");
    expect(hits).toHaveLength(1);
    expect(hits[0].hostId).toBe("host-udm-2");
  });

  it("surfaces both hosts that share a hostname instead of silently taking the first", async () => {
    const index = await buildSiteIndex();
    const hits = matchSites(index, DUPLICATE_HOSTNAME);
    expect(hits.length).toBeGreaterThan(1);
  });

  it("returns nothing for a name that does not exist", async () => {
    const index = await buildSiteIndex();
    expect(matchSites(index, "Nonexistent Customer")).toEqual([]);
  });
});

describe("resolveLocalSiteId", () => {
  it("joins on internalReference, never on position", async () => {
    connGet.mockResolvedValue(UOS_LOCAL_SITES_RESPONSE);
    const index = await buildSiteIndex();
    const entry = index.find((e) => e.slug === "slug0001")!;

    const localSiteId = await resolveLocalSiteId(entry);

    // The bug this replaces: data[0] is "local-default", the empty placeholder.
    expect(localSiteId).toBe("local-fabrikam");
    expect(localSiteId).not.toBe(UOS_LOCAL_SITES_RESPONSE.data[0].id);
  });

  it("asks the connector for the full page rather than the default 25", async () => {
    connGet.mockResolvedValue(UOS_LOCAL_SITES_RESPONSE);
    const index = await buildSiteIndex();
    await resolveLocalSiteId(index.find((e) => e.slug === "slug0001")!);

    const [, path, params] = connGet.mock.calls[0];
    expect(path).toBe("network/integration/v1/sites");
    expect(params).toMatchObject({ limit: 200 });
  });

  it("reports the connector's status instead of collapsing it to 'not found'", async () => {
    connGet.mockRejectedValue(
      new ConnectorError("HTTP 403: Forbidden", 403, {}),
    );
    const index = await buildSiteIndex();
    const entry = index.find((e) => e.slug === "slug0001")!;

    await expect(resolveLocalSiteId(entry)).rejects.toThrow(
      SiteResolutionError,
    );
    await expect(resolveLocalSiteId(entry)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("distinguishes a reachable console with no such site from an unreachable one", async () => {
    connGet.mockResolvedValue({
      data: [
        { id: "local-default", name: "Default", internalReference: "default" },
      ],
    });
    const index = await buildSiteIndex();
    const entry = index.find((e) => e.slug === "slug0001")!;

    await expect(resolveLocalSiteId(entry)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("caches per host so a second site on the same console costs no extra call", async () => {
    connGet.mockResolvedValue(UOS_LOCAL_SITES_RESPONSE);
    const index = await buildSiteIndex();

    await resolveLocalSiteId(index.find((e) => e.slug === "slug0001")!);
    await resolveLocalSiteId(index.find((e) => e.slug === "slug0002")!);

    expect(connGet).toHaveBeenCalledTimes(1);
  });
});

describe("resilience", () => {
  it("shares one in-flight build across concurrent callers", async () => {
    // Without this, a fan-out tool fires N identical /hosts + /sites pairs
    // before the first resolves and the TTL cache can help.
    await Promise.all([buildSiteIndex(), buildSiteIndex(), buildSiteIndex()]);
    expect(cloudGet).toHaveBeenCalledTimes(2);
  });

  it("still indexes sites when /hosts fails", async () => {
    cloudGet.mockImplementation((path: string) => {
      if (path === "/hosts") return Promise.reject(new Error("hosts down"));
      if (path === "/sites") return Promise.resolve(SITES_RESPONSE);
      throw new Error(`unexpected ${path}`);
    });
    // /sites alone carries every customer name; /hosts only supplies a fallback
    // label. Losing the label must not lose the fleet.
    const index = await buildSiteIndex();
    expect(index.length).toBeGreaterThan(0);
    expect(matchSites(index, "Fabrikam Charter School")).toHaveLength(1);
  });

  it("fails the build when /sites fails, rather than serving an empty fleet", async () => {
    cloudGet.mockImplementation((path: string) => {
      if (path === "/hosts") return Promise.resolve(HOSTS_RESPONSE);
      return Promise.reject(new Error("sites down"));
    });
    // An empty index would report every real site as "not found".
    await expect(buildSiteIndex()).rejects.toThrow();
  });

  it("caches a connector failure briefly, so a down console is not hammered", async () => {
    connGet.mockRejectedValue(new ConnectorError("HTTP 502: Bad Gateway", 502, {}));
    const index = await buildSiteIndex();
    const sites = index.filter((e) => e.hostId === UOS_HOST_ID && e.slug !== "default");

    for (const s of sites) {
      await expect(resolveLocalSiteId(s)).rejects.toMatchObject({ status: 502 });
    }

    // The Cloud Connector allows 100 req/min per console. Retrying per site
    // would spend that budget on a console already known to be down.
    expect(connGet).toHaveBeenCalledTimes(1);
  });

  it("does not let a cached failure outlive the console's recovery", async () => {
    connGet.mockRejectedValueOnce(new ConnectorError("HTTP 502", 502, {}));
    const index = await buildSiteIndex();
    const entry = index.find((e) => e.slug === "slug0001")!;

    await expect(resolveLocalSiteId(entry)).rejects.toMatchObject({ status: 502 });

    connGet.mockResolvedValue(UOS_LOCAL_SITES_RESPONSE);
    clearSiteIndexCache();
    await expect(resolveLocalSiteId(entry)).resolves.toBe("local-fabrikam");
  });
});
