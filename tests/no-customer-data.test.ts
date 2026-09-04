/**
 * This repository is PUBLIC. Nothing in it may name a real customer.
 *
 * This exists because it happened: a real customer's name, one of its branch
 * locations and that branch's device count were committed here in a code
 * comment and a doc, as an illustration of the ambiguity policy. They were
 * accurate, which is exactly what made them a disclosure. A prior manual scrub
 * of a different real name had already run in the same session and missed this
 * one -- a scrub is a one-time act, and the rule needs to outlive it.
 *
 * The rule: EXAMPLE NAMES COME FROM THE FIXTURES. `tests/fixtures/fleet.ts`
 * holds a deliberately fictional fleet; anything that reads like a company name
 * anywhere else has to appear there too, or be listed below as a known
 * non-company phrase. Inventing a new example means adding it to the fixtures,
 * which is the moment to notice it is real.
 *
 * Scoped to TRACKED files via `git ls-files`, because that is the actual
 * exposure surface -- internal notes are gitignored and correctly out of scope.
 *
 * WHAT THIS DOES NOT CATCH, deliberately: a customer name written as unquoted
 * prose. Both real leaks were quoted (a code comment and a fenced block), and
 * scanning unquoted Title Case produced roughly fifty false positives from
 * ordinary Title Case section headers in the existing docs and comments.
 * A guard that noisy gets deleted, and a deleted guard catches nothing. Fleet
 * SIZES are likewise not pattern-matched; they are kept out by the gitignore
 * policy above, not by this file. Treat this as a net for the shape that has
 * actually escaped, not as proof the tree is clean.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const FIXTURES = join("tests", "fixtures", "fleet.ts");

/**
 * Two or more consecutive Capitalised words inside a quoted string --- the shape
 * of a company or site name. Deliberately broad; false positives are cheap to
 * allowlist, a missed customer name is not.
 */
const COMPANY_SHAPED =
  /["'`]([A-Z][a-z]+(?![A-Za-z])(?:[ -]+[A-Z][a-z]+(?![A-Za-z]))+)[^"'`]*["'`]/g;

/**
 * A bare 12-hex console hostname, which is what a UniFi OS Server reports. It
 * names a specific physical box and is not a company name, so nothing above
 * would ever catch it -- and it was in the leaked file.
 */
const CONSOLE_HOSTNAME = /\b[0-9a-f]{12}\b/g;


/**
 * Multi-word Capitalised phrases that are not company names. Each is a real
 * phrase from prose or an API, not an example of a customer.
 */
const NOT_A_COMPANY = new Set([
  // Vendor and protocol vocabulary.
  "Cloud Connector",
  "Site Manager",
  "Ubiquiti Inc",
  "Content-Type",
  "Firewall Zone",
  "Firewall Policy",
  "Traffic Matching List",
  "Site Summary",
  "Full Access",
  "Bad Gateway",
  "Camera NVR",
  // Sentence fragments the pattern clips out of prose or a UI title.
  "Get Uni",
  "List Wi",
  "All Uni",
  "Include Wi",
  // Names that are obviously fictional by construction.
  "Acme Inc",
  "Nonexistent Customer",
]);

function trackedTextFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((f) => /\.(ts|tsx|js|mjs|md|json|ya?ml)$/.test(f))
    .filter((f) => !f.startsWith("node_modules/"));
}

function companyShapedPhrases(text: string): string[] {
  return [...text.matchAll(COMPANY_SHAPED)].map((m) => m[1]!.trim());
}

/** Every fictional name the fixtures establish, plus its leading words. */
function approvedFromFixtures(): Set<string> {
  const text = readFileSync(join(ROOT, FIXTURES), "utf8");
  const approved = new Set<string>();
  for (const phrase of companyShapedPhrases(text)) {
    approved.add(phrase);
    // "Tailspin Tire - North" also approves the bare "Tailspin Tire".
    const words = phrase.split(/\s+/);
    for (let n = 2; n <= words.length; n++) {
      approved.add(words.slice(0, n).join(" "));
    }
  }
  return approved;
}

describe("public repository hygiene", () => {
  it("scans a non-empty set of tracked files, so a pass is never vacuous", () => {
    const files = trackedTextFiles();
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(FIXTURES);
  });

  it("uses no example name that the fixtures do not establish", () => {
    const approved = approvedFromFixtures();
    const offenders: string[] = [];

    for (const file of trackedTextFiles()) {
      if (file === FIXTURES) continue;
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const phrase of companyShapedPhrases(text)) {
        if (approved.has(phrase)) continue;
        if (NOT_A_COMPANY.has(phrase)) continue;
        // A fixture name with a suffix ("Tailspin Tire - Branch 3") is still
        // the fixture's name.
        if (approved.has(phrase.split(/\s+/).slice(0, 2).join(" "))) continue;
        offenders.push(`${file}: "${phrase}"`);
      }
    }

    // Every entry here is either a real customer name (remove it) or a harmless
    // phrase (add it to NOT_A_COMPANY, having checked that it is harmless).
    expect(offenders).toEqual([]);
  });

  it("names no console by its bare hostname", () => {
    // A UniFi OS Server reports a bare 12-hex hostname. It names one physical
    // box, is not a company name, and so nothing above would ever see it --
    // and it was in the file that leaked. Near-zero false positives.
    const approvedHex = new Set(
      [...readFileSync(join(ROOT, FIXTURES), "utf8").matchAll(CONSOLE_HOSTNAME)].map(
        (m) => m[0],
      ),
    );
    const offenders: string[] = [];

    for (const file of trackedTextFiles()) {
      if (file === FIXTURES) continue;
      for (const m of readFileSync(join(ROOT, file), "utf8").matchAll(CONSOLE_HOSTNAME)) {
        if (!approvedHex.has(m[0])) offenders.push(`${file}: console '${m[0]}'`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps internal fleet notes out of the tracked tree", () => {
    // FORK.md records real site counts, console names and device counts.
    expect(trackedTextFiles()).not.toContain("FORK.md");
  });
});
