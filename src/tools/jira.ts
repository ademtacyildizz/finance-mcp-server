import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JiraConfig } from "../config.js";
import { apiRequest } from "../lib/http.js";
import { guard, jsonResult } from "../lib/result.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

/**
 * Jira Cloud (API v3) takes rich text as Atlassian Document Format; Server/DC
 * (v2) takes a plain wiki-markup string. Callers always pass plain text.
 */
function toAdf(text: string): Record<string, unknown> {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p !== "");
  const blocks = paragraphs.length > 0 ? paragraphs : [text.trim() || " "];
  return {
    type: "doc",
    version: 1,
    content: blocks.map((paragraph) => ({
      type: "paragraph",
      content: [{ type: "text", text: paragraph }],
    })),
  };
}

const DEFAULT_FIELDS = [
  "summary",
  "status",
  "assignee",
  "reporter",
  "priority",
  "issuetype",
  "project",
  "labels",
  "created",
  "updated",
];

export function registerJiraTools(server: McpServer, cfg: JiraConfig, timeoutMs: number): number {
  const api = `/rest/api/${cfg.apiVersion}`;

  const call = <T>(
    path: string,
    init: { method?: "GET" | "POST" | "PUT"; query?: Record<string, any>; body?: unknown } = {},
  ): Promise<T> =>
    apiRequest<T>({
      service: "Jira",
      baseUrl: cfg.baseUrl,
      path,
      timeoutMs,
      headers: { authorization: cfg.authorization },
      ...init,
    });

  const richText = (text: string): unknown => (cfg.usesAdf ? toAdf(text) : text);

  server.registerTool(
    "jira_myself",
    {
      title: "Jira: connectivity check",
      description: "Returns the account the configured Jira credentials belong to, plus the detected API flavour.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guard(async () => {
      const me = await call(`${api}/myself`);
      return jsonResult({
        baseUrl: cfg.baseUrl,
        apiVersion: cfg.apiVersion,
        deployment: cfg.usesAdf ? "Cloud" : "Server/Data Center",
        writesEnabled: cfg.allowWrite,
        account: me,
      });
    }),
  );

  server.registerTool(
    "jira_list_projects",
    {
      title: "Jira: list projects",
      description: "Lists projects visible to the credentials, with their keys. You need a project key to write JQL.",
      inputSchema: {
        query: z.string().optional().describe("Substring match on project name or key."),
        maxResults: z.number().int().positive().max(100).optional().describe("Default 50."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      // Cloud paginates via /project/search; Server/DC only has the unpaginated /project.
      if (cfg.usesAdf) {
        const data = await call(`${api}/project/search`, {
          query: { query: args.query, maxResults: args.maxResults ?? 50 },
        });
        return jsonResult(data);
      }
      const all = await call<Array<Record<string, unknown>>>(`${api}/project`);
      const needle = args.query?.toLowerCase();
      const filtered = !needle
        ? all
        : all.filter((project) =>
            [project["key"], project["name"]].some((value) => String(value ?? "").toLowerCase().includes(needle)),
          );
      return jsonResult(filtered.slice(0, args.maxResults ?? 50));
    }),
  );

  server.registerTool(
    "jira_search_issues",
    {
      title: "Jira: search issues with JQL",
      description:
        'Runs a JQL query. Example: project = OPS AND status != Done ORDER BY updated DESC. On Jira Cloud this uses the /search/jql endpoint, which paginates with an opaque nextPageToken rather than an offset - pass the token back in to get the next page.',
      inputSchema: {
        jql: z.string().describe("The JQL query."),
        fields: z
          .array(z.string())
          .optional()
          .describe("Fields to return. Defaults to a compact summary set. Use ['*all'] for everything."),
        maxResults: z.number().int().positive().max(100).optional().describe("Page size (default 50)."),
        nextPageToken: z.string().optional().describe("Jira Cloud: the token from the previous page's response."),
        startAt: z.number().int().nonnegative().optional().describe("Jira Server/DC only: result offset."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const fields = args.fields ?? DEFAULT_FIELDS;

      if (cfg.usesAdf) {
        // The legacy /rest/api/3/search endpoint was retired and now returns 410.
        const data = await call(`${api}/search/jql`, {
          method: "POST",
          body: {
            jql: args.jql,
            fields,
            maxResults: args.maxResults ?? 50,
            ...(args.nextPageToken ? { nextPageToken: args.nextPageToken } : {}),
          },
        });
        return jsonResult(data);
      }

      const data = await call(`${api}/search`, {
        query: {
          jql: args.jql,
          fields: fields.join(","),
          maxResults: args.maxResults ?? 50,
          startAt: args.startAt ?? 0,
        },
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "jira_count_issues",
    {
      title: "Jira: approximate issue count",
      description:
        "Returns an approximate count for a JQL query without fetching the issues. Much cheaper than paging through results just to count them.",
      inputSchema: { jql: z.string().describe("The JQL query.") },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      if (cfg.usesAdf) {
        const data = await call(`${api}/search/approximate-count`, { method: "POST", body: { jql: args.jql } });
        return jsonResult(data);
      }
      // Server/DC has no count endpoint; ask for zero results and read the total.
      const data = await call<{ total?: number }>(`${api}/search`, {
        query: { jql: args.jql, maxResults: 0, fields: "summary" },
      });
      return jsonResult({ count: data.total });
    }),
  );

  server.registerTool(
    "jira_get_issue",
    {
      title: "Jira: issue detail",
      description: "Returns one issue by key, optionally with its comments and changelog.",
      inputSchema: {
        issueKey: z.string().describe("Issue key, e.g. OPS-1234."),
        fields: z.array(z.string()).optional().describe("Fields to return. Omit for all fields."),
        includeComments: z.boolean().optional().describe("Also fetch the comment thread."),
        includeChangelog: z.boolean().optional().describe("Also fetch the change history."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const key = encodeURIComponent(args.issueKey);
      const expand: string[] = [];
      if (args.includeChangelog) expand.push("changelog");

      const issue = await call(`${api}/issue/${key}`, {
        query: {
          fields: args.fields?.join(","),
          expand: expand.length > 0 ? expand.join(",") : undefined,
        },
      });

      if (!args.includeComments) return jsonResult(issue);
      const comments = await call(`${api}/issue/${key}/comment`, { query: { maxResults: 50 } });
      return jsonResult({ issue, comments });
    }),
  );

  server.registerTool(
    "jira_list_transitions",
    {
      title: "Jira: available transitions",
      description:
        "Lists the workflow transitions available on an issue right now, with their ids. Call this before jira_transition_issue - transition ids differ per project workflow.",
      inputSchema: { issueKey: z.string().describe("Issue key, e.g. OPS-1234.") },
      annotations: READ_ONLY,
    },
    guard(async (args) =>
      jsonResult(await call(`${api}/issue/${encodeURIComponent(args.issueKey)}/transitions`)),
    ),
  );

  if (!cfg.allowWrite) return 6;

  server.registerTool(
    "jira_add_comment",
    {
      title: "Jira: add a comment",
      description:
        "Posts a comment on an issue. Visible to everyone who can see the issue. Requires JIRA_ALLOW_WRITE=true.",
      inputSchema: {
        issueKey: z.string().describe("Issue key, e.g. OPS-1234."),
        body: z.string().describe("Comment text. Blank lines start a new paragraph."),
      },
      annotations: WRITE,
    },
    guard(async (args) => {
      const data = await call(`${api}/issue/${encodeURIComponent(args.issueKey)}/comment`, {
        method: "POST",
        body: { body: richText(args.body) },
      });
      return jsonResult(data, `Comment added to ${args.issueKey}.`);
    }),
  );

  server.registerTool(
    "jira_transition_issue",
    {
      title: "Jira: move an issue through its workflow",
      description:
        "Applies a workflow transition, optionally with a comment. Get the transition id from jira_list_transitions first. Requires JIRA_ALLOW_WRITE=true.",
      inputSchema: {
        issueKey: z.string().describe("Issue key, e.g. OPS-1234."),
        transitionId: z.string().describe("Transition id from jira_list_transitions."),
        comment: z.string().optional().describe("Optional comment to post with the transition."),
      },
      annotations: WRITE,
    },
    guard(async (args) => {
      const body: Record<string, unknown> = { transition: { id: args.transitionId } };
      if (args.comment) {
        body["update"] = { comment: [{ add: { body: richText(args.comment) } }] };
      }
      await call(`${api}/issue/${encodeURIComponent(args.issueKey)}/transitions`, { method: "POST", body });
      return jsonResult(
        { issueKey: args.issueKey, transitionId: args.transitionId },
        `Transition applied. Jira returns no body for this call; re-read the issue to confirm the new status.`,
      );
    }),
  );

  server.registerTool(
    "jira_create_issue",
    {
      title: "Jira: create an issue",
      description:
        "Creates an issue. projectKey and issueType must match the project's configuration - check jira_list_projects. Requires JIRA_ALLOW_WRITE=true.",
      inputSchema: {
        projectKey: z.string().describe("Project key, e.g. OPS."),
        issueType: z.string().describe('Issue type name, e.g. "Task", "Bug", "Incident".'),
        summary: z.string().describe("The issue title."),
        description: z.string().optional().describe("Issue description as plain text."),
        priority: z.string().optional().describe('Priority name, e.g. "High".'),
        labels: z.array(z.string()).optional(),
        assigneeAccountId: z
          .string()
          .optional()
          .describe("Jira Cloud account id, or username on Server/DC."),
        extraFields: z
          .record(z.string(), z.any())
          .optional()
          .describe("Any additional fields, keyed by field id, merged into the request."),
      },
      annotations: WRITE,
    },
    guard(async (args) => {
      const fields: Record<string, unknown> = {
        project: { key: args.projectKey },
        issuetype: { name: args.issueType },
        summary: args.summary,
      };
      if (args.description) fields["description"] = richText(args.description);
      if (args.priority) fields["priority"] = { name: args.priority };
      if (args.labels) fields["labels"] = args.labels;
      if (args.assigneeAccountId) {
        fields["assignee"] = cfg.usesAdf ? { id: args.assigneeAccountId } : { name: args.assigneeAccountId };
      }
      Object.assign(fields, args.extraFields ?? {});

      const data = await call<{ key?: string }>(`${api}/issue`, { method: "POST", body: { fields } });
      return jsonResult(data, data.key ? `Created ${data.key} at ${cfg.baseUrl}/browse/${data.key}` : "Issue created.");
    }),
  );

  return 9;
}
