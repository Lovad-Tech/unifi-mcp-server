import { createWrapToolHandler } from "@us-all/mcp-toolkit";
import { UniFiError } from "../client.js";
import { SiteResolutionError } from "../helpers/site-index.js";
import { ConnectorError, ConnectorUnavailableError } from "../connector-client.js";
import { LocalControllerError, LocalControllerUnavailableError } from "../local-controller-client.js";

export const wrapToolHandler = createWrapToolHandler({
  redactionPatterns: [/X-API-KEY/i, /Cookie/i, /TOKEN=[A-Za-z0-9._-]+/i, /X-CSRF-Token/i],
  errorExtractors: [
    {
      // Registered so the status survives WITHOUT each tool remembering to
      // catch. The fallback branch keeps only `message`, and the status is the
      // one thing a caller needs: 300 "say which one", 404 "no such site",
      // 502 "the console did not answer".
      match: (error) => error instanceof SiteResolutionError,
      extract: (error) => {
        const e = error as SiteResolutionError;
        return {
          kind: "structured",
          data: { message: e.message, status: e.status },
        };
      },
    },
    {
      match: (error) => error instanceof ConnectorUnavailableError,
      extract: (error) => ({
        kind: "passthrough",
        text: (error as ConnectorUnavailableError).message,
      }),
    },
    {
      match: (error) => error instanceof LocalControllerUnavailableError,
      extract: (error) => ({
        kind: "passthrough",
        text: (error as LocalControllerUnavailableError).message,
      }),
    },
    {
      match: (error) => error instanceof ConnectorError,
      extract: (error) => {
        const e = error as ConnectorError;
        return {
          kind: "structured",
          data: { message: e.message, status: e.status, details: e.body },
        };
      },
    },
    {
      match: (error) => error instanceof LocalControllerError,
      extract: (error) => {
        const e = error as LocalControllerError;
        return {
          kind: "structured",
          data: { message: e.message, status: e.status, details: e.body },
        };
      },
    },
    {
      match: (error) => error instanceof UniFiError,
      extract: (error) => {
        const e = error as UniFiError;
        return {
          kind: "structured",
          data: { message: e.message, status: e.status, details: e.body },
        };
      },
    },
  ],
});
