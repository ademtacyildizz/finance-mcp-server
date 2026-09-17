import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GitlabConfig } from "../config.js";
import { apiRequest } from "../lib/http.js";
import { guard, jsonResult, textResult } from "../lib/result.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

/** Matches ANSI SGR/cursor sequences. Built from a code point to keep the source ASCII-clean. */
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** GitLab accepts either a numeric id or a URL-encoded "group/subgroup/project" path. */
function projectRef(project: string): string {
  return encodeURIComponent(project.trim());
}

/** Job traces are ANSI-coloured and carry collapsible-section markers; both are noise here. */
function cleanTrace(trace: string): string {
  return trace
    .replace(ANSI_PATTERN, "")
    .replace(/section_(start|end):\d+:[^\r\n]*/g, "")
    .replace(/\r/g, "");
}

const projectArg = z
  .string()
  .describe('Project id or full path, e.g. "1234" or "platform/payments/api".');

export function registerGitlabTools(server: McpServer, cfg: GitlabConfig, timeoutMs: number): number {
  const authHeader: Record<string, string> =
    cfg.tokenType === "oauth"
      ? { authorization: `Bearer ${cfg.token}` }
      : { "private-token": cfg.token };

  const call = <T>(
    path: string,
    init: { method?: "GET" | "POST"; query?: Record<string, any>; body?: unknown; raw?: boolean } = {},
  ): Promise<T> =>
    apiRequest<T>({ service: "GitLab", baseUrl: cfg.baseUrl, path, timeoutMs, headers: authHeader, ...init });

  server.registerTool(
    "gitlab_whoami",
    {
      title: "GitLab: connectivity check",
      description: "Returns the user the configured GitLab token belongs to. Use this to verify the token works.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guard(async () => {
      const user = await call("/api/v4/user");
      return jsonResult({ baseUrl: cfg.baseUrl, writesEnabled: cfg.allowWrite, user });
    }),
  );

  server.registerTool(
    "gitlab_search_projects",
    {
      title: "GitLab: find projects",
      description: "Searches projects by name or path. Start here when you only know a project by name.",
      inputSchema: {
        search: z.string().optional().describe("Text to match against project name and path."),
        membership: z.boolean().optional().describe("Limit to projects the token's user is a member of."),
        orderBy: z.enum(["id", "name", "path", "created_at", "updated_at", "last_activity_at"]).optional(),
        perPage: z.number().int().positive().max(100).optional().describe("Results per page (default 20)."),
        page: z.number().int().positive().optional(),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const data = await call("/api/v4/projects", {
        query: {
          search: args.search,
          membership: args.membership,
          order_by: args.orderBy,
          per_page: args.perPage ?? 20,
          page: args.page,
          simple: true,
        },
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "gitlab_get_project",
    {
      title: "GitLab: project details",
      description: "Returns full metadata for one project, including its default branch and visibility.",
      inputSchema: { project: projectArg },
      annotations: READ_ONLY,
    },
    guard(async (args) => jsonResult(await call(`/api/v4/projects/${projectRef(args.project)}`))),
  );

  server.registerTool(
    "gitlab_list_pipelines",
    {
      title: "GitLab: list pipelines",
      description: "Lists CI pipelines for a project, newest first. Filter by status to find what is broken.",
      inputSchema: {
        project: projectArg,
        ref: z.string().optional().describe("Branch or tag name."),
        status: z
          .enum([
            "created",
            "waiting_for_resource",
            "preparing",
            "pending",
            "running",
            "success",
            "failed",
            "canceled",
            "skipped",
            "manual",
            "scheduled",
          ])
          .optional(),
        username: z.string().optional().describe("Filter to pipelines triggered by this username."),
        perPage: z.number().int().positive().max(100).optional().describe("Results per page (default 20)."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const data = await call(`/api/v4/projects/${projectRef(args.project)}/pipelines`, {
        query: { ref: args.ref, status: args.status, username: args.username, per_page: args.perPage ?? 20 },
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "gitlab_get_pipeline",
    {
      title: "GitLab: pipeline with its jobs",
      description:
        "Returns one pipeline plus its jobs in a single call. This is the fastest way to see which stage of a pipeline failed.",
      inputSchema: {
        project: projectArg,
        pipelineId: z.number().int().positive().describe("Pipeline id."),
        scope: z
          .enum(["created", "pending", "running", "failed", "success", "canceled", "skipped", "manual"])
          .optional()
          .describe("Only return jobs in this state."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const base = `/api/v4/projects/${projectRef(args.project)}/pipelines/${args.pipelineId}`;
      const [pipeline, jobs] = await Promise.all([
        call(base),
        call<unknown[]>(`${base}/jobs`, { query: { scope: args.scope, per_page: 100 } }),
      ]);
      return jsonResult({ pipeline, jobs });
    }),
  );

  server.registerTool(
    "gitlab_get_job_log",
    {
      title: "GitLab: job log",
      description:
        "Fetches a CI job's log with ANSI colour codes stripped. Returns the last `tailLines` lines, because the failure is almost always at the end.",
      inputSchema: {
        project: projectArg,
        jobId: z.number().int().positive().describe("Job id (from gitlab_get_pipeline)."),
        tailLines: z
          .number()
          .int()
          .positive()
          .max(2000)
          .optional()
          .describe("Lines to return from the end (default 200)."),
        full: z.boolean().optional().describe("Return the whole log instead of the tail. May be very large."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const trace = await call<string>(`/api/v4/projects/${projectRef(args.project)}/jobs/${args.jobId}/trace`, {
        raw: true,
      });
      const cleaned = cleanTrace(trace);
      if (args.full) return textResult(cleaned);

      const lines = cleaned.split("\n");
      const tail = args.tailLines ?? 200;
      if (lines.length <= tail) return textResult(cleaned);
      return textResult(
        `[showing last ${tail} of ${lines.length} lines - pass full:true or a larger tailLines for more]\n\n` +
          lines.slice(-tail).join("\n"),
      );
    }),
  );

  server.registerTool(
    "gitlab_list_merge_requests",
    {
      title: "GitLab: list merge requests",
      description: "Lists merge requests for a project, or across all projects when `project` is omitted.",
      inputSchema: {
        project: z.string().optional().describe("Project id or path. Omit to search every project you can see."),
        state: z.enum(["opened", "closed", "locked", "merged", "all"]).optional().describe("Default: opened."),
        authorUsername: z.string().optional(),
        reviewerUsername: z.string().optional(),
        targetBranch: z.string().optional(),
        search: z.string().optional().describe("Text to match in title and description."),
        perPage: z.number().int().positive().max(100).optional().describe("Results per page (default 20)."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const path = args.project
        ? `/api/v4/projects/${projectRef(args.project)}/merge_requests`
        : "/api/v4/merge_requests";
      const data = await call(path, {
        query: {
          state: args.state ?? "opened",
          author_username: args.authorUsername,
          reviewer_username: args.reviewerUsername,
          target_branch: args.targetBranch,
          search: args.search,
          per_page: args.perPage ?? 20,
        },
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "gitlab_get_merge_request",
    {
      title: "GitLab: merge request detail",
      description: "Returns one merge request, optionally with its diff and its discussion notes.",
      inputSchema: {
        project: projectArg,
        mergeRequestIid: z.number().int().positive().describe("The project-scoped MR number (iid), not the global id."),
        includeChanges: z.boolean().optional().describe("Include the diff. Can be large."),
        includeNotes: z.boolean().optional().describe("Include review comments."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const base = `/api/v4/projects/${projectRef(args.project)}/merge_requests/${args.mergeRequestIid}`;
      const result: Record<string, unknown> = { mergeRequest: await call(base) };
      if (args.includeChanges) result["changes"] = await call(`${base}/changes`);
      if (args.includeNotes) result["notes"] = await call(`${base}/notes`, { query: { per_page: 100 } });
      return jsonResult(result);
    }),
  );

  server.registerTool(
    "gitlab_list_commits",
    {
      title: "GitLab: list commits",
      description: "Lists commits on a branch or tag, newest first.",
      inputSchema: {
        project: projectArg,
        refName: z.string().optional().describe("Branch or tag. Defaults to the project's default branch."),
        since: z.string().optional().describe("ISO-8601 lower bound on commit date."),
        until: z.string().optional().describe("ISO-8601 upper bound on commit date."),
        path: z.string().optional().describe("Only commits touching this file path."),
        perPage: z.number().int().positive().max(100).optional().describe("Results per page (default 20)."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const data = await call(`/api/v4/projects/${projectRef(args.project)}/repository/commits`, {
        query: {
          ref_name: args.refName,
          since: args.since,
          until: args.until,
          path: args.path,
          per_page: args.perPage ?? 20,
        },
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "gitlab_get_file",
    {
      title: "GitLab: read a repository file",
      description: "Returns the raw contents of a file at a given ref. Useful for reading CI config or manifests.",
      inputSchema: {
        project: projectArg,
        filePath: z.string().describe("Path inside the repository, e.g. .gitlab-ci.yml or deploy/values.yaml."),
        ref: z.string().optional().describe("Branch, tag or commit SHA. Defaults to HEAD of the default branch."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const encodedPath = encodeURIComponent(args.filePath);
      const content = await call<string>(
        `/api/v4/projects/${projectRef(args.project)}/repository/files/${encodedPath}/raw`,
        { query: { ref: args.ref }, raw: true },
      );
      return textResult(content);
    }),
  );

  server.registerTool(
    "gitlab_list_issues",
    {
      title: "GitLab: list issues",
      description: "Lists issues for a project, or across everything you can see when `project` is omitted.",
      inputSchema: {
        project: z.string().optional().describe("Project id or path. Omit to search globally."),
        state: z.enum(["opened", "closed", "all"]).optional().describe("Default: opened."),
        labels: z.string().optional().describe("Comma-separated label names."),
        assigneeUsername: z.string().optional(),
        search: z.string().optional(),
        perPage: z.number().int().positive().max(100).optional().describe("Results per page (default 20)."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const path = args.project ? `/api/v4/projects/${projectRef(args.project)}/issues` : "/api/v4/issues";
      const data = await call(path, {
        query: {
          state: args.state ?? "opened",
          labels: args.labels,
          assignee_username: args.assigneeUsername,
          search: args.search,
          per_page: args.perPage ?? 20,
        },
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "gitlab_search",
    {
      title: "GitLab: search code and content",
      description:
        "Full-text search. Scope `blobs` searches file contents, which is the way to find where something is defined across repositories.",
      inputSchema: {
        search: z.string().describe("The search term."),
        scope: z
          .enum(["projects", "issues", "merge_requests", "milestones", "blobs", "commits", "wiki_blobs", "users"])
          .describe("What to search. Use 'blobs' for file contents."),
        project: z.string().optional().describe("Restrict the search to one project."),
        perPage: z.number().int().positive().max(100).optional().describe("Results per page (default 20)."),
      },
      annotations: READ_ONLY,
    },
    guard(async (args) => {
      const path = args.project ? `/api/v4/projects/${projectRef(args.project)}/search` : "/api/v4/search";
      const data = await call(path, {
        query: { scope: args.scope, search: args.search, per_page: args.perPage ?? 20 },
      });
      return jsonResult(data);
    }),
  );

  if (!cfg.allowWrite) return 12;

  server.registerTool(
    "gitlab_retry_pipeline",
    {
      title: "GitLab: retry a pipeline",
      description: "Retries the failed and canceled jobs of a pipeline. Requires GITLAB_ALLOW_WRITE=true.",
      inputSchema: { project: projectArg, pipelineId: z.number().int().positive() },
      annotations: WRITE,
    },
    guard(async (args) => {
      const data = await call(`/api/v4/projects/${projectRef(args.project)}/pipelines/${args.pipelineId}/retry`, {
        method: "POST",
      });
      return jsonResult(data, "Pipeline retry requested.");
    }),
  );

  server.registerTool(
    "gitlab_cancel_pipeline",
    {
      title: "GitLab: cancel a pipeline",
      description: "Cancels a running pipeline. Requires GITLAB_ALLOW_WRITE=true.",
      inputSchema: { project: projectArg, pipelineId: z.number().int().positive() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const data = await call(`/api/v4/projects/${projectRef(args.project)}/pipelines/${args.pipelineId}/cancel`, {
        method: "POST",
      });
      return jsonResult(data, "Pipeline cancellation requested.");
    }),
  );

  return 14;
}
