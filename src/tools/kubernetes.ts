import { execFile } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KubernetesConfig } from "../config.js";
import { guard, jsonResult, textResult } from "../lib/result.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/**
 * Arguments reach kubectl through execFile, so there is no shell and therefore
 * no command injection. The remaining risk is *flag* injection: a value such as
 * "--kubeconfig=/tmp/evil" arriving as a resource name would be read by kubectl
 * as an option. Everything interpolated into argv is validated first.
 */
const DNS_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const RESOURCE_KIND = /^[a-zA-Z][a-zA-Z0-9.-]*$/;
const SELECTOR = /^[a-zA-Z0-9_.\-/=!(),\s]+$/;
/** Context names are freer than DNS names (EKS uses ARNs), but must not look like a flag. */
const CONTEXT_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

/**
 * stderr lines that appear on every single invocation and carry no information
 * about the call itself. Left in, they would be appended to every result.
 */
const IGNORABLE_STDERR = [
  /version difference between client .* exceeds the supported minor version skew/i,
];

/**
 * Resource types that live outside namespaces. kubectl tolerates a stray
 * `-n` on these, but passing it makes commands and error messages misleading.
 */
const CLUSTER_SCOPED = new Set([
  "no",
  "node",
  "nodes",
  "ns",
  "namespace",
  "namespaces",
  "pv",
  "persistentvolume",
  "persistentvolumes",
  "sc",
  "storageclass",
  "storageclasses",
  "crd",
  "customresourcedefinition",
  "customresourcedefinitions",
  "clusterrole",
  "clusterroles",
  "clusterrolebinding",
  "clusterrolebindings",
]);

function meaningfulStderr(stderr: string): string {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !IGNORABLE_STDERR.some((pattern) => pattern.test(line)))
    .join("\n");
}

function assertName(label: string, value: string): string {
  if (!DNS_NAME.test(value) || value.length > 253) {
    throw new Error(
      `Invalid ${label}: ${JSON.stringify(value)}. Expected a Kubernetes name (lowercase letters, digits, '-' and '.').`,
    );
  }
  return value;
}

function assertKind(value: string): string {
  if (!RESOURCE_KIND.test(value) || value.length > 120) {
    throw new Error(`Invalid resource type: ${JSON.stringify(value)}.`);
  }
  return value;
}

function assertSelector(value: string): string {
  if (!SELECTOR.test(value) || value.startsWith("-")) {
    throw new Error(`Invalid label selector: ${JSON.stringify(value)}.`);
  }
  return value;
}

function assertContext(value: string): string {
  if (!CONTEXT_NAME.test(value) || value.length > 253) {
    throw new Error(`Invalid context: ${JSON.stringify(value)}. Run k8s_contexts to see the available names.`);
  }
  return value;
}

/** kubectl accepts durations like 15m, 2h, 30s. */
function assertDuration(value: string): string {
  if (!/^\d+[smhd]$/.test(value)) {
    throw new Error(`Invalid duration: ${JSON.stringify(value)}. Use a form like 30s, 15m or 2h.`);
  }
  return value;
}

