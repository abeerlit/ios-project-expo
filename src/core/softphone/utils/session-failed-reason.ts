/**
 * Detect "same user answered on another device" from JsSIP RTCSession `failed` payload
 * ({ originator, message, cause }). Remote CANCEL often includes Reason headers:
 * - SIP;cause=200;text="Call completed elsewhere"
 * - Q.850;cause=26 (call completed elsewhere)
 *
 * `cause` alone is often just "Canceled" for both this case and caller hang-up — use Reason text.
 */
export function isAnsweredElsewhereSessionFailed(data: unknown): boolean {
  if (data == null || typeof data !== "object") {
    return false;
  }
  const d = data as Record<string, unknown>;
  const blob = collectReasonAndMessageText(d);
  if (!blob) {
    return false;
  }
  const lower = blob.toLowerCase();
  if (lower.includes("completed elsewhere")) {
    return true;
  }
  // Q.850 cause 26 = "call completed elsewhere" (numeric only to avoid false positives)
  if (/\bq\.850\b/i.test(blob) && /\bcause\s*=\s*26\b/i.test(blob)) {
    return true;
  }
  return false;
}

function collectReasonAndMessageText(d: Record<string, unknown>): string {
  const parts: string[] = [];
  const msg = d.message as
    | {
        parseHeader?: (name: string, idx?: number) => unknown;
        headers?: object;
      }
    | null
    | undefined;
  if (msg && typeof msg.parseHeader === "function") {
    for (let i = 0; i < 8; i++) {
      try {
        const parsed = msg.parseHeader("Reason", i);
        if (parsed == null) {
          break;
        }
        parts.push(safeStringify(parsed));
      } catch {
        break;
      }
    }
  }
  if (msg?.headers && typeof msg.headers === "object") {
    const headers = msg.headers as Record<string, unknown>;
    const reasonRaw = headers.Reason ?? headers.reason;
    if (reasonRaw != null) {
      parts.push(safeStringify(reasonRaw));
    }
  }
  parts.push(safeStringify(d.cause));
  parts.push(safeStringify(d.originator));
  return parts.filter(Boolean).join(" ");
}

function safeStringify(x: unknown): string {
  if (x == null) {
    return "";
  }
  if (typeof x === "string") {
    return x;
  }
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}
