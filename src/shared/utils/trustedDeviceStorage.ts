/**
 * Trusted Device Storage
 *
 * After a user completes 2FA OTP verification for the first time on a device,
 * we mark that account as "trusted" locally. On subsequent logins (same account,
 * same device), we pass the trustedDeviceToken so the backend can skip OTP.
 *
 * Trust is cleared when:
 * - User reinstalls the app
 * - User clears app data/cache
 *
 * Backend requirements for this to work:
 * 1. Login API (/v2/authentication/mfa) must accept optional `trustedDeviceToken`
 * 2. validateMFA (/v2/mfa/validate) must accept optional `trustedDeviceToken` in the request.
 *    When provided, the backend stores it for the user.
 * 3. When login receives a valid trustedDeviceToken, return accessToken directly
 *    instead of mfaVerifyToken.
 */
import { MMKV } from "react-native-mmkv";
import { v4 as uuidv4 } from "uuid";

const TRUSTED_DEVICE_PREFIX = "trusted_device:";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function storageKey(email: string): string {
  return `${TRUSTED_DEVICE_PREFIX}${normalizeEmail(email)}`;
}

interface TrustedDeviceRecord {
  token: string;
  trustedAt: number;
}

const mmkv = new MMKV({ id: "trusted_devices" });

export const TrustedDeviceStorage = {
  /**
   * Generate a new trusted device token. Use this before calling validateMFA,
   * then pass the same token to markTrusted after success.
   */
  generateToken(): string {
    return uuidv4();
  },

  /**
   * Mark an account as trusted on this device. Call after successful OTP verification.
   */
  markTrusted(email: string, token?: string): string {
    const normalized = normalizeEmail(email);
    const finalToken = token ?? uuidv4();
    const record: TrustedDeviceRecord = {
      token: finalToken,
      trustedAt: Date.now()
    };
    mmkv.set(storageKey(normalized), JSON.stringify(record));
    return finalToken;
  },

  /**
   * Get the trusted device token for an account, if any.
   */
  getToken(email: string): string | null {
    const normalized = normalizeEmail(email);
    const raw = mmkv.getString(storageKey(normalized));
    if (!raw) return null;
    try {
      const record = JSON.parse(raw) as TrustedDeviceRecord;
      return record?.token ?? null;
    } catch {
      return null;
    }
  },

  /**
   * Clear trusted status for an account (e.g. on explicit logout from shared device).
   */
  clearTrusted(email: string): void {
    mmkv.delete(storageKey(normalizeEmail(email)));
  },

  /**
   * Check if an account is trusted on this device.
   */
  isTrusted(email: string): boolean {
    return this.getToken(email) !== null;
  }
};