export function registerKubernetesTools(server: McpServer, cfg: KubernetesConfig): number {
  function resolveNamespace(namespace?: string): string {
    const target = namespace ?? cfg.defaultNamespace;
    assertName("namespace", target);
    if (cfg.namespaceAllowList.length > 0 && !cfg.namespaceAllowList.includes(target)) {
      throw new Error(
        `Namespace ${JSON.stringify(target)} is not in K8S_NAMESPACES. Permitted: ${cfg.namespaceAllowList.join(", ")}.`,
      );
    }
    return target;
  }

  function assertClusterWideAllowed(): void {
    if (cfg.namespaceAllowList.length > 0) {
      throw new Error(
        `Cluster-wide queries are disabled because K8S_NAMESPACES restricts access to: ${cfg.namespaceAllowList.join(", ")}.`,
      );
    }
  }

  /**
   * `contextOverride` lets a single call target a different cluster than the
   * configured default, which matters when KUBECONFIG merges several clusters.
   */
  function runKubectl(args: string[], contextOverride?: string): Promise<string> {
    const context = contextOverride ? assertContext(contextOverride) : cfg.context;
    const fullArgs = context ? ["--context", context, ...args] : args;
    const env = { ...process.env };
    if (cfg.kubeconfig) env["KUBECONFIG"] = cfg.kubeconfig;

    return new Promise((resolve, reject) => {
      execFile(
        cfg.kubectlPath,
        fullArgs,
        { env, timeout: cfg.timeoutMs, maxBuffer: 24 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (!error) {
            const notable = meaningfulStderr(stderr);
            if (!notable) {
              resolve(stdout);
              return;
            }
            // kubectl writes "No resources found in <ns> namespace." to stderr with
            // an empty stdout. That is an ordinary answer, not a side note.
            resolve(stdout.trim() ? `${stdout}\n[kubectl stderr] ${notable}` : notable);
            return;
          }
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            reject(
              new Error(
                `kubectl not found at ${JSON.stringify(cfg.kubectlPath)}. Install it, or set KUBECTL_PATH to its absolute path in .env.`,
              ),
            );
            return;
          }
          const detail = (meaningfulStderr(stderr) || stdout || error.message).trim();
          reject(new Error(`kubectl ${fullArgs.join(" ")} failed:\n${detail}`));
        },
      );
    });
  }

  /**
   * Adds -n <ns> or --all-namespaces, honouring the allowlist. `resource` lets
   * cluster-scoped types skip the namespace flag entirely.
   */
  function scopeArgs(
    namespace: string | undefined,
    allNamespaces: boolean | undefined,
    resource?: string,
  ): string[] {
    if (resource && CLUSTER_SCOPED.has(resource.toLowerCase())) return [];
    if (allNamespaces) {
      assertClusterWideAllowed();
      return ["--all-namespaces"];
    }
    return ["-n", resolveNamespace(namespace)];
  }

  const namespaceArg = z
    .string()
    .optional()
    .describe(`Namespace. Defaults to ${cfg.defaultNamespace}.`);

  /** Spread into every tool so any call can pick a cluster. */
  const contextArg = {
    context: z
      .string()
      .optional()
      .describe(
        `Cluster context to target. Defaults to ${cfg.context ?? "the kubeconfig current-context"}. ` +
          `Run k8s_contexts to list them.`,
      ),
  };

  server.registerTool(
    "k8s_contexts",
    {
      title: "Kubernetes: list contexts",
      description:
        "Lists every context the kubeconfig provides and marks the default this server uses. Call this first when you need to know which clusters are reachable, or before passing `context` to another tool.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guard(async () => {
      const contexts = await runKubectl(["config", "get-contexts"]);
      return textResult(
        `default context: ${cfg.context ?? "(kubeconfig current-context)"}\n` +
          `kubeconfig: ${cfg.kubeconfig ?? "(default ~/.kube/config)"}\n` +
          `default namespace: ${cfg.defaultNamespace}\n` +
          `writes enabled: ${cfg.allowWrite}\n` +
          `namespace allowlist: ${cfg.namespaceAllowList.length > 0 ? cfg.namespaceAllowList.join(", ") : "(all)"}\n\n` +
          contexts,
      );
    }),
  );

  server.registerTool(
    "k8s_api_resources",
    {
      title: "Kubernetes: list resource types",
      description:
        "Lists the resource types the cluster serves, including CRDs, with their short names. Use this when you are unsure what to pass as `resource`.",
      inputSchema: {
        ...contextArg,
        namespaced: z.boolean().optional().describe("Restrict to namespaced (true) or cluster-scoped (false) types."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const argv = ["api-resources"];
      if (args.namespaced !== undefined) argv.push(`--namespaced=${args.namespaced}`);
      return textResult(await runKubectl(argv, args.context));
    }),
  );

  server.registerTool(
    "k8s_get",
    {
      title: "Kubernetes: get resources",
      description:
        "Lists or fetches resources of any type. Defaults to kubectl's table output, which is compact and usually enough; switch to json only when you need specific fields, because full objects are large.",
      inputSchema: {
        ...contextArg,
        resource: z.string().describe("Resource type, e.g. pods, deployments, svc, ingress, nodes, deployments.apps."),
        name: z.string().optional().describe("A single resource name. Omit to list all matching."),
        namespace: namespaceArg,
        allNamespaces: z.boolean().optional().describe("Query every namespace instead of one."),
        selector: z.string().optional().describe("Label selector, e.g. app=payments,tier!=canary."),
        fieldSelector: z.string().optional().describe("Field selector, e.g. status.phase=Running."),
        output: z
          .enum(["table", "wide", "json", "yaml", "name"])
          .optional()
          .describe("Output format. Default table; 'wide' adds node and IP columns."),
        sortBy: z.string().optional().describe("JSONPath to sort on, e.g. .metadata.creationTimestamp."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const argv = ["get", assertKind(args.resource)];
      if (args.name) argv.push(assertName("resource name", args.name));
      argv.push(...scopeArgs(args.namespace, args.allNamespaces, args.resource));
      if (args.selector) argv.push("-l", assertSelector(args.selector));
      if (args.fieldSelector) argv.push("--field-selector", assertSelector(args.fieldSelector));
      if (args.sortBy) argv.push(`--sort-by=${assertSelector(args.sortBy)}`);

      const output = args.output ?? "table";
      if (output === "wide") argv.push("-o", "wide");
      else if (output !== "table") argv.push("-o", output);

      const result = await runKubectl(argv, args.context);
      return output === "json" ? jsonResult(result) : textResult(result);
    }),
  );

  server.registerTool(
    "k8s_describe",
    {
      title: "Kubernetes: describe a resource",
      description:
        "Runs kubectl describe, which includes the resource's recent events. This is the first thing to read when a pod will not start.",
      inputSchema: {
        ...contextArg,
        resource: z.string().describe("Resource type, e.g. pod, deployment, node."),
        name: z.string().describe("Resource name."),
        namespace: namespaceArg,
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const argv = ["describe", assertKind(args.resource), assertName("resource name", args.name)];
      if (!CLUSTER_SCOPED.has(args.resource.toLowerCase())) {
        argv.push("-n", resolveNamespace(args.namespace));
      }
      return textResult(await runKubectl(argv, args.context));
    }),
  );

  server.registerTool(
    "k8s_logs",
    {
      title: "Kubernetes: pod logs",
      description:
        "Reads container logs. Use previous:true to see why a crash-looping container died on its last run - that is where the real error usually is.",
      inputSchema: {
        ...contextArg,
        pod: z
          .string()
          .describe("Pod name. A deployment/<name> or job/<name> selector is not accepted here; use k8s_logs_by_selector instead."),
        namespace: namespaceArg,
        container: z.string().optional().describe("Container name, required for multi-container pods."),
        tailLines: z.number().int().positive().max(5000).optional().describe("Lines from the end (default 200)."),
        since: z.string().optional().describe("Only logs newer than this, e.g. 15m or 2h."),
        previous: z.boolean().optional().describe("Read the previous, terminated container instance."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const argv = ["logs", assertName("pod name", args.pod), "-n", resolveNamespace(args.namespace)];
      if (args.container) argv.push("-c", assertName("container name", args.container));
      argv.push(`--tail=${args.tailLines ?? 200}`);
      if (args.since) argv.push(`--since=${assertDuration(args.since)}`);
      if (args.previous) argv.push("--previous");
      return textResult(await runKubectl(argv, args.context));
    }),
  );

  server.registerTool(
    "k8s_logs_by_selector",
    {
      title: "Kubernetes: logs across pods matching a label",
      description:
        "Reads logs from every pod matching a label selector at once - the practical way to read a deployment's logs without listing its pods first.",
      inputSchema: {
        ...contextArg,
        selector: z.string().describe("Label selector, e.g. app=payments."),
        namespace: namespaceArg,
        container: z.string().optional(),
        tailLines: z.number().int().positive().max(2000).optional().describe("Lines per pod (default 100)."),
        since: z.string().optional().describe("Only logs newer than this, e.g. 15m."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const argv = [
        "logs",
        "-l",
        assertSelector(args.selector),
        "-n",
        resolveNamespace(args.namespace),
        "--prefix=true",
        `--tail=${args.tailLines ?? 100}`,
      ];
      if (args.container) argv.push("-c", assertName("container name", args.container));
      if (args.since) argv.push(`--since=${assertDuration(args.since)}`);
      return textResult(await runKubectl(argv, args.context));
    }),
  );

  server.registerTool(
    "k8s_events",
    {
      title: "Kubernetes: recent events",
      description:
        "Lists events newest-last. Warning-type events explain scheduling failures, image pull errors and probe failures.",
      inputSchema: {
        ...contextArg,
        namespace: namespaceArg,
        allNamespaces: z.boolean().optional(),
        warningsOnly: z.boolean().optional().describe("Only Warning-type events."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const argv = ["get", "events", ...scopeArgs(args.namespace, args.allNamespaces), "--sort-by=.lastTimestamp"];
      if (args.warningsOnly) argv.push("--field-selector", "type=Warning");
      return textResult(await runKubectl(argv, args.context));
    }),
  );

  server.registerTool(
    "k8s_top",
    {
      title: "Kubernetes: CPU and memory usage",
      description:
        "Shows live resource usage for pods or nodes. Requires metrics-server to be installed in the cluster.",
      inputSchema: {
        ...contextArg,
        kind: z.enum(["pods", "nodes"]).describe("What to measure."),
        namespace: namespaceArg,
        allNamespaces: z.boolean().optional().describe("Pods only."),
        selector: z.string().optional().describe("Label selector (pods only)."),
        containers: z.boolean().optional().describe("Break pod usage down per container."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const argv = ["top", args.kind];
      if (args.kind === "pods") {
        argv.push(...scopeArgs(args.namespace, args.allNamespaces));
        if (args.selector) argv.push("-l", assertSelector(args.selector));
        if (args.containers) argv.push("--containers");
      }
      return textResult(await runKubectl(argv, args.context));
    }),
  );

  server.registerTool(
    "k8s_rollout_status",
    {
      title: "Kubernetes: rollout status",
      description: "Reports how far a deployment, statefulset or daemonset rollout has progressed. Does not wait.",
      inputSchema: {
        ...contextArg,
        resource: z.enum(["deployment", "statefulset", "daemonset"]),
        name: z.string(),
        namespace: namespaceArg,
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const argv = [
        "rollout",
        "status",
        `${args.resource}/${assertName("resource name", args.name)}`,
        "-n",
        resolveNamespace(args.namespace),
        "--watch=false",
      ];
      return textResult(await runKubectl(argv, args.context));
    }),
  );

  if (!cfg.allowWrite) return 9;

  server.registerTool(
    "k8s_rollout_restart",
    {
      title: "Kubernetes: restart a workload",
      description:
        "Triggers a rolling restart by patching the pod template annotation. Requires K8S_ALLOW_WRITE=true.",
      inputSchema: {
        ...contextArg,
        resource: z.enum(["deployment", "statefulset", "daemonset"]),
        name: z.string(),
        namespace: namespaceArg,
      },
      annotations: WRITE,
    },
    guard(async (args) => {
      const argv = [
        "rollout",
        "restart",
        `${args.resource}/${assertName("resource name", args.name)}`,
        "-n",
        resolveNamespace(args.namespace),
      ];
      return textResult(await runKubectl(argv, args.context));
    }),
  );

  server.registerTool(
    "k8s_scale",
    {
      title: "Kubernetes: scale a workload",
      description: "Sets the replica count on a deployment, statefulset or replicaset. Requires K8S_ALLOW_WRITE=true.",
      inputSchema: {
        ...contextArg,
        resource: z.enum(["deployment", "statefulset", "replicaset"]),
        name: z.string(),
        replicas: z.number().int().nonnegative().max(1000).describe("Desired replica count."),
        namespace: namespaceArg,
      },
      annotations: WRITE,
    },
    guard(async (args) => {
      const argv = [
        "scale",
        `${args.resource}/${assertName("resource name", args.name)}`,
        `--replicas=${args.replicas}`,
        "-n",
        resolveNamespace(args.namespace),
      ];
      return textResult(await runKubectl(argv, args.context));
    }),
  );

  server.registerTool(
    "k8s_delete_pod",
    {
      title: "Kubernetes: delete a pod",
      description:
        "Deletes a single pod so its controller recreates it. Deleting a bare pod with no controller destroys it permanently. Requires K8S_ALLOW_WRITE=true.",
      inputSchema: {
        ...contextArg,
        name: z.string().describe("Pod name."),
        namespace: namespaceArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    guard(async (args) => {
      const argv = ["delete", "pod", assertName("pod name", args.name), "-n", resolveNamespace(args.namespace)];
      return textResult(await runKubectl(argv, args.context));
    }),
  );

  return 12;
}
