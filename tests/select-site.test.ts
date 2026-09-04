import { describe, it, expect } from "vitest";
import { selectSite } from "../src/helpers/select-site.js";
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
