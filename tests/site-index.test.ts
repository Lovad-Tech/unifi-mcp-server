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
import { selectSite, selectHost } from "../src/helpers/select-site.js";
import {
  HOSTS_RESPONSE,
  SITES_RESPONSE,
  UOS_LOCAL_SITES_RESPONSE,
  UOS_HOST_ID,
  DUPLICATE_HOSTNAME,
  STALE_SITES_RESPONSE,
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
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-04T12:00:00Z"));
  clearSiteIndexCache();
  cloudGet.mockReset();
  connGet.mockReset();
  wireCloud();
});

describe("buildSiteIndex", () => {
  it("indexes every site on every host, not just one per host", async () => {
    const index = await buildSiteIndex();
    expect(index.entries).toHaveLength(SITES_RESPONSE.data.length);
    expect(index.entries.filter((e) => e.hostId === UOS_HOST_ID)).toHaveLength(5);
  });

  it("carries the human display name from meta.desc, which upstream discarded", async () => {
    const index = await buildSiteIndex();
    const entry = index.entries.find((e) => e.slug === "slug0001");
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
    const entry = index.entries.find((e) => e.hostId === "host-udm-1");
    expect(entry?.displayName).toBe("Northwind-Clinic-UDM");
  });
});

describe("matchSites", () => {
  it("finds a site on a multi-site console by customer name", async () => {
    const index = await buildSiteIndex();
    const hits = matchSites(index.entries, "Fabrikam Charter School");
    expect(hits).toHaveLength(1);
    expect(hits[0].slug).toBe("slug0001");
  });

  it("matches case-insensitively on a partial name", async () => {
    const index = await buildSiteIndex();
    expect(matchSites(index.entries, "fabrikam")).toHaveLength(1);
  });

  it("returns every candidate when a query is ambiguous", async () => {
    const index = await buildSiteIndex();
    const hits = matchSites(index.entries, "Tailspin Tire");
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.displayName).sort()).toEqual([
      "Tailspin Tire - East",
      "Tailspin Tire - North",
      "Tailspin Tire - South",
    ]);
  });

  it("ranks an exact match above the partial matches it contains", async () => {
    const index = await buildSiteIndex();
    const hits = matchSites(index.entries, "Tailspin Tire - East");
    expect(hits[0].displayName).toBe("Tailspin Tire - East");
  });

  it("still resolves by console hostname, so existing callers keep working", async () => {
    const index = await buildSiteIndex();
    const hits = matchSites(index.entries, "Contoso-Bakery-UDM-Pro");
    expect(hits).toHaveLength(1);
    expect(hits[0].hostId).toBe("host-udm-2");
  });

  it("surfaces both hosts that share a hostname instead of silently taking the first", async () => {
    const index = await buildSiteIndex();
    const hits = matchSites(index.entries, DUPLICATE_HOSTNAME);
    expect(hits.length).toBeGreaterThan(1);
  });

  it("returns nothing for a name that does not exist", async () => {
    const index = await buildSiteIndex();
    expect(matchSites(index.entries, "Nonexistent Customer")).toEqual([]);
  });
});

