import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Exact console-hostname matching is the bug this fork exists to remove: on a
 * UniFi OS Server every customer is a site on ONE console, so no customer name
 * can ever equal a hostname. The pattern is easy to re-inline by hand while
 * refactoring -- it was, once, in siteHealthTimeline -- and nothing in the type
 * system objects.
 */
const SRC = join(import.meta.dirname, "..", "src");

function sources(dir: string): Array<[string, string]> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith(".ts")
      ? ([[p.slice(SRC.length + 1), readFileSync(p, "utf8")]] as Array<[string, string]>)
      : [];
  });
}

describe("site resolution", () => {
  it("never matches a console hostname by exact string comparison", () => {
    // e.g. `h.hostName.toUpperCase() === name.toUpperCase()`
    const inlined = /hostName\s*\.\s*toUpperCase\(\)\s*===/;
    const offenders = sources(SRC)
      .filter(([, src]) => inlined.test(src))
      .map(([file]) => file);

    expect(offenders).toEqual([]);
  });

  it("keeps exactly one resolution mechanism, so no caller can pick the wrong one", () => {
    // Two parallel resolvers -- one index-based and correct, one hostname-based
    // and not -- is how a future contributor reintroduces the original bug.
    const resolver = readFileSync(join(SRC, "helpers", "resolver.ts"), "utf8");
    expect(resolver).not.toContain("export async function resolveHostByName");
    expect(resolver).not.toContain("export async function resolveDevicesByHostName");
  });
});
