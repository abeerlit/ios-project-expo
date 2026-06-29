/**
 * use-notifications.ts
 * React hook for using the notification system
 *
 * This hook provides a simple interface to:
 * - Initialize the notification system
 * - Get notification tokens for push registration
 * - Set the currently viewing conversation (to suppress duplicate notifications)
 *
 * Note: Notification handling (display, navigation) is handled internally by NotificationManager
 */
import { useEffect, useState, useCallback } from "react";
import { useDispatch } from "react-redux";
import { Platform } from "react-native";
import notifee, { AndroidImportance } from "@notifee/react-native";
import NotificationManager, {
  NotificationToken
} from "core/notifications/NotificationManager.ts";
import VoxoNotificationManager from "core/notifications/VoxoNotificationManager.ts";
import { useSendbirdContext } from "features/chat/utils/SendbirdContext.ts";
import * as textActions from "store/text/actions.ts";
import * as userActions from "store/users/actions.ts";
import { resolveSmsSenderDisplayName } from "core/notifications/resolveSmsSenderDisplayName.ts";

let hookListenerRefCount = 0;
let hookListenerCleanup: (() => void) | undefined;

function retainHookOwnedIosListeners(
  attach: () => (() => void) | undefined
): () => void {
  hookListenerRefCount += 1;
  if (!hookListenerCleanup) {
    hookListenerCleanup = attach() ?? (() => {});
    console.log(
      `[useNotifications] iOS hook listeners attached (owners=${hookListenerRefCount})`
    );
    void VoxoNotificationManager.logListenerDiagnostics(
      "useNotifications.hookListeners.attach"
    );
  } else {
    console.log(
      `[useNotifications] iOS hook listeners reused (owners=${hookListenerRefCount})`
    );
  }
  return () => {
    hookListenerRefCount = Math.max(0, hookListenerRefCount - 1);
    if (hookListenerRefCount === 0 && hookListenerCleanup) {
      hookListenerCleanup();
      hookListenerCleanup = undefined;
      console.log("[useNotifications] iOS hook listeners released (owners=0)");
      void VoxoNotificationManager.logListenerDiagnostics(
        "useNotifications.hookListeners.release"
      );
    }
  };
}

export interface UseNotificationsResult {
  tokens: NotificationToken[];
  isInitialized: boolean;
  setViewingConversation: (conversationId: string | null) => void;
}

