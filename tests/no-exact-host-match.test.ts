/**
 * Exact console-hostname matching is the bug this fork exists to remove: on a
 * UniFi OS Server every customer is a site on ONE console, so no customer name
 * can ever equal a hostname. It is easy to re-inline by hand while refactoring
 * -- it was, once, in `siteHealthTimeline` -- and nothing in the type system
 * objects.
 *
 * The previous version of this file blocklisted the two function NAMES that
 * happened to exist when it was written. Reintroducing the identical broken
 * lookup as `lookupConsole` passed it green, which was proven by mutation. A
 * blocklist can only refuse the past.
 *
 * So: an ALLOWLIST of the exported surface -- any new way to resolve a name has
 * to be added here, which is the review -- plus behavioural tests that pin what
 * resolution must actually do.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HOSTS_RESPONSE, SITES_RESPONSE, UOS_HOST_ID } from "./fixtures/fleet.js";

vi.mock("../src/client.js", () => ({
  unifiClient: { get: vi.fn(), post: vi.fn() },
  UniFiError: class extends Error {},
}));
vi.mock("../src/connector-client.js", () => ({
  connectorClient: { get: vi.fn() },
  ConnectorError: class extends Error {},
  ConnectorUnavailableError: class extends Error {},
}));

import { unifiClient } from "../src/client.js";
import * as resolver from "../src/helpers/resolver.js";
import { clearSiteIndexCache } from "../src/helpers/site-index.js";

const cloudGet = unifiClient.get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearSiteIndexCache();
  cloudGet.mockReset();
  cloudGet.mockImplementation((path: string) => {
    if (path === "/hosts") return Promise.resolve(HOSTS_RESPONSE);
    if (path === "/sites") return Promise.resolve(SITES_RESPONSE);
    if (path === "/devices")
      return Promise.resolve({
        data: [
          {
            hostId: UOS_HOST_ID,
            hostName: "a1b2c3d4e5f6",
            devices: [{ id: "d1", status: "online" }],
            updatedAt: "2026-09-04T00:00:00Z",
          },
        ],
      });
    throw new Error(`unexpected ${path}`);
  });
});

/**
 * Every way out of the resolver. Adding a name here is the review step: it is
 * the moment someone has to justify a second way to turn a string into a site.
 */
const ALLOWED_RESOLVER_EXPORTS = [
  "resolveAllDevices",
  "resolveAllSites",
  "resolveConnectorContext",
  "resolveDeviceHostEntry",
  "resolveHostEntry",
  "resolveSiteEntry",
].sort();

describe("resolution surface", () => {
  it("exposes exactly the resolution entry points that were reviewed", () => {
    // A blocklist refuses only the names it already knows. This refuses every
    // name it has not been told about, including one invented tomorrow.
    expect(Object.keys(resolver).sort()).toEqual(ALLOWED_RESOLVER_EXPORTS);
  });
});

describe("resolution behaviour on a shared console", () => {
  it("finds a customer whose name equals no console hostname", async () => {
    // The bug: the only lookup was an exact match on console hostname, which a
    // customer on a UOS Server can never satisfy.
    const entry = await resolver.resolveSiteEntry("Fabrikam Charter School");
    expect(entry.slug).toBe("slug0001");
    expect(entry.hostId).toBe(UOS_HOST_ID);
  });

  it("never answers a customer query with the console's placeholder site", async () => {
    // `data[0]` on that console is the empty "Default" site. Returning it for
    // every customer is the silent failure the fork replaces.
    const entry = await resolver.resolveSiteEntry("Fabrikam Charter School");
    expect(entry.slug).not.toBe("default");
  });

  it("refuses rather than guessing between a customer's locations", async () => {
    await expect(resolver.resolveSiteEntry("Tailspin Tire")).rejects.toMatchObject({
      status: 300,
    });
  });

  it("still reaches the console itself for host-scoped inventory", async () => {
    // Host-scoped endpoints are per console, so many sites on one console is
    // not ambiguity. Routing this through the site axis made the console
    // permanently unaddressable by the name its own schema advertises.
    const { host, devices } = await resolver.resolveDeviceHostEntry("a1b2c3d4e5f6");
    expect(host.hostId).toBe(UOS_HOST_ID);
    expect(host.sites.length).toBeGreaterThan(1);
    expect(devices?.devices).toHaveLength(1);
  });
});
