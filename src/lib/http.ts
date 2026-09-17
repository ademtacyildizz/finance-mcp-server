/** Shared REST plumbing for the Instana, GitLab, Grafana and Jira integrations. */

export class ApiError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    readonly statusText: string,
    readonly url: string,
    readonly bodySnippet: string,
  ) {
    super(
      `${service} API returned ${status} ${statusText} for ${url}` +
        (bodySnippet ? `\n${bodySnippet}` : ""),
    );
    this.name = "ApiError";
  }
}

export type QueryValue = string | number | boolean | undefined | null | Array<string | number>;

export interface RequestOptions {
  service: string;
  baseUrl: string;
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs: number;
  /** Return the raw response body as text instead of parsing JSON. */
  raw?: boolean;
}

export interface DetailedResponse<T> {
  data: T;
  status: number;
  headers: Record<string, string>;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    // Repeated keys are how Instana and GitLab express array filters.
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.append(key, String(value));
    }
  }
  return url.toString();
}

export async function apiRequestDetailed<T = unknown>(
  options: RequestOptions,
): Promise<DetailedResponse<T>> {
  const { service, baseUrl, path, method = "GET", query, body, headers, timeoutMs, raw } = options;
  const url = buildUrl(baseUrl, path, query);

  const requestHeaders: Record<string, string> = {
    accept: raw ? "text/plain, */*" : "application/json",
    ...headers,
  };
  if (body !== undefined) requestHeaders["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const hint =
      cause instanceof Error && cause.name === "TimeoutError"
        ? ` (no response within ${timeoutMs}ms)`
        : "";
    throw new Error(`${service}: could not reach ${url}${hint} — ${reason}`, { cause });
  }

  const text = await response.text();

  if (!response.ok) {
    // Cap the echoed body: error pages can be entire HTML documents.
    const snippet = text.length > 800 ? `${text.slice(0, 800)}…` : text;
    throw new ApiError(service, response.status, response.statusText, url, snippet);
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  if (raw) {
    return { data: text as T, status: response.status, headers: responseHeaders };
  }

  if (text.trim() === "") {
    return { data: null as T, status: response.status, headers: responseHeaders };
  }

  try {
    return { data: JSON.parse(text) as T, status: response.status, headers: responseHeaders };
  } catch {
    // Some endpoints advertise JSON but return plain text; surface it rather than failing.
    return { data: text as T, status: response.status, headers: responseHeaders };
  }
}

export async function apiRequest<T = unknown>(options: RequestOptions): Promise<T> {
  const { data } = await apiRequestDetailed<T>(options);
  return data;
}
