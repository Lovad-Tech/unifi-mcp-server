/**
 * Ambiguity policy for site resolution.
 *
 * `matchSites` deliberately returns EVERY candidate. Something has to decide
 * what happens when a tech types "Tailspin Tire" and four sites match. That
 * decision is a product judgement, not a lookup detail, so it lives alone in
 * this file where it can be changed without touching the index.
 *
 * It matters more than it looks. Today every caller is a read, so a wrong pick
 * returns the wrong site's data -- bad, but visible. The same resolver will
 * front the write path (device restarts, firewall changes), where picking the
 * wrong branch of a multi-site customer is expensive and silent.
 */

import type { SiteEntry } from "./site-index.js";

/** Enough for the tech to recognise theirs; short of dumping a 60-site console. */
const MAX_LISTED = 8;

export interface SiteSelection {
  /** The site to act on, or null when the caller must be told to narrow down. */
  chosen: SiteEntry | null;
  /** Always populated, so an error message can list what the tech could mean. */
  candidates: SiteEntry[];
  /** Human-readable explanation when `chosen` is null. */
  reason?: string;
}

export function selectSite(
  candidates: SiteEntry[],
  query: string,
): SiteSelection {
  if (candidates.length === 0) {
    return { chosen: null, candidates, reason: `No site matches '${query}'.` };
  }

  if (candidates.length === 1) {
    return { chosen: candidates[0], candidates };
  }

  // Always ask. A cluster of similar names is usually ONE customer with several
  // locations -- "Tailspin Tire - North", "- South", "- East", and so on -- so a
  // near-match is the least reliable moment to guess, not the most. An exact hit
  // does NOT win outright either: a bare "Tailspin Tire" among branches is as
  // likely a typo for one of them as it is the customer's own HQ site.
  //
  // The cost is asymmetric. The caller is an LLM relaying to a tech, so a refusal
  // costs one cheap round trip and teaches them the real site names. A wrong pick
  // gets repeated to a customer as fact -- and this same resolver will front the
  // write path, where acting on the wrong branch is silent and expensive.
  const shown = candidates.slice(0, MAX_LISTED);
  const names = shown.map((c) => c.displayName).join(", ");
  const andMore =
    candidates.length > shown.length
      ? `, and ${candidates.length - shown.length} more`
      : "";

  return {
    chosen: null,
    candidates,
    reason:
      `'${query}' matches ${candidates.length} sites: ${names}${andMore}. ` +
      `Ask which one is meant, then retry with that exact name.`,
  };
}
