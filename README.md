# UniFi MCP Server

> **The MSP-style UniFi MCP — built around the official Site Manager API + Cloud Connector with cross-site analytics no other UniFi MCP exposes.**
>
> 54 tools split across 7 semantic-analysis aggregations, 9 raw Site Manager, and 35 Cloud Connector — plus 2 optional **local controller** tools that surface per-port error counters and SFP DDM the Cloud API doesn't expose. Severity verdicts (`healthy`/`info`/`warning`/`critical`) on top of curated thresholds. 8 MCP Prompts (4 fleet-wide ops + 4 MSP workflows). Read-only — Ubiquiti's API keys don't ship write yet.

[![npm](https://img.shields.io/npm/v/@us-all/unifi-mcp)](https://www.npmjs.com/package/@us-all/unifi-mcp)
[![downloads](https://img.shields.io/npm/dm/@us-all/unifi-mcp)](https://www.npmjs.com/package/@us-all/unifi-mcp)
[![tools](https://img.shields.io/badge/tools-54%2B2-blue)](#tools)
[![@us-all standard](https://img.shields.io/badge/built%20to-%40us--all%20MCP%20standard-blue)](https://github.com/us-all/mcp-toolkit/blob/main/STANDARD.md)
[![Glama MCP server](https://glama.ai/mcp/servers/us-all/unifi-mcp-server/badges/score.svg)](https://glama.ai/mcp/servers/us-all/unifi-mcp-server)

## About this fork

This is a fork of [`us-all/unifi-mcp-server`](https://github.com/us-all/unifi-mcp-server). It changes one thing: **how a name is resolved to a site.**

Upstream matches a console's hostname exactly, then takes the first site on that
console. That works on a fleet of single-site consoles. It does not work on a
UniFi OS Server, where every customer is a separate *site* on one *shared*
console: no customer name can equal the console's hostname, and every lookup
that does resolve returns the console's first site --- usually the empty
`Default` placeholder. The failure is silent; you get another site's data, not
an error.

The fork builds a fleet-wide index instead, joining Site Manager's `meta.name`
to the local Network API's `internalReference`, and searches customer names as
well as console names. Two consequences worth knowing about:

- **Ambiguity is refused, not guessed.** A name matching several sites returns
  the candidate list. Similar names usually mean one customer with several
  locations, which is the worst moment to guess --- and this resolver will front
  the write path when Ubiquiti ships write scopes.
- **Site questions and console questions are answered differently.** Device
  inventory is per *console*, so many sites on one console is not ambiguity
  there. Statistics are per *site*, and are omitted rather than borrowed from a
  neighbouring tenant when a name picks out the console.

Upstream's tools, prompts and transports are otherwise unchanged. Fixtures in
`tests/` are synthetic by policy and enforced by `tests/no-customer-data.test.ts`.

## Pre-flight diagnostic

```bash
npx -y @us-all/unifi-mcp --doctor
```

Validates env vars, pings Site Manager API, probes Cloud Connector (if owner key set), and checks category toggles before starting. Exits non-zero on critical issues so it works in CI / pre-deploy scripts.

## What it does that others don't

- **Site Manager analytics** — `site-health-timeline`, `summarize-site`, `firmware-inventory`, `compare-sites`, `wan-uptime-trend`, `top-clients-by-bandwidth`, `list-sites-overview`. No other UniFi MCP exposes these.
- **Severity verdicts**, not just numbers — every analysis tool returns `healthy / info / warning / critical / unknown` with a curated reason. Curated thresholds (e.g. WAN uptime <90% = `critical`, startupTime <1h = `critical` post-reboot).
- **Cloud Connector first-class** — 35 tools through the official `/v1/connector/consoles/{id}/...` proxy. `connectorAvailable` (capability) vs `connectorResolved` (this-call) split.
- **Aggregation tools** — fold 3–7 sequential calls into 1 with `caveats` array surfacing partial failures (e.g. Site Manager API can't window-bound WAN uptime — that's surfaced explicitly).
- **MCP Prompts** (8) — fleet ops: `triage-site-degradation`, `firmware-rollout-audit`, `wan-uptime-report`, `cross-site-anomaly-detection`. MSP workflows: `msp-onboard-site-checklist`, `msp-monthly-client-report`, `msp-fleet-firmware-plan`, `msp-bandwidth-complaint-investigation`.
- **Token-efficient by design** — smallest schema footprint of all `@us-all/*` MCPs (default ~5K tokens with owner key). Fleet of 200+ devices analyzable inside a single session.
- **Apps SDK card** — `summarize-site` renders as a fleet-status card on ChatGPT clients (online %, WAN uptime, gateway, devices) via `_meta["openai/outputTemplate"]`. Claude clients receive the same JSON content.
- **stdio + Streamable HTTP** — defaults to stdio. Set `MCP_TRANSPORT=http` for ChatGPT Apps SDK or remote clients (Bearer auth via `MCP_HTTP_TOKEN`).
- **Local controller direct access** (v1.13.0) — opt-in `UNIFI_LOCAL_*` env enables 2 tools that bypass the Cloud Connector and hit the controller's legacy `/api/s/{site}/stat/device/{mac}` directly on the LAN: `get-port-errors` (port-level rx/tx errors, link-flap counters, **SFP DDM** — Rx/Tx Power dBm, temperature, voltage, TX/RX fault) and `list-port-flap-summary` (fleet-wide port instability ranking). Surfaces data the Integration API doesn't expose. Requires LAN reachability.

## Try this — 5 prompts

Connect the server to Claude Desktop or Claude Code, then paste any of these:

1. **MSP morning check** — *"Fleet health check across all my UniFi sites. Flag anything not `healthy` with severity, top 3 issues."*
2. **Firmware rollout audit** — *"Find devices on outdated firmware across every site. Group by site, show current vs latest version, prioritize by criticality."*
3. **Site degradation triage** — *"USM site has WiFi complaints. Pull the last 24h: device statuses, WAN uptime, recent reboots, top-bandwidth clients. Anything anomalous?"*
4. **WAN SLA report** — *"Generate a monthly WAN uptime report for all sites. Surface outages > 5 minutes, dual-WAN failover events, sites below 99.5% target."*
5. **Cross-site anomaly** — *"Compare USS to my other sites — clients per AP, traffic patterns, device firmware mix. Flag outliers and suggest the most likely cause."*
6. **Port flap triage** *(requires `UNIFI_LOCAL_*`)* — *"Rank every port across all switches by instability score. For the top 3 worst offenders, pull SFP DDM if present and tell me whether the signal itself is bad or it's something downstream."*

## When to use this vs other UniFi MCPs

| | sirkirby/unifi-mcp | enuno/unifi-mcp-server | `@us-all/unifi-mcp` (this) |
|--|---|---|---|
| GitHub stars | 291 | 117 | — |
| Tool count | 224 | 74 | **54** |
| Scope | Network + Protect + Access + Drive | Network + multi-site + QoS + backup | Site Manager + Cloud Connector + analytics |
| Site Manager API | ❌ | partial | ✅ deep + analytics |
| Cloud Connector | ❌ | partial (3 modes) | ✅ avail/resolved split |
| UniFi Protect (cameras) | ✅ | ❌ | ❌ (out of scope) |
| UniFi Access (doors) | ✅ | ❌ | ❌ (out of scope) |
| Aggregation tools | ❌ | ❌ | ✅ 7 |
| Severity verdicts | ❌ | ❌ | ✅ curated thresholds |
| MCP Prompts | ❌ | ❌ | ✅ 8 (incl. 4 MSP workflows) |

Use **sirkirby** when you need cameras (Protect) or door access. Use **enuno** if you want raw Network API breadth. Use **this server** for MSP-style multi-site analytics, fleet triage, and any "is something off?" question across many consoles.

## Install

### Claude Desktop

```json
{
  "mcpServers": {
    "unifi": {
      "command": "npx",
      "args": ["-y", "@us-all/unifi-mcp"],
      "env": {
        "UNIFI_API_KEY": "<your-key>",
        "UNIFI_API_KEY_OWNER": "<owner-key-or-same-key-if-role=owner>"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add unifi -s user \
  -e UNIFI_API_KEY=<your-key> \
  -e UNIFI_API_KEY_OWNER=<owner-key> \
  -- npx -y @us-all/unifi-mcp
```

### Build from source

```bash
git clone https://github.com/us-all/unifi-mcp-server.git
cd unifi-mcp-server && pnpm install && pnpm build
node dist/index.js
```

## API keys — which one and where

The most common onboarding friction. UniFi has **two surfaces** through the same `https://api.ui.com/v1`:

| Surface | What it gives | Path | Env var |
|---|---|---|---|
| **Site Manager** | hosts, sites, devices summary, ISP metrics, SD-WAN configs (aggregated, console-wide) | `/v1/hosts`, `/v1/sites`, `/v1/devices`, `/v1/sd-wan-configs` | `UNIFI_API_KEY` |
| **Cloud Connector** | per-device, per-client, networks, firewall, WiFi (proxies to local controller) | `/v1/connector/consoles/{hostId}/...` | `UNIFI_API_KEY_OWNER` |

API key permissions inherit from the role of the account that created them.

| Account role | Site Manager | Cloud Connector |
|---|---|---|
| Admin (non-owner) | ✅ | ❌ 403 |
| **Owner** | ✅ | ✅ |

**If you have the owner role, set both env vars to the same key.** That's the most common case for `@us-all` operators.

Get the key: [unifi.ui.com](https://unifi.ui.com) → Settings → API → Generate. **View Only** is the only option in GA today (Full Access greyed out — Early Access program needed for write).

### Cloud Connector requirements

- Console firmware ≥ 5.0.3
- API path: `https://api.ui.com/v1/connector/consoles/{hostId}/{appPath}`
- Local `siteId` is a UUID, not the literal string `default`
- Available endpoints: Network integration API (`/network/integration/v1/sites`, devices, clients, networks). Legacy paths (`/api/s/{site}/stat/event`) return 404. Event logs / syslog not exposed.

### Local controller (optional, v1.13.0+)

Adds 2 tools that fill the gap left by Cloud Connector — per-port error counters, flap counters, and SFP DDM. These live in `/api/s/{site}/stat/device/{mac}` (legacy) and the official Network Integration API does not expose them (verified against OpenAPI spec v10.4.57).

Requirements:
- LAN/VPN reachability from the host running this MCP to the controller (typically `https://<controller-ip>`)
- A controller **local account** (Viewer / Limited Admin role is sufficient — Owner credentials NOT required)
- Self-signed cert handling: set `UNIFI_LOCAL_INSECURE=true` for stock UDM Pro

Auth flow: `POST /api/auth/login` (cookie) → all subsequent calls re-use the session, 401 triggers automatic re-login. Read-only.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `UNIFI_API_KEY` | ✅ | — | API key from unifi.ui.com (any admin role) |
| `UNIFI_API_KEY_OWNER` | ❌ | — | Owner-role API key — enables 35 Cloud Connector tools. If your key has owner role, set this to the same value. |
| `UNIFI_API_URL` | ❌ | `https://api.ui.com/v1` | API base URL |
| `UNIFI_TOOLS` | ❌ | — | Comma-sep allowlist of categories. |
| `UNIFI_DISABLE` | ❌ | — | Comma-sep denylist. Ignored when `UNIFI_TOOLS` is set. |
| `MCP_TRANSPORT` | ❌ | `stdio` | `http` to enable Streamable HTTP transport |
| `MCP_HTTP_TOKEN` | conditional | — | Bearer token. Required when `MCP_TRANSPORT=http` |
| `MCP_HTTP_PORT` | ❌ | `3000` | HTTP listen port |
| `MCP_HTTP_HOST` | ❌ | `127.0.0.1` | HTTP bind host (DNS rebinding protection auto-enabled for localhost) |
| `MCP_HTTP_SKIP_AUTH` | ❌ | `false` | Skip Bearer auth — e.g. behind a reverse proxy that handles it |
| `UNIFI_LOCAL_URL` | ❌ | — | Local controller URL (e.g. `https://10.10.1.1`). Setting this + USER/PASS enables 2 `local` category tools. |
| `UNIFI_LOCAL_USER` | conditional | — | Controller local account username (required when `UNIFI_LOCAL_URL` set). Viewer/Limited-Admin role is sufficient. |
| `UNIFI_LOCAL_PASS` | conditional | — | Controller local account password (required when `UNIFI_LOCAL_URL` set). |
| `UNIFI_LOCAL_SITE` | ❌ | `default` | Site slug for legacy `/api/s/{site}/*`. |
| `UNIFI_LOCAL_INSECURE` | ❌ | `false` | Accept self-signed cert (typical for UDM Pro). |

**Categories** (9): `analysis`, `raw`, `devices`, `clients`, `networks`, `firewall`, `wan`, `reference`, `local`.

When `MCP_TRANSPORT=http`: `POST /mcp` (Bearer-auth JSON-RPC) + `GET /health` (public liveness).

### Token efficiency

Smallest schema footprint of all `@us-all/*` MCPs.

| Scenario | Tools | Schema tokens |
|----------|------:|--------------:|
| default no-owner | 17 | 1,700 |
| `UNIFI_TOOLS=analysis` | 8 | **1,000** (−42%) |
| default with owner key | 52 | ~5,000 |
| `UNIFI_TOOLS=analysis` + owner | 8 | **1,000** (−80%) |

## Severity & thresholds

Every analysis tool returns one of:
- `healthy` — no issues
- `info` — informational, no action
- `warning` — needs attention
- `critical` — immediate action
- `unknown` — API failure or incomplete data

Curated thresholds:

| Condition | Severity |
|---|---|
| Device offline | `critical` |
| `startupTime < 1h` | `critical` (just rebooted) |
| `startupTime < 24h` | `warning` (recent reboot) |
| `startupTime < 72h` | `info` (monitor) |
| WAN uptime < 90% | `critical` |
| WAN uptime < 95% | `warning` |

## MCP Prompts (8)

Workflow templates available via MCP `prompts/list`. Four are fleet-ops; four are MSP-specific (managed-service-provider workflows).

**Fleet ops:**
- `triage-site-degradation` — site complaints workflow: device + WAN + reboots + clients in sequence.
- `firmware-rollout-audit` — fleet-wide firmware diff and rollout safety check.
- `wan-uptime-report` — monthly WAN SLA-style report across sites.
- `cross-site-anomaly-detection` — compare a site to fleet baseline; flag outliers.

**MSP workflows:**
- `msp-onboard-site-checklist` — pass/fail readiness checklist for a newly added customer site (firmware floor, console connectivity, uptime trend, connector availability, firewall sanity, recent reboots, pending devices).
- `msp-monthly-client-report` — customer-facing monthly health report (one site → headline, network availability, devices, top users, recommendations) with non-technical phrasing.
- `msp-fleet-firmware-plan` — staggered N-wave rollout plan to a target firmware version, ordered by risk-tolerance with maintenance windows + rollback triggers.
- `msp-bandwidth-complaint-investigation` — triage 'internet is slow at site X' via WAN trend + ISP metrics + top clients + DPI categories + recent reboots.

## MCP Resources

- `unifi://site/{hostName}/devices` — site's devices snapshot
- `unifi://reboots/recent` — recently rebooted devices fleet-wide

## Tools (54 + 2 optional local)

9 categories. Use `search-tools` to discover at runtime; full list collapsed below. Cloud Connector tools (33) only register when `UNIFI_API_KEY_OWNER` is set; without it the surface is 19 tools. Local controller tools (2) only register when `UNIFI_LOCAL_URL/USER/PASS` are set.

| Group | Tools |
|-------|------:|
| Semantic analysis (incl. aggregations) | 9 |
| Site Manager raw | 9 |
| Cloud Connector (devices/clients/networks/wifi/firewall/wan/reference) | 33 |
| Sites local (`list-local-sites`, `get-app-info`) | 2 |
| **Local controller** (`get-port-errors`, `list-port-flap-summary`) | 2 |
| Meta (`search-tools`) | 1 |

<details>
<summary>Full tool list</summary>

### Semantic analysis (9)
`list-sites-overview`, `analyze-site-health`, `detect-recent-reboots`, `compare-sites`, `firmware-inventory`, `wan-uptime-trend`, `top-clients-by-bandwidth`, `summarize-site` *(aggregation)*, `site-health-timeline` *(aggregation)*

### Site Manager API (9)
`list-hosts`, `get-host`, `list-sites`, `list-devices`, `get-isp-metrics` (optional), `query-isp-metrics` (optional), `list-sdwan-configs`, `get-sdwan-config`, `get-sdwan-config-status`

### Cloud Connector — devices (4)
`get-device-details`, `get-device-by-id`, `get-device-statistics`, `list-pending-devices`

### Cloud Connector — clients (2)
`list-site-clients`, `get-client-details`

### Cloud Connector — networks (3)
`list-networks`, `get-network-details`, `get-network-references`

### Cloud Connector — WiFi (2)
`list-wifi-broadcasts`, `get-wifi-broadcast-details`

### Cloud Connector — firewall / ACL / DNS (10)
`list-firewall-zones`, `get-firewall-zone`, `list-firewall-policies`, `get-firewall-policy`, `get-firewall-policy-ordering`, `list-acl-rules`, `get-acl-rule`, `get-acl-rule-ordering`, `list-dns-policies`, `get-dns-policy`

### Cloud Connector — traffic / WAN / VPN (5)
`list-traffic-matching-lists`, `get-traffic-matching-list`, `list-wans`, `list-vpn-tunnels`, `list-vpn-servers`

### Cloud Connector — hotspot / reference (7)
`list-vouchers`, `get-voucher-details`, `list-radius-profiles`, `list-device-tags`, `list-dpi-categories`, `list-dpi-applications`, `list-countries`

### Sites local (2)
`list-local-sites`, `get-app-info`

### Local controller (2, opt-in via `UNIFI_LOCAL_*`)
- `get-port-errors` — per-port `rx_errors` / `tx_errors` / `rx_dropped` / `tx_dropped` + link state, plus persistent flap counters (`linkDownCount`, `stpChangeCount`, `anomalies`) and **SFP DDM** when a transceiver is present (`rxPowerDbm`, `txPowerDbm`, `temperatureC`, `voltageV`, `txBiasMa`, `rxFault`, `txFault`, vendor/part/serial). `onlyProblems` filter for triage.
- `list-port-flap-summary` — iterates all switches in the controller, ranks ports fleet-wide by score `linkDownCount*2 + stpChangeCount + rx_errors + tx_errors`. Surfaces the unstable cables / transceivers / NIC-power-save endpoints anywhere in the site at once. Counters are persistent across queries (reset only on switch reboot).

### Meta
`search-tools` — query other tools by keyword; always enabled.

</details>

## Architecture

```
Claude → MCP stdio → src/index.ts
                      ├── tools/analysis.ts     → Site Manager API (UNIFI_API_KEY)
                      ├── tools/*.ts (raw)       → Site Manager API (UNIFI_API_KEY)
                      ├── tools/connector.ts     → Cloud Connector  (UNIFI_API_KEY_OWNER)
                      └── tools/local-ports.ts   → Local Controller (UNIFI_LOCAL_URL + LAN)
                      helpers/resolver.ts        → hostName ↔ ID mapping
```

Built on [`@us-all/mcp-toolkit`](https://github.com/us-all/mcp-toolkit):
- `extractFields` — token-efficient response projections
- `aggregate(fetchers, caveats)` — fan-out helper for `summarize-site` / `site-health-timeline`
- `createWrapToolHandler` — `X-API-KEY` redaction + `ConnectorError`/`UniFiError` extraction
- Retry: 3 attempts, exponential backoff (1s → 2s → 4s) + jitter, 30s Cloud Connector timeout

## Limitations

- **Read-only** — UniFi API keys don't support write yet (Full Access role greyed out in GA).
- **Rate limit** — 10,000 req/min on stable v1; 100 req/min on Early Access.
- **Cloud Connector partial proxy** — Network integration API works; legacy paths return 404; event logs/syslog not exposed.
- **ISP Metrics** — may return 404 depending on account/plan.

## Tech stack

Node.js 22+ • TypeScript strict ESM • pnpm • `@modelcontextprotocol/sdk` • zod v4 • dotenv.

## License

[MIT](./LICENSE)
