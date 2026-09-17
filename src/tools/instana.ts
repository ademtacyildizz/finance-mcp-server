import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanaConfig } from "../config.js";
import { apiRequest } from "../lib/http.js";
import { guard, jsonResult } from "../lib/result.js";
import { resolveTimeWindow } from "../lib/time.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

/** Shared time-window arguments, spelled in ISO so the model never has to do epoch maths. */
const timeArgs = {
  windowSizeMinutes: z
    .number()
    .positive()
    .optional()
    .describe("Length of the look-back window in minutes, ending now. Defaults to 60. Ignored when fromIso is given."),
  fromIso: z.string().optional().describe("Start of an explicit window, ISO-8601 (e.g. 2026-09-17T08:00:00Z)."),
  toIso: z.string().optional().describe("End of the window, ISO-8601. Defaults to now."),
};

export function registerInstanaTools(server: McpServer, cfg: InstanaConfig, timeoutMs: number): number {
  const call = <T>(
    path: string,
    init: { method?: "GET" | "POST"; query?: Record<string, never> | Record<string, any>; body?: unknown } = {},
  ): Promise<T> =>
    apiRequest<T>({
      service: "Instana",
      baseUrl: cfg.baseUrl,
      path,
      timeoutMs,
      // Instana expects the literal scheme name "apiToken", not Bearer.
      headers: { authorization: `apiToken ${cfg.apiToken}` },
      ...init,
    });

  server.registerTool(
    "instana_health",
    {
      title: "Instana: connectivity check",
      description:
        "Verifies the Instana base URL and API token by reading the tenant's version and health endpoints. Use this first when Instana calls are failing.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guard(async () => {
      const [version, health] = await Promise.all([
        call("/api/instana/version").catch((e: Error) => ({ error: e.message })),
        call("/api/instana/health").catch((e: Error) => ({ error: e.message })),
      ]);
      return jsonResult({ baseUrl: cfg.baseUrl, version, health });
    }),
  );

  server.registerTool(
    "instana_list_events",
    {
      title: "Instana: list events, issues and incidents",
      description:
        "Lists Instana events in a time window. Filter by type to answer questions like 'what incidents fired in the last 2 hours'. INCIDENT is the most severe, then ISSUE, then CHANGE.",
      inputSchema: {
        ...timeArgs,
        eventTypeFilters: z
          .array(z.enum(["INCIDENT", "ISSUE", "CHANGE"]))
          .optional()
          .describe("Restrict to these event types. Omit for all types."),
        excludeTriggeredBefore: z
          .boolean()
          .optional()
          .describe("Exclude events that started before the window, so only newly triggered events are returned."),
        filterEventUpdates: z
          .boolean()
          .optional()
          .describe("Only return events whose state changed inside the window."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const window = resolveTimeWindow(args);
      const events = await call<unknown[]>("/api/events", {
        query: {
          to: window.to,
          windowSize: window.windowSize,
          eventTypeFilters: args.eventTypeFilters,
          excludeTriggeredBefore: args.excludeTriggeredBefore,
          filterEventUpdates: args.filterEventUpdates,
        },
      });
      const count = Array.isArray(events) ? events.length : 0;
      return jsonResult(
        events,
        `${count} event(s) between ${new Date(window.from).toISOString()} and ${new Date(window.to).toISOString()}.`,
      );
    }),
  );

  server.registerTool(
    "instana_list_applications",
    {
      title: "Instana: list monitored applications",
      description: "Lists application perspectives with their key metrics for the window. Use nameFilter to narrow by name.",
      inputSchema: {
        ...timeArgs,
        nameFilter: z.string().optional().describe("Substring match on the application name."),
        page: z.number().int().positive().optional().describe("1-based page number."),
        pageSize: z.number().int().positive().max(200).optional().describe("Results per page (default 20)."),
        applicationBoundaryScope: z
          .enum(["ALL", "INBOUND"])
          .optional()
          .describe("INBOUND counts only calls entering the application; ALL includes internal calls."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const window = resolveTimeWindow(args);
      const data = await call("/api/application-monitoring/applications", {
        query: {
          to: window.to,
          windowSize: window.windowSize,
          nameFilter: args.nameFilter,
          page: args.page,
          pageSize: args.pageSize ?? 20,
          applicationBoundaryScope: args.applicationBoundaryScope,
        },
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "instana_list_services",
    {
      title: "Instana: list monitored services",
      description: "Lists services observed in the window, with their metrics. Use nameFilter to find a specific service.",
      inputSchema: {
        ...timeArgs,
        nameFilter: z.string().optional().describe("Substring match on the service name."),
        page: z.number().int().positive().optional().describe("1-based page number."),
        pageSize: z.number().int().positive().max(200).optional().describe("Results per page (default 20)."),
        includeSnapshotIds: z.boolean().optional().describe("Include the underlying snapshot ids."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const window = resolveTimeWindow(args);
      const data = await call("/api/application-monitoring/services", {
        query: {
          to: window.to,
          windowSize: window.windowSize,
          nameFilter: args.nameFilter,
          page: args.page,
          pageSize: args.pageSize ?? 20,
          includeSnapshotIds: args.includeSnapshotIds,
        },
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "instana_search_snapshots",
    {
      title: "Instana: search infrastructure entities",
      description:
        "Searches infrastructure snapshots — hosts, JVMs, processes, containers and so on. A snapshot holds an entity's static attributes at a point in time. Use `plugin` for the entity type and `query` for a Dynamic Focus filter.",
      inputSchema: {
        ...timeArgs,
        query: z
          .string()
          .optional()
          .describe('Dynamic Focus query, e.g. entity.zone:prod* or entity.kubernetes.namespace:payments'),
        plugin: z.string().optional().describe("Entity type, e.g. host, jvmRuntimePlatform, docker, kubernetesPod."),
        size: z.number().int().positive().max(500).optional().describe("Maximum snapshots to return (default 50)."),
        offline: z
          .boolean()
          .optional()
          .describe("true returns entities that were online at any point in the window; false only those online at its end."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const window = resolveTimeWindow(args);
      const data = await call("/api/infrastructure-monitoring/snapshots", {
        query: {
          to: window.to,
          windowSize: window.windowSize,
          query: args.query,
          plugin: args.plugin,
          size: args.size ?? 50,
          offline: args.offline,
        },
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "instana_get_application_metrics",
    {
      title: "Instana: application metrics",
      description:
        "Fetches aggregated metrics for application perspectives — latency, calls, erroneous calls. Any field used in `orderBy` must also appear in `metrics`.",
      inputSchema: {
        ...timeArgs,
        metrics: z
          .array(
            z.object({
              metric: z.string().describe("Metric name, e.g. latency, calls, erroneousCalls."),
              aggregation: z
                .enum(["SUM", "MEAN", "MAX", "MIN", "P25", "P50", "P75", "P90", "P95", "P98", "P99", "DISTINCT_COUNT"])
                .describe("Aggregation applied over the window."),
              granularity: z.number().int().positive().optional().describe("Bucket size in seconds for a time series."),
            }),
          )
          .min(1)
          .describe("Metrics to retrieve."),
        applicationId: z.string().optional().describe("Restrict to one application perspective."),
        nameFilter: z.string().optional().describe("Substring match on the application name."),
        applicationBoundaryScope: z.enum(["ALL", "INBOUND"]).optional(),
        orderBy: z.string().optional().describe("Metric name to sort by; must also be present in `metrics`."),
        orderDirection: z.enum(["ASC", "DESC"]).optional().describe("Sort direction (default DESC)."),
        page: z.number().int().positive().optional(),
        pageSize: z.number().int().positive().max(200).optional().describe("Results per page (default 20)."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const window = resolveTimeWindow(args);
      const body: Record<string, unknown> = {
        metrics: args.metrics,
        timeFrame: { to: window.to, windowSize: window.windowSize },
        pagination: { page: args.page ?? 1, pageSize: args.pageSize ?? 20 },
      };
      if (args.applicationId) body["applicationId"] = args.applicationId;
      if (args.nameFilter) body["nameFilter"] = args.nameFilter;
      if (args.applicationBoundaryScope) body["applicationBoundaryScope"] = args.applicationBoundaryScope;
      if (args.orderBy) body["order"] = { by: args.orderBy, direction: args.orderDirection ?? "DESC" };

      const data = await call("/api/application-monitoring/metrics/applications", { method: "POST", body });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "instana_api_get",
    {
      title: "Instana: raw GET request (escape hatch)",
      description:
        "Performs an arbitrary GET against the Instana REST API for endpoints without a dedicated tool. Read-only. Full endpoint list: https://instana.github.io/openapi/",
      inputSchema: {
        path: z
          .string()
          .regex(/^\/api\//, "path must start with /api/")
          .describe("API path starting with /api/, e.g. /api/infrastructure-monitoring/catalog/plugins"),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Query string parameters."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const data = await call(args.path, { query: args.query ?? {} });
      return jsonResult(data);
    }),
  );

  return 7;
}
