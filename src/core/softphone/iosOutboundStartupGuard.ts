import { Platform } from "react-native";
import type { PendingRecentsStart } from "./iosRecentsEarly.ts";

/** Drop stale CallKit Recents auto-dials for this long after JS bundle load. */
export const IOS_OUTBOUND_STARTUP_GRACE_MS = 5000;
let jsBundleLoadedAt = Date.now();

/** Call from index.js so grace starts at bundle load, not first softphone import. */
export function markIosJsBundleLoaded(at: number = Date.now()): void {
  jsBundleLoadedAt = at;
}

export function getOutboundStartupGraceRemainingMs(
  now = Date.now()
): number {
  if (Platform.OS !== "ios") {
    return 0;
  }
  return Math.max(0, IOS_OUTBOUND_STARTUP_GRACE_MS - (now - jsBundleLoadedAt));
}

export function isOutboundStartupGraceActive(now = Date.now()): boolean {
  return getOutboundStartupGraceRemainingMs(now) > 0;
}

/** Normalize Recents handle for dedupe (E.164-ish / digits). */
export function normalizeOutboundRecentsHandle(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return "";
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("sip:")) {
    return lower;
  }
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 3 ? digits : lower;
}

/** Keep the last queued start per destination — avoids 3–4 INVITEs for one number. */
export function dedupePendingRecentsStarts(
  items: PendingRecentsStart[]
): PendingRecentsStart[] {
  const byHandle = new Map<string, PendingRecentsStart>();
  for (const item of items) {
    const handleKey = normalizeOutboundRecentsHandle(item.handle);
    if (!handleKey) {
      continue;
    }
    byHandle.set(handleKey, item);
  }
  return Array.from(byHandle.values());
}
