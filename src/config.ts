import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Claude Desktop launches MCP servers with an arbitrary working directory, so
 * the .env file is resolved against this package's own root rather than cwd.
 *
 * `quiet` matters: on a stdio transport, anything written to stdout that is not
 * a JSON-RPC frame corrupts the protocol. dotenv would otherwise print a tip.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotenv({ path: resolve(packageRoot, ".env"), quiet: true });

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function str(key: string): string | undefined {
  const raw = process.env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function bool(key: string, fallback: boolean): boolean {
  const value = str(key);
  return value === undefined ? fallback : TRUTHY.has(value.toLowerCase());
}

function int(key: string, fallback: number): number {
  const value = str(key);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function csv(key: string): string[] {
  const value = str(key);
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

/** Normalises a host into an origin with no trailing slash, defaulting to https. */
function baseUrl(key: string): string | undefined {
  const value = str(key);
  if (!value) return undefined;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withScheme.replace(/\/+$/, "");
}

export interface InstanaConfig {
  baseUrl: string;
  apiToken: string;
}

export interface GitlabConfig {
  baseUrl: string;
  token: string;
  tokenType: "pat" | "oauth";
  allowWrite: boolean;
}

export interface GrafanaConfig {
  baseUrl: string;
  token: string;
  orgId?: number;
}

export interface JiraConfig {
  baseUrl: string;
  apiVersion: "2" | "3";
  /** Pre-built Authorization header value; the raw token never leaves here. */
  authorization: string;
  /** Cloud uses Atlassian Document Format for rich text; Server/DC uses plain strings. */
  usesAdf: boolean;
  allowWrite: boolean;
}

export interface KubernetesConfig {
  kubectlPath: string;
  kubeconfig?: string;
  context?: string;
  defaultNamespace: string;
  /** Empty means every namespace is permitted. */
  namespaceAllowList: string[];
  allowWrite: boolean;
  timeoutMs: number;
}

export interface AppConfig {
  httpTimeoutMs: number;
  maxResultChars: number;
  instana: InstanaConfig | null;
  gitlab: GitlabConfig | null;
  grafana: GrafanaConfig | null;
  jira: JiraConfig | null;
  kubernetes: KubernetesConfig | null;
}

function buildJira(): JiraConfig | null {
  const url = baseUrl("JIRA_BASE_URL");
  const token = str("JIRA_API_TOKEN");
  if (!url || !token) return null;

  const email = str("JIRA_EMAIL");
  // Cloud authenticates with Basic email:apiToken; Server/DC uses a bearer PAT.
  const authorization = email
    ? `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`
    : `Bearer ${token}`;

  const override = str("JIRA_API_VERSION");
  const isCloud = /\.atlassian\.net$/i.test(new URL(url).hostname);
  const apiVersion: "2" | "3" = override === "2" || override === "3" ? override : isCloud ? "3" : "2";

  return {
    baseUrl: url,
    apiVersion,
    authorization,
    usesAdf: apiVersion === "3",
    allowWrite: bool("JIRA_ALLOW_WRITE", false),
  };
}

function buildKubernetes(): KubernetesConfig | null {
  if (!bool("K8S_ENABLED", true)) return null;
  return {
    kubectlPath: str("KUBECTL_PATH") ?? "kubectl",
    kubeconfig: str("KUBECONFIG"),
    context: str("K8S_CONTEXT"),
    defaultNamespace: str("K8S_DEFAULT_NAMESPACE") ?? "default",
    namespaceAllowList: csv("K8S_NAMESPACES"),
    allowWrite: bool("K8S_ALLOW_WRITE", false),
    timeoutMs: int("K8S_TIMEOUT_MS", 30_000),
  };
}

export function loadConfig(): AppConfig {
  const instanaUrl = baseUrl("INSTANA_BASE_URL");
  const instanaToken = str("INSTANA_API_TOKEN");

  const gitlabUrl = baseUrl("GITLAB_BASE_URL");
  const gitlabToken = str("GITLAB_TOKEN");

  const grafanaUrl = baseUrl("GRAFANA_BASE_URL");
  const grafanaToken = str("GRAFANA_TOKEN");
  const grafanaOrg = str("GRAFANA_ORG_ID");

  return {
    httpTimeoutMs: int("HTTP_TIMEOUT_MS", 30_000),
    maxResultChars: int("MAX_RESULT_CHARS", 60_000),

    instana: instanaUrl && instanaToken ? { baseUrl: instanaUrl, apiToken: instanaToken } : null,

    gitlab: gitlabUrl && gitlabToken
      ? {
          baseUrl: gitlabUrl,
          token: gitlabToken,
          tokenType: str("GITLAB_TOKEN_TYPE")?.toLowerCase() === "oauth" ? "oauth" : "pat",
          allowWrite: bool("GITLAB_ALLOW_WRITE", false),
        }
      : null,

    grafana: grafanaUrl && grafanaToken
      ? {
          baseUrl: grafanaUrl,
          token: grafanaToken,
          ...(grafanaOrg ? { orgId: Number.parseInt(grafanaOrg, 10) } : {}),
        }
      : null,

    jira: buildJira(),
    kubernetes: buildKubernetes(),
  };
}
