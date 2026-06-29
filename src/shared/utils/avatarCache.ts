/**
 * Avatar image cache-busting: use per-contact/media keys instead of a global
 * directory timestamp so one contact update does not invalidate every avatar URL.
 */

function hashString(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Stable key from avatar path fields. Changes only when those values change.
 */
export function avatarMediaCacheKey(
  primary?: string | null,
  secondary?: string | null
): string {
  const p = (primary ?? "").trim();
  const s = (secondary ?? "").trim();
  if (!p && !s) return "0";
  return hashString(`${p}|${s}`);
}

export function appendAvatarCacheBust(
  uri: string | null | undefined,
  cacheKey: string
): string {
  if (!uri?.trim()) return uri ?? "";
  const v = encodeURIComponent(cacheKey);
  return `${uri}${uri.includes("?") ? "&" : "?"}v=${v}`;
}

export type UserWithMediaVersions = {
  avatarPath?: string | null;
  coverPhoto?: string | null;
  avatarMediaVersion?: number;
  coverMediaVersion?: number;
  /** @deprecated Prefer avatarMediaVersion */
  profileMediaVersion?: number;
};

export function getSelfAvatarMediaVersion(
  user?: UserWithMediaVersions | null
): number {
  return user?.avatarMediaVersion ?? user?.profileMediaVersion ?? 0;
}

export function getSelfCoverMediaVersion(
  user?: UserWithMediaVersions | null
): number {
  return user?.coverMediaVersion ?? 0;
}

/**
 * Current user's profile image: bust when path or avatarMediaVersion changes.
 */
export function appendSelfAvatarCacheBust(
  uri: string | null | undefined,
  avatarPath: string | null | undefined,
  avatarMediaVersion: number
): string {
  if (!uri?.trim()) return uri ?? "";
  const key = avatarMediaCacheKey(avatarPath, String(avatarMediaVersion));
  return appendAvatarCacheBust(uri, key);
}

/**
 * Current user's cover/banner: bust when path or coverMediaVersion changes.
 */
export function appendSelfCoverCacheBust(
  uri: string | null | undefined,
  coverPhoto: string | null | undefined,
  coverMediaVersion: number
): string {
  if (!uri?.trim()) return uri ?? "";
  if (!coverMediaVersion) return uri;
  const key = avatarMediaCacheKey(coverPhoto, String(coverMediaVersion));
  return appendAvatarCacheBust(uri, key);
}
