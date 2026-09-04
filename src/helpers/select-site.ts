/**
 * Ambiguity policy for resolution. Pure, synchronous, and the only place that
 * decides what happens when a name matches more than one thing.
 *
 * `matchSites` deliberately returns EVERY candidate. Something has to decide
 * what happens when a tech types a customer name and four sites match. That
 * decision is a product judgement, not a lookup detail, so it lives alone in
 * this file where it can be changed without touching the index.
 *
 * It matters more than it looks. Today every caller is a read, so a wrong pick
 * returns the wrong site's data -- bad, but visible. The same resolver will
 * front the write path (device restarts, firewall changes), where picking the
 * wrong branch of a multi-site customer is expensive and silent.
 *
 * THERE ARE TWO AXES, and conflating them is a bug in its own right:
 *
 *   selectSite -- "which SITE?"    Needs exactly one site. A wrong pick returns
 *                                  another customer's data.
 *   selectHost -- "which CONSOLE?" Needs exactly one host. Every site on one
 *                                  console gives the identical answer for a
 *                                  host-scoped endpoint (`/devices` is per
 *                                  console), so asking the tech to choose
 *                                  between them is a question with one answer.
 *
 * Routing host-scoped tools through `selectSite` made a console with many sites
 * permanently unaddressable by its own name -- every query returned "matches N
 * sites, pick one", and every choice led to the same device list.
 */

import type { SiteEntry } from "./site-index.js";
import { exactKeys } from "./site-index.js";

/** Enough for the tech to recognise theirs; short of dumping a large console. */
const MAX_LISTED = 8;

export interface SiteSelection {
  /** The site to act on, or null when the caller must be told to narrow down. */
  chosen: SiteEntry | null;
  /** Always populated, so an error message can list what the tech could mean. */
  candidates: SiteEntry[];
  /** Human-readable explanation when `chosen` is null. */
  reason?: string;
}

/** One console, plus whichever of its sites matched the query. */
export interface HostGroup {
  hostId: string;
  hostName: string;
  /** Non-empty. More than one means the name named a console, not a site. */
  sites: SiteEntry[];
}

export interface HostSelection {
  chosen: HostGroup | null;
  groups: HostGroup[];
  reason?: string;
}

/**
 * A stable id the caller can pass straight back to select this exact row.
 *
 * Taken from `exactKeys`, which `matchSites` also matches on -- so an id
 * printed here is by construction an id the resolver accepts. Written as two
 * independent lists it was not: the first version printed the `slug`, which is
 * unique only WITHIN a console, so two colliding candidates got the identical
 * bracket and the refusal stayed exactly as unactionable as before.
 *
 * `tests/site-index.test.ts` round-trips every id a refusal emits.
 */
function selectorFor(entry: SiteEntry): string {
  return exactKeys(entry)[0] ?? entry.hostId;
}

/**
 * Label each candidate, disambiguating ONLY where the display name repeats.
 *
 * Two consoles really can report the same hostname, and each then contributes a
 * site whose display name falls back to that hostname. Listing those as
 * `"X, X — retry with that exact name"` asks for something that cannot work:
 * the retry produces the identical refusal, and an LLM caller will loop on it.
 * Adding the selector unconditionally would bury the common case in noise, so
 * it is added only where it is load-bearing.
 */
function disambiguate<T>(
  items: readonly T[],
  name: (item: T) => string,
  id: (item: T) => string,
): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(name(item), (counts.get(name(item)) ?? 0) + 1);
  }
  return items.map((item) =>
    (counts.get(name(item)) ?? 0) > 1
      ? `${name(item)} [${id(item)}]`
      : name(item),
  );
}

function summarise(labels: string[], total: number): string {
  const shown = labels.slice(0, MAX_LISTED);
  const andMore =
    total > shown.length ? `, and ${total - shown.length} more` : "";
  return `${shown.join(", ")}${andMore}`;
}

/**
 * The one site a host group refers to, or null when it refers to the console.
 *
 * Guards the seam between the two axes: a host-scoped lookup that also wants a
 * site-scoped figure must be told when there isn't one, rather than taking the
 * first of many -- which is precisely the positional pick this fork removed.
 */
