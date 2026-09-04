import { z } from "zod/v4";
import { applyExtractFields } from "@us-all/mcp-toolkit";
import { unifiClient } from "../client.js";
import { extractFieldsDescription } from "./extract-fields.js";
import { buildSiteIndex, matchSites } from "../helpers/site-index.js";

const ef = z.string().optional().describe(extractFieldsDescription);

export const listSitesSchema = z.object({
  extractFields: ef,
});

/**
 * Raw Site Manager site list.
 *
 * Trimmed by default, as `listHosts` already was. Untrimmed this is ~150 KB on a
 * fleet of this size -- the `statistics` block on every site carries full device
 * counts, gateway state and ISP info that a listing does not need. Pass
 * `extractFields` for a different projection.
 */
export async function listSites(params: z.infer<typeof listSitesSchema> = {}) {
  const response = await unifiClient.get<{ data: unknown[] }>("/sites");
  // Applied, not ignored. `listHosts` upstream returns the RAW payload when a
  // projection is passed, which makes the parameter mean its own opposite.
  if (params.extractFields) return applyExtractFields(response.data, params.extractFields);
  return applyExtractFields(
    response.data,
    "*.siteId,*.hostId,*.meta.name,*.meta.desc,*.meta.timezone,*.statistics.counts.totalDevice,*.statistics.counts.offlineDevice",
  );
}

/** A fleet listing is for orientation; anything longer is a search, not a list. */
const SITE_INDEX_DEFAULT_LIMIT = 50;

export const listSiteIndexSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Customer name, site name, console name, or slug. Partial and " +
        "case-insensitive. Omit to list the fleet.",
    ),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(`Max rows to return (default ${SITE_INDEX_DEFAULT_LIMIT}).`),
});

/**
 * The searchable fleet view: one row per site, carrying the CUSTOMER name.
 *
 * `listSites` returns Site Manager's raw shape, where the human name hides in
 * `meta.desc` and `meta.name` is an opaque slug. On a console holding one site
 * per customer that raw shape is close to unreadable, which is why this exists.
 */
export async function listSiteIndex(
  params: z.infer<typeof listSiteIndexSchema> = {},
) {
  const index = await buildSiteIndex();
  const limit = params.limit ?? SITE_INDEX_DEFAULT_LIMIT;
  const rows = params.query ? matchSites(index, params.query) : index;

  // Report the true total, so a truncated answer never reads as the whole fleet.
  return {
    total: rows.length,
    returned: Math.min(rows.length, limit),
    sites: rows.slice(0, limit),
  };
}