describe("resolveLocalSiteId", () => {
  it("joins on internalReference, never on position", async () => {
    connGet.mockResolvedValue(UOS_LOCAL_SITES_RESPONSE);
    const index = await buildSiteIndex();
    const entry = index.entries.find((e) => e.slug === "slug0001")!;

    const localSiteId = await resolveLocalSiteId(entry);

    // The bug this replaces: data[0] is "local-default", the empty placeholder.
    expect(localSiteId).toBe("local-fabrikam");
    expect(localSiteId).not.toBe(UOS_LOCAL_SITES_RESPONSE.data[0].id);
  });

  it("asks the connector for the full page rather than the default 25", async () => {
    connGet.mockResolvedValue(UOS_LOCAL_SITES_RESPONSE);
    const index = await buildSiteIndex();
    await resolveLocalSiteId(index.entries.find((e) => e.slug === "slug0001")!);

    const [, path, params] = connGet.mock.calls[0];
    expect(path).toBe("network/integration/v1/sites");
    expect(params).toMatchObject({ limit: 200 });
  });

  it("reports the connector's status instead of collapsing it to 'not found'", async () => {
    connGet.mockRejectedValue(
      new ConnectorError("HTTP 403: Forbidden", 403, {}),
    );
    const index = await buildSiteIndex();
    const entry = index.entries.find((e) => e.slug === "slug0001")!;

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
    const entry = index.entries.find((e) => e.slug === "slug0001")!;

    await expect(resolveLocalSiteId(entry)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("caches per host so a second site on the same console costs no extra call", async () => {
    connGet.mockResolvedValue(UOS_LOCAL_SITES_RESPONSE);
    const index = await buildSiteIndex();

    await resolveLocalSiteId(index.entries.find((e) => e.slug === "slug0001")!);
    await resolveLocalSiteId(index.entries.find((e) => e.slug === "slug0002")!);

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

  describe("when /hosts fails", () => {
    beforeEach(() => {
      cloudGet.mockImplementation((path: string) => {
        if (path === "/hosts") return Promise.reject(new Error("hosts down"));
        if (path === "/sites") return Promise.resolve(SITES_RESPONSE);
        throw new Error(`unexpected ${path}`);
      });
    });

    it("still finds sites that carry their own name", async () => {
      // /sites alone carries meta.desc, so a real customer name still resolves.
      const index = await buildSiteIndex();
      expect(index.entries.length).toBeGreaterThan(0);
      expect(matchSites(index.entries, "Fabrikam Charter School")).toHaveLength(1);
    });

    it("says so, because losing /hosts loses REACH and not just labelling", async () => {
      // The claim this replaces was "degrades naming, not reach". False: a
      // single-site console's desc is the literal "Default", so its display
      // name IS the hostname -- and with /hosts gone it becomes "unknown" and
      // is unfindable. A caller must be able to tell that from a typo.
      const index = await buildSiteIndex();

      expect(matchSites(index.entries, "Northwind-Clinic-UDM")).toHaveLength(0);
      expect(index.degraded).toHaveLength(1);
      expect(index.degraded[0]).toMatch(/console/i);
    });

    it("caches the degraded index only briefly, so recovery is picked up", async () => {
      const degradedAt = Date.now();
      await buildSiteIndex();

      // A complete index is held for 5 minutes; a known-incomplete one must not
      // be, or a recovered /hosts stays invisible for that whole window.
      vi.setSystemTime(degradedAt + 45_000);
      cloudGet.mockImplementation((path: string) => {
        if (path === "/hosts") return Promise.resolve(HOSTS_RESPONSE);
        if (path === "/sites") return Promise.resolve(SITES_RESPONSE);
        throw new Error(`unexpected ${path}`);
      });

      const recovered = await buildSiteIndex();
      expect(recovered.degraded).toEqual([]);
      expect(matchSites(recovered.entries, "Northwind-Clinic-UDM")).toHaveLength(1);
      vi.useRealTimers();
    });
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
    const sites = index.entries.filter((e) => e.hostId === UOS_HOST_ID && e.slug !== "default");

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
    const entry = index.entries.find((e) => e.slug === "slug0001")!;

    await expect(resolveLocalSiteId(entry)).rejects.toMatchObject({ status: 502 });

    connGet.mockResolvedValue(UOS_LOCAL_SITES_RESPONSE);
    clearSiteIndexCache();
    await expect(resolveLocalSiteId(entry)).resolves.toBe("local-fabrikam");
  });
});

describe("a refusal's escape hatch must open", () => {
  // The class of bug this catches: an error message that names an identifier
  // the resolver does not accept. The message reads as helpful, the retry
  // returns the same refusal, and an LLM caller loops. Asserting the round trip
  // is the only way to know the two halves agree -- no type checker sees it.
  function idsOfferedBy(reason: string): string[] {
    return [...reason.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!);
  }

  it("resolves every id selectSite prints for colliding site names", async () => {
    const { entries } = await buildSiteIndex();
    const candidates = matchSites(entries, DUPLICATE_HOSTNAME);
    const { reason } = selectSite(candidates, DUPLICATE_HOSTNAME);

    const ids = idsOfferedBy(reason!);
    expect(ids.length).toBe(candidates.length);

    for (const id of ids) {
      // Exactly one, or the retry lands back in the same ambiguity.
      expect(matchSites(entries, id), `id '${id}' did not resolve`).toHaveLength(1);
    }
  });

  it("resolves every id selectHost prints for colliding console names", async () => {
    const { entries } = await buildSiteIndex();
    const candidates = matchSites(entries, DUPLICATE_HOSTNAME);
    const { reason, groups } = selectHost(candidates, DUPLICATE_HOSTNAME);

    const ids = idsOfferedBy(reason!);
    expect(ids.length).toBe(groups.length);

    for (const id of ids) {
      const hits = matchSites(entries, id);
      expect(hits.length, `id '${id}' did not resolve`).toBeGreaterThan(0);
      expect(new Set(hits.map((h) => h.hostId)).size).toBe(1);
    }
  });
});

describe("loadLocalSites pagination", () => {
  it("pages past the API's 200-row cap instead of truncating silently", async () => {
    // The local API caps `limit` at 200. A console past that returned a partial
    // slug map, and a site in the missing tail was reported as "no such site" --
    // a 404 asserting something the console never actually said.
    const page1 = {
      data: Array.from({ length: 200 }, (_, i) => ({
        id: `local-${i}`,
        internalReference: `ref-${i}`,
      })),
      totalCount: 201,
    };
    const page2 = {
      data: [{ id: "local-tail", internalReference: "slug0001" }],
      totalCount: 201,
    };
    connGet.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

    const { entries } = await buildSiteIndex();
    const entry = entries.find((e) => e.slug === "slug0001")!;

    await expect(resolveLocalSiteId(entry)).resolves.toBe("local-tail");
    expect(connGet).toHaveBeenCalledTimes(2);
    expect(connGet.mock.calls[1]![2]).toMatchObject({ offset: 200 });
  });

  it("stops at one page when the console reports no more", async () => {
    connGet.mockResolvedValue(UOS_LOCAL_SITES_RESPONSE);
    const { entries } = await buildSiteIndex();
    await resolveLocalSiteId(entries.find((e) => e.slug === "slug0001")!);
    expect(connGet).toHaveBeenCalledTimes(1);
  });

  it("explains a console that has no Network site at all", async () => {
    // A Protect-only NVR indexes with an empty slug. Quoting that empty slug
    // back at the caller ("has no site ''") explains nothing.
    const { entries } = await buildSiteIndex();
    const nvr = { ...entries[0]!, slug: "", displayName: "Camera NVR" };
    await expect(resolveLocalSiteId(nvr)).rejects.toMatchObject({ status: 404 });
    await expect(resolveLocalSiteId(nvr)).rejects.toThrow(/no UniFi Network site/);
  });
});

describe("pagination must not trust the server's own arithmetic", () => {
  it("keeps paging when totalCount is absent and a full page came back", async () => {
    // Breaking here cached a TRUNCATED slug map for 5 minutes, and a site in
    // the missing tail then got a 404 quoting a count the console never said.
    const full = {
      data: Array.from({ length: 200 }, (_, i) => ({
        id: `local-${i}`,
        internalReference: `ref-${i}`,
      })),
      // totalCount deliberately omitted.
    };
    const tail = { data: [{ id: "local-tail", internalReference: "slug0001" }] };
    connGet.mockResolvedValueOnce(full).mockResolvedValueOnce(tail);

    const { entries } = await buildSiteIndex();
    const entry = entries.find((e) => e.slug === "slug0001")!;

    await expect(resolveLocalSiteId(entry)).resolves.toBe("local-tail");
    expect(connGet).toHaveBeenCalledTimes(2);
  });

  it("refuses rather than answering from a knowingly partial list", async () => {
    // Out of pages with rows still outstanding. Caching what we have would turn
    // "we stopped reading" into "the console does not have it" -- a 404 that
    // asserts something the console never said.
    connGet.mockResolvedValue({
      data: Array.from({ length: 200 }, (_, i) => ({
        id: `local-${i}`,
        internalReference: `ref-${i}`,
      })),
    });

    const { entries } = await buildSiteIndex();
    const entry = entries.find((e) => e.slug === "slug0001")!;

    await expect(resolveLocalSiteId(entry)).rejects.toMatchObject({ status: 502 });
  });
});

describe("an outage is not a typo", () => {
  it("gives a /sites failure the UNREACHABLE status, not a raw client error", async () => {
    // Unwrapped, this escaped the SiteResolutionError taxonomy entirely and
    // every caller's `instanceof` check fell through to String(err).
    cloudGet.mockImplementation((path: string) => {
      if (path === "/hosts") return Promise.resolve(HOSTS_RESPONSE);
      return Promise.reject(new Error("502 Bad Gateway"));
    });

    await expect(buildSiteIndex()).rejects.toMatchObject({
      name: "SiteResolutionError",
      status: 502,
    });
  });
});

describe("clearSiteIndexCache", () => {
  it("is not undone by a build that was already in flight", async () => {
    // Clearing only detached the promise handle; the running closure still
    // wrote its stale result on settle, so the clear silently reverted itself
    // and the next five minutes served exactly what was discarded.
    let release: (v: unknown) => void = () => {};
    const stalled = new Promise((r) => (release = r));

    cloudGet.mockImplementation((path: string) => {
      if (path === "/hosts") return Promise.resolve(HOSTS_RESPONSE);
      return stalled.then(() => STALE_SITES_RESPONSE);
    });

    const inFlight = buildSiteIndex();
    clearSiteIndexCache();

    wireCloud();
    const fresh = await buildSiteIndex();
    release(null);
    await inFlight;

    // The stale build has now settled. The cache must still hold the fresh one.
    expect(matchSites(fresh.entries, "Wingtip Toys")).toHaveLength(0);
    const after = await buildSiteIndex();
    expect(matchSites(after.entries, "Wingtip Toys")).toHaveLength(0);
    expect(matchSites(after.entries, "Fabrikam Charter School")).toHaveLength(1);
  });
});

describe("a failed build must not poison the cache", () => {
  it("does not cache a rejection, so the next call retries", async () => {
    let attempts = 0;
    cloudGet.mockImplementation((path: string) => {
      if (path === "/hosts") return Promise.resolve(HOSTS_RESPONSE);
      attempts++;
      if (attempts === 1) return Promise.reject(new Error("transient 503"));
      return Promise.resolve(SITES_RESPONSE);
    });

    await expect(buildSiteIndex()).rejects.toThrow();

    // A cached rejection would strand the whole process for the TTL on one
    // transient blip -- the caller cannot clear a cache it cannot see.
    const recovered = await buildSiteIndex();
    expect(matchSites(recovered.entries, "Fabrikam Charter School")).toHaveLength(1);
    expect(attempts).toBe(2);
  });

  it("gives concurrent callers the same rejection without a second fetch", async () => {
    let attempts = 0;
    cloudGet.mockImplementation((path: string) => {
      if (path === "/hosts") return Promise.resolve(HOSTS_RESPONSE);
      attempts++;
      return Promise.reject(new Error("down"));
    });

    const results = await Promise.allSettled([
      buildSiteIndex(),
      buildSiteIndex(),
      buildSiteIndex(),
    ]);

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(attempts).toBe(1);
  });
});

describe("operator visibility", () => {
  it("logs once when the index degrades, and again when it recovers", async () => {
    // Without a log the only evidence is a "no site matches" reaching whoever
    // is asking the AI -- indistinguishable from a typo, and there is no other
    // log, metric or health surface in this process.
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The transition state is module-global and deliberately survives
      // clearSiteIndexCache (nothing in production clears the cache). Drive it
      // to a known-healthy state through the real code path rather than
      // assuming whatever the previous test left behind.
      await buildSiteIndex();
      errs.mockClear();
      clearSiteIndexCache();

      cloudGet.mockImplementation((path: string) => {
        if (path === "/hosts") return Promise.reject(new Error("hosts down"));
        return Promise.resolve(SITES_RESPONSE);
      });
      await buildSiteIndex();
      expect(errs.mock.calls.flat().join(" ")).toMatch(/DEGRADED/);

      // Rebuilt every 30s by design; logging each rebuild would print all night
      // and be filtered out, which is the same as not logging.
      errs.mockClear();
      clearSiteIndexCache();
      await buildSiteIndex();
      expect(errs).not.toHaveBeenCalled();

      errs.mockClear();
      clearSiteIndexCache();
      wireCloud();
      await buildSiteIndex();
      expect(errs.mock.calls.flat().join(" ")).toMatch(/recovered/);
    } finally {
      errs.mockRestore();
    }
  });
});

describe("the optional feed must not hold up the required one", () => {
  it("degrades on a deadline instead of waiting out the retry ladder", async () => {
    // client.ts wraps every request in withRetry: 4 attempts at a 30 s timeout
    // plus backoff, so a HANGING /hosts takes ~127 s to reach its catch --
    // longer than the 30 s TTL that then rebuilds it. Every rebuild re-pays the
    // ladder, a build is always in flight, and callers wait on it. A partial
    // outage of the OPTIONAL feed became a total latency outage.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    cloudGet.mockImplementation((path: string) => {
      if (path === "/hosts") return new Promise(() => {}); // never settles
      return Promise.resolve(SITES_RESPONSE);
    });

    const pending = buildSiteIndex();
    await vi.advanceTimersByTimeAsync(6_000);
    const index = await pending;

    expect(index.degraded).toHaveLength(1);
    expect(index.degraded[0]).toMatch(/no answer within/);
    // The required feed still produced a usable fleet.
    expect(matchSites(index.entries, "Fabrikam Charter School")).toHaveLength(1);
    vi.useRealTimers();
  });

  it("does not let the late loser mutate an index already built and cached", async () => {
    // The losing fetch still settles. Pushing its reason into the shared
    // `degraded` array would mutate an index that has already been returned and
    // cached, silently growing duplicate lines minutes later.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let releaseHosts: (v: unknown) => void = () => {};
    cloudGet.mockImplementation((path: string) => {
      if (path === "/hosts") return new Promise((r) => (releaseHosts = r));
      return Promise.resolve(SITES_RESPONSE);
    });

    const pending = buildSiteIndex();
    await vi.advanceTimersByTimeAsync(6_000);
    const index = await pending;
    expect(index.degraded).toHaveLength(1);

    releaseHosts(HOSTS_RESPONSE);
    await vi.advanceTimersByTimeAsync(10);

    expect(index.degraded).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe("the expensive refusal must be remembered", () => {
  it("negative-caches a pagination refusal instead of re-spending the budget", async () => {
    // 20 connector calls per attempt against a 100 req/min per console budget:
    // five retries exhaust it, and the 429s that follow look like a different
    // fault entirely. This was the one path the negative cache did not cover,
    // and the one 20x more expensive than the path it did.
    connGet.mockResolvedValue({
      data: Array.from({ length: 200 }, (_, i) => ({
        id: `local-${i}`,
        internalReference: `ref-${i}`,
      })),
    });

    const { entries } = await buildSiteIndex();
    const entry = entries.find((e) => e.slug === "slug0001")!;

    await expect(resolveLocalSiteId(entry)).rejects.toMatchObject({ status: 502 });
    expect(connGet).toHaveBeenCalledTimes(20);

    await expect(resolveLocalSiteId(entry)).rejects.toMatchObject({ status: 502 });
    expect(connGet).toHaveBeenCalledTimes(20);
  });

  it("says which failure it is, rather than asserting a site count", async () => {
    // This fires because a console is ignoring `offset`, far more often than
    // because it holds thousands of sites. byRef stopping while offset climbs
    // is the evidence that separates them, and it is already in hand.
    connGet.mockResolvedValue({
      data: Array.from({ length: 200 }, (_, i) => ({
        id: `local-${i}`,
        internalReference: `ref-${i}`,
      })),
    });

    const { entries } = await buildSiteIndex();
    const entry = entries.find((e) => e.slug === "slug0001")!;

    await expect(resolveLocalSiteId(entry)).rejects.toThrow(/ignoring 'offset'/);
    await expect(resolveLocalSiteId(entry)).rejects.toThrow(/only 200 distinct sites/);
  });
});