export function siteScopeCaveat(group: HostGroup, query: string): string | null {
  if (soleSite(group)) return null;
  // Says what is TRUE: `sites` holds the entries that MATCHED, not the
  // console's roster. Claiming "a console carrying N sites" misstated the
  // console's size whenever the query was an ambiguous customer prefix, and
  // told the tech to name one site of a console they never referenced.
  const names = group.sites.map((s) => s.displayName).join(", ");
  return (
    `'${query}' matched ${group.sites.length} sites on console ${group.hostName} ` +
    `(${names}). Per-site statistics are omitted because they differ between ` +
    `them; name one site to include them.`
  );
}

export function soleSite(group: HostGroup): SiteEntry | null {
  const [only] = group.sites;
  return group.sites.length === 1 && only ? only : null;
}

export function selectSite(
  candidates: SiteEntry[],
  query: string,
): SiteSelection {
  if (candidates.length === 0) {
    return { chosen: null, candidates, reason: `No site matches '${query}'.` };
  }

  const [only] = candidates;
  if (candidates.length === 1 && only) {
    return { chosen: only, candidates };
  }

  // Always ask. A cluster of similar names is usually ONE customer with several
  // locations -- a chain's branches, say -- so a near-match is the least
  // reliable moment to guess, not the most. An exact hit does NOT win outright
  // either: a bare chain name among its branches is as likely a typo for one of
  // them as it is the customer's own HQ site.
  //
  // The cost is asymmetric. The caller is an LLM relaying to a tech, so a
  // refusal costs one cheap round trip and teaches them the real site names. A
  // wrong pick gets repeated to a customer as fact -- and this same resolver
  // will front the write path, where acting on the wrong branch is silent and
  // expensive.
  const labels = disambiguate(candidates, (c) => c.displayName, selectorFor);
  // Computed over the SHOWN slice, not all labels. Over all of them, a match
  // list longer than MAX_LISTED whose colliding names sit past the cut promised
  // "the id shown in brackets" with no bracket on screen -- and that is exactly
  // the large shared console this fork exists to serve.
  const bracketed = labels.slice(0, MAX_LISTED).some((l) => l.endsWith("]"));

  return {
    chosen: null,
    candidates,
    reason:
      `'${query}' matches ${candidates.length} sites: ` +
      `${summarise(labels, candidates.length)}. ` +
      `Ask which one is meant, then retry with that exact name` +
      (bracketed ? ` or with the id shown in brackets.` : `.`),
  };
}

/**
 * Collapse candidates to exactly one CONSOLE, for host-scoped endpoints.
 *
 * Many sites resolving to one host is not ambiguity -- it is the normal shape of
 * a UniFi OS Server, and every one of those sites yields the same host-scoped
 * answer. Only a name spanning two genuinely different consoles is a question
 * worth asking.
 */
export function selectHost(
  candidates: SiteEntry[],
  query: string,
): HostSelection {
  if (candidates.length === 0) {
    return {
      chosen: null,
      groups: [],
      reason: `No site or console matches '${query}'.`,
    };
  }

  const byHost = new Map<string, HostGroup>();
  for (const entry of candidates) {
    const group = byHost.get(entry.hostId);
    if (group) group.sites.push(entry);
    else
      byHost.set(entry.hostId, {
        hostId: entry.hostId,
        hostName: entry.hostName,
        sites: [entry],
      });
  }

  const groups = [...byHost.values()];
  const [only] = groups;
  if (groups.length === 1 && only) return { chosen: only, groups };

  // Hostnames collide across consoles more often than they should, so label by
  // hostId wherever the name alone would not tell two apart.
  const labels = disambiguate(
    groups,
    (g) => g.hostName,
    (g) => g.hostId,
  );

  return {
    chosen: null,
    groups,
    reason:
      `'${query}' spans ${groups.length} consoles: ` +
      `${summarise(labels, groups.length)}. ` +
      `Ask which one is meant, then retry with that console's name or id.`,
  };
}
