import { Platform } from "react-native";
import type { PendingRecentsStart } from "./iosRecentsEarly.ts";

/** Drop stale CallKit Recents auto-dials for this long after JS bundle load. */
export const IOS_OUTBOUND_STARTUP_GRACE_MS = 5000;
/** Ignore CallKit re-delivery of outbound UUIDs that already ended. */
export const IOS_OUTBOUND_REPLAY_BLOCK_MS = 10 * 60 * 1000;
/** After foreground resume, block stale start-call replays briefly. */
export const IOS_FOREGROUND_RESUME_OUTBOUND_GUARD_MS = 8000;
/** Drop queued Recents starts older than this when flushing. */
export const PENDING_RECENTS_MAX_AGE_MS = 120 * 1000;

let jsBundleLoadedAt = Date.now();
let lastForegroundAt: number | null = null;
const endedOutboundByUuid = new Map<string, number>();
const endedOutboundByHandle = new Map<string, number>();

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

export function markIosAppForegrounded(at: number = Date.now()): void {
  if (Platform.OS !== "ios") {
    return;
  }
  lastForegroundAt = at;
}

function pruneStaleOutboundReplayMaps(now: number): void {
  for (const [key, ts] of endedOutboundByUuid) {
    if (now - ts > IOS_OUTBOUND_REPLAY_BLOCK_MS) {
      endedOutboundByUuid.delete(key);
    }
  }
  for (const [key, ts] of endedOutboundByHandle) {
    if (now - ts > IOS_OUTBOUND_REPLAY_BLOCK_MS) {
      endedOutboundByHandle.delete(key);
    }
  }
}

/** Remember completed outbound legs so CallKit cannot replay them on foreground resume. */
export function markOutboundCallKitCompleted(
  callUUID: string,
  handle?: string,
  at: number = Date.now()
): void {
  if (Platform.OS !== "ios") {
    return;
  }
  const uuid = String(callUUID || "").trim().toLowerCase();
  if (uuid) {
    endedOutboundByUuid.set(uuid, at);
  }
  const handleKey = normalizeOutboundRecentsHandle(handle ?? "");
  if (handleKey) {
    endedOutboundByHandle.set(handleKey, at);
  }
  pruneStaleOutboundReplayMaps(at);
}

export function shouldBlockStaleOutboundStartAction(params: {
  callUUID: string;
  handle: string;
  now?: number;
  hasLiveSipSession?: boolean;
  isAppInitiatedRecently?: boolean;
  queuedAt?: number;
}): { blocked: boolean; reason?: string } {
  if (Platform.OS !== "ios") {
    return { blocked: false };
  }

  const now = params.now ?? Date.now();
  pruneStaleOutboundReplayMaps(now);

  if (params.isAppInitiatedRecently || params.hasLiveSipSession) {
    return { blocked: false };
  }

  if (
    typeof params.queuedAt === "number" &&
    now - params.queuedAt > PENDING_RECENTS_MAX_AGE_MS
  ) {
    return { blocked: true, reason: "queued_recents_expired" };
  }

  const uuid = String(params.callUUID || "").trim().toLowerCase();
  const endedAt = uuid ? endedOutboundByUuid.get(uuid) : undefined;
  if (
    endedAt != null &&
    now - endedAt < IOS_OUTBOUND_REPLAY_BLOCK_MS
  ) {
    return { blocked: true, reason: "completed_uuid_replay" };
  }

  const handleKey = normalizeOutboundRecentsHandle(params.handle);
  const handleEndedAt = handleKey
    ? endedOutboundByHandle.get(handleKey)
    : undefined;

  const withinForegroundResumeGuard =
    lastForegroundAt != null &&
    now - lastForegroundAt < IOS_FOREGROUND_RESUME_OUTBOUND_GUARD_MS;

  if (
    withinForegroundResumeGuard &&
    handleEndedAt != null &&
    now - handleEndedAt < IOS_OUTBOUND_REPLAY_BLOCK_MS
  ) {
    return { blocked: true, reason: "foreground_resume_handle_replay" };
  }

  if (
    withinForegroundResumeGuard &&
    endedAt != null &&
    now - endedAt < IOS_OUTBOUND_REPLAY_BLOCK_MS
  ) {
    return { blocked: true, reason: "foreground_resume_uuid_replay" };
  }

  return { blocked: false };
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
