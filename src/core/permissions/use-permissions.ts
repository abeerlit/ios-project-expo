import { useState, useEffect, useCallback } from "react";
import { Alert, Linking, Platform } from "react-native";
import { Logger } from "shared/utils/Logger.ts";
import { PermissionType, PermissionResult, PermissionsState } from "./types.ts";
import { checkPermission, requestPermission } from "./utils.ts";

/**
 * Permissions Hook
 * Custom hook for managing app permissions
 */

// Logger instance
const logger = new Logger("PermissionsHook: ");

// Default permission values
const defaultPermissionResult: PermissionResult = {
  status: "not-determined",
  granted: false
};

// Initial state for permissions
const initialPermissionsState: PermissionsState = {
  microphone: defaultPermissionResult,
  location: defaultPermissionResult,
  notifications: defaultPermissionResult,
  phone: defaultPermissionResult
};

/**
 * Hook for managing app permissions
 * Provides functions for checking and requesting permissions
 * along with current permission states
 */
export const usePermissions = () => {
  // State
  const [permissionsState, setPermissionsState] = useState<PermissionsState>(
    initialPermissionsState
  );
  const [isLoading, setIsLoading] = useState(false);

  // Check the status of all permissions
  const checkPermissions = useCallback(async () => {
    setIsLoading(true);

    try {
      const microphoneStatus = await checkPermission("microphone");
      const locationStatus = await checkPermission("location");
      const notificationsStatus = await checkPermission("notifications");
      const phoneStatus = await checkPermission("phone");

      setPermissionsState({
        microphone: microphoneStatus,
        location: locationStatus,
        notifications: notificationsStatus,
        phone: phoneStatus
      });
    } catch (error) {
      logger.error("Error checking permissions:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Request a specific permission
  const requestSinglePermission = useCallback(async (type: PermissionType) => {
    setIsLoading(true);

    try {
      const permissionResult = await requestPermission(type);

      setPermissionsState((prev) => ({
        ...prev,
        [type]: permissionResult
      }));

      return permissionResult;
    } catch (error) {
      logger.error(`Error requesting ${type} permission:`, error);
      return { status: "unavailable", granted: false } as PermissionResult;
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Request all required permissions sequentially with delays
  // This ensures each permission dialog is shown one at a time (especially important for iOS)
  const requestAllPermissions = useCallback(async () => {
    setIsLoading(true);
    logger.debug("Requesting all permissions sequentially");

    try {
      const results: Partial<PermissionsState> = {};

      // Helper to add delay between permission requests
      // iOS needs more time between dialogs, Android is more forgiving
      const delay = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));
      const delayBetweenPermissions = Platform.OS === "ios" ? 1500 : 800;

      // Define permission order (notifications first as it's most critical for token registration)
      const permissionOrder: PermissionType[] = [
        "notifications",
        "microphone",
        "location",
        "phone"
      ];

      // Request each permission sequentially
      for (const permissionType of permissionOrder) {
        // Check if already granted before requesting
        const currentStatus = await checkPermission(permissionType);

        if (currentStatus.granted) {
          logger.debug(
            `${permissionType} permission already granted, skipping`
          );
          // Type-safe assignment - only assign if it's a valid PermissionsState key
          if (
            permissionType === "microphone" ||
            permissionType === "location" ||
            permissionType === "notifications" ||
            permissionType === "phone"
          ) {
            results[permissionType] = currentStatus;
          }
          continue;
        }

        logger.debug(`Requesting ${permissionType} permission...`);
        const result = await requestPermission(permissionType);
        // Type-safe assignment
        if (
          permissionType === "microphone" ||
          permissionType === "location" ||
          permissionType === "notifications" ||
          permissionType === "phone"
        ) {
          results[permissionType] = result;
        }
        logger.debug(`${permissionType} permission result:`, result.status);

        // Wait before requesting next permission (except after the last one)
        if (permissionType !== permissionOrder[permissionOrder.length - 1]) {
          await delay(delayBetweenPermissions);
        }
      }

      // Update state with all results
      setPermissionsState(
        (prev) =>
          ({
            ...prev,
            ...results
          } as PermissionsState)
      );

      logger.debug("All permissions request completed:", {
        microphone: results.microphone?.status,
        location: results.location?.status,
        notifications: results.notifications?.status,
        phone: results.phone?.status
      });

      return {
        allGranted:
          (results.microphone?.granted ?? false) &&
          (results.location?.granted ?? false) &&
          (results.notifications?.granted ?? false) &&
          (results.phone?.granted ?? false),
        results: {
          microphone: results.microphone || defaultPermissionResult,
          location: results.location || defaultPermissionResult,
          notifications: results.notifications || defaultPermissionResult,
          phone: results.phone || defaultPermissionResult
        }
      };
    } catch (error) {
      logger.error("Error requesting all permissions:", error);
      return { allGranted: false, results: permissionsState };
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Open app settings if permission is blocked
  const openSettings = useCallback(() => {
    logger.debug("Opening app settings");
    Linking.openSettings();
  }, []);

  // Show alert for blocked permissions with option to open settings
  const showBlockedPermissionAlert = useCallback(
    (permissionName: string) => {
      logger.debug(`Showing alert for blocked ${permissionName} permission`);
      Alert.alert(
        "Permission Required",
        `${permissionName} permission is required for this feature. Please enable it in your device settings.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Open Settings", onPress: openSettings }
        ]
      );
    },
    [openSettings]
  );

  // Check if all required permissions are granted
  const areAllPermissionsGranted = useCallback(() => {
    return (
      permissionsState.microphone.granted &&
      permissionsState.location.granted &&
      permissionsState.notifications.granted &&
      (permissionsState.phone?.granted ?? false)
    );
  }, [permissionsState]);

  // Check permissions on initial mount
  useEffect(() => {
    logger.debug("Initializing permissions check");
    checkPermissions();
  }, [checkPermissions]);

  // Return hook values and functions
  return {
    permissions: permissionsState,
    isLoading,
    checkPermissions,
    requestPermission: requestSinglePermission,
    requestAllPermissions,
    openSettings,
    showBlockedPermissionAlert,
    areAllPermissionsGranted
  };
};
