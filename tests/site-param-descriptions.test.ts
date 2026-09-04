/**
 * The schema `describe()` strings are the interface the MODEL reads.
 *
 * The resolver was widened to accept customer names while every schema still
 * said "Host name (e.g. 'USM')", so the model kept passing console names and
 * the fix was unreachable from outside. No type checker sees that drift.
 *
 * This guard reads the DESCRIPTIONS THE MODEL ACTUALLY RECEIVES -- Zod exposes
 * them at runtime -- rather than grepping source for a spelling. The previous
 * version regexed `.describe("..."` and passed green on a `.describe(\`...\`)`
 * carrying the exact banned text; the codebase already uses that template-literal
 * form, so the hole was reachable, not theoretical.
 */
import { describe, it, expect, vi } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { SITE_NAME_DESCRIPTION } from "../src/tools/site-param.js";

vi.mock("../src/client.js", () => ({
  unifiClient: { get: vi.fn(), post: vi.fn() },
  UniFiError: class extends Error {},
}));
vi.mock("../src/connector-client.js", () => ({
  connectorClient: { get: vi.fn() },
  ConnectorError: class extends Error {},
  ConnectorUnavailableError: class extends Error {},
}));

/** Fields that answer "which site/console?" and therefore must say so. */
const SELECTOR_FIELDS = new Set(["name", "names", "hostName", "site", "siteName"]);

interface DescribedField {
  module: string;
  schema: string;
  field: string;
  description: string | undefined;
}

async function everyDescribedField(): Promise<DescribedField[]> {
  const dir = join(import.meta.dirname, "..", "src", "tools");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  const out: DescribedField[] = [];

  for (const file of files) {
    const mod: Record<string, unknown> = await import(join(dir, file));
    for (const [exportName, value] of Object.entries(mod)) {
      if (!exportName.endsWith("Schema")) continue;
      const shape = (value as { shape?: Record<string, unknown> })?.shape;
      if (!shape || typeof shape !== "object") continue;
      for (const [field, def] of Object.entries(shape)) {
        out.push({
          module: file,
          schema: exportName,
          field,
          description: (def as { description?: string })?.description,
        });
      }
    }
  }
  return out;
}

describe("site parameter descriptions", () => {
  it("finds schemas to check, so a green run is never vacuous", async () => {
    // A ratchet that silently checks nothing always passes. Assert the corpus.
    const fields = await everyDescribedField();
    expect(fields.length).toBeGreaterThan(20);
    expect(new Set(fields.map((f) => f.module)).size).toBeGreaterThan(3);
  });

  it("describes every site selector with the one shared description", async () => {
    const fields = await everyDescribedField();
    const selectors = fields.filter((f) => SELECTOR_FIELDS.has(f.field));
    expect(selectors.length).toBeGreaterThan(5);

    const wrong = selectors
      .filter((f) => !(f.description ?? "").includes(SITE_NAME_DESCRIPTION))
      .map((f) => `${f.module}:${f.schema}.${f.field}`);

    expect(wrong).toEqual([]);
  });

  it("never calls a parameter a host name outside that shared description", async () => {
    // The shared constant says "not a console/host name" on purpose, so the
    // check is scoped to descriptions that do NOT use it: either you route
    // through the constant, or you do not mention host names at all.
    const fields = await everyDescribedField();
    const offenders = fields
      .filter((f) => {
        const d = f.description ?? "";
        return !d.includes(SITE_NAME_DESCRIPTION) && /\bhost ?name\b/i.test(d);
      })
      .map((f) => `${f.module}:${f.schema}.${f.field} -> ${f.description}`);

    expect(offenders).toEqual([]);
  });

  it("tells the model that a customer name is what to pass", () => {
    expect(SITE_NAME_DESCRIPTION.toLowerCase()).toContain("customer name");
    expect(SITE_NAME_DESCRIPTION.toLowerCase()).toContain("find-site");
  });
});
