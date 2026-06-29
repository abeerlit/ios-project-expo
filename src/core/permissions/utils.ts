// React Imports
import { Platform } from "react-native";
import {
  check,
  request,
  PERMISSIONS,
  RESULTS,
  Permission,
  requestNotifications,
  checkNotifications
} from "react-native-permissions";

// Utils & Types
import { Logger } from "shared/utils/Logger.ts";
import { PermissionResult, PermissionStatus, PermissionType } from "./types.ts";

/**
 * Permissions Utilities
 * Core utilities for checking and requesting permissions
 */

// Logger instance
const logger = new Logger("Permissions: ");

/**
 * Permission Mapping
 * Maps our simplified permission types to the platform-specific permission
 */
const permissionMap: Record<
  PermissionType,
  { ios: Permission; android: Permission }
> = {
  microphone: {
    ios: PERMISSIONS.IOS.MICROPHONE,
    android: PERMISSIONS.ANDROID.RECORD_AUDIO
  },
  location: {
    ios: PERMISSIONS.IOS.LOCATION_WHEN_IN_USE,
    android: PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION
  },
  notifications: {
    // For iOS, we need to handle notifications differently
    // iOS requires a different approach for notifications than Android
    ios: PERMISSIONS.IOS.LOCATION_WHEN_IN_USE, // Placeholder - iOS uses checkNotifications/requestNotifications
    android:
      (PERMISSIONS.ANDROID as any).POST_NOTIFICATIONS ||
      PERMISSIONS.ANDROID.READ_CONTACTS // Fallback for older RN permissions
  },
  contacts: {
    ios: PERMISSIONS.IOS.CONTACTS,
    android: PERMISSIONS.ANDROID.READ_CONTACTS
  },
  phone: {
    ios: PERMISSIONS.IOS.MICROPHONE,
    android: PERMISSIONS.ANDROID.READ_PHONE_STATE
  }
};

/**
 * Maps the library's result to our simplified status
 */
const mapStatus = (result: string): PermissionResult => {
  let status = "not-determined";
  let granted = false;

  switch (result) {
    case RESULTS.GRANTED:
      status = "granted";
      granted = true;
      break;
    case RESULTS.DENIED:
      status = "denied";
      granted = false;
      break;
    case RESULTS.BLOCKED:
      status = "blocked";
      granted = false;
      break;
    case RESULTS.UNAVAILABLE:
      status = "unavailable";
      granted = false;
      break;
    case RESULTS.LIMITED:
      status = "limited";
      granted = true;
      break;
  }

  return { status, granted } as PermissionResult;
};

/**
 * Gets the permission for the current platform
 */
export const getPermission = (type: PermissionType): Permission | null => {
  const platform = Platform.OS === "ios" ? "ios" : "android";
  const permission = permissionMap[type]?.[platform];

  if (!permission) {
    logger.error(
      `Permission not found for type: ${type} on platform: ${platform}`
    );
    return null;
  }

  return permission;
};

/**
 * Special handling for iOS notifications
 */
const requestIOSNotifications = async (): Promise<PermissionResult> => {
  if (Platform.OS !== "ios") {
    return { status: "unavailable", granted: false };
  }

  try {
    // For iOS, we need to use the native module from react-native
    const result = await requestNotifications(["alert", "badge", "sound"]);

    return {
      status: result.status.toLowerCase() as PermissionStatus,
      granted: result.status === RESULTS.GRANTED
    };
  } catch (error) {
    logger.error("Error requesting iOS notifications permission:", error);
    return { status: "unavailable", granted: false };
  }
};

/**
 * Check the status of iOS notifications
 */
const checkIOSNotifications = async (): Promise<PermissionResult> => {
  if (Platform.OS !== "ios") {
    return { status: "unavailable", granted: false };
  }

  try {
    const result = await checkNotifications();

    return {
      status: result.status.toLowerCase() as PermissionStatus,
      granted: result.status === RESULTS.GRANTED
    };
  } catch (error) {
    logger.error("Error checking iOS notifications permission:", error);
    return { status: "unavailable", granted: false };
  }
};

/**
 * Check the status of a permission
 */
export const checkPermission = async (
  type: PermissionType
): Promise<PermissionResult> => {
  try {
    // Special handling for iOS notifications
    if (type === "notifications" && Platform.OS === "ios") {
      return await checkIOSNotifications();
    }

    const permission = getPermission(type);
    if (!permission) {
      logger.error(
        `Cannot check permission - permission is null for type: ${type}`
      );
      return { status: "unavailable", granted: false };
    }

    const result = await check(permission);
    return mapStatus(result);
  } catch (error) {
    logger.error(`Error checking permission ${type}:`, error);
    return { status: "unavailable", granted: false };
  }
};

/**
 * Request a permission
 */
export const requestPermission = async (
  type: PermissionType
): Promise<PermissionResult> => {
  try {
    // Special handling for iOS notifications
    if (type === "notifications" && Platform.OS === "ios") {
      return await requestIOSNotifications();
    }

    const permission = getPermission(type);
    if (!permission) {
      logger.error(
        `Cannot request permission - permission is null for type: ${type}`
      );
      return { status: "unavailable", granted: false };
    }

    const result = await request(permission);
    return mapStatus(result);
  } catch (error) {
    logger.error(`Error requesting permission ${type}:`, error);
    return { status: "unavailable", granted: false };
  }
};

/**
 * Check and request a permission in one step if not already granted
 */
export const ensurePermission = async (
  type: PermissionType
): Promise<PermissionResult> => {
  const status = await checkPermission(type);

  if (status.granted) {
    return status;
  }

  return requestPermission(type);
};
