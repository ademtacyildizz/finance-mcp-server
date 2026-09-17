#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { setMaxResultChars } from "./lib/result.js";
import { registerInstanaTools } from "./tools/instana.js";
import { registerGitlabTools } from "./tools/gitlab.js";
import { registerGrafanaTools } from "./tools/grafana.js";
import { registerJiraTools } from "./tools/jira.js";
import { registerKubernetesTools } from "./tools/kubernetes.js";

/**
 * On a stdio transport, stdout carries JSON-RPC frames and nothing else.
 * Every diagnostic goes to stderr, which the host surfaces as server logs.
 */
function log(message: string): void {
  process.stderr.write(`[finance-mcp-server] ${message}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  setMaxResultChars(config.maxResultChars);

  const server = new McpServer(
    { name: "finance-mcp-server", version: "0.1.0" },
    {
      instructions:
        "Read-only-by-default access to Instana (observability), GitLab (source and CI), Grafana " +
        "(dashboards, metrics, alerts), Jira (issue tracking) and Kubernetes (cluster state). " +
        "Only the integrations configured in .env are registered, so the tool list reflects what is " +
        "actually reachable. Call finance_status to see which are live and whether writes are enabled. " +
        "When investigating an incident, a good order is: Grafana or Instana for the symptom, " +
        "Kubernetes for the workload's state, GitLab for what changed, Jira to record the outcome.",
    },
  );

  const registered: Record<string, number> = {};
  const skipped: string[] = [];

  if (config.instana) {
    registered["instana"] = registerInstanaTools(server, config.instana, config.httpTimeoutMs);
  } else {
    skipped.push("instana (set INSTANA_BASE_URL and INSTANA_API_TOKEN)");
  }

  if (config.gitlab) {
    registered["gitlab"] = registerGitlabTools(server, config.gitlab, config.httpTimeoutMs);
  } else {
    skipped.push("gitlab (set GITLAB_BASE_URL and GITLAB_TOKEN)");
  }

  if (config.grafana) {
    registered["grafana"] = registerGrafanaTools(server, config.grafana, config.httpTimeoutMs);
  } else {
    skipped.push("grafana (set GRAFANA_BASE_URL and GRAFANA_TOKEN)");
  }

  if (config.jira) {
    registered["jira"] = registerJiraTools(server, config.jira, config.httpTimeoutMs);
  } else {
    skipped.push("jira (set JIRA_BASE_URL and JIRA_API_TOKEN)");
  }

  if (config.kubernetes) {
    registered["kubernetes"] = registerKubernetesTools(server, config.kubernetes);
  } else {
    skipped.push("kubernetes (set K8S_ENABLED=true)");
  }

  // A self-describing tool beats making the model guess why something is missing.
  server.registerTool(
    "finance_status",
    {
      title: "Which integrations are active",
      description:
        "Reports which of Instana, GitLab, Grafana, Jira and Kubernetes are configured, how many tools each " +
        "registered, and whether write operations are enabled. Call this when a tool you expected is absent.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              active: Object.entries(registered).map(([name, toolCount]) => ({ name, toolCount })),
              inactive: skipped,
              writesEnabled: {
                gitlab: config.gitlab?.allowWrite ?? false,
                jira: config.jira?.allowWrite ?? false,
                kubernetes: config.kubernetes?.allowWrite ?? false,
                instana: false,
                grafana: false,
              },
              endpoints: {
                instana: config.instana?.baseUrl ?? null,
                gitlab: config.gitlab?.baseUrl ?? null,
                grafana: config.grafana?.baseUrl ?? null,
                jira: config.jira ? `${config.jira.baseUrl} (API v${config.jira.apiVersion})` : null,
                kubernetes: config.kubernetes
                  ? config.kubernetes.context ?? "kubeconfig current-context"
                  : null,
              },
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  const total = Object.values(registered).reduce((sum, count) => sum + count, 0) + 1;
  log(`active: ${Object.keys(registered).join(", ") || "none"} - ${total} tools`);
  if (skipped.length > 0) log(`inactive: ${skipped.join("; ")}`);

  await server.connect(new StdioServerTransport());
  log("connected over stdio");
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
