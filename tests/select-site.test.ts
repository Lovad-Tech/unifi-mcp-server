import { describe, it, expect } from "vitest";
import {
  selectSite,
  selectHost,
  soleSite,
  siteScopeCaveat,
} from "../src/helpers/select-site.js";
import type { SiteEntry } from "../src/helpers/site-index.js";

function entry(displayName: string, slug: string): SiteEntry {
  return {
    cloudSiteId: `cloud-${slug}`,
    hostId: "host-uos",
    hostName: "a1b2c3d4e5f6",
    slug,
    displayName,
  };
}

// Referenced by the todo cases below — the worked example for the policy.
export const TAILSPIN = [
  entry("Tailspin Tire - North", "slug0002"),
  entry("Tailspin Tire - South", "slug0003"),
  entry("Tailspin Tire - East", "slug0004"),
];

describe("selectSite — settled behaviour", () => {
  it("reports no match without inventing one", () => {
    const result = selectSite([], "Nonexistent Customer");
    expect(result.chosen).toBeNull();
    expect(result.reason).toContain("Nonexistent Customer");
  });

  it("takes the only candidate when there is exactly one", () => {
    const only = entry("Fabrikam Charter School", "slug0001");
    expect(selectSite([only], "Fabrikam").chosen).toBe(only);
  });

});

describe("selectSite — multi-candidate policy: always ask", () => {
  it("refuses to guess when a name matches several locations", () => {
    const result = selectSite(TAILSPIN, "Tailspin Tire");
    expect(result.chosen).toBeNull();
  });

  it("names every candidate, so the tech can pick one", () => {
    const { reason } = selectSite(TAILSPIN, "Tailspin Tire");
    for (const site of TAILSPIN) {
      expect(reason).toContain(site.displayName);
    }
  });

  it("always returns the candidate list, so a caller can explain itself", () => {
    expect(selectSite(TAILSPIN, "Tailspin Tire").candidates).toHaveLength(3);
  });

  it("asks even when one candidate is an exact match of the query", () => {
    // "Tailspin Tire" could be the HQ site OR a typo for a branch. Same company,
    // different locations -- exactly the case where guessing is worst.
    const withExact = [
      { ...TAILSPIN[0], displayName: "Tailspin Tire" },
      ...TAILSPIN,
    ];
    expect(selectSite(withExact, "Tailspin Tire").chosen).toBeNull();
  });

  it("caps a very long candidate list rather than dumping the fleet", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...TAILSPIN[0],
      slug: `slug${i}`,
      displayName: `Tailspin Tire - Branch ${i}`,
    }));
    const { reason, candidates } = selectSite(many, "Tailspin Tire");
    expect(candidates).toHaveLength(40);
    expect(reason).toContain("40");
    expect(reason!.length).toBeLessThan(1200);
  });
});

describe("selectSite — the refusal must be actionable", () => {
  // Two consoles really do report the same hostname, and each contributes a
  // site whose display name falls back to it. "matches 2 sites: X, X --- retry
  // with that exact name" asks for something that cannot work: the retry is the
  // same query, so an LLM caller loops on it.
  const COLLIDING = [
    { ...entry("shared.example.com", "default"), hostId: "host-a", cloudSiteId: "cloud-a" },
    { ...entry("shared.example.com", "default"), hostId: "host-b", cloudSiteId: "cloud-b" },
  ];

  it("distinguishes candidates whose display names are identical", () => {
    const { reason } = selectSite(COLLIDING, "shared.example.com");
    expect(reason).toContain("cloud-a");
    expect(reason).toContain("cloud-b");
  });

  it("offers the id as a way out, since a name retry cannot resolve it", () => {
    const { reason } = selectSite(COLLIDING, "shared.example.com");
    expect(reason).toMatch(/id shown in brackets/i);
  });

  it("stays quiet when names already differ, so the common case is not noisy", () => {
    const { reason } = selectSite(TAILSPIN, "Tailspin Tire");
    expect(reason).not.toContain("[");
  });
});

