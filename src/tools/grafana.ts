import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GrafanaConfig } from "../config.js";
import { apiRequest } from "../lib/http.js";
import { guard, jsonResult } from "../lib/result.js";
import { resolveTimeWindow } from "../lib/time.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export function registerGrafanaTools(server: McpServer, cfg: GrafanaConfig, timeoutMs: number): number {
  const headers: Record<string, string> = { authorization: `Bearer ${cfg.token}` };
  // Only meaningful on multi-org instances; harmless elsewhere.
  if (cfg.orgId !== undefined && Number.isFinite(cfg.orgId)) {
    headers["x-grafana-org-id"] = String(cfg.orgId);
  }

  const call = <T>(
    path: string,
    init: { method?: "GET" | "POST"; query?: Record<string, any>; body?: unknown } = {},
  ): Promise<T> =>
    apiRequest<T>({ service: "Grafana", baseUrl: cfg.baseUrl, path, timeoutMs, headers, ...init });

  server.registerTool(
    "grafana_health",
    {
      title: "Grafana: connectivity check",
      description: "Reads Grafana's health endpoint and the configured org. Use this to verify base URL and token.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guard(async () => {
      const health = await call("/api/health");
      const org = await call("/api/org").catch((e: Error) => ({ error: e.message }));
      return jsonResult({ baseUrl: cfg.baseUrl, health, org });
    }),
  );

  server.registerTool(
    "grafana_list_datasources",
    {
      title: "Grafana: list data sources",
      description:
        "Lists configured data sources with their uid, type and name. You need a data source uid before running any query.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guard(async () => {
      const all = await call<Array<Record<string, unknown>>>("/api/datasources");
      // The full payload carries connection settings and secure-field flags; keep what is useful for querying.
      const summary = Array.isArray(all)
        ? all.map((ds) => ({
            uid: ds["uid"],
            name: ds["name"],
            type: ds["type"],
            isDefault: ds["isDefault"],
            url: ds["url"],
          }))
        : all;
      return jsonResult(summary);
    }),
  );

  server.registerTool(
    "grafana_search_dashboards",
    {
      title: "Grafana: search dashboards",
      description: "Searches dashboards and folders by title or tag. Returns uids you can pass to grafana_get_dashboard.",
      inputSchema: {
        query: z.string().optional().describe("Text to match in the dashboard title."),
        tag: z.array(z.string()).optional().describe("Only dashboards carrying all of these tags."),
        type: z.enum(["dash-db", "dash-folder"]).optional().describe("Restrict to dashboards or folders."),
        folderUIDs: z.array(z.string()).optional().describe("Restrict to these folder uids."),
        limit: z.number().int().positive().max(500).optional().describe("Maximum results (default 50)."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const data = await call("/api/search", {
        query: {
          query: args.query,
          tag: args.tag,
          type: args.type ?? "dash-db",
          folderUIDs: args.folderUIDs,
          limit: args.limit ?? 50,
        },
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "grafana_get_dashboard",
    {
      title: "Grafana: dashboard definition",
      description:
        "Returns a dashboard's full JSON model by uid. With panelsOnly, returns just the panel titles, types and queries - far smaller, and usually what you want in order to reuse a panel's query.",
      inputSchema: {
        uid: z.string().describe("Dashboard uid, from grafana_search_dashboards."),
        panelsOnly: z
          .boolean()
          .optional()
          .describe("Return a condensed list of panels and their targets instead of the whole model."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const data = await call<{ dashboard?: Record<string, any>; meta?: unknown }>(
        `/api/dashboards/uid/${encodeURIComponent(args.uid)}`,
      );
      if (!args.panelsOnly) return jsonResult(data);

      const dashboard = data.dashboard ?? {};
      const panels = Array.isArray(dashboard["panels"]) ? dashboard["panels"] : [];
      return jsonResult({
        uid: dashboard["uid"],
        title: dashboard["title"],
        tags: dashboard["tags"],
        templating: dashboard["templating"],
        panels: panels.map((panel: Record<string, any>) => ({
          id: panel["id"],
          title: panel["title"],
          type: panel["type"],
          datasource: panel["datasource"],
          targets: panel["targets"],
        })),
      });
    }),
  );

  server.registerTool(
    "grafana_list_folders",
    {
      title: "Grafana: list folders",
      description: "Lists dashboard folders with their uids.",
      inputSchema: { limit: z.number().int().positive().max(500).optional() },
      annotations: READ_ONLY,
    },
    guard(async (args) => jsonResult(await call("/api/folders", { query: { limit: args.limit ?? 100 } }))),
  );

  server.registerTool(
    "grafana_query_prometheus",
    {
      title: "Grafana: run a PromQL query",
      description:
        "Runs PromQL against a Prometheus-compatible data source through Grafana's proxy, so it uses Grafana's stored credentials. An instant query returns one value per series; a range query returns a time series.",
      inputSchema: {
        datasourceUid: z.string().describe("Prometheus data source uid, from grafana_list_datasources."),
        expr: z.string().describe('The PromQL expression, e.g. sum(rate(http_requests_total[5m])) by (status)'),
        instant: z
          .boolean()
          .optional()
          .describe("true (default) evaluates once at the end of the window; false returns a range."),
        windowSizeMinutes: z.number().positive().optional().describe("Look-back window in minutes (default 60)."),
        fromIso: z.string().optional().describe("Explicit window start, ISO-8601."),
        toIso: z.string().optional().describe("Window end, ISO-8601. Defaults to now."),
        stepSeconds: z.number().int().positive().optional().describe("Range-query resolution in seconds (default 60)."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const window = resolveTimeWindow(args);
      const proxy = `/api/datasources/proxy/uid/${encodeURIComponent(args.datasourceUid)}`;
      const instant = args.instant !== false;

      const data = instant
        ? await call(`${proxy}/api/v1/query`, {
            query: { query: args.expr, time: Math.floor(window.to / 1000) },
          })
        : await call(`${proxy}/api/v1/query_range`, {
            query: {
              query: args.expr,
              start: Math.floor(window.from / 1000),
              end: Math.floor(window.to / 1000),
              step: args.stepSeconds ?? 60,
            },
          });

      return jsonResult(
        data,
        `${instant ? "Instant" : "Range"} query at ${new Date(window.to).toISOString()}` +
          (instant ? "." : ` over ${new Date(window.from).toISOString()} - ${new Date(window.to).toISOString()}.`),
      );
    }),
  );

  server.registerTool(
    "grafana_query",
    {
      title: "Grafana: run a data source query",
      description:
        "Generic query against any data source via /api/ds/query. Use this for Loki, Elasticsearch, SQL and other non-Prometheus sources. Each query object needs a refId and a datasource uid; the remaining fields are data-source specific - copy them from a dashboard panel's target via grafana_get_dashboard with panelsOnly.",
      inputSchema: {
        queries: z
          .array(z.record(z.string(), z.any()))
          .min(1)
          .describe('Query objects, e.g. [{"refId":"A","datasource":{"uid":"abc","type":"loki"},"expr":"{app=\\"api\\"}"}]'),
        from: z.string().optional().describe('Window start: "now-1h" or epoch ms as a string. Default "now-1h".'),
        to: z.string().optional().describe('Window end: "now" or epoch ms as a string. Default "now".'),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const data = await call("/api/ds/query", {
        method: "POST",
        body: {
          from: args.from ?? "now-1h",
          to: args.to ?? "now",
          queries: args.queries.map((query, index) => ({
            refId: query["refId"] ?? String.fromCharCode(65 + index),
            intervalMs: query["intervalMs"] ?? 60_000,
            maxDataPoints: query["maxDataPoints"] ?? 100,
            ...query,
          })),
        },
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "grafana_list_alert_rules",
    {
      title: "Grafana: list alert rules",
      description: "Lists the provisioned Grafana-managed alert rules - their definitions, not their current state.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guard(async () => jsonResult(await call("/api/v1/provisioning/alert-rules"))),
  );

  server.registerTool(
    "grafana_list_firing_alerts",
    {
      title: "Grafana: currently firing alerts",
      description:
        "Lists alerts currently active in Grafana's built-in Alertmanager. This answers 'what is alerting right now'.",
      inputSchema: {
        active: z.boolean().optional().describe("Include active alerts (default true)."),
        silenced: z.boolean().optional().describe("Include silenced alerts (default false)."),
        inhibited: z.boolean().optional().describe("Include inhibited alerts (default false)."),
        filter: z
          .array(z.string())
          .optional()
          .describe('Label matchers, e.g. ["severity=critical", "namespace=payments"].'),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const data = await call("/api/alertmanager/grafana/api/v2/alerts", {
        query: {
          active: args.active ?? true,
          silenced: args.silenced ?? false,
          inhibited: args.inhibited ?? false,
          filter: args.filter,
        },
      });
      return jsonResult(data);
    }),
  );

  return 9;
}
