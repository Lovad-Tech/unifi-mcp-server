/**
 * The one description for every "which site?" parameter.
 *
 * These strings are the interface the model actually reads. The resolver was
 * changed to accept customer names, but every schema still said "Host name
 * (e.g. 'USM')" -- so the model kept passing console names and the fix was
 * unreachable from the outside. Kept in one place so that cannot drift again.
 */
export const SITE_NAME_DESCRIPTION =
  "Customer name, site name, console name, or site slug. On a UniFi OS Server " +
  "every customer is a separate SITE on one shared console, so the customer's " +
  "name is normally what to pass here, not a console/host name. If the name " +
  "matches several locations of one customer the call returns the candidate " +
  "list instead of guessing -- ask which is meant, then retry with that exact " +
  "name. Use find-site to search.";
