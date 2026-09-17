#!/usr/bin/env node
/**
 * Connectivity check. Run `npm run doctor` after filling in .env to confirm each
 * credential works before wiring the server into Claude - a failure here is far
 * easier to read than an MCP tool error.
 *
 * This is a plain CLI, not the MCP server, so writing to stdout is fine.
 */
import { execFile } from "node:child_process";
import { loadConfig } from "./config.js";
import { apiRequest } from "./lib/http.js";

interface CheckResult {
  service: string;
  ok: boolean;
  detail: string;
}

async function check(service: string, probe: () => Promise<string>): Promise<CheckResult> {
  try {
    return { service, ok: true, detail: await probe() };
  } catch (error) {
    return { service, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const results: CheckResult[] = [];
  const inactive: string[] = [];

  if (config.instana) {
    const cfg = config.instana;
    results.push(
      await check("Instana", async () => {
        const version = await apiRequest<Record<string, unknown>>({
          service: "Instana",
          baseUrl: cfg.baseUrl,
          path: "/api/instana/version",
          timeoutMs: config.httpTimeoutMs,
          headers: { authorization: `apiToken ${cfg.apiToken}` },
        });
        return `${cfg.baseUrl} - version ${JSON.stringify(version)}`;
      }),
    );
  } else inactive.push("Instana");

  if (config.gitlab) {
    const cfg = config.gitlab;
    results.push(
      await check("GitLab", async () => {
        const user = await apiRequest<{ username?: string; name?: string }>({
          service: "GitLab",
          baseUrl: cfg.baseUrl,
          path: "/api/v4/user",
          timeoutMs: config.httpTimeoutMs,
          headers:
            cfg.tokenType === "oauth"
              ? { authorization: `Bearer ${cfg.token}` }
              : { "private-token": cfg.token },
        });
        return `${cfg.baseUrl} - authenticated as ${user.username ?? user.name ?? "unknown"} (writes: ${cfg.allowWrite})`;
      }),
    );
  } else inactive.push("GitLab");

  if (config.grafana) {
    const cfg = config.grafana;
    results.push(
      await check("Grafana", async () => {
        const health = await apiRequest<{ version?: string; database?: string }>({
          service: "Grafana",
          baseUrl: cfg.baseUrl,
          path: "/api/health",
          timeoutMs: config.httpTimeoutMs,
          headers: { authorization: `Bearer ${cfg.token}` },
        });
        const datasources = await apiRequest<unknown[]>({
          service: "Grafana",
          baseUrl: cfg.baseUrl,
          path: "/api/datasources",
          timeoutMs: config.httpTimeoutMs,
          headers: { authorization: `Bearer ${cfg.token}` },
        });
        const count = Array.isArray(datasources) ? datasources.length : 0;
        return `${cfg.baseUrl} - v${health.version ?? "?"}, database ${health.database ?? "?"}, ${count} data source(s)`;
      }),
    );
  } else inactive.push("Grafana");

  if (config.jira) {
    const cfg = config.jira;
    results.push(
      await check("Jira", async () => {
        const me = await apiRequest<{ displayName?: string; emailAddress?: string; name?: string }>({
          service: "Jira",
          baseUrl: cfg.baseUrl,
          path: `/rest/api/${cfg.apiVersion}/myself`,
          timeoutMs: config.httpTimeoutMs,
          headers: { authorization: cfg.authorization },
        });
        const who = me.displayName ?? me.name ?? me.emailAddress ?? "unknown";
        const flavour = cfg.usesAdf ? "Cloud" : "Server/DC";
        return `${cfg.baseUrl} - ${flavour} API v${cfg.apiVersion}, authenticated as ${who} (writes: ${cfg.allowWrite})`;
      }),
    );
  } else inactive.push("Jira");

  if (config.kubernetes) {
    const cfg = config.kubernetes;
    results.push(
      await check("Kubernetes", async () => {
        const env = { ...process.env };
        if (cfg.kubeconfig) env["KUBECONFIG"] = cfg.kubeconfig;
        const args = cfg.context ? ["--context", cfg.context, "version", "-o", "json"] : ["version", "-o", "json"];

        const stdout = await new Promise<string>((resolve, reject) => {
          execFile(cfg.kubectlPath, args, { env, timeout: cfg.timeoutMs, encoding: "utf8" }, (error, out, err) => {
            if (error) {
              const code = (error as NodeJS.ErrnoException).code;
              reject(
                new Error(
                  code === "ENOENT"
                    ? `kubectl not found at ${cfg.kubectlPath}. Set KUBECTL_PATH in .env.`
                    : (err || error.message).trim(),
                ),
              );
              return;
            }
            resolve(out);
          });
        });

        const parsed = JSON.parse(stdout) as {
          clientVersion?: { gitVersion?: string };
          serverVersion?: { gitVersion?: string };
        };
        const serverVersion = parsed.serverVersion?.gitVersion;
        if (!serverVersion) {
          throw new Error(
            `kubectl ${parsed.clientVersion?.gitVersion ?? ""} runs, but no cluster answered. ` +
              `Check that a context is configured and reachable (kubectl config get-contexts).`,
          );
        }
        return `client ${parsed.clientVersion?.gitVersion}, server ${serverVersion} (writes: ${cfg.allowWrite})`;
      }),
    );
  } else inactive.push("Kubernetes");

  console.log("\nfinance-mcp-server connectivity check\n");
  for (const result of results) {
    console.log(`${result.ok ? "  PASS" : "  FAIL"}  ${result.service.padEnd(12)} ${result.detail}`);
    console.log("");
  }
  if (inactive.length > 0) {
    console.log(`  SKIP  not configured in .env: ${inactive.join(", ")}\n`);
  }

  const failed = results.filter((result) => !result.ok);
  if (results.length === 0) {
    console.log("Nothing configured yet. Copy .env.example to .env and fill in the services you use.\n");
    process.exit(1);
  }
  if (failed.length > 0) {
    console.log(`${failed.length} of ${results.length} configured integration(s) failed.\n`);
    process.exit(1);
  }
  console.log(`All ${results.length} configured integration(s) reachable.\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
