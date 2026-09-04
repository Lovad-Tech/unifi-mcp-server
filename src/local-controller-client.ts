import { Agent, fetch as undiciFetch } from "undici";
import { config, isLocalAvailable } from "./config.js";
import { withRetry } from "./retry.js";

const LOCAL_TIMEOUT_MS = 30_000;

export class LocalControllerError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "LocalControllerError";
    this.status = status;
    this.body = body;
  }
}

export class LocalControllerUnavailableError extends Error {
  constructor() {
    super("Local controller not configured. Set UNIFI_LOCAL_URL/USER/PASS to enable.");
    this.name = "LocalControllerUnavailableError";
  }
}

// UDM Pro ships with a self-signed cert; opt-in via UNIFI_LOCAL_INSECURE.
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

class LocalControllerClient {
  private cookie: string | null = null;
  private csrf: string | null = null;
  private loginPromise: Promise<void> | null = null;

  private assertAvailable(): void {
    if (!isLocalAvailable()) throw new LocalControllerUnavailableError();
  }

  private dispatcher() {
    return config.local.insecure ? insecureAgent : undefined;
  }

  private async login(): Promise<void> {
    // Coalesce concurrent login attempts so a 401 storm only triggers one /auth/login.
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const url = `${config.local.url}/api/auth/login`;
      const res = await undiciFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ username: config.local.user, password: config.local.pass }),
        signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
        dispatcher: this.dispatcher(),
      });
      if (!res.ok) {
        let body: unknown;
        try { body = await res.json(); } catch { body = await res.text().catch(() => ""); }
        throw new LocalControllerError(`login failed: HTTP ${res.status}`, res.status, body);
      }
      // UniFi OS returns Set-Cookie: TOKEN=<jwt>; ... and X-Updated-CSRF-Token (or X-CSRF-Token).
      const rawSetCookie = res.headers.getSetCookie?.() ?? [];
      const tokenCookie = rawSetCookie.find((c) => c.startsWith("TOKEN="));
      if (!tokenCookie) {
        throw new LocalControllerError("login response missing TOKEN cookie", res.status, null);
      }
      // `split` always yields at least one element, but the compiler cannot
      // know that; the fallback keeps the whole cookie rather than `undefined`.
      this.cookie = tokenCookie.split(";", 1)[0] ?? tokenCookie;
      this.csrf =
        res.headers.get("x-updated-csrf-token") ??
        res.headers.get("x-csrf-token") ??
        null;
    })().finally(() => { this.loginPromise = null; });
    return this.loginPromise;
  }

  private async rawGet<T>(path: string): Promise<T> {
    const url = `${config.local.url}${path}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.csrf) headers["X-CSRF-Token"] = this.csrf;
    const res = await undiciFetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
      dispatcher: this.dispatcher(),
    });
    if (res.status === 401 || res.status === 403) {
      // Stale session — bubble up so caller can retry once after re-login.
      throw new LocalControllerError(`HTTP ${res.status} (auth)`, res.status, null);
    }
    if (!res.ok) {
      let body: unknown;
      try { body = await res.json(); } catch { body = await res.text().catch(() => ""); }
      throw new LocalControllerError(`HTTP ${res.status}: ${res.statusText}`, res.status, body);
    }
    return res.json() as Promise<T>;
  }

  async get<T = unknown>(path: string): Promise<T> {
    this.assertAvailable();
    return withRetry(async () => {
      if (!this.cookie) await this.login();
      try {
        return await this.rawGet<T>(path);
      } catch (err) {
        if (err instanceof LocalControllerError && (err.status === 401 || err.status === 403)) {
          this.cookie = null;
          this.csrf = null;
          await this.login();
          return await this.rawGet<T>(path);
        }
        throw err;
      }
    });
  }

  // For tests
  _reset(): void { this.cookie = null; this.csrf = null; }
}

export const localControllerClient = new LocalControllerClient();

/** Helper: build the legacy network API path with the configured site slug. */
export function netPath(suffix: string): string {
  const site = encodeURIComponent(config.local.site);
  const clean = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `/proxy/network/api/s/${site}${clean}`;
}
