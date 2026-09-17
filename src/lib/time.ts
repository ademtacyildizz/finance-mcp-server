/** Time-window helpers. Instana and Grafana both work in Unix epoch milliseconds. */

export interface TimeWindowInput {
  fromIso?: string | undefined;
  toIso?: string | undefined;
  windowSizeMinutes?: number | undefined;
}

export interface TimeWindow {
  /** Epoch ms marking the end of the window. */
  to: number;
  /** Window length in ms, relative to `to`. */
  windowSize: number;
  from: number;
}

function parseIso(label: string, value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`${label} is not a valid ISO-8601 timestamp: ${value}`);
  }
  return ms;
}

/**
 * Resolves the three ways a caller can express a window:
 *   both fromIso and toIso  -> exact range
 *   toIso only              -> windowSizeMinutes ending at toIso
 *   neither                 -> windowSizeMinutes ending now
 */
export function resolveTimeWindow(input: TimeWindowInput): TimeWindow {
  const to = input.toIso ? parseIso("toIso", input.toIso) : Date.now();

  if (input.fromIso) {
    const from = parseIso("fromIso", input.fromIso);
    if (from >= to) throw new Error(`fromIso (${input.fromIso}) must be earlier than the end of the window.`);
    return { to, from, windowSize: to - from };
  }

  const minutes = input.windowSizeMinutes ?? 60;
  if (minutes <= 0) throw new Error("windowSizeMinutes must be greater than 0.");
  const windowSize = Math.round(minutes * 60_000);
  return { to, windowSize, from: to - windowSize };
}
