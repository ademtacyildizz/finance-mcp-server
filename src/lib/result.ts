import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError } from "./http.js";

/**
 * Set once from config at startup. A single unbounded `kubectl get -o json` or
 * Grafana dashboard can otherwise swamp the model's context window.
 */
let maxResultChars = 60_000;

export function setMaxResultChars(value: number): void {
  if (Number.isFinite(value) && value > 1000) maxResultChars = value;
}

function truncate(text: string): string {
  if (text.length <= maxResultChars) return text;
  return (
    `${text.slice(0, maxResultChars)}\n\n` +
    `[... truncated: ${text.length - maxResultChars} more characters. ` +
    `Narrow the query — use a filter, a smaller page size or a shorter time window.]`
  );
}

export function jsonResult(data: unknown, note?: string): CallToolResult {
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const text = note ? `${note}\n\n${body}` : body;
  return { content: [{ type: "text", text: truncate(text) }] };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text: truncate(text) }] };
}

export function errorResult(error: unknown): CallToolResult {
  let message: string;
  if (error instanceof ApiError) {
    message = error.message;
    if (error.status === 401 || error.status === 403) {
      message += `\n\nHint: check the credentials for ${error.service} in .env, and that the token's scopes cover this endpoint.`;
    }
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Wraps a tool handler so a thrown error becomes a normal `isError` result.
 * An uncaught throw would otherwise surface as an opaque transport failure.
 */
export function guard<A>(
  handler: (args: A) => Promise<CallToolResult>,
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error) {
      return errorResult(error);
    }
  };
}
