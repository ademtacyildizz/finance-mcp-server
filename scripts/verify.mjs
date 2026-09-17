#!/usr/bin/env node
/**
 * Self-check for the built server. Run `npm run verify` after any change.
 *
 * Covers the failure modes that are silent in normal use:
 *   1. anything written to stdout that is not JSON-RPC (breaks the transport)
 *   2. finance_status reporting a tool count that disagrees with tools/list
 *   3. write tools leaking in while *_ALLOW_WRITE is false
 *   4. the kubectl argument guards letting a flag through
 *
 * Credentials here are deliberately fake: nothing in this script makes a
 * network call that needs a real token.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const serverPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const FAKE_ENV_ALL = {
  INSTANA_BASE_URL: "https://verify.instana.io",
  INSTANA_API_TOKEN: "verify",
  GITLAB_BASE_URL: "https://gitlab.example.com",
  GITLAB_TOKEN: "verify",
  GRAFANA_BASE_URL: "https://grafana.example.com",
  GRAFANA_TOKEN: "verify",
  JIRA_BASE_URL: "https://verify.atlassian.net",
  JIRA_EMAIL: "verify@example.com",
  JIRA_API_TOKEN: "verify",
  K8S_ENABLED: "true",
};

function connect(extraEnv) {
  const child = spawn("node", [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...FAKE_ENV_ALL, ...extraEnv },
  });

  let buffer = "";
  const pending = new Map();
  let nextId = 1;
  const stdoutViolations = [];

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.id && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      } catch {
        stdoutViolations.push(line);
      }
    }
  });
  child.stderr.resume();

  const send = (method, params) =>
    new Promise((resolveResponse) => {
      const id = nextId++;
      pending.set(id, resolveResponse);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  return {
    send,
    stdoutViolations,
    close: () => child.kill(),
    async handshake() {
      const init = await send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "verify", version: "1.0.0" },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
      return init;
    },
  };
}

const failures = [];
function expect(condition, message) {
  if (condition) {
    console.log(`  ok    ${message}`);
  } else {
    console.log(`  FAIL  ${message}`);
    failures.push(message);
  }
}

async function main() {
  console.log("\nfinance-mcp-server verify\n");

  // --- writes disabled ------------------------------------------------------
  console.log("read-only mode");
  {
    const client = connect({ GITLAB_ALLOW_WRITE: "false", JIRA_ALLOW_WRITE: "false", K8S_ALLOW_WRITE: "false" });
    await client.handshake();

    const list = await client.send("tools/list", {});
    const tools = list.result.tools;
    const status = JSON.parse((await client.send("tools/call", { name: "finance_status", arguments: {} })).result.content[0].text);

    const reported = status.active.reduce((sum, entry) => sum + entry.toolCount, 0) + 1;
    expect(reported === tools.length, `finance_status count (${reported}) matches tools/list (${tools.length})`);
    expect(status.active.length === 5, `all five integrations active (got ${status.active.length})`);

    const writeTools = tools.filter((tool) => tool.annotations?.readOnlyHint === false);
    expect(writeTools.length === 0, `no write tools exposed (found ${writeTools.map((t) => t.name).join(", ") || "none"})`);
    expect(client.stdoutViolations.length === 0, "stdout carried only JSON-RPC");
    client.close();
  }

  // --- writes enabled -------------------------------------------------------
  console.log("\nwrites enabled");
  {
    const client = connect({ GITLAB_ALLOW_WRITE: "true", JIRA_ALLOW_WRITE: "true", K8S_ALLOW_WRITE: "true" });
    await client.handshake();

    const list = await client.send("tools/list", {});
    const tools = list.result.tools;
    const status = JSON.parse((await client.send("tools/call", { name: "finance_status", arguments: {} })).result.content[0].text);

    const reported = status.active.reduce((sum, entry) => sum + entry.toolCount, 0) + 1;
    expect(reported === tools.length, `finance_status count (${reported}) matches tools/list (${tools.length})`);

    const writeNames = tools.filter((tool) => tool.annotations?.readOnlyHint === false).map((tool) => tool.name).sort();
    const expected = [
      "gitlab_cancel_pipeline",
      "gitlab_retry_pipeline",
      "jira_add_comment",
      "jira_create_issue",
      "jira_transition_issue",
      "k8s_delete_pod",
      "k8s_rollout_restart",
      "k8s_scale",
    ];
    expect(
      JSON.stringify(writeNames) === JSON.stringify(expected),
      `exactly the expected write tools appear (${writeNames.length})`,
    );

    const missingDescriptions = tools.filter((tool) => !tool.description || tool.description.length < 20);
    expect(missingDescriptions.length === 0, `every tool has a usable description (${missingDescriptions.map((t) => t.name).join(", ") || "all present"})`);
    client.close();
  }

  // --- kubectl argument guards ---------------------------------------------
  console.log("\nkubectl argument guards");
  {
    const client = connect({});
    await client.handshake();

    const attempts = [
      { name: "k8s_get", arguments: { resource: "pods", name: "--kubeconfig=/tmp/evil" }, label: "flag as resource name" },
      { name: "k8s_get", arguments: { resource: "pods", namespace: "../../etc" }, label: "path traversal as namespace" },
      { name: "k8s_logs", arguments: { pod: "api-0", since: "15m; rm -rf /" }, label: "shell metacharacters in duration" },
      { name: "k8s_get", arguments: { resource: "pods", selector: "-o=json" }, label: "flag as label selector" },
      { name: "k8s_describe", arguments: { resource: "pod", name: "-n kube-system" }, label: "flag smuggled into describe" },
      { name: "k8s_get", arguments: { resource: "pods", context: "--kubeconfig=/tmp/evil" }, label: "flag as context name" },
      { name: "k8s_logs", arguments: { pod: "api-0", context: "-v=9" }, label: "flag as context on logs" },
    ];

    for (const attempt of attempts) {
      const response = await client.send("tools/call", { name: attempt.name, arguments: attempt.arguments });
      const rejected = response.result?.isError === true && /Invalid/.test(response.result.content[0].text);
      expect(rejected, `rejected: ${attempt.label}`);
    }
    client.close();
  }

  // --- namespace allowlist --------------------------------------------------
  console.log("\nnamespace allowlist");
  {
    const client = connect({ K8S_NAMESPACES: "payments,ledger" });
    await client.handshake();

    const denied = await client.send("tools/call", { name: "k8s_get", arguments: { resource: "pods", namespace: "kube-system" } });
    expect(
      denied.result?.isError === true && /not in K8S_NAMESPACES/.test(denied.result.content[0].text),
      "namespace outside the allowlist is refused",
    );

    const clusterWide = await client.send("tools/call", { name: "k8s_get", arguments: { resource: "pods", allNamespaces: true } });
    expect(
      clusterWide.result?.isError === true && /Cluster-wide queries are disabled/.test(clusterWide.result.content[0].text),
      "allNamespaces is refused while an allowlist is set",
    );
    client.close();
  }

  console.log("");
  if (failures.length > 0) {
    console.log(`${failures.length} check(s) failed.\n`);
    process.exit(1);
  }
  console.log("All checks passed.\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
