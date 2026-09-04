import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The schema `describe()` strings are the interface the MODEL reads. The
 * resolver was widened to accept customer names while every schema still said
 * "Host name (e.g. 'USM')", so the model kept passing console names and the fix
 * was unreachable from outside. No type checker can see that kind of drift.
 */
const SRC = join(import.meta.dirname, "..", "src");

/** Whole tree: prompts.ts and resources.ts drive the same tools. */
function toolSources(dir = SRC): Array<[string, string]> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return toolSources(p);
    return e.name.endsWith(".ts")
      ? ([[p.slice(SRC.length + 1), readFileSync(p, "utf8")]] as Array<[string, string]>)
      : [];
  });
}

describe("site parameter descriptions", () => {
  it("never describes any parameter as a host name", () => {
    // Anchored on the PHRASE anywhere in a describe(), not on a prefix: the
    // prefix form passed vacuously on "Specific site host names to compare".
    const stale = /\.describe\(\s*"[^"]*[Hh]ost name/;
    const offenders = toolSources()
      .filter(([file]) => file !== "tools/site-param.ts")
      .filter(([, src]) => stale.test(src))
      .map(([file]) => file);

    expect(offenders).toEqual([]);
  });

  it("never tells the model to enumerate consoles to find a site", () => {
    // Prompt bodies are instructions the model follows literally. "Call
    // list-hosts to enumerate consoles" sends it down the pre-fork path.
    const offenders = toolSources()
      .filter(([, src]) => /list-hosts` to enumerate|enumerate consoles/i.test(src))
      .map(([file]) => file);

    expect(offenders).toEqual([]);
  });

  it("routes every site parameter through the one shared description", () => {
    // A hand-written variant is how the drift starts. One constant or nothing.
    for (const [file, src] of toolSources()) {
      if (file === "tools/site-param.ts") continue; // defines it
      if (!src.includes("SITE_NAME_DESCRIPTION")) continue;
      expect(
        /from "\.{1,2}\/(?:tools\/)?site-param\.js"/.test(src),
        `${file} uses SITE_NAME_DESCRIPTION without importing it`,
      ).toBe(true);
    }
  });

  it("tells the model that a customer name is what to pass", async () => {
    const { SITE_NAME_DESCRIPTION } = await import("../src/tools/site-param.js");
    expect(SITE_NAME_DESCRIPTION.toLowerCase()).toContain("customer name");
    expect(SITE_NAME_DESCRIPTION.toLowerCase()).toContain("find-site");
  });
});
