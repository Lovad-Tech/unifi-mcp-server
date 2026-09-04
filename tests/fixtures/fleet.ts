/**
 * Synthetic fixtures modelled on the real Site Manager + Cloud Connector shapes.
 *
 * Deliberately synthetic: this repo is a public fork, so no real customer site
 * names go in here. The SHAPES are copied verbatim from live responses --
 * notably that a UniFi OS Server console carries many sites, that Site Manager
 * puts the opaque slug in `meta.name` and the human name in `meta.desc`, and
 * that the local Network API flips them (`name` is human, `internalReference`
 * is the slug). That flip is the join key the resolver depends on.
 */

/** The multi-site console: a UniFi OS Server carrying one site per customer. */
export const UOS_HOST_ID = "00000000-1111-2222-3333-444444444444";

/** Two hosts really do share a hostname in the field; `.find()` silently hides one. */
export const DUPLICATE_HOSTNAME = "example-domain.ui.com";

export const HOSTS_RESPONSE = {
  data: [
    // Bare hex hostname is what a UOS Server reports -- it is NOT a customer name.
    {
      id: UOS_HOST_ID,
      reportedState: { hostname: "a1b2c3d4e5f6", name: "Acme UOS Server" },
    },
    { id: "host-udm-1", reportedState: { hostname: "Northwind-Clinic-UDM" } },
    { id: "host-udm-2", reportedState: { hostname: "Contoso-Bakery-UDM-Pro" } },
    { id: "host-dupe-a", reportedState: { hostname: DUPLICATE_HOSTNAME } },
    { id: "host-dupe-b", reportedState: { hostname: DUPLICATE_HOSTNAME } },
  ],
};

/**
 * Site Manager `/v1/sites`. Note `meta.name` is the slug and `meta.desc` is the
 * display name -- the opposite of what the local API returns.
 */
export const SITES_RESPONSE = {
  data: [
    // The first entry on the UOS console is the empty placeholder site. The
    // upstream resolver took `data[0]` unconditionally, so this is what every
    // customer lookup silently resolved to.
    {
      siteId: "cloud-default",
      hostId: UOS_HOST_ID,
      meta: { name: "default", desc: "Default", timezone: "UTC" },
    },
    {
      siteId: "cloud-fabrikam",
      hostId: UOS_HOST_ID,
      meta: {
        name: "slug0001",
        desc: "Fabrikam Charter School",
        timezone: "America/New_York",
      },
    },
    {
      siteId: "cloud-tailspin-n",
      hostId: UOS_HOST_ID,
      meta: {
        name: "slug0002",
        desc: "Tailspin Tire - North",
        timezone: "America/New_York",
      },
    },
    {
      siteId: "cloud-tailspin-s",
      hostId: UOS_HOST_ID,
      meta: {
        name: "slug0003",
        desc: "Tailspin Tire - South",
        timezone: "America/New_York",
      },
    },
    {
      siteId: "cloud-tailspin-e",
      hostId: UOS_HOST_ID,
      meta: {
        name: "slug0004",
        desc: "Tailspin Tire - East",
        timezone: "America/New_York",
      },
    },
    // Single-site consoles: slug is literally "default".
    {
      siteId: "cloud-northwind",
      hostId: "host-udm-1",
      meta: { name: "default", desc: "Default", timezone: "America/New_York" },
    },
    {
      siteId: "cloud-contoso",
      hostId: "host-udm-2",
      meta: { name: "default", desc: "Default", timezone: "America/New_York" },
    },
    // Two distinct consoles reporting the same hostname, each with its own site.
    {
      siteId: "cloud-dupe-a",
      hostId: "host-dupe-a",
      meta: { name: "default", desc: "Default", timezone: "UTC" },
    },
    {
      siteId: "cloud-dupe-b",
      hostId: "host-dupe-b",
      meta: { name: "default", desc: "Default", timezone: "UTC" },
    },
  ],
};

/**
 * Cloud Connector -> local Network API `v1/sites` for the UOS console.
 * `name` is human, `internalReference` is the slug. Order deliberately differs
 * from SITES_RESPONSE: nothing guarantees the two feeds agree on ordering, which
 * is exactly why positional indexing was wrong.
 */
export const UOS_LOCAL_SITES_RESPONSE = {
  data: [
    { id: "local-default", name: "Default", internalReference: "default" },
    {
      id: "local-tailspin-e",
      name: "Tailspin Tire - East",
      internalReference: "slug0004",
    },
    {
      id: "local-fabrikam",
      name: "Fabrikam Charter School",
      internalReference: "slug0001",
    },
    {
      id: "local-tailspin-n",
      name: "Tailspin Tire - North",
      internalReference: "slug0002",
    },
    {
      id: "local-tailspin-s",
      name: "Tailspin Tire - South",
      internalReference: "slug0003",
    },
  ],
  totalCount: 5,
  offset: 0,
  limit: 200,
};

export const NORTHWIND_LOCAL_SITES_RESPONSE = {
  data: [
    { id: "local-northwind", name: "Default", internalReference: "default" },
  ],
  totalCount: 1,
  offset: 0,
  limit: 200,
};

/**
 * A one-site payload used to prove that a build already in flight when the
 * cache is cleared cannot write its result afterwards.
 *
 * Wingtip Toys is another of Microsoft's standard fictional companies, added
 * here rather than invented inline because `tests/no-customer-data.test.ts`
 * requires every example name to come from this file --- which is the whole
 * point: inventing a name is the moment to notice it might be a real one.
 */
export const STALE_SITES_RESPONSE = {
  data: [
    {
      siteId: "stale-site",
      hostId: UOS_HOST_ID,
      meta: { name: "stale", desc: "Wingtip Toys" },
    },
  ],
};
