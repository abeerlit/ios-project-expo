import React, { useEffect } from "react";
import { useNotifications } from "hooks/use-notifications.ts";
import VoxoNotificationManager from "core/notifications/VoxoNotificationManager.ts";

/**
 * Register NotificationManager + native APNs→Notifee listeners as soon as the
 * authenticated shell mounts — not only when the Home tab is visible.
 */
export function NotificationsBootstrap() {
  useNotifications();

  useEffect(() => {
    console.log("[NotificationsBootstrap] mounted — ensuring listener diagnostics");
    void VoxoNotificationManager.logListenerDiagnostics(
      "NotificationsBootstrap.mount"
    );
  }, []);

  return null;
}
