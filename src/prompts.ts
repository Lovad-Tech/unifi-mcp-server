import { z } from "zod";
import { SITE_NAME_DESCRIPTION } from "./tools/site-param.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// MCP Prompts: pre-built workflow templates that clients can invoke. Each
// returns a user-facing instruction the LLM should follow, leveraging the
// already-registered UniFi tools.

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "triage-site-degradation",
    {
      title: "Triage site degradation",
      description: "Investigate a site's health, recent reboots, client impact, and WAN status to produce a triage summary.",
      argsSchema: {
        hostName: z.string().describe(SITE_NAME_DESCRIPTION),
        windowHours: z.string().optional().describe("Reboot detection window in hours (default: 24)"),
      },
    },
    ({ hostName, windowHours }) => {
      const win = windowHours ?? "24";
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: [
              `Triage degradation on UniFi site ${JSON.stringify(hostName)} (last ${win}h).`,
              "",
              "Steps:",
              `1. Call \`analyze-site-health\` with hostName=${JSON.stringify(hostName)} to capture device status, WAN info, and severity flags.`,
              `2. Call \`detect-recent-reboots\` with hostName=${JSON.stringify(hostName)} and windowHours=${win} to find devices that rebooted in the window.`,
              `3. If the connector is available, call \`list-site-clients\` with hostName=${JSON.stringify(hostName)} and capture the client count (use default limit).`,
              `4. If the connector is available, call \`list-wans\` with hostName=${JSON.stringify(hostName)} to confirm per-WAN status; otherwise rely on the WAN block from step 1.`,
              "5. Produce a triage summary including:",
              "   - Overall severity (healthy / info / warning / critical / unknown) — use the worst from steps 1-4.",
              "   - Candidate root cause (e.g. 'Recent gateway reboot', 'WAN uptime <95%', 'Multiple offline devices').",
              "   - Client impact (online client count + any offline devices that serve clients).",
              "   - Recommended next action (1-2 bullets).",
            ].join("\n"),
          },
        }],
      };
    },
  );

  server.registerPrompt(
    "firmware-rollout-audit",
    {
      title: "Firmware rollout audit",
      description: "Audit a firmware rollout: which hosts/devices are on the target version, which are lagging, and what to upgrade next.",
      argsSchema: {
        targetVersion: z.string().describe("Target firmware version to roll out (e.g. '7.5.83')"),
        hostNameFilter: z.string().optional().describe(`Optional site to scope the audit, or a comma-separated list. ${SITE_NAME_DESCRIPTION} Omit to scan every site.`),
      },
    },
    ({ targetVersion, hostNameFilter }) => {
      const filter = hostNameFilter && hostNameFilter.trim().length > 0
        ? `scoped to host(s) ${JSON.stringify(hostNameFilter)}`
        : "across all hosts";
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: [
              `Audit firmware rollout to version ${JSON.stringify(targetVersion)} ${filter}.`,
              "",
              "Steps:",
              `1. Call \`firmware-inventory\` (no args) to enumerate all devices grouped by firmware version + model.`,
              hostNameFilter && hostNameFilter.trim().length > 0
                ? `2. Filter the result to hosts in ${JSON.stringify(hostNameFilter)} (split on comma, trim).`
                : "2. Keep all hosts in scope.",
              `3. Group devices into two buckets: (a) on target = currentFirmware === ${JSON.stringify(targetVersion)}; (b) lagging = anything else. Track model + count for each bucket.`,
              "4. Flag stuck/lagging models — any model where >=50% of units are not on target, or any device on a firmware older than the next-most-common version.",
              "5. Produce a rollout health report:",
              `   - % devices on ${JSON.stringify(targetVersion)} (overall and per-model).`,
              "   - Top 3 lagging models with current firmware versions and counts.",
              "   - Suggested next batch (5-10 devices) to upgrade, prioritizing stuck models and oldest firmware.",
            ].join("\n"),
          },
        }],
      };
    },
  );

  server.registerPrompt(
    "wan-uptime-report",
    {
      title: "WAN uptime SLA report",
      description: "Compute a WAN uptime SLA-style report for a site over a window, with relative ranking against the fleet.",
      argsSchema: {
        hostName: z.string().describe(SITE_NAME_DESCRIPTION),
        days: z.string().optional().describe("Window length in days (default: 30)"),
      },
    },
    ({ hostName, days }) => {
      const window = days ?? "30";
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: [
              `Generate a WAN uptime SLA report for ${JSON.stringify(hostName)} over the last ${window} days.`,
              "",
              "Steps:",
              `1. Call \`wan-uptime-trend\` (no host filter) and capture per-WAN uptime % across the fleet for the last ${window} days. Pass days=${window} if the schema accepts it; otherwise use defaults and note the actual window in the report.`,
              `2. Filter the response to WANs belonging to host ${JSON.stringify(hostName)}; compute that site's average and minimum uptime %.`,
              `3. Call \`compare-sites\` to obtain side-by-side site rankings by WAN uptime; record the rank of ${JSON.stringify(hostName)} relative to peer sites.`,
              "4. Apply severity thresholds from the existing system:",
              "   - uptime < 80% → critical (SLA breach).",
              "   - uptime < 90% → critical.",
              "   - uptime < 95% → warning.",
              "   - >= 95% → healthy.",
              "5. Produce an SLA-style report with:",
              "   - Site uptime % (avg + min per WAN), severity, and rank vs peers.",
              "   - Worst WAN(s) called out with timestamps if available.",
              "   - Pass/fail vs a 95% SLA bar, and a 1-2 line recommendation.",
            ].join("\n"),
          },
        }],
      };
    },
  );

  server.registerPrompt(
    "cross-site-anomaly-detection",
    {
      title: "Cross-site anomaly detection",
      description: "Compute fleet medians across sites and flag sites that deviate >2σ from the median on key health metrics.",
      argsSchema: {
        sitesFilter: z.string().optional().describe(SITE_NAME_DESCRIPTION),
      },
    },
    ({ sitesFilter }) => {
      const filter = sitesFilter && sitesFilter.trim().length > 0 ? sitesFilter : "all";
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: [
              `Detect cross-site anomalies (filter=${JSON.stringify(filter)}).`,
              "",
              "Steps:",
              "1. Call `find-site` to look up sites by customer name. If sitesFilter !== 'all', restrict to host names in the comma-separated list.",
              "2. For each in-scope host, call `summarize-site` with hostName=<host> to collect device count, online %, WAN uptime, and (when connector is available) client count.",
              "3. Compute fleet medians and standard deviation (population σ) for: deviceCount, onlinePct, wanUptimePct, and clientDensity = clientCount / deviceCount (skip sites where clientCount is unavailable).",
              "4. Flag a site as an outlier if any metric is more than 2σ away from the median (in the worse direction — e.g. low onlinePct, low wanUptime, very high or very low clientDensity).",
              "5. Produce a ranked anomaly list:",
              "   - One row per flagged site: hostName, which metric(s) tripped, observed vs median, σ-distance.",
              "   - Sort by max σ-distance descending.",
              "   - One-line explanation per site (e.g. 'WAN uptime 87% vs fleet median 99%, 3.1σ low — likely ISP issue').",
              "   - If no outliers, state that the fleet is within 2σ on all metrics.",
            ].join("\n"),
          },
        }],
      };
    },
  );

  // --- MSP (Managed Service Provider) workflows ---

  server.registerPrompt(
    "msp-onboard-site-checklist",
    {
      title: "MSP — onboard-site readiness checklist",
      description: "Validate that a newly-added site has the firmware, config, and security baselines an MSP would require before going live.",
      argsSchema: {
        hostName: z.string().describe(SITE_NAME_DESCRIPTION),
      },
    },
    ({ hostName }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            `Run an MSP onboarding readiness check on site ${JSON.stringify(hostName)}. Produce a pass/fail checklist with one short remediation per failed item.`,
            "",
            "Checks:",
            `1. **Firmware floor** — call \`firmware-inventory\` (filter to ${JSON.stringify(hostName)}) and assert every device's firmware status is "uptodate" or that the upgradeable count is acceptable per MSP policy. Surface the per-device version table.`,
            `2. **Console connectivity** — call \`get-host\` with hostName=${JSON.stringify(hostName)} and confirm \`reportedState\` is online and \`isBlocked\` is false. Capture firmware version + lastSeen.`,
            `3. **Site uptime trend** — call \`wan-uptime-trend\` for the site over the last 7 days. Pass if minWanUptime >= 99.0%, warn if 95–99%, fail otherwise.`,
            `4. **Cloud connector availability** — call \`summarize-site\` with name=${JSON.stringify(hostName)}. Pass if connectorAvailable is true (owner key configured) AND connectorResolved is true for this host. Note that connector is required for the per-device, per-client and firewall checks below.`,
            `5. **Firewall sanity** — when connector is available, call \`list-firewall-policies\` and \`list-firewall-zones\` for the site. Surface the policy count and any "all-allow" patterns. Fail if a permit-any-any rule is detected at the WAN edge.`,
            `6. **Recent reboots** — call \`detect-recent-reboots\` filtered to the site. Fail if any device rebooted < 1h ago without a planned change window.`,
            `7. **Pending devices** — when connector is available, call \`list-pending-devices\`. Pass if zero; warn otherwise (untrusted devices waiting for adoption).`,
            "",
            "Output format: Markdown checklist with ✅/⚠️/❌ icons, one row per check, with 'observed' and 'remediation' columns. End with a one-line go/no-go verdict.",
          ].join("\n"),
        },
      }],
    }),
  );

  server.registerPrompt(
    "msp-monthly-client-report",
    {
      title: "MSP — monthly site health report",
      description: "Generate the monthly customer-facing health report for one site (uptime, devices, top consumers, anomalies, recommended actions).",
      argsSchema: {
        hostName: z.string().describe(SITE_NAME_DESCRIPTION),
        clientLabel: z.string().optional().describe("Customer-facing label to use in the report header (defaults to hostName)"),
      },
    },
    ({ hostName, clientLabel }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            `Compose the monthly health report for ${JSON.stringify(clientLabel ?? hostName)} (host=${JSON.stringify(hostName)}).`,
            "",
            "Steps:",
            `1. \`summarize-site\` with name=${JSON.stringify(hostName)}, includeClients=true, includeNetworks=true, includeWifi=true — single-call snapshot.`,
            `2. \`site-health-timeline\` for the same host over the last 30 days — extract any reboot incidents, uptime dips, or device flaps.`,
            `3. \`wan-uptime-trend\` (per-WAN) over 30 days — pull the per-WAN uptime % and any noteworthy outage windows.`,
            `4. \`top-clients-by-bandwidth\` for the site — top 5 by total bytes; note any single-client concentration (>25% of total).`,
            "",
            "Output: a customer-friendly Markdown report (no UniFi jargon where possible) with these sections:",
            "  • **Headline**: one sentence — overall status (Healthy / Degraded / Action required), uptime %, key incident count.",
            "  • **Network availability**: per-WAN uptime, outage table (date, duration, suspected cause).",
            "  • **Devices**: count, online %, any devices that flapped, any firmware behind.",
            "  • **Top users**: top 5 clients by usage with friendly names where available.",
            "  • **Recommendations**: 1–3 concrete next actions for the customer (firmware upgrade, device replacement, WiFi tuning, etc.).",
            "",
            "Style: avoid acronyms in the headline. The customer is non-technical.",
          ].join("\n"),
        },
      }],
    }),
  );

  server.registerPrompt(
    "msp-fleet-firmware-plan",
    {
      title: "MSP — staggered fleet firmware rollout plan",
      description: "Plan a multi-wave firmware upgrade across all sites, ordered by risk-tolerance, with concrete maintenance windows.",
      argsSchema: {
        targetVersion: z.string().describe("Target firmware version (e.g. '7.5.176'). Used to identify behind-target devices."),
        wavesCount: z.string().optional().describe("Number of rollout waves (default '3': pilot/canary/general)."),
      },
    },
    ({ targetVersion, wavesCount }) => {
      const waves = wavesCount && wavesCount.trim().length > 0 ? wavesCount : "3";
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: [
              `Plan a ${waves}-wave fleet firmware rollout to version ${JSON.stringify(targetVersion)}.`,
              "",
              "Steps:",
              "1. `firmware-inventory` (no host filter) — capture every site's per-device firmware. Identify devices already at target (skip), behind-target (in scope), and ahead-of-target (warn — manual review).",
              "2. `list-sites-overview` — pull each site's device count and a coarse criticality signal (more devices = higher impact). Combine with `summarize-site` for sites with 50+ devices to get WAN uptime as a proxy for environment stability.",
              `3. Bucket sites into ${waves} waves by risk tolerance (lowest-risk first):`,
              "   - **Wave 1 (pilot)**: 1–2 internal/non-customer sites. Fastest feedback, lowest blast radius.",
              "   - **Wave 2 (canary)**: 10% of customer sites by device count, weighted toward sites with redundancy / dual-WAN / lower criticality.",
              `   - **Wave 3+ (general)**: remaining sites split evenly across the remaining waves. Critical / single-WAN sites land in the last wave.`,
              "4. For each wave, propose:",
              "   - Maintenance window (suggested time-of-day in the customer's timezone — assume off-hours if unclear).",
              "   - Pre-flight: which checks to run (e.g. `wan-uptime-trend` baseline 24h prior).",
              "   - Rollback trigger: if Wave N completion shows >X% device-offline rate, halt subsequent waves and surface the failing site list.",
              "5. Output: Markdown plan with one section per wave (sites, devices, window, success criteria) + a final 'Risks & Caveats' section.",
              "Do NOT trigger any actual upgrades. Read-only planning only.",
            ].join("\n"),
          },
        }],
      };
    },
  );

  server.registerPrompt(
    "msp-bandwidth-complaint-investigation",
    {
      title: "MSP — investigate 'internet is slow' complaint at a site",
      description: "Triage a customer bandwidth complaint by correlating WAN uptime, top consumers, and (when connector is available) DPI category breakdowns.",
      argsSchema: {
        hostName: z.string().describe(SITE_NAME_DESCRIPTION),
        windowHours: z.string().optional().describe("Recent window to focus on (default '24'). Useful when the customer can pin down a time."),
      },
    },
    ({ hostName, windowHours }) => {
      const w = windowHours && windowHours.trim().length > 0 ? windowHours : "24";
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: [
              `Triage 'internet is slow' at ${JSON.stringify(hostName)} over the last ${w}h.`,
              "",
              "Steps:",
              `1. \`wan-uptime-trend\` for the site over ${w}h. Pass if all WANs >= 99% for the window. Otherwise capture the dip windows (timestamps + duration).`,
              `2. \`get-isp-metrics\` for the site if available (latency, jitter, loss). Note whether ISP-side numbers correlate with the complaint window.`,
              `3. \`summarize-site\` with name=${JSON.stringify(hostName)}, includeClients=true. Note the connector status — without owner key the next steps are limited.`,
              `4. \`top-clients-by-bandwidth\` for the site. Identify any single client consuming >25% of total. If so, flag it for follow-up (likely the cause). Compare against a historical baseline if you can derive one from prior runs.`,
              `5. When connector is available: \`list-dpi-categories\` and \`list-dpi-applications\` for the site to break down traffic by application class. Surface the top 3 categories — common culprits are streaming, backups, file sync.`,
              `6. \`detect-recent-reboots\` filtered to the site — a recent reboot can transiently degrade throughput as devices renegotiate.`,
              "7. Produce a triage summary:",
              "   - **Suspected cause**: ISP / single-client hog / DPI category spike / device flap / unknown",
              "   - **Evidence**: the specific metric numbers that support it",
              "   - **Suggested next action**: one concrete step (e.g. 'rate-limit client X', 'open ISP ticket with packet-loss screenshot', 'schedule reboot of device Y')",
              "Read-only investigation. Do not change configuration.",
            ].join("\n"),
          },
        }],
      };
    },
  );
}