describe("selectHost — host-scoped questions have one answer", () => {
  const ONE_CONSOLE = TAILSPIN; // all three share hostId "host-uos"

  it("does not ask which site when every candidate is on one console", () => {
    // `/devices` is host-scoped: all three sites return the identical inventory,
    // so asking the tech to choose is a question with a single answer. Routing
    // this through selectSite made a large console unaddressable by its own name.
    const { chosen } = selectHost(ONE_CONSOLE, "a1b2c3d4e5f6");
    expect(chosen?.hostId).toBe("host-uos");
    expect(chosen?.sites).toHaveLength(3);
  });

  it("still asks when a name spans two genuinely different consoles", () => {
    const spanning = [
      ONE_CONSOLE[0]!,
      { ...ONE_CONSOLE[1]!, hostId: "host-other", hostName: "Other-UDM" },
    ];
    const { chosen, groups } = selectHost(spanning, "Tailspin");
    expect(chosen).toBeNull();
    expect(groups).toHaveLength(2);
  });

  it("labels colliding console names by id, so the retry is possible", () => {
    const spanning = [
      { ...ONE_CONSOLE[0]!, hostId: "host-a", hostName: "dupe.example.com" },
      { ...ONE_CONSOLE[1]!, hostId: "host-b", hostName: "dupe.example.com" },
    ];
    const { reason } = selectHost(spanning, "dupe.example.com");
    expect(reason).toContain("host-a");
    expect(reason).toContain("host-b");
  });

  it("reports no match without inventing a console", () => {
    expect(selectHost([], "Nonexistent").chosen).toBeNull();
  });
});

describe("soleSite — the seam between the two axes", () => {
  it("returns the site when the name picked out exactly one", () => {
    const group = selectHost([TAILSPIN[0]!], "Tailspin Tire - North").chosen!;
    expect(soleSite(group)?.displayName).toBe("Tailspin Tire - North");
  });

  it("returns null when the name picked out a console, not a site", () => {
    // The caller must omit its site-scoped figures rather than take the first
    // of many --- which is the positional pick this fork exists to remove.
    const group = selectHost(TAILSPIN, "a1b2c3d4e5f6").chosen!;
    expect(soleSite(group)).toBeNull();
  });
});

describe("the offered id must be ON SCREEN, not merely computed", () => {
  it("does not promise brackets when the colliding rows fall past the cut", () => {
    // The listing is capped at 8. Deciding "are any bracketed?" over ALL
    // candidates promised "the id shown in brackets" with no bracket visible --
    // on precisely the large shared console this fork exists to serve.
    const distinct = Array.from({ length: 10 }, (_, i) => ({
      ...TAILSPIN[0]!,
      cloudSiteId: `cloud-${i}`,
      slug: `slug${i}`,
      displayName: `Tailspin Tire - Branch ${i}`,
    }));
    const colliding = [
      { ...TAILSPIN[0]!, cloudSiteId: "cloud-x", displayName: "Tailspin Tire - Depot" },
      { ...TAILSPIN[0]!, cloudSiteId: "cloud-y", displayName: "Tailspin Tire - Depot" },
    ];
    const { reason } = selectSite([...distinct, ...colliding], "Tailspin Tire");

    const shown = reason!.slice(0, reason!.indexOf(". Ask"));
    if (!shown.includes("[")) {
      expect(reason).not.toMatch(/id shown in brackets/i);
    }
  });

  it("still promises them when a colliding row is visible", () => {
    const colliding = [
      { ...TAILSPIN[0]!, cloudSiteId: "cloud-x", displayName: "Tailspin Tire - Depot" },
      { ...TAILSPIN[0]!, cloudSiteId: "cloud-y", displayName: "Tailspin Tire - Depot" },
    ];
    const { reason } = selectSite(colliding, "Tailspin Tire - Depot");
    expect(reason).toContain("[");
    expect(reason).toMatch(/id shown in brackets/i);
  });
});

describe("siteScopeCaveat", () => {
  it("says nothing when the name resolved to exactly one site", () => {
    const group = selectHost([TAILSPIN[0]!], "Tailspin Tire - North").chosen!;
    expect(siteScopeCaveat(group, "Tailspin Tire - North")).toBeNull();
  });

  it("reports what MATCHED, not a console roster it cannot see", () => {
    // `sites` holds the entries that matched the query. Calling that "a console
    // carrying N sites" misstated the console's real size whenever the query
    // was an ambiguous customer prefix, and told the tech to name one site of a
    // console they never referenced.
    const group = selectHost(TAILSPIN, "Tailspin Tire").chosen!;
    const caveat = siteScopeCaveat(group, "Tailspin Tire")!;

    expect(caveat).toContain("matched 3 sites");
    expect(caveat).not.toMatch(/carrying 3 sites/);
    for (const site of TAILSPIN) expect(caveat).toContain(site.displayName);
  });
});
