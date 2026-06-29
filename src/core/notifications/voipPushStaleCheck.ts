export const VOIP_PUSH_MAX_AGE_MS = 20_000;

function coerceSentAt(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

export function parseVoipSentAt(
  payload: Record<string, unknown>
): number | null {
  return coerceSentAt(payload.sentAt);
}

export function isVoipPushStaleDeclined(
  payload: Record<string, unknown>
): boolean {
  const flag = payload.staleDeclined;
  return flag === true || flag === 1 || flag === "1" || flag === "YES";
}

export function getVoipPushAge(payload: Record<string, unknown>): {
  stale: boolean;
  ageMs: number;
  sentAt: number | null;
} {
  if (isVoipPushStaleDeclined(payload)) {
    const sentAt = parseVoipSentAt(payload);
    const ageMs =
      sentAt != null ? Math.max(0, Date.now() - sentAt) : VOIP_PUSH_MAX_AGE_MS;
    return { stale: true, ageMs, sentAt };
  }

  const sentAt = parseVoipSentAt(payload);
  if (sentAt == null) {
    return { stale: false, ageMs: 0, sentAt: null };
  }

  const ageMs = Math.max(0, Date.now() - sentAt);
  return {
    stale: ageMs > VOIP_PUSH_MAX_AGE_MS,
    ageMs,
    sentAt
  };
}