export const useNotifications = (): UseNotificationsResult => {
  const [tokens, setTokens] = useState<NotificationToken[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);
  const { refreshChannel, sendbirdInstance, isConnected } =
    useSendbirdContext();
  const dispatch = useDispatch();

  const handleTokenReceived = useCallback(
    (token: NotificationToken) => {
      setTokens((prev) => {
        const filtered = prev.filter((t) => t.tokenType !== token.tokenType);
        return [...filtered, token];
      });
      // Register VoIP token with backend so it can send VoIP push when app is background/killed.
      if (token.tokenType === "ios_voip" && token.token) {
        console.warn("[useNotifications] Dispatching VoIP token to backend via STORE_PUSH_ID", {
          tokenType: token.tokenType,
          tokenLength: token.token.length,
          token: token.token
        });
        dispatch({
          type: userActions.STORE_PUSH_ID,
          payload: {
            pushToken: token.token,
            tokenType: "ios_voip"
          }
        });
      }
    },
    [dispatch]
  );

  const handleSendbirdMessageReceived = useCallback(
    (channelUrl: string, unreadCount?: number) => {
      console.log(
        "🔄 [useNotifications] Sendbird message received, refreshing channel:",
        channelUrl,
        "unread:",
        unreadCount
      );
      refreshChannel(channelUrl, unreadCount);
    },
    [refreshChannel]
  );

  const handleFetchSendbirdMessage = useCallback(
    async (channelUrl: string, messageId: string) => {
      if (!sendbirdInstance || !isConnected) {
        console.warn(
          "⚠️ [useNotifications] Sendbird not connected, cannot fetch message"
        );
        return null;
      }

      try {
        // Get channel first.
        const channel = await sendbirdInstance.groupChannel.getChannel(
          channelUrl
        );
        if (!channel) {
          console.error("❌ [useNotifications] Channel not found:", channelUrl);
          return null;
        }

        // Fetch message.
        const message = await sendbirdInstance.message.getMessage({
          messageId: parseInt(messageId, 10),
          channelUrl: channelUrl,
          channelType: channel.channelType,
          includeThreadInfo: true,
          includeMetaArray: true,
          includeReactions: true
        });

        //@ts-ignore
        console.log(
          "✅ [useNotifications] Parent message fetched:",
          message?.messageId
        );
        return message;
      } catch (error) {
        console.error(
          "❌ [useNotifications] Error fetching Sendbird message:",
          error
        );
        return null;
      }
    },
    [sendbirdInstance, isConnected]
  );

  useEffect(() => {
    let mounted = true;

    let releaseHookListeners: (() => void) | undefined;

    if (Platform.OS === "ios") {
      releaseHookListeners = retainHookOwnedIosListeners(() => {
        const removeConversationListener =
          VoxoNotificationManager.addConversationUpdateListener((data) => {
            console.log(
              "📱 [useNotifications] iOS native conversation updated, fetching conversations for badge sync:",
              data.conversationId
            );
            dispatch(textActions.fetchConversations());
          });

        const removeSmsNotificationListener =
          VoxoNotificationManager.addSmsNotificationListener(async (data) => {
          console.log(
            "📱 [useNotifications] iOS SMS notification received for Notifee display:",
            data
          );

          try {
            const checkIfGif = (url: string): boolean => {
              const lowerUrl = url.toLowerCase();
              const urlWithoutQuery = lowerUrl.split("?")[0];
              return (
                urlWithoutQuery.endsWith(".gif") ||
                lowerUrl.includes("giphy") ||
                lowerUrl.includes("tenor.com") ||
                lowerUrl.includes("gph.is") ||
                lowerUrl.includes("/gif/") ||
                lowerUrl.includes(".gif")
              );
            };

            const normalizeMediaUrls = (raw: unknown): string[] => {
              if (!raw) return [];
              if (Array.isArray(raw)) {
                return raw
                  .map((u) => (typeof u === "string" ? u.trim() : ""))
                  .filter(Boolean);
              }
              if (typeof raw === "string") {
                const trimmed = raw.trim();
                if (!trimmed) return [];
                try {
                  const parsed = JSON.parse(trimmed);
                  if (Array.isArray(parsed)) {
                    return parsed
                      .map((u) => (typeof u === "string" ? u.trim() : ""))
                      .filter(Boolean);
                  }
                  if (typeof parsed === "string" && parsed.trim()) {
                    return [parsed.trim()];
                  }
                } catch {
                  // Some payloads are comma-separated URLs instead of JSON.
                  if (trimmed.includes(",")) {
                    return trimmed
                      .split(",")
                      .map((u) => u.trim())
                      .filter(Boolean);
                  }
                }
                return [trimmed];
              }
              return [];
            };

            // Determine notification body based on mediaUrls
            // Note: iOS push payload often doesn't include mediaUrls, so empty body = likely media
            let body = data.body || "";
            const mediaUrls = normalizeMediaUrls((data as any).mediaUrls);
            const firstMediaUrl = (mediaUrls[0] || "").toLowerCase();
            const bodyLooksLikeGif = checkIfGif(body || "");
            const mediaLooksLikeGif = checkIfGif(firstMediaUrl);

            if (!body.trim()) {
              // Check if we have mediaUrls to determine type
              if (mediaUrls.length > 0) {
                if (mediaLooksLikeGif) {
                  body = "Received a GIF 🎞️";
                  console.log("✅ [useNotifications] SMS GIF detected", {
                    source: "mediaUrls",
                    mediaUrlsCount: mediaUrls.length,
                    firstMediaUrl: firstMediaUrl.substring(0, 120)
                  });
                } else {
                  body = "Received an attachment 📎";
                  console.log(
                    "ℹ️ [useNotifications] SMS media detected but not GIF",
                    {
                      source: "mediaUrls",
                      mediaUrlsCount: mediaUrls.length,
                      firstMediaUrl: firstMediaUrl.substring(0, 120)
                    }
                  );
                }
              } else {
                // No mediaUrls in payload - default to attachment (most likely case for empty body SMS)
                body = bodyLooksLikeGif
                  ? "Received a GIF 🎞️"
                  : "Received an attachment 📎";
                console.log(
                  "📱 [useNotifications] SMS empty body classification fallback",
                  {
                    reason:
                      bodyLooksLikeGif && (body || "").trim()
                        ? "body_looks_like_gif_url"
                        : "no_media_urls_default_attachment",
                    bodyPreview: (data.body || "").substring(0, 120),
                    mediaUrlsCount: mediaUrls.length
                  }
                );
              }
            } else if (bodyLooksLikeGif) {
              body = "Received a GIF 🎞️";
              console.log(
                "✅ [useNotifications] SMS GIF detected from body text",
                {
                  source: "body",
                  bodyPreview: body.substring(0, 120)
                }
              );
            }

            const title = resolveSmsSenderDisplayName(data.from, data.peerName, {
              systemNotificationTitle: data.title,
              notificationBody: body,
              conversationId: data.conversationId
            });

            // Create notification channel
            const channelId = await notifee.createChannel({
              id: "voxo-sms-notifications",
              name: "SMS Notifications",
              importance: AndroidImportance.HIGH,
              vibration: true,
              sound: "default"
            });

            // Display notification via Notifee
            await notifee.displayNotification({
              title,
              body,
              android: {
                channelId,
                importance: AndroidImportance.HIGH,
                pressAction: { id: "default" },
                smallIcon: "ic_launcher",
                timestamp: Date.now(),
                showTimestamp: true,
                visibility: 1
              },
              ios: {
                sound: "default",
                interruptionLevel: "timeSensitive",
                foregroundPresentationOptions: {
                  alert: true,
                  badge: true,
                  sound: true,
                  banner: true,
                  list: true
                }
              },
              data: {
                click_action: "TEXT-RECEIVED",
                reference_id: data.conversationId,
                conversationId: data.conversationId,
                peerName: data.peerName,
                from: data.from
              }
            });

            console.log(
              "✅ [useNotifications] SMS notification displayed via Notifee:",
              { title, body }
            );

            // Also fetch conversations for badge sync
            dispatch(textActions.fetchConversations());
          } catch (error) {
            console.error(
              "❌ [useNotifications] Error displaying SMS notification:",
              error
            );
          }
        }, "smsNotificationHook");

        return () => {
          removeConversationListener?.();
          removeSmsNotificationListener?.();
        };
      });
    }

    NotificationManager.initialize({
      onTokenReceived: (token) => {
        if (mounted) handleTokenReceived(token);
      },
      onSendbirdMessageReceived: handleSendbirdMessageReceived,
      onFetchSendbirdMessage: handleFetchSendbirdMessage
    }).then(() => {
      if (mounted) {
        setIsInitialized(true);
        void VoxoNotificationManager.logListenerDiagnostics(
          "useNotifications.initialize.complete"
        );
      }
    });

    void VoxoNotificationManager.logListenerDiagnostics(
      "useNotifications.mount"
    );

    return () => {
      mounted = false;
      releaseHookListeners?.();
      // Don't destroy NotificationManager here - it should persist across re-renders
      // Destruction is handled by logout saga in authentication/sagas.ts
    };
  }, [
    handleTokenReceived,
    handleSendbirdMessageReceived,
    handleFetchSendbirdMessage,
    dispatch
  ]);

  const setViewingConversation = useCallback(
    (conversationId: string | null) => {
      NotificationManager.setViewingConversation(conversationId);
    },
    []
  );

  return {
    tokens,
    isInitialized,
    setViewingConversation
  };
};
