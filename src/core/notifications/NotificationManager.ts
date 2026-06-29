import messaging from "@react-native-firebase/messaging";
import { AppState, NativeModules, Platform } from "react-native";
import CallKeep from "react-native-callkeep";
import { USE_VOXO_MOBILE_APPROACH } from "../config/callApproach";
import VoipPushNotification from "react-native-voip-push-notification";
import VoxoNotificationManager from "./VoxoNotificationManager";
import notifee, { AndroidImportance, EventType } from "@notifee/react-native";
import { VoipBridge } from "../softphone/VoipBridge";
import {
  SlimSipClient,
  SipClientSettings
} from "../softphone/jssip/SlimSipClient";
import { store, rehydratePromise } from "../../store/global-store";
import PushNotificationIOS from "@react-native-community/push-notification-ios";
import {
  navigateOrReplace,
  getCurrentRoute,
  navigationRef
} from "../navigation/utils/Ref";
import { CommonActions } from "@react-navigation/native";
import { emitNavigateToMissedTab } from "../navigation/utils/MissedCallNavEvent.ts";
import { emitNavigateToVoicemailTab } from "../navigation/utils/VoicemailNavEvent.ts";
import { Routes } from "../navigation/types/types";
import { handleTextNotification } from "./TextNotificationHandler";
import * as textActions from "../../store/text/actions.ts";
import { getSmsLogicalDedupeKey } from "./smsNotificationDedup";
import { resolveSmsSenderDisplayName } from "./resolveSmsSenderDisplayName.ts";
import { getMessagesForConversation } from "../../shared/api/messaging/methods.ts";
import PendingCallManager from "./PendingCallManager";
import { showCallPickedElsewhereNotification } from "./callPickedElsewhereNotification";
import { getVoipPushAge, isVoipPushStaleDeclined } from "./voipPushStaleCheck";
import {
  extractCallUuidFromMissedCallPayload,
  markMissedCallHandledByServer,
  resolveMissedCallCallerLabel,
  scheduleStaleVoipMissedCallFallback
} from "./staleVoipMissedCallFallback";
import { isAnsweredElsewhereSessionFailed } from "../softphone/utils/session-failed-reason";
import { notifySipBackendCallDiscovered } from "../softphone/sipBackendCallIdBridge.ts";
import {
  extractSendbirdMessageIdFromRemoteMessage,
  recordSendbirdLocalNotifeeShown,
  recordSendbirdMessageFromSystemPush,
  shouldSkipIosDuplicateLocalBanner
} from "../../features/chat/utils/sendbirdNotificationDedup.ts";
import { shouldShowSendbirdNotification } from "../../features/chat/utils/sendbirdNotificationPrefs.ts";
import {
  extractSendbirdChannelUrlFromPressPayload,
  normalizeNotificationPressPayload
} from "./notificationPressPayload.ts";

export type NotificationToken = {
  token: string;
  tokenType: "android_fcm" | "ios_remote_notifications" | "ios_voip";
  timestamp: number;
};

export type VoipCallData = {
  callUuid: string;
  callerName: string;
  callerNumber: string;
  payload: any;
};

export type NotificationManagerCallbacks = {
  onTokenReceived?: (token: NotificationToken) => void;
  onNotification?: (remoteMessage: any) => void;
  onNotificationPressed?: (payload: any) => void;
  onConversationUpdated?: (data: { conversationId: string }) => void;
  onVoipCallReceived?: (callData: VoipCallData) => void;
  onSendbirdMessageReceived?: (
    channelUrl: string,
    unreadCount?: number
  ) => void;
  onFetchSendbirdMessage?: (
    channelUrl: string,
    messageId: string
  ) => Promise<any>;
};

const getSuppressedCallKeepEndSet = (): Set<string> => {
  const g = global as any;
  if (!g.__voxoSuppressCallKeepEndUuids) {
    g.__voxoSuppressCallKeepEndUuids = new Set<string>();
  }
  return g.__voxoSuppressCallKeepEndUuids as Set<string>;
};

class NotificationManager {
  private callbacks?: NotificationManagerCallbacks;
  private displayedNotifications: Set<string> = new Set();
  private processedSendbirdMessages: Set<string> = new Set();
  private readonly NOTIFICATION_CACHE_SIZE = 50;
  private voipToken: string | null = null;
  private androidChannelId: string = "voxo-notifications";
  private isDestroyed: boolean = false;
  private isInitialized: boolean = false;
  private notifeeListenersAttached: boolean = false;
  private iosKilledStateHandlersAttached: boolean = false;
  private iosPendingFlushSub: ReturnType<typeof AppState.addEventListener> | null =
    null;
  private iosDeliveredDedupSub: ReturnType<
    typeof AppState.addEventListener
  > | null = null;
  private voipPushListenersAttached: boolean = false;

  private ensureVoipPushListeners(): void {
    if (Platform.OS !== "ios" || this.voipPushListenersAttached) {
      return;
    }
    this.registerForVoipToken();
    this.setupVoipPushListeners();
    this.voipPushListenersAttached = true;
  }

  private safeJsonForLog(value: unknown, maxChars: number = 8000): string {
    try {
      const seen = new WeakSet<object>();
      const json = JSON.stringify(
        value,
        (_k, v) => {
          if (typeof v === "bigint") return v.toString();
          if (v && typeof v === "object") {
            const obj = v as object;
            if (seen.has(obj)) return "[Circular]";
            seen.add(obj);
          }
          return v;
        },
        2
      );
      if (typeof json !== "string") return String(json);
      if (json.length <= maxChars) return json;
      return `${json.slice(0, maxChars)}\n…[truncated ${json.length - maxChars} chars]`;
    } catch (e) {
      return `[unserializable payload: ${String(e)}]`;
    }
  }

  /**
   * Re-bind iOS native event listeners after JS reload or bridge detach.
   * Safe to call multiple times; idempotent per call.
   */
  ensureIosNativeListeners(): void {
    if (Platform.OS !== "ios" || this.isDestroyed) {
      return;
    }
    VoxoNotificationManager.ensureNativeModuleWithRetry(() => {
      this.attachNotifeeListenersIfNeeded();
      this.attachIosKilledStateHandlersIfNeeded();
      this.setupNativeNotificationListeners();
      void VoxoNotificationManager.flushPendingNativeEvents();
      this.attachIosPendingFlushOnActive();
    });
  }

  private attachIosKilledStateHandlersIfNeeded(): void {
    if (this.iosKilledStateHandlersAttached) {
      return;
    }
    this.setupIosKilledStateNotificationHandlers();
    this.iosKilledStateHandlersAttached = true;
  }

  /**
   * Entry for index.js Notifee background handler and other out-of-tree callers.
   */
  handleExternalNotificationPress(
    payload: unknown,
    isKilledState: boolean = false
  ): void {
    if (this.isDestroyed) {
      return;
    }
    const normalized = normalizeNotificationPressPayload(payload);
    console.log("[NotificationManager] handleExternalNotificationPress", {
      channelUrl: normalized.channelUrl,
      click_action: normalized.click_action,
      isKilledState
    });
    this.handleNotificationPressWithRetry(normalized, 0, isKilledState);
  }

  private attachNotifeeListenersIfNeeded(): void {
    if (this.notifeeListenersAttached) {
      return;
    }
    this.setupNotifeeListeners();
    this.notifeeListenersAttached = true;
  }

  private attachIosPendingFlushOnActive(): void {
    if (Platform.OS !== "ios") {
      return;
    }
    if (this.iosPendingFlushSub) {
      return;
    }
    this.iosPendingFlushSub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        // Fast Refresh / background can drop NativeEventEmitter subscriptions.
        this.setupNativeNotificationListeners();
        void VoxoNotificationManager.flushPendingNativeEvents();
      }
    });
  }

  async initialize(callbacks: NotificationManagerCallbacks) {
    this.isDestroyed = false;
    this.callbacks = callbacks;

    // Always re-bind iOS native listeners (bridge reload drops them while flags may persist).
    if (Platform.OS === "ios") {
      this.ensureIosNativeListeners();
      // Wire VoIP + didLoadWithEvents before slow permission/token awaits (killed stale replay).
      this.ensureVoipPushListeners();
    }

    if (this.isInitialized) {
      return;
    }

    this.attachNotifeeListenersIfNeeded();

    await this.requestPermissions();
    await this.getPushToken();

    if (Platform.OS === "ios") {
      this.setupIosSendbirdPushDedup();
    } else if (Platform.OS === "android") {
      await this.createAndroidNotificationChannel();
      // Set up Android-specific notification handlers
      this.setupAndroidNotificationHandlers();
    }

    this.listenForTokenRefresh();
    this.listenForNotifications();
    this.isInitialized = true;
  }

  /**
   * Centralized notification press handler
   * Handles navigation for all notification types
   * Uses replace() to ensure navigation works even when already on a chat/thread screen
   */
  /**
   * Navigate to chat with retry logic
   * This is needed when app is launching from background/killed state
   */
  private navigateToChatWithRetry(
    conversationId: number,
    attempt: number = 0
  ): void {
    const maxAttempts = 20; // Keep high for reliability
    const delay = 200; // Reduced from 250ms to 200ms for faster checks

    if (attempt >= maxAttempts) {
      console.error(
        "❌ [NotificationManager] Failed to navigate to chat after",
        maxAttempts,
        "attempts"
      );
      return;
    }

    // Check if navigation is ready
    const currentRoute = getCurrentRoute();
    if (currentRoute) {
      // Navigation is ready, navigate now
      console.log(
        "✅ [NotificationManager] Navigation ready, navigating to chat:",
        conversationId,
        "attempt:",
        attempt + 1
      );
      navigateOrReplace(Routes.Chat, { conversationId } as any);
    } else {
      // Navigation not ready yet, retry after delay
      console.log(
        "⏳ [NotificationManager] Navigation not ready yet, retrying in",
        delay,
        "ms (attempt",
        attempt + 1,
        "of",
        maxAttempts,
        ")"
      );
      setTimeout(() => {
        this.navigateToChatWithRetry(conversationId, attempt + 1);
      }, delay);
    }
  }

  /**
   * Navigate to Sendbird chat with retry logic
   * This is needed when app is launching from background/killed state
   */
  private navigateToSendbirdChatWithRetry(
    channelUrl: string,
    attempt: number = 0,
    parentMessageId?: string,
    scrollToMessageId?: string
  ): void {
    const maxAttempts = 15; // Keep high for reliability
    const delay = 200; // Reduced from 250ms to 200ms for faster checks

    if (attempt >= maxAttempts) {
      console.error(
        "❌ [NotificationManager] Failed to navigate to Sendbird chat after",
        maxAttempts,
        "attempts"
      );
      return;
    }

    // Check if navigation is ready
    const currentRoute = getCurrentRoute();
    if (currentRoute) {
      // Navigation is ready, navigate now
      console.log(
        "✅ [NotificationManager] Navigation ready, navigating to Sendbird chat:",
        channelUrl,
        parentMessageId ? `with thread ${parentMessageId}` : "",
        scrollToMessageId ? `scrollTo ${scrollToMessageId}` : "",
        "attempt:",
        attempt + 1
      );

      // Always navigate to Chat, even for thread notifications
      // Pass parentMessageId so Chat can scroll to that message (not open Threads)
      navigateOrReplace(Routes.Chat, {
        channelUrl,
        ...(parentMessageId
          ? { parentMessageId: parentMessageId.toString() }
          : {}),
        ...(scrollToMessageId ? { scrollToMessageId } : {})
      } as any);

      // Verify navigation succeeded after a short delay, retry if not (same as SMS)
      setTimeout(() => {
        const newRoute = getCurrentRoute();
        const routeParams = newRoute?.params as any;
        const isOnTargetRoute =
          newRoute?.name === Routes.Chat &&
          routeParams?.channelUrl === channelUrl;

        if (!isOnTargetRoute && attempt < maxAttempts - 1) {
          console.warn(
            "⚠️ [NotificationManager] Navigation verification failed, retrying in",
            delay,
            "ms (attempt",
            attempt + 2,
            "of",
            maxAttempts,
            ")",
            {
              currentRoute: newRoute?.name,
              expectedRoute: Routes.Chat,
              currentChannelUrl: routeParams?.channelUrl,
              targetChannelUrl: channelUrl
            }
          );
          setTimeout(() => {
            this.navigateToSendbirdChatWithRetry(
              channelUrl,
              attempt + 1,
              parentMessageId,
              scrollToMessageId
            );
          }, delay);
        } else if (isOnTargetRoute) {
          console.log(
            "✅ [NotificationManager] Channel navigation verified successfully"
          );
        }
      }, 100);
    } else {
      // Navigation not ready yet, retry after delay
      console.log(
        "⏳ [NotificationManager] Navigation not ready yet, retrying in",
        delay,
        "ms (attempt",
        attempt + 1,
        "of",
        maxAttempts,
        ")"
      );
      setTimeout(() => {
        this.navigateToSendbirdChatWithRetry(
          channelUrl,
          attempt + 1,
          parentMessageId,
          scrollToMessageId
        );
      }, delay);
    }
  }

  /**
   * Navigate to Inbox → Missed tab (used when user taps a missed call notification).
   * Uses retry logic when app is launching from killed/background state.
   */
  private navigateToMissedCallsTab(attempt: number = 0): void {
    const maxAttempts = 20;
    const delay = 200;

    if (attempt >= maxAttempts) {
      console.error(
        "❌ [NotificationManager] Failed to navigate to Missed calls tab after",
        maxAttempts,
        "attempts"
      );
      return;
    }

    const currentRoute = getCurrentRoute();
    if (currentRoute) {
      console.log(
        "✅ [NotificationManager] Navigation ready, navigating to Missed calls tab (attempt:",
        attempt + 1,
        ")"
      );
      navigationRef.dispatch(
        CommonActions.navigate({
          name: Routes.BottomTabNavigator,
          params: {
            screen: Routes.Inbox
          }
        })
      );
      setTimeout(() => {
        emitNavigateToMissedTab();
      }, 300);
    } else {
      console.log(
        "⏳ [NotificationManager] Navigation not ready yet, retrying Missed calls in",
        delay,
        "ms (attempt",
        attempt + 1,
        "of",
        maxAttempts,
        ")"
      );
      setTimeout(() => this.navigateToMissedCallsTab(attempt + 1), delay);
    }
  }

  /**
   * Navigate to Inbox → Voicemails tab (used when user taps a voicemail notification).
   * Uses retry logic when app is launching from killed/background state.
   */
  private navigateToVoicemailsTab(attempt: number = 0): void {
    const maxAttempts = 20;
    const delay = 200;

    if (attempt >= maxAttempts) {
      console.error(
        "❌ [NotificationManager] Failed to navigate to Voicemails tab after",
        maxAttempts,
        "attempts"
      );
      return;
    }

    const currentRoute = getCurrentRoute();
    if (currentRoute) {
      console.log(
        "✅ [NotificationManager] Navigation ready, navigating to Voicemails tab (attempt:",
        attempt + 1,
        ")"
      );
      navigationRef.dispatch(
        CommonActions.navigate({
          name: Routes.BottomTabNavigator,
          params: {
            screen: Routes.Inbox
          }
        })
      );
      setTimeout(() => {
        emitNavigateToVoicemailTab();
      }, 300);
    } else {
      console.log(
        "⏳ [NotificationManager] Navigation not ready yet, retrying Voicemails in",
        delay,
        "ms (attempt",
        attempt + 1,
        "of",
        maxAttempts,
        ")"
      );
      setTimeout(() => this.navigateToVoicemailsTab(attempt + 1), delay);
    }
  }

  /**
   * Navigate to thread with proper delay to avoid timing issues.
   * First navigates to channel, waits for it to load, then fetches parent message and navigates to thread.
   */
  private async navigateToThreadWithDelay(
    channelUrl: string,
    parentMessageId: string,
    scrollToMessageId?: string
  ): Promise<void> {
    try {
      console.log(
        "🧭 [NotificationManager] Navigating to Threads with delay:",
        {
          channelUrl,
          parentMessageId,
          scrollToMessageId
        }
      );

      // Step 1: Navigate to Chat first to ensure channel is loaded
      navigateOrReplace(Routes.Chat, { channelUrl } as any);

      // Step 2: Wait for Chat screen to mount and channel to be ready (optimized delay)
      await new Promise((resolve) => setTimeout(resolve, 800));

      // Step 3: Fetch parent message with retries
      let parentMessage = null;
      const maxRetries = 3;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (this.callbacks?.onFetchSendbirdMessage) {
          try {
            parentMessage = await this.callbacks.onFetchSendbirdMessage(
              channelUrl,
              parentMessageId
            );
            if (parentMessage) {
              // console.log("✅ [NotificationManager] Parent message fetched on attempt:", attempt + 1);
              break;
            }
          } catch (_error) {
            // console.error("❌ [NotificationManager] Failed to fetch parent message, attempt:", attempt + 1, _error);
          }
        }
        if (!parentMessage && attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      if (!parentMessage) {
        // console.error("❌ [NotificationManager] Could not fetch parent message after retries, cannot navigate to thread");
        return;
      }

      // Step 4: Wait longer to ensure channel and messages are fully loaded (avoid skeleton)
      await new Promise((resolve) => setTimeout(resolve, 500)); // Reduced from 1000ms to 500ms for faster navigation

      // Step 5: Navigate to Threads with parent message
      console.log("🧭 [NotificationManager] Navigating to Threads screen:", {
        channelUrl,
        parentMessageId: parentMessage.messageId,
        scrollToMessageId
      });

      navigateOrReplace(Routes.Threads, {
        channelUrl,
        parentMessage,
        offset: 10,
        ...(scrollToMessageId ? { scrollToMessageId } : {})
      } as any);

      console.log("✅ [NotificationManager] Thread navigation completed");
    } catch (_error) {
      console.error(
        "❌ [NotificationManager] Error navigating to thread:",
        _error
      );
    }
  }

  private handleNotificationPress(payload: any): void {
    // ✅ CRITICAL: Stop processing notifications if destroyed (user logged out)
    if (this.isDestroyed) {
      console.warn(
        "🚫 [NotificationManager] Ignoring notification press - NotificationManager destroyed (user logged out)"
      );
      return;
    }

    payload = normalizeNotificationPressPayload(payload);

    console.warn("🔔 [NotificationManager] Notification pressed:", {
      payload,
      hasData: !!payload?.data,
      dataKeys: payload?.data ? Object.keys(payload.data) : [],
      allKeys: payload ? Object.keys(payload) : [],
      payloadString: JSON.stringify(payload, null, 2)
    });

    if (!payload) {
      console.warn("⚠️ [NotificationManager] No payload received");
      return;
    }

    try {
      // Normalize payload structure - handle both iOS and Android formats
      // iOS: payload.data contains the actual data
      // Android: payload contains data directly
      const normalizedData = payload.data || payload;

      const title = payload.title ?? normalizedData?.title ?? "";
      const body = payload.body ?? normalizedData?.body ?? "";
      const text = `${title} ${body}`.toLowerCase();
      const navClickAction =
        payload.click_action ??
        payload.clickAction ??
        normalizedData?.click_action ??
        normalizedData?.clickAction ??
        normalizedData?.vm_payload_type;

      const isMissedCallPayload =
        navClickAction === "CALL-EVENT-MISSED" ||
        navClickAction === "MISSED-CALL" ||
        navClickAction === "missed-call" ||
        navClickAction === "MISSED-CALL-RECEIVED" ||
        navClickAction === "missed_call" ||
        normalizedData?.vm_payload_type === "missed_call";

      // CRITICAL: Ignore incoming call notifications - just bring app to foreground.
      // CallKeep handles the call UI, we don't navigate to InCallScreen.
      // Stale/local missed-call Notifee alerts include callUuid — must not match here.
      const isIncomingCall =
        !isMissedCallPayload &&
        (normalizedData?.vm_payload_type === "incoming_call_notification" ||
          normalizedData?.callUuid ||
          payload?.callUuid);
      if (isIncomingCall) {
        console.log(
          "📞 [NotificationManager] Ignoring incoming call notification press - CallKeep handles UI"
        );
        return;
      }
      const callCancelReason =
        payload.callCancelReason ?? normalizedData?.callCancelReason;

      // Voicemail: check FIRST (before missed call) - voicemail uses callCancelReason: "newVoicemail"
      // which would otherwise be mistaken for a missed call.
      const isVoicemail =
        navClickAction === "VOICEMAIL-EVENT-RECEIVE" ||
        navClickAction === "VOICEMAIL-RECEIVED" ||
        navClickAction === "voicemail-received" ||
        callCancelReason === "newVoicemail" ||
        text.includes("voicemail received");
      if (isVoicemail) {
        if (getCurrentRoute()?.name !== Routes.Voicemails) {
          this.navigateToVoicemailsTab(0);
        }
        return;
      }

      // Missed call: navigate to call history (Missed tab)
      const isMissedCall =
        isMissedCallPayload ||
        (callCancelReason !== undefined &&
          callCancelReason !== "newVoicemail") ||
        text.includes("missed call");
      if (isMissedCall) {
        const missedCallUuid = extractCallUuidFromMissedCallPayload({
          ...(normalizedData || {}),
          ...(payload || {})
        });
        if (missedCallUuid) {
          markMissedCallHandledByServer(missedCallUuid);
        }
        if (getCurrentRoute()?.name !== Routes.Missed) {
          this.navigateToMissedCallsTab(0);
        }
        return;
      }

      // No payload: redirect to Voicemails (e.g. generic "New Message" with empty data).
      const hasChannelUrl = !!(
        normalizedData?.channelUrl || payload.channelUrl
      );
      const hasConversationId = !!(
        normalizedData?.reference_id ||
        normalizedData?.referenceId ||
        normalizedData?.conversationId ||
        normalizedData?.conversation_id ||
        payload.reference_id ||
        payload.referenceId ||
        payload.conversationId ||
        payload.conversation_id
      );
      const hasSendbird = !!(normalizedData?.sendbird || payload.sendbird);
      const hasIdentifyingPayload =
        hasChannelUrl || hasConversationId || hasSendbird;
      if (!hasIdentifyingPayload) {
        if (getCurrentRoute()?.name !== Routes.Voicemails) {
          this.navigateToVoicemailsTab(0);
        }
        return;
      }

      // Handle text message notifications
      // Check both top-level and nested data structure (iOS vs Android)
      const clickAction =
        normalizedData.click_action ||
        normalizedData.clickAction ||
        payload.click_action ||
        payload.clickAction ||
        payload.type ||
        payload.data?.click_action ||
        payload.data?.clickAction;

      const conversationIdStr =
        normalizedData.reference_id ||
        normalizedData.referenceId ||
        normalizedData.conversationId ||
        normalizedData.conversation_id ||
        payload.reference_id ||
        payload.referenceId ||
        payload.conversationId ||
        payload.conversation_id ||
        payload.data?.reference_id ||
        payload.data?.referenceId ||
        payload.data?.conversationId ||
        payload.data?.conversation_id;

      console.warn("📱 [NotificationManager] Checking for SMS notification:", {
        clickAction,
        conversationIdStr,
        hasClickAction: !!clickAction,
        hasConversationId: !!conversationIdStr,
        allPayloadKeys: Object.keys(payload || {}),
        hasDataObject: !!payload.data,
        dataKeys: payload.data ? Object.keys(payload.data) : []
      });

      const isTextNotification =
        clickAction === "TEXT-RECEIVED" ||
        clickAction === "text-received" ||
        !!conversationIdStr ||
        (normalizedData.messageId && normalizedData.from) || // Fallback: if it has messageId and from, it's likely SMS
        (payload.messageId && payload.from) ||
        (payload.data?.messageId && payload.data?.from);

      if (isTextNotification && conversationIdStr) {
        console.warn(
          "📱 [NotificationManager] Text notification detected - navigating to chat:",
          conversationIdStr
        );
        const conversationId = parseInt(conversationIdStr.toString(), 10);
        if (!isNaN(conversationId) && conversationId > 0) {
          const currentRoute = getCurrentRoute();
          const currentConversationId = (currentRoute?.params as any)
            ?.conversationId;

          // Check if already viewing this conversation on either Chat or TextThread route
          const isAlreadyOnConversation =
            (currentRoute?.name === Routes.Chat ||
              currentRoute?.name === Routes.TextThread) &&
            currentConversationId === conversationId;

          if (isAlreadyOnConversation) {
            console.warn(
              "📱 [NotificationManager] Already viewing this conversation, skipping navigation"
            );
            return;
          }

          console.warn(
            "📱 [NotificationManager] Navigating to Chat with conversationId:",
            conversationId,
            "from route:",
            currentRoute?.name
          );

          // Use Routes.Chat for consistency with personal contacts navigation
          // Wait for navigation to be ready, especially when app is launching from background
          this.navigateToChatWithRetry(conversationId, 0);
          return;
        } else {
          console.error(
            "❌ [NotificationManager] Invalid conversation ID:",
            conversationIdStr,
            "parsed as:",
            conversationId
          );
        }
      } else {
        console.warn(
          "ℹ️ [NotificationManager] Not a text notification or missing conversationId",
          {
            isTextNotification,
            hasConversationId: !!conversationIdStr,
            clickAction,
            payloadKeys: Object.keys(payload || {}),
            messageId: payload.messageId || payload.data?.messageId,
            from: payload.from || payload.data?.from
          }
        );
      }

      // Handle Sendbird chat notifications
      // Check for Notifee format first (channelUrl directly in payload).
      // When coming from Notifee foreground event, data is already at the top level
      const notifeeChannelUrl =
        normalizedData.channelUrl ||
        payload.channelUrl ||
        payload.data?.channelUrl;
      const notifeeClickAction =
        normalizedData.click_action ||
        normalizedData.clickAction ||
        payload.click_action ||
        payload.clickAction ||
        payload.data?.click_action;

      console.log(
        "🔍 [NotificationManager] Checking for Sendbird notification:",
        {
          notifeeChannelUrl,
          notifeeClickAction,
          normalizedDataKeys: Object.keys(normalizedData || {}),
          payloadKeys: Object.keys(payload || {}),
          hasDataKey: !!payload.data
        }
      );

      // Check for nested Sendbird format.
      let sendbirdData;
      const sendbirdValue = payload.sendbird || payload.data?.sendbird;
      if (sendbirdValue) {
        try {
          sendbirdData =
            typeof sendbirdValue === "string"
              ? JSON.parse(sendbirdValue)
              : sendbirdValue;
        } catch (e) {
          console.warn(
            "[NotificationManager] Failed to parse sendbird payload:",
            e
          );
        }
      }

      // Get channelUrl from either Notifee format or nested Sendbird format.
      let channelUrl: string | undefined;
      let parentMessageId: string | undefined;
      let scrollToMessageId: string | undefined;

      if (notifeeChannelUrl && notifeeClickAction === "SENDBIRD-RECEIVED") {
        // Notifee format - channelUrl is directly in payload.
        channelUrl = notifeeChannelUrl;
        parentMessageId =
          normalizedData.parentMessageId ||
          normalizedData.parent_message_id ||
          normalizedData.parentMessage?.messageId?.toString() ||
          payload.parentMessageId ||
          payload.parent_message_id ||
          payload.parentMessage?.messageId?.toString() ||
          payload.data?.parentMessageId ||
          payload.data?.parent_message_id;
        // Get messageId for scrolling to specific message (e.g., reacted message in thread)
        scrollToMessageId =
          normalizedData.messageId ||
          payload.messageId ||
          payload.data?.messageId;
      } else if (sendbirdData?.channel?.channel_url) {
        // Nested Sendbird format.
        channelUrl = sendbirdData.channel.channel_url;
        parentMessageId =
          sendbirdData.parent_message_id ||
          sendbirdData.parentMessageId ||
          payload.data?.parentMessageId;
        console.log(
          "💬 [NotificationManager] Detected nested Sendbird notification format:",
          { channelUrl, parentMessageId }
        );
      }

      if (!channelUrl) {
        channelUrl = extractSendbirdChannelUrlFromPressPayload(payload);
        if (channelUrl) {
          console.log(
            "💬 [NotificationManager] Resolved Sendbird channelUrl from normalized payload:",
            channelUrl
          );
        }
      }

      // Fallback: If we have channelUrl but no click_action or different click_action,
      // and it's not a text notification, assume it's a Sendbird notification
      // This handles cases where Notifee notifications might not have click_action set correctly
      if (!channelUrl && notifeeChannelUrl && !isTextNotification) {
        // Only if it's definitely not a text notification and we have channelUrl
        channelUrl = notifeeChannelUrl;
        parentMessageId =
          normalizedData.parentMessageId ||
          normalizedData.parent_message_id ||
          payload.parentMessageId ||
          payload.parent_message_id ||
          payload.data?.parentMessageId;
        scrollToMessageId =
          normalizedData.messageId ||
          payload.messageId ||
          payload.data?.messageId;
        console.log(
          "💬 [NotificationManager] Using channelUrl as Sendbird notification (missing/incorrect click_action, assuming Sendbird):",
          {
            channelUrl,
            parentMessageId,
            clickAction: notifeeClickAction,
            isTextNotification
          }
        );
      }

      if (channelUrl) {
        console.log(
          "💬 [NotificationManager] Sendbird notification - navigating to chat:",
          channelUrl,
          parentMessageId
            ? `(will scroll to parent message: ${parentMessageId})`
            : ""
        );

        const currentRoute = getCurrentRoute();
        const currentChannelUrl = (currentRoute?.params as any)?.channelUrl;
        const currentParentMessageId = (currentRoute?.params as any)
          ?.parentMessageId;

        // Only skip if already viewing the exact same channel and same parent message in Chat
        if (
          currentRoute?.name === Routes.Chat &&
          currentChannelUrl === channelUrl &&
          (!parentMessageId ||
            currentParentMessageId?.toString() === parentMessageId.toString())
        ) {
          console.log(
            "[NotificationManager] Already viewing this channel/message in Chat, skipping navigation",
            {
              currentRoute: currentRoute?.name,
              currentChannelUrl,
              targetChannelUrl: channelUrl,
              currentParentMessageId,
              targetParentMessageId: parentMessageId
            }
          );
          return;
        }

        console.log("[NotificationManager] Navigating to Sendbird Chat:", {
          currentRoute: currentRoute?.name,
          currentChannelUrl,
          targetChannelUrl: channelUrl,
          hasParentMessageId: !!parentMessageId,
          willNavigate: true
        });

        // If parentMessageId exists, navigate to Threads screen
        // Otherwise, navigate to Chat (with optional scrollToMessageId for reactions)
        if (parentMessageId) {
          this.navigateToThreadWithDelay(
            channelUrl,
            parentMessageId,
            scrollToMessageId
          );
        } else {
          this.navigateToSendbirdChatWithRetry(
            channelUrl,
            0,
            undefined,
            scrollToMessageId
          );
        }
      } else {
        console.warn(
          "⚠️ [NotificationManager] Sendbird notification detected but no channelUrl found:",
          {
            normalizedData,
            payload,
            notifeeChannelUrl,
            notifeeClickAction,
            hasSendbirdData: !!sendbirdData
          }
        );
      }
    } catch (error) {
      console.error(
        "❌ [NotificationManager] Error handling notification press:",
        error
      );
    }
  }

  /**
   * Convert APNs `userInfo` (from native willPresent) into an FCM-shaped message for displayNotification.
   */
  private apnsUserInfoToRemoteMessage(userInfo: Record<string, unknown>): {
    messageId: string;
    data: Record<string, unknown>;
    notification?: { title?: string; body?: string };
  } {
    const data: Record<string, unknown> = {};
    const nested = userInfo.data;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      Object.assign(data, nested as Record<string, unknown>);
    }
    const topKeys = [
      "sendbird",
      "click_action",
      "channelUrl",
      "reference_id",
      "messageId",
      "ignorePush",
      "mediaUrls",
      "media_urls",
      "title",
      "body",
      "from",
      "peerName",
      "text"
    ];
    for (const k of topKeys) {
      const v = userInfo[k];
      if (v !== undefined && v !== null) {
        data[k] = v;
      }
    }
    const gcmId =
      (userInfo["gcm.message_id"] as string) ||
      (userInfo["google.message_id"] as string);
    if (gcmId) {
      data["gcm.message_id"] = gcmId;
    }
    const aps = userInfo.aps as Record<string, unknown> | undefined;
    let title: string | undefined;
    let body: string | undefined;
    const alert = aps?.alert;
    if (typeof alert === "string") {
      body = alert;
    } else if (alert && typeof alert === "object") {
      const al = alert as Record<string, unknown>;
      title = (al.title as string) || undefined;
      body = (al.body as string) || undefined;
    }
    const notificationBlock =
      title || body ? { title: title || "", body: body || "" } : undefined;
    const smsStableId = getSmsLogicalDedupeKey({
      data,
      notification: notificationBlock,
      messageId: gcmId
    });
    const messageId =
      gcmId ||
      (data.messageId as string) ||
      (userInfo.messageId as string) ||
      smsStableId ||
      `apns-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    return {
      messageId,
      data,
      notification: notificationBlock
    };
  }

  /**
   * Foreground remote APNs: native suppresses system UI and forwards payload here; Notifee shows banner + sound.
   */
  private async handleIosRemoteNotificationForNotifee(payload: {
    userInfo: Record<string, unknown>;
  }): Promise<void> {
    if (this.isDestroyed || !payload?.userInfo) {
      return;
    }
    try {
      const state = store.getState();
      const isLoggedIn = (state as any)?.authReducer?.isLoggedIn;
      const user = (state as any)?.userReducer?.user;
      if (!isLoggedIn || !user?.id) {
        return;
      }
    } catch {
      return;
    }

    const rm = this.apnsUserInfoToRemoteMessage(payload.userInfo);

    const remoteMessage = {
      messageId: rm.messageId,
      data: rm.data,
      notification: rm.notification
    };

    const sendbirdMid =
      extractSendbirdMessageIdFromRemoteMessage(remoteMessage);

    this.logSendbirdHtmlTrace("handleIosRemoteNotificationForNotifee.enter", {
      appState: AppState.currentState,
      sendbirdMessageId: sendbirdMid,
      fcmMessageId: remoteMessage.messageId,
      notificationTitle: remoteMessage.notification?.title,
      notificationBody: remoteMessage.notification?.body,
      dataMessage: remoteMessage.data?.message,
      dataBody: remoteMessage.data?.body,
      hasSendbirdInData: !!remoteMessage.data?.sendbird,
      notificationBodyLooksHtml: this.bodyLooksLikeHtml(
        String(remoteMessage.notification?.body ?? "")
      )
    });

    // Foreground: Sendbird WebSocket delivers the message and displaySendbirdNotification
    // shows the correct Notifee banner. Native still forwards the same APNs here — skip
    // duplicate Notifee (and wrong "Sent a message" body from processNotificationContent).
    if (
      Platform.OS === "ios" &&
      AppState.currentState === "active" &&
      sendbirdMid != null
    ) {
      console.log(
        "[NotificationManager] iOS foreground Sendbird push — skip Notifee (SDK onMessageReceived handles banner)",
        {
          sendbirdMessageId: sendbirdMid,
          fcmMessageId: remoteMessage.messageId
        }
      );
      return;
    }

    // Background/inactive: SDK may have already reserved this Sendbird id in MMKV before Notifee awaits.
    if (Platform.OS === "ios" && sendbirdMid != null) {
      const { skip, reason } = shouldSkipIosDuplicateLocalBanner(
        sendbirdMid,
        undefined
      );
      if (skip) {
        console.log(
          "[IOS_NOTIF_SOUND_TRACE] handleIosRemoteNotificationForNotifee.skip",
          {
            sendbirdMessageId: sendbirdMid,
            reason,
            fcmMessageId: remoteMessage.messageId
          }
        );
        return;
      }
    }

    console.log(
      "🔔 [NotificationManager] iOS APNs → Notifee (native UI suppressed)",
      {
        messageId: remoteMessage.messageId,
        click_action: remoteMessage.data?.click_action
      }
    );
    console.log(
      "📦 [iOS APNs→Notifee] Full remoteMessage (truncated):\n" +
        this.safeJsonForLog(
          {
            messageId: remoteMessage?.messageId,
            notification: remoteMessage?.notification,
            data: remoteMessage?.data
          },
          12000
        )
    );
    console.log(
      "[IOS_NOTIF_SOUND_TRACE] onRemoteNotificationForNotifee → displayNotification",
      {
        sendbirdMessageId: sendbirdMid,
        fcmMessageId: remoteMessage.messageId
      }
    );

    await this.displayNotification(remoteMessage);
  }

  /**
   * Setup native notification listeners for iOS
   * Keeps only essential native listeners
   */
  private setupNativeNotificationListeners(): void {
    console.log(
      "📱 [NotificationManager] Setting up iOS native notification listeners at:",
      new Date().toISOString()
    );

    VoxoNotificationManager.addRemoteNotificationForNotifeeListener(
      (payload) => {
        void this.handleIosRemoteNotificationForNotifee(payload);
      }
    );

    // Listen for notification press events from native module
    VoxoNotificationManager.addNotificationPressListener(
      (payload) => {
        const normalized = normalizeNotificationPressPayload(payload);
        console.log(
          "📱 [NotificationManager] ✅ iOS notification press received from native module:",
          {
            payload: normalized,
            hasPayload: !!normalized,
            payloadKeys: normalized ? Object.keys(normalized) : [],
            channelUrl: normalized.channelUrl,
            click_action: normalized.click_action,
            hasSendbird: !!normalized?.sendbird,
            timestamp: new Date().toISOString()
          }
        );

        if (AppState.currentState === "active") {
          this.handleNotificationPressForActiveApp(normalized);
          return;
        }

        const isKilledState = !getCurrentRoute();
        this.handleNotificationPressWithRetry(normalized, 0, isKilledState);
      }
    );

    // Listen for onCallEndedRemotely (CALL-EVENT-MISSED push - caller hung up, timeout, etc)
    // Native dismisses CallKit; we clean up VoipBridge and app state so call screen goes away
    VoxoNotificationManager.addCallEndedRemotelyListener(({ callUUID }) => {
      console.warn(
        `📞 [NotificationManager] onCallEndedRemotely: cleaning up call ${callUUID}`
      );
      if (callUUID) {
        markMissedCallHandledByServer(callUUID);
      }
      const voipBridge = VoipBridge.getInstance();
      if (voipBridge.isVoipCall(callUUID)) {
        voipBridge.handleCallEnd(callUUID);
      }
    });

    // Listen for SMS notifications with ignorePush=true (foreground APNs)
    // This allows immediate badge update when notification is suppressed
    const removeSMSListener = VoxoNotificationManager.addSmsNotificationListener(
      (payload: any) => {
        console.log(
          "📱 [NotificationManager] SMS notification received (ignorePush=true), processing for badge update:",
          payload
        );

        // Process notification immediately to update Redux and badge
        const notificationData = {
          data: payload.data || payload,
          messageId: payload.messageId || Date.now().toString(),
          click_action:
            payload.click_action ||
            payload.data?.click_action ||
            "TEXT-RECEIVED",
          reference_id: payload.reference_id || payload.data?.reference_id,
          conversationId: payload.conversationId || payload.data?.conversationId
        };

        handleTextNotification(notificationData);
        console.log(
          "✅ [NotificationManager] SMS notification processed for badge update"
        );
      },
      "smsNotificationBadge"
    );
    console.log("📱SMSlistener", removeSMSListener);

    console.log(
      "✅ [NotificationManager] iOS native notification listeners setup complete"
    );

    void VoxoNotificationManager.flushPendingNativeEvents();
    void VoxoNotificationManager.logListenerDiagnostics(
      "NotificationManager.setupNativeNotificationListeners"
    );

    // Note: We don't need onNotificationReceived callback - notifications are already
    // displayed by the native layer. We only need to handle press events for navigation.
  }

  async requestPermissions() {
    try {
      const authStatus = await messaging().requestPermission();
      const enabled =
        authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
        authStatus === messaging.AuthorizationStatus.PROVISIONAL;

      // console.log("📱 [NotificationManager] Notification permission status:", {
      //   authStatus,
      //   enabled,
      //   platform: Platform.OS
      // });

      if (!enabled) {
        // console.warn(
        //   "⚠️ [NotificationManager] Notification permission not granted"
        // );
      }

      // Also request Notifee permissions for Android
      if (Platform.OS === "android") {
        const settings = await notifee.requestPermission();
        console.log(
          "📱 [NotificationManager] Notifee permission status:",
          settings
        );
      }
    } catch (error) {
      console.error(
        "❌ [NotificationManager] Error requesting permissions:",
        error
      );
    }
  }

  async getPushToken() {
    if (Platform.OS === "ios") {
      const apnsToken = await messaging().getAPNSToken();
      if (apnsToken) {
        this.callbacks?.onTokenReceived?.({
          token: apnsToken,
          tokenType: "ios_remote_notifications",
          timestamp: Date.now()
        });
      }
    } else {
      const token = await messaging().getToken();
      this.callbacks?.onTokenReceived?.({
        token,
        tokenType: "android_fcm",
        timestamp: Date.now()
      });
    }
  }

  destroy() {
    this.isDestroyed = true;
    this.isInitialized = false;
    console.warn(
      "🚫 [NotificationManager] Destroyed - stopping all notification processing"
    );

    if (Platform.OS === "ios") {
      VoxoNotificationManager.removeAllListeners();
      this.iosDeliveredDedupSub?.remove();
      this.iosDeliveredDedupSub = null;
      this.iosPendingFlushSub?.remove();
      this.iosPendingFlushSub = null;
    }
    this.notifeeListenersAttached = false;
    this.iosKilledStateHandlersAttached = false;
    this.callbacks = undefined;
    this.displayedNotifications.clear();
    this.processedSendbirdMessages.clear();
  }

  isDestroyedState(): boolean {
    return this.isDestroyed;
  }

  setViewingConversation(conversationId: string | null) {
    if (Platform.OS === "ios") {
      VoxoNotificationManager.setViewingConversation(conversationId);
    }
  }

  /**
   * Set the badge count on the app icon
   * @param count - Number to display on the badge (0 to clear)
   */
  async setBadgeCount(count: number) {
    try {
      const badgeCount = Math.max(0, count); // Ensure non-negative

      // console.log("🔔 [NotificationManager] Setting badge count:", {
      //   count,
      //   badgeCount,
      //   platform: Platform.OS
      // });

      if (Platform.OS === "ios") {
        try {
          await notifee.setBadgeCount(badgeCount);
        } catch (_e) {
          PushNotificationIOS.setApplicationIconBadgeNumber(badgeCount);
        }
        // console.log(
        //   "✅ [NotificationManager] iOS badge count set:",
        //   badgeCount
        // );
      } else if (Platform.OS === "android") {
        await notifee.setBadgeCount(badgeCount);
        // console.log(
        //   "✅ [NotificationManager] Android badge count set:",
        //   badgeCount
        // );
      }
    } catch (error) {
      console.error(
        "❌ [NotificationManager] Error setting badge count:",
        error
      );
    }
  }

  /**
   * Get the current badge count
   * @returns The current badge count
   */
  async getBadgeCount(): Promise<number> {
    try {
      if (Platform.OS === "ios") {
        return new Promise((resolve) => {
          PushNotificationIOS.getApplicationIconBadgeNumber((count) => {
            resolve(count);
          });
        });
      } else if (Platform.OS === "android") {
        return await notifee.getBadgeCount();
      }
      return 0;
    } catch (error) {
      console.error("Error getting badge count:", error);
      return 0;
    }
  }

  /**
   * Clear the badge count (set to 0)
   */
  async clearBadge() {
    await this.setBadgeCount(0);
  }

  private async createAndroidNotificationChannel() {
    if (Platform.OS === "android") {
      await notifee.createChannel({
        id: this.androidChannelId,
        name: "Voxo Notifications",
        importance: AndroidImportance.HIGH,
        vibration: true,
        sound: "default"
      });
    }
  }

  private setupNotifeeListeners() {
    // console.log("📱 [NotificationManager] Setting up Notifee listeners");

    notifee.onForegroundEvent(async ({ type, detail }) => {
      if (type === EventType.ACTION_PRESS && detail.pressAction?.id) {
        const actionId = detail.pressAction.id;
        const callData = detail.notification?.data;

        console.log("📞 [Notifee] Call action pressed:", {
          action: actionId,
          callUuid: callData?.callUuid,
          callerName: callData?.callerName
        });

        if (actionId === "answer" && callData?.callUuid) {
          // Dismiss notification
          await notifee.cancelNotification(String(callData.callUuid));

          // Send call data to VoIP bridge for processing
          const voipBridge = VoipBridge.getInstance();
          await voipBridge.handleVoipCall({
            callUuid: String(callData.callUuid),
            callerName: String(callData.callerName || "Unknown Caller"),
            callerNumber: String(callData.callerNumber || "Unknown Number"),
            payload: callData
          });

          console.log("✅ [Notifee] Answered call from notification");
        } else if (actionId === "decline" && callData?.callUuid) {
          // Dismiss notification
          await notifee.cancelNotification(String(callData.callUuid));

          // TODO: Send decline to SIP/VoipBridge if needed
          console.log("❌ [Notifee] Declined call from notification");
        }
      } else if (type === EventType.PRESS && detail.notification) {
        console.warn("👆 [Notifee] User pressed notification in foreground");
        const notificationData = detail.notification.data || {};
        const n = detail.notification;

        const payload = normalizeNotificationPressPayload({
          ...notificationData,
          data: notificationData,
          channelUrl: notificationData.channelUrl,
          click_action: notificationData.click_action,
          messageId: notificationData.messageId,
          parentMessageId:
            notificationData.parentMessageId ||
            notificationData.parent_message_id,
          title: n.title,
          body: n.body
        });

        this.handleNotificationPress(payload);
      } else if (type === EventType.DELIVERED) {
        // DELIVERED event - notification was shown, just informational - no logging needed
      }
    });

    notifee.onBackgroundEvent(async ({ type, detail }) => {
      console.warn("🔔 [Notifee] Background event received:", {
        type,
        eventType: EventType[type],
        hasNotification: !!detail.notification,
        notificationId: detail.notification?.id,
        pressAction: detail.pressAction?.id,
        data: detail.notification?.data,
        dataKeys: detail.notification?.data
          ? Object.keys(detail.notification.data)
          : []
      });

      // Handle call notification actions
      if (type === EventType.ACTION_PRESS && detail.pressAction?.id) {
        const actionId = detail.pressAction.id;
        const callData = detail.notification?.data;

        console.log("📞 [Notifee] Call action pressed in background:", {
          action: actionId,
          callUuid: callData?.callUuid,
          callerName: callData?.callerName
        });

        if (actionId === "answer" && callData?.callUuid) {
          console.log("📞 [Notifee] Answer button pressed (background):", {
            callUuid: callData.callUuid,
            callerNumber: callData.callerNumber,
            callerName: callData.callerName,
            timestamp: new Date().toISOString()
          });

          await notifee.cancelNotification(String(callData.callUuid));

          const voipBridge = VoipBridge.getInstance();
          voipBridge.handleCallAnswer(String(callData.callUuid));
        } else if (actionId === "decline" && callData?.callUuid) {
          // Dismiss notification
          await notifee.cancelNotification(String(callData.callUuid));

          // TODO: Send decline to SIP/VoipBridge if needed
          console.log(
            "❌ [Notifee] Declined call from background notification"
          );
        }
      } else if (type === EventType.PRESS && detail.notification) {
        console.warn(
          "👆 [Notifee] User pressed notification in background/killed state"
        );
        const n = detail.notification;
        const notificationData = n.data || {};
        const payload = normalizeNotificationPressPayload({
          ...notificationData,
          data: notificationData,
          title: n.title,
          body: n.body
        });

        // Start timing
        const startTime = Date.now();

        // Killed state handler - slower with more retries
        const handleWithDelay = () => {
          const currentRoute = getCurrentRoute();
          if (!currentRoute) {
            setTimeout(handleWithDelay, 500);
          } else {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log(
              `🔴 [Notifee] Android KILLED STATE: Navigation ready, took ${elapsed}s`
            );
            this.handleNotificationPress(payload);
          }
        };

        // Active or background State handler - faster with limited retries
        let activeAttempt = 0;
        const maxActiveAttempts = 5;
        const handleWithActiveDelay = () => {
          const currentRoute = getCurrentRoute();
          if (!currentRoute && activeAttempt < maxActiveAttempts) {
            activeAttempt++;
            setTimeout(handleWithActiveDelay, 100);
          } else if (currentRoute) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log(
              `🟢 [Notifee] Android ACTIVE/BACKGROUND STATE: Navigation ready, took ${elapsed}s`
            );
            this.handleNotificationPress(payload);
          } else {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            console.error(
              `❌ [Notifee] Android ACTIVE/BACKGROUND STATE: Failed after ${elapsed}s`
            );
          }
        };

        // Detect app state and use appropriate handler
        const currentRoute = getCurrentRoute();
        if (currentRoute) {
          // Active state - navigation already ready
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
          console.log(
            `🟡 [Notifee] Android ACTIVE STATE: Navigation already ready, took ${elapsed}s`
          );
          this.handleNotificationPress(payload);
        } else {
          // Check if this might be background (nav might be ready soon) or killed state
          setTimeout(() => {
            const routeCheck = getCurrentRoute();
            if (routeCheck) {
              // Background state - nav became ready quickly
              const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
              console.log(
                `🟠 [Notifee] Android BACKGROUND STATE: Navigation ready, took ${elapsed}s`
              );
              handleWithActiveDelay();
            } else {
              // Killed state - use slow handler
              console.log(
                `🔴 [Notifee] Android KILLED STATE: Using slow handler with 500ms delay`
              );
              setTimeout(handleWithDelay, 500);
            }
          }, 100);
        }
      }
      return Promise.resolve();
    });

    // console.log("✅ [NotificationManager] Notifee listeners setup complete");
  }

  private registerForVoipToken() {
    VoipPushNotification.addEventListener("register", (token: string) => {
      this.voipToken = token;
      console.warn("[NotificationManager] VoIP push token received from PushKit", {
        tokenType: "ios_voip",
        tokenLength: token?.length ?? 0,
        token
      });
      this.callbacks?.onTokenReceived?.({
        token,
        tokenType: "ios_voip",
        timestamp: Date.now()
      });
    });
    console.warn("[NotificationManager] Registering for VoIP push token (PushKit)");
    VoipPushNotification.registerVoipToken();
  }

  private handleVoipPushNotification = async (notification: any) => {
    const ts = () => new Date().toISOString();
    // @ts-ignore
    const sessionCount = global.pendingSipSessions
      ? global.pendingSipSessions.size
      : 0;
    // @ts-ignore
    const wakeupFlag = !!global.pendingVoipPushWakeup;
    const appState = AppState.currentState;
    console.warn(
      `📞 [NM] ${ts()} VoIP push received | AppState=${appState} | wakeupFlag=${wakeupFlag} | pendingSessions=${sessionCount}`
    );
    console.warn(`📞 [NM] ${ts()} Payload:`, JSON.stringify(notification));

    const callData: VoipCallData = {
      callUuid: notification.callUuid || notification.uuid,
      callerName:
        notification.callerName ||
        notification.displayName ||
        notification.name ||
        "Unknown Caller",
      callerNumber:
        notification.callerNumber ||
        notification.handle ||
        notification.caller_number ||
        "Unknown Number",
      payload: notification
    };

    let enrichedNotification = notification;
    if (Platform.OS === "ios" && callData.callUuid) {
      try {
        const pending = await PendingCallManager.getPendingCalls();
        const entry = pending[callData.callUuid];
        if (entry) {
          if (
            entry.callerName &&
            entry.callerName !== "Unknown" &&
            (callData.callerName === "Unknown Caller" || !callData.callerName)
          ) {
            callData.callerName = entry.callerName;
          }
          if (
            entry.callerNumber &&
            entry.callerNumber !== "Unknown" &&
            (callData.callerNumber === "Unknown Number" || !callData.callerNumber)
          ) {
            callData.callerNumber = entry.callerNumber;
          }
          enrichedNotification = {
            ...notification,
            sentAt: notification.sentAt ?? entry.sentAt,
            staleDeclined:
              notification.staleDeclined ?? entry.staleDeclined,
            callerName: callData.callerName,
            callerNumber: callData.callerNumber
          };
        }
      } catch (_) {
        /* pending lookup is best-effort for killed-state replay */
      }
    }

    console.warn(
      `📞 [NM] ${ts()} callUuid=${callData.callUuid} callerName=${
        callData.callerName
      }`
    );

    const { stale, ageMs, sentAt } = getVoipPushAge(enrichedNotification);
    if (stale || isVoipPushStaleDeclined(enrichedNotification)) {
      console.warn(
        `📞 [NM] ${ts()} STALE VoIP push | AppState=${appState} ageMs=${ageMs} sentAt=${sentAt}`
      );
      const endStaleCallKit = () => {
        try {
          CallKeep.reportEndCallWithUUID(callData.callUuid, 3);
          VoipBridge.getInstance().handleCallEnd(callData.callUuid);
        } catch (_) {
          /* idempotent with native stale path */
        }
      };
      endStaleCallKit();
      // Killed wake: CallKeep.setup may finish after first end attempt.
      setTimeout(endStaleCallKit, 400);
      setTimeout(endStaleCallKit, 1200);
      await PendingCallManager.clearPendingCall(callData.callUuid);
      scheduleStaleVoipMissedCallFallback(callData);
      return;
    }

    const callerIp = notification.ip || notification.callerIp;
    console.warn(`📞 [NM] ${ts()} callerIp=${callerIp}`);

    // When app is in foreground AND not using voxo-mobile approach: SessionManager (sip.js)
    // receives the INVITE over WebSocket first. Skip SlimSipClient to avoid duplicate SIP legs.
    // When USE_VOXO_MOBILE_APPROACH: always use SlimSipClient (like voxo-mobile), no skip.
    if (
      callerIp &&
      AppState.currentState === "active" &&
      !USE_VOXO_MOBILE_APPROACH
    ) {
      console.warn(
        `📞 [NM] ${ts()} App is ACTIVE — skipping SlimSipClient (SessionManager handles call via WebSocket INVITE)`
      );
      return;
    }

    // Notifications preference: no SlimSip / CallKeep from VoIP push when background/killed (foreground uses INVITE path above).
    if (AppState.currentState !== "active") {
      await rehydratePromise;
      const user = store.getState().userReducer.user;
      if (user && user.enableMobileCallNotifications === 0) {
        console.warn(
          `📞 [NM] ${ts()} Background VoIP handling skipped — enableMobileCallNotifications is off`
        );
        return;
      }
    }

    // Track if call ended before SIP established (caller hung up, timeout, etc.)
    // When true, we dismiss CallKit and skip handleVoipCall to avoid showing a dead call.
    let callEndedBeforeEstablish = false;

    if (callerIp) {
      // CRITICAL: Set global flag BEFORE creating SlimSipClient.
      // This prevents SessionManager (sip.js) from registering and stealing the INVITE.
      // @ts-ignore
      global.pendingVoipPushWakeup = true;
      console.warn(`📞 [NM] ${ts()} Set pendingVoipPushWakeup=true`);

      try {
        console.warn(`� [NM] ${ts()} Awaiting store rehydration...`);
        const rehydrateStart = Date.now();
        await rehydratePromise;
        console.warn(
          `� [NM] ${ts()} Store rehydrated in ${Date.now() - rehydrateStart}ms`
        );

        const state = store.getState();
        const { authReducer, userReducer } = state;

        console.warn(
          `📞 [NM] ${ts()} isLoggedIn=${
            authReducer.isLoggedIn
          } hasUser=${!!userReducer.user} peerName=${
            userReducer.user?.peerName || "N/A"
          }`
        );

        if (!authReducer.isLoggedIn || !userReducer.user) {
          console.error(
            `� [NM] ${ts()} ❌ NOT LOGGED IN - cannot create SlimSipClient`
          );
          // @ts-ignore
          global.pendingVoipPushWakeup = false;
        } else {
          const sipSettings: SipClientSettings = {
            routeOptions: {
              direction: "inbound",
              callUuid: callData.callUuid
            },
            pcConfig: {
              bundlePolicy: "max-compat",
              iceServers: [
                {
                  urls: [
                    "stun:stun.l.google.com:19302",
                    "stun:stun1.l.google.com:19302",
                    "stun:stun2.l.google.com:19302",
                    "stun:stun3.l.google.com:19302",
                    "stun:stun4.l.google.com:19302"
                  ]
                }
              ],
              iceTransportPolicy: "all"
            },
            token: authReducer.accessToken,
            sipUri: `sip:${userReducer.user.peerName}@dev-sip.voxo.co`,
            name: "User",
            wsUrl: "wss://api.voxo.co/webrtc",
            password: userReducer.user.peerSecret
          };

          console.warn(
            `� [NM] ${ts()} Creating SlimSipClient | callUuid=${
              callData.callUuid
            } | AppState=${AppState.currentState} | sipUri=${
              sipSettings.sipUri
            }`
          );

          const sipClient = new SlimSipClient(sipSettings);

          console.warn(`� [NM] ${ts()} Calling establishInboundSession...`);
          const establishStart = Date.now();

          const sipSession = await sipClient.establishInboundSession(
            callData.callUuid,
            callerIp
          );

          console.warn(
            `� [NM] ${ts()} ✅ SIP session established in ${
              Date.now() - establishStart
            }ms`
          );

          // @ts-ignore
          if (!global.pendingSipSessions) {
            // @ts-ignore
            global.pendingSipSessions = new Map();
          }
          // @ts-ignore
          if (!global.pendingSipClients) {
            // @ts-ignore
            global.pendingSipClients = new Map();
          }
          // @ts-ignore
          global.pendingSipSessions.set(callData.callUuid, sipSession);
          // @ts-ignore
          global.pendingSipClients.set(callData.callUuid, sipClient);

          sipSession.on("sessionFailed", (failedPayload: unknown) => {
            const suppressed = getSuppressedCallKeepEndSet();
            if (suppressed.has(callData.callUuid)) {
              console.warn(
                `📞 [NM] sessionFailed for ${callData.callUuid} — skipping CallKit dismiss (UUID rebound to active leg)`
              );
              suppressed.delete(callData.callUuid);
              return;
            }
            console.warn(
              `📞 [NM] sessionFailed for ${callData.callUuid} — dismissing CallKit`
            );
            try {
              CallKeep.reportEndCallWithUUID(callData.callUuid, 2);
              VoipBridge.getInstance().handleCallEnd(callData.callUuid);
              if (isAnsweredElsewhereSessionFailed(failedPayload)) {
                void showCallPickedElsewhereNotification(
                  callData.callUuid
                ).catch(() => {});
              }
            } catch (e: any) {
              console.error(
                `📞 [NM] Failed to dismiss on sessionFailed:`,
                e?.message || e
              );
            }
          });

          sipSession.on("sessionEnded", () => {
            const suppressed = getSuppressedCallKeepEndSet();
            if (suppressed.has(callData.callUuid)) {
              console.warn(
                `📞 [NM] sessionEnded for ${callData.callUuid} — skipping CallKit dismiss (UUID rebound to active leg)`
              );
              suppressed.delete(callData.callUuid);
              return;
            }
            console.warn(
              `📞 [NM] sessionEnded for ${callData.callUuid} (remote hung up) — dismissing CallKit`
            );
            try {
              CallKeep.reportEndCallWithUUID(callData.callUuid, 2);
              VoipBridge.getInstance().handleCallEnd(callData.callUuid);
            } catch (e: any) {
              console.error(
                `📞 [NM] Failed to dismiss on sessionEnded:`,
                e?.message || e
              );
            }
          });

          sipSession.on("backendCallIdUpdate", (id: string) => {
            notifySipBackendCallDiscovered(callData.callUuid, id);
          });

          // @ts-ignore
          console.warn(
            `� [NM] ${ts()} ✅ Stored globally | sessions=${
              global.pendingSipSessions.size
            } clients=${global.pendingSipClients.size}`
          );
        }
      } catch (error: any) {
        console.error(
          `� [NM] ${ts()} ❌ Error:`,
          error?.error || error?.message || error
        );

        if (error.error === "RECEIVE_INVITE_TIMEOUT") {
          callEndedBeforeEstablish = true;
          console.error(
            `� [NM] ${ts()} ❌ INVITE timeout (8s) - server did not send INVITE after REGISTER`
          );
        } else if (error.error === "INVITE_ANSWERED_ELSEWHERE") {
          callEndedBeforeEstablish = true;
          console.error(` � [NM] ${ts()} ❌ Answered elsewhere`);
          void showCallPickedElsewhereNotification(callData.callUuid).catch(
            () => {}
          );
        } else if (error.error === "INVITE_CANCELLED_EARLY") {
          callEndedBeforeEstablish = true;
          console.error(` � [NM] ${ts()} ❌ Cancelled early (caller hung up)`);
        } else if (error.error === "REGISTRATION_FAILED") {
          callEndedBeforeEstablish = true;
          console.error(` � [NM] ${ts()} ❌ SIP registration failed`);
        }

        if (callEndedBeforeEstablish) {
          try {
            CallKeep.reportEndCallWithUUID(callData.callUuid, 2);
            VoipBridge.getInstance().handleCallEnd(callData.callUuid);
          } catch (dismissErr: any) {
            console.error(
              ` [NM] ${ts()} Failed to dismiss CallKit:`,
              dismissErr?.message || dismissErr
            );
          }
        }
      } finally {
        // CRITICAL: Always clear flag + UserDefaults so SessionManager can register later
        // @ts-ignore
        global.pendingVoipPushWakeup = false;
        await PendingCallManager.clearPendingCall(callData.callUuid);
        console.warn(
          `📞 [NM] ${ts()} Finally: cleared wakeup flag + UserDefaults for ${
            callData.callUuid
          }`
        );
      }
    } else {
      console.warn(
        `📞 [NM] ${ts()} No callerIp in payload - skipping SIP establishment`
      );
    }

    // Send to VoIP bridge for UI updates (skip when call ended before SIP established)
    if (!callEndedBeforeEstablish) {
      console.warn(`📞 [NM] ${ts()} Sending to VoipBridge.handleVoipCall...`);
      const voipBridge = VoipBridge.getInstance();
      voipBridge.handleVoipCall(callData).catch((error) => {
        console.error(
          `📞 [NM] ${ts()} ❌ VoipBridge.handleVoipCall error:`,
          error
        );
      });
    }
  };

  private setupVoipPushListeners() {
    console.warn(
      `📞 [NM] setupVoipPushListeners() called at ${new Date().toISOString()}`
    );

    // Listen for VoIP push notifications (fires when app is already running)
    VoipPushNotification.addEventListener(
      "notification",
      (notification: any) => {
        console.warn(
          `📞 [NM] "notification" event fired at ${new Date().toISOString()}`
        );
        this.handleVoipPushNotification(notification);
      }
    );

    // CRITICAL: Handle VoIP push notifications that arrived BEFORE JS was ready (killed state).
    // Without this, killed-state VoIP pushes are never replayed to JS and only the
    // wrong code path (checkPendingCalls → SessionManager wake-up UA) handles the call.
    // This matches voxo-mobile's GlobalCallManager.rnVoipPushNotificationDidLoadWithEvents.
    VoipPushNotification.addEventListener(
      "didLoadWithEvents",
      (events: any) => {
        console.warn(
          `📞 [NM] "didLoadWithEvents" fired at ${new Date().toISOString()} | eventCount=${
            events?.length || 0
          }`
        );
        console.warn(`📞 [NM] didLoadWithEvents raw:`, JSON.stringify(events));

        if (!events || !Array.isArray(events) || events.length < 1) {
          console.warn(`📞 [NM] didLoadWithEvents: no events to replay`);
          return;
        }

        for (const voipPushEvent of events) {
          const { name, data } = voipPushEvent;
          console.warn(`📞 [NM] didLoadWithEvents event: name=${name}`);
          if (
            name ===
            VoipPushNotification.RNVoipPushRemoteNotificationReceivedEvent
          ) {
            console.warn(
              `📞 [NM] ▶ Replaying queued VoIP push from killed state`
            );
            this.handleVoipPushNotification(data);
          } else if (
            name ===
            VoipPushNotification.RNVoipPushRemoteNotificationsRegisteredEvent
          ) {
            console.warn(`📞 [NM] ▶ Replaying VoIP token registration`);
            this.voipToken = data;
            this.callbacks?.onTokenReceived?.({
              token: data,
              tokenType: "ios_voip",
              timestamp: Date.now()
            });
          }
        }
      }
    );
  }

  private listenForTokenRefresh() {
    if (Platform.OS === "android") {
      messaging().onTokenRefresh((token) => {
        this.callbacks?.onTokenReceived?.({
          token,
          tokenType: "android_fcm",
          timestamp: Date.now()
        });
      });
    }
  }

  /**
   * Handle notification press with retry logic for killed state
   * This ensures navigation works even when app is launching from killed state
   */
  // Kill state.
  private handleNotificationPressWithRetry(
    payload: any,
    attempt: number = 0,
    isKilledState: boolean = false
  ): void {
    const maxAttempts = isKilledState ? 40 : 5; // Expo deferred boot needs longer window (up to ~20s)
    const delay = isKilledState ? 500 : 300; // Longer delay for killed state

    if (attempt >= maxAttempts) {
      console.error(
        "❌ [NotificationManager] Failed to handle notification press after",
        maxAttempts,
        "attempts",
        {
          isKilledState,
          payload
        }
      );
      return;
    }

    // Check if navigation is ready
    const currentRoute = getCurrentRoute();
    if (currentRoute) {
      // Navigation is ready, handle notification press now
      console.log(
        "✅ [NotificationManager] Navigation ready, handling notification press:",
        {
          attempt: attempt + 1,
          isKilledState,
          route: currentRoute.name
        }
      );
      this.handleNotificationPress(payload);
    } else {
      // Navigation not ready yet, retry after delay
      console.log(
        "⏳ [NotificationManager] Navigation not ready yet, retrying in",
        delay,
        "ms (attempt",
        attempt + 1,
        "of",
        maxAttempts,
        ")",
        {
          isKilledState
        }
      );
      setTimeout(() => {
        this.handleNotificationPressWithRetry(
          payload,
          attempt + 1,
          isKilledState
        );
      }, delay);
    }
  }

  // Background or active state.
  private handleNotificationPressForActiveApp(
    payload: any,
    attempt: number = 0
  ): void {
    const maxAttempts = Platform.OS === "ios" ? 3 : 5;
    const delay = 100;
    if (attempt >= maxAttempts) {
      console.error(
        "❌ [NotificationManager] Failed to handle notification press (active app) after",
        maxAttempts,
        "attempts",
        {
          platform: Platform.OS,
          payload
        }
      );
      return;
    }
    // Check if navigation is ready.
    const currentRoute = getCurrentRoute();
    if (currentRoute) {
      // Navigation is ready, handle notification press now.
      console.log(
        "✅ [NotificationManager] Navigation ready (active app), handling notification press:",
        {
          attempt: attempt + 1,
          platform: Platform.OS,
          route: currentRoute.name
        }
      );
      this.handleNotificationPress(payload);
    } else {
      // Navigation not ready yet, retry after delay.
      console.log(
        "⏳ [NotificationManager] Navigation not ready (active app), retrying in",
        delay,
        "ms (attempt",
        attempt + 1,
        "of",
        maxAttempts,
        ")",
        {
          platform: Platform.OS
        }
      );
      setTimeout(() => {
        this.handleNotificationPressForActiveApp(payload, attempt + 1);
      }, delay);
    }
  }

  /**
   * iOS: app opened from notification tap while killed (Notifee banner + APNs cold start).
   * Native pendingPayload is stashed in AppDelegate; this covers Notifee-displayed Sendbird taps.
   */
  private setupIosKilledStateNotificationHandlers(): void {
    if (Platform.OS !== "ios") {
      return;
    }

    const handleOpenedPayload = (
      payload: Record<string, unknown>,
      source: string
    ) => {
      const normalized = normalizeNotificationPressPayload(payload);
      const channelUrl = extractSendbirdChannelUrlFromPressPayload(normalized);
      const clickAction = normalized.click_action;
      if (
        !channelUrl &&
        clickAction !== "SENDBIRD-RECEIVED" &&
        clickAction !== "TEXT-RECEIVED"
      ) {
        return;
      }
      console.log(`🔔 [NotificationManager] iOS opened from ${source}`, {
        channelUrl,
        click_action: clickAction
      });
      setTimeout(() => {
        this.handleNotificationPressWithRetry(normalized, 0, true);
      }, 500);
    };

    void messaging()
      .getInitialNotification()
      .then((remoteMessage) => {
        if (!remoteMessage?.data) {
          return;
        }
        handleOpenedPayload(
          {
            ...(remoteMessage.data as Record<string, unknown>),
            data: remoteMessage.data
          },
          "FCM getInitialNotification"
        );
      })
      .catch((error) => {
        console.error(
          "❌ [NotificationManager] Error getting iOS FCM initial notification:",
          error
        );
      });

    void notifee
      .getInitialNotification()
      .then((initialNotification) => {
        if (!initialNotification?.notification) {
          return;
        }
        const n = initialNotification.notification;
        const notificationData = n.data || {};
        console.log(
          "🔔 [Notifee] iOS app opened from notification (killed state):",
          {
            notificationId: n.id,
            hasData: !!n.data,
            dataKeys: n.data ? Object.keys(n.data) : []
          }
        );

        handleOpenedPayload(
          {
            ...notificationData,
            data: notificationData,
            title: n.title,
            body: n.body
          },
          "Notifee getInitialNotification"
        );
      })
      .catch((error) => {
        console.error(
          "❌ [NotificationManager] Error getting iOS initial Notifee notification:",
          error
        );
      });
  }

  /**
   * Setup Android-specific notification handlers
   * Handles notifications when app is opened from notification press
   */
  private setupAndroidNotificationHandlers() {
    if (Platform.OS !== "android") {
      return;
    }

    // console.log(
    //   "📱 [NotificationManager] Setting up Android notification handlers"
    // );

    // Handle notification when app is opened from quit/killed state
    // This uses retry logic to ensure navigation is ready before handling
    messaging()
      .getInitialNotification()
      .then((remoteMessage) => {
        if (remoteMessage) {
          console.log("🔔 [FCM] App opened from notification (killed state):", {
            messageId: remoteMessage.messageId,
            hasData: !!remoteMessage.data,
            dataKeys: remoteMessage.data ? Object.keys(remoteMessage.data) : []
          });
          console.log("🔔 [FCM] Notification data:", remoteMessage.data);
          // Reduced delay for faster navigation - navigation container should be ready quickly
          // The retry logic in navigateToChatWithRetry/navigateToSendbirdChatWithRetry
          // will handle additional retries if navigation still isn't ready after this delay
          setTimeout(() => {
            console.log(
              "🔔 [FCM] Processing initial notification after delay (killed state)"
            );
            this.handleNotificationPressWithRetry(
              remoteMessage.data || {},
              0,
              true
            );
          }, 500); // Reduced from 800ms to 500ms for faster navigation
        } else {
          // ✅ NEW: Also check Notifee for initial notification (for Sendbird notifications displayed via Notifee)
          // This handles cases where notification was displayed by Notifee but FCM didn't capture it
          notifee
            .getInitialNotification()
            .then((initialNotification) => {
              if (initialNotification?.notification) {
                const notification = initialNotification.notification;
                const notificationData = notification.data || {};
                console.log(
                  "🔔 [Notifee] App opened from notification (killed state - Notifee):",
                  {
                    notificationId: notification.id,
                    hasData: !!notification.data,
                    dataKeys: notification.data
                      ? Object.keys(notification.data)
                      : []
                  }
                );
                console.log(
                  "🔔 [Notifee] Notification data:",
                  notificationData
                );

                setTimeout(() => {
                  console.log(
                    "🔔 [Notifee] Processing initial notification after delay (killed state)"
                  );
                  this.handleNotificationPressWithRetry(
                    notificationData,
                    0,
                    true
                  );
                }, 500); // Reduced delay for faster navigation
              }
            })
            .catch((error) => {
              console.error(
                "❌ [NotificationManager] Error getting initial Notifee notification:",
                error
              );
            });
        }
      })
      .catch((error) => {
        console.error(
          "❌ [NotificationManager] Error getting initial notification:",
          error
        );
      });

    // Handle notification when app is opened from background state
    // Background state doesn't need as much retry since navigation is already initialized
    messaging().onNotificationOpenedApp((remoteMessage) => {
      console.log("🔔 [FCM] App opened from notification (background state):", {
        messageId: remoteMessage.messageId,
        hasData: !!remoteMessage.data,
        dataKeys: remoteMessage.data ? Object.keys(remoteMessage.data) : []
      });
      console.log("🔔 [FCM] Notification data:", remoteMessage.data);

      // Use retry logic but with fewer attempts for background state
      this.handleNotificationPressWithRetry(
        remoteMessage.data || {},
        0,
        false // isKilledState = false
      );
    });

    // console.log(
    //   "✅ [NotificationManager] Android notification handlers setup complete"
    // );
  }

  /**
   * iOS: When the user opens the app from a Sendbird APNs/FCM notification, record the
   * chat message id so JS does not post a second local Notifee banner for the same message
   * after Sendbird reconnects (killed/background → active).
   *
   * Also sync message ids from UNUserNotificationCenter delivered notifications when the app
   * becomes active (e.g. user saw the system banner in background then opened via app icon).
   */
  private setupIosSendbirdPushDedup() {
    if (Platform.OS !== "ios") {
      return;
    }

    const recordFromRemote = (remoteMessage: {
      data?: Record<string, unknown>;
    }) => {
      const mid = extractSendbirdMessageIdFromRemoteMessage(remoteMessage);
      if (mid != null) {
        recordSendbirdMessageFromSystemPush(mid);
      }
    };

    // Killed-state initial notification is drained in displaySendbirdNotification
    // (drainIosInitialNotificationForDedup) so it races before the first local banner.

    messaging().onNotificationOpenedApp((remoteMessage) => {
      recordFromRemote(remoteMessage);
      const normalized = normalizeNotificationPressPayload({
        ...(remoteMessage.data || {}),
        data: remoteMessage.data || {}
      });
      const channelUrl = extractSendbirdChannelUrlFromPressPayload(normalized);
      const clickAction = normalized.click_action;
      if (
        channelUrl ||
        clickAction === "SENDBIRD-RECEIVED" ||
        clickAction === "TEXT-RECEIVED"
      ) {
        console.log(
          "🔔 [NotificationManager] iOS FCM onNotificationOpenedApp — navigating",
          { channelUrl, click_action: clickAction }
        );
        this.handleNotificationPressWithRetry(normalized, 0, false);
      }
    });

    const mod = NativeModules.VoxoNotificationsModule as
      | {
          getDeliveredSendbirdMessageIds?: () => Promise<number[]>;
        }
      | undefined;

    const syncDeliveredSendbirdIds = async (): Promise<void> => {
      if (this.isDestroyed || !mod?.getDeliveredSendbirdMessageIds) {
        return;
      }
      try {
        const ids = await mod.getDeliveredSendbirdMessageIds();
        if (!Array.isArray(ids) || ids.length === 0) {
          return;
        }
        for (const raw of ids) {
          const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
          if (Number.isFinite(n) && n > 0) {
            recordSendbirdMessageFromSystemPush(n);
          }
        }
        console.log(
          "✅ [NotificationManager] iOS delivered Sendbird message ids synced for dedup",
          { count: ids.length }
        );
      } catch (e) {
        console.warn(
          "[NotificationManager] getDeliveredSendbirdMessageIds failed:",
          e
        );
      }
    };

    this.iosDeliveredDedupSub?.remove();
    void syncDeliveredSendbirdIds();
    this.iosDeliveredDedupSub = AppState.addEventListener(
      "change",
      (nextState) => {
        if (nextState === "active") {
          void syncDeliveredSendbirdIds();
        }
      }
    );
  }

  private listenForNotifications() {
    // console.log(
    //   "📱 [NotificationManager] Setting up FCM notification listeners for platform:",
    //   Platform.OS
    // );

    // Foreground message handler (app is open)
    messaging().onMessage(async (remoteMessage) => {
      // 🔎 Payload logging for debugging SMS/FCM shapes (readable + truncated)
      try {
        const clickAction =
          remoteMessage?.data?.click_action ??
          (remoteMessage as any)?.data?.clickAction ??
          (remoteMessage as any)?.click_action;
        console.log(
          "📦 [FCM onMessage] Full remoteMessage (truncated):\n" +
            this.safeJsonForLog(
              {
                messageId: remoteMessage?.messageId,
                from: (remoteMessage as any)?.from,
                sentTime: (remoteMessage as any)?.sentTime,
                ttl: (remoteMessage as any)?.ttl,
                collapseKey: (remoteMessage as any)?.collapseKey,
                notification: remoteMessage?.notification,
                data: remoteMessage?.data,
                click_action: clickAction
              },
              12000
            )
        );
      } catch {
        // ignore log failures
      }

      try {
        const state = store.getState();
        const isLoggedIn = (state as any)?.authReducer?.isLoggedIn;
        const user = (state as any)?.userReducer?.user;

        if (!isLoggedIn || !user || !user.id) {
          console.log(
            "🚫 [FCM] Foreground notification BLOCKED - User not logged in",
            {
              isLoggedIn,
              hasUser: !!user,
              userId: user?.id,
              messageId: remoteMessage.messageId,
              notificationType:
                remoteMessage.data?.vm_payload_type ||
                remoteMessage.data?.click_action ||
                "unknown"
            }
          );
          return;
        }
      } catch (error) {
        console.error("❌ [FCM] Error checking login state:", error);
        return;
      }

      if (this.isDestroyed) {
        console.warn(
          "🚫 [FCM] Foreground notification BLOCKED - NotificationManager destroyed (user logged out)"
        );
        return;
      }

      const notificationData = remoteMessage.data || {};

      const isTextNotification =
        notificationData.click_action === "TEXT-RECEIVED" ||
        notificationData.reference_id ||
        notificationData.conversationId ||
        notificationData.conversation_id;

      // Check if this is a Sendbird notification
      let sendbirdData;
      try {
        if (remoteMessage.data?.sendbird) {
          sendbirdData =
            typeof remoteMessage.data.sendbird === "string"
              ? JSON.parse(remoteMessage.data.sendbird)
              : remoteMessage.data.sendbird;
        }
      } catch (error) {
        console.error("[FCM] Error parsing sendbird data:", error);
      }

      const isSendbirdPush =
        !!sendbirdData?.channel?.channel_url ||
        remoteMessage.data?.click_action === "SENDBIRD-RECEIVED" ||
        !!remoteMessage.data?.channelUrl;

      // Only log non-Sendbird pushes for debugging (Sendbird sends many duplicates)
      if (!isSendbirdPush) {
        console.log("🔍 [FCM onMessage] Non-Sendbird push:", {
          clickAction: remoteMessage.data?.click_action,
          hasNotificationPayload: !!remoteMessage.notification,
          timestamp: Date.now()
        });
      }

      if (isSendbirdPush) {
        const channelUrl =
          sendbirdData?.channel?.channel_url || remoteMessage.data?.channelUrl;
        const unreadCount = sendbirdData?.channel?.channel_unread_message_count;
        const messageId =
          sendbirdData?.message_id || remoteMessage.data?.messageId;

        // ✅ DEDUPLICATION: Prevent processing same Sendbird message multiple times
        const dedupeKey = `${channelUrl}_${messageId}`;
        if (this.processedSendbirdMessages.has(dedupeKey)) {
          // Silent return - no need to log every duplicate, reduces noise
          return;
        }
        this.processedSendbirdMessages.add(dedupeKey);
        // Keep cache size limited
        if (
          this.processedSendbirdMessages.size > this.NOTIFICATION_CACHE_SIZE
        ) {
          const iterator = this.processedSendbirdMessages.values();
          const firstItem = iterator.next().value;
          if (firstItem) this.processedSendbirdMessages.delete(firstItem);
        }

        if (channelUrl) {
          console.log(
            "📨 [FCM] Sendbird notification in foreground, refreshing channel:",
            channelUrl,
            "unread:",
            unreadCount
          );
          // ✅ CRITICAL: Stop processing if destroyed (user logged out)
          if (this.isDestroyed) {
            console.warn(
              "🚫 [FCM] Ignoring Sendbird message - NotificationManager destroyed (user logged out)"
            );
            return;
          }

          // Trigger channel refresh with FCM unread count for immediate badge update
          this.callbacks?.onSendbirdMessageReceived?.(channelUrl, unreadCount);
        }
        return;
      } else if (isTextNotification) {
        console.log(
          "📱 [FCM] Text notification in foreground, processing for badge update"
        );
        // Process notification to update Redux state (unread counts, messages)
        // This will trigger badge count update via SendbirdContextProvider subscription
        handleTextNotification(remoteMessage);
      }

      // If server asked to ignore push display, process SMS for badge update but suppress banner in foreground
      // Normalize ignorePush to accept both boolean and string forms
      const ignorePushValue = remoteMessage.data?.ignorePush;
      let ignorePush = false;
      if (typeof ignorePushValue === "string") {
        ignorePush = ignorePushValue === "true" || ignorePushValue === "1";
      } else if (typeof ignorePushValue === "boolean") {
        ignorePush = ignorePushValue === true;
      } else if (typeof ignorePushValue === "number") {
        ignorePush = ignorePushValue === 1;
      }
      if (ignorePush) {
        console.log(
          "🔕 [FCM onMessage] ignorePush=true in foreground; processed for badge/unread — suppressing banner UI"
        );
        // Ensure SMS processing happened
        if (isTextNotification) {
          handleTextNotification(remoteMessage);
        }
        return; // Do not call displayNotification()
      }

      // 🔍 DUPLICATE TRACKING: Log before calling displayNotification
      console.log(
        "🔍🔍🔍 [FCM onMessage] About to call displayNotification()",
        {
          isSendbirdPush,
          isTextNotification,
          messageId: remoteMessage.messageId,
          hasNotificationPayload: !!remoteMessage.notification,
          timestamp: Date.now()
        }
      );

      await this.displayNotification(remoteMessage);
    });

    // Note: Background message handler MUST be registered in index.js at the top level
    // It cannot be registered here in a class method
    // See index.js for the background handler implementation

    // console.log("✅ [NotificationManager] FCM listeners setup complete");
  }

  private async displayNotification(remoteMessage: any) {
    // 🔍 DUPLICATE TRACKING: Log entry point
    // console.log("🔍🔍🔍 [displayNotification] ENTRY POINT - NotificationManager.displayNotification()", {
    //   messageId: remoteMessage.messageId,
    //   hasData: !!remoteMessage.data,
    //   hasNotification: !!remoteMessage.notification,
    //   platform: Platform.OS,
    //   clickAction: remoteMessage.data?.click_action,
    //   channelUrl: remoteMessage.data?.channelUrl,
    //   timestamp: Date.now(),
    //   stackTrace: new Error().stack?.split('\n').slice(0, 5).join('\n')
    // });
    // console.log("📱 [displayNotification] Called with message:", {
    //   hasData: !!remoteMessage.data,
    //   hasNotification: !!remoteMessage.notification,
    //   platform: Platform.OS,
    //   messageId: remoteMessage.messageId
    // });

    if (!remoteMessage.data) {
      // console.log("⚠️ [displayNotification] No data in message, skipping");
      return;
    }

    const gcmMessageId =
      (remoteMessage.data as Record<string, unknown> | undefined)?.[
        "gcm.message_id"
      ] ?? (remoteMessage.data as Record<string, unknown> | undefined)?.fcmId;
    const sendbirdMsgIdForDedupe =
      extractSendbirdMessageIdFromRemoteMessage(remoteMessage);
    const smsDedupeKey = getSmsLogicalDedupeKey(remoteMessage);
    // Same Sendbird chat message can arrive twice with different synthetic apns-* messageIds;
    // SMS can arrive twice (FCM + native willPresent) with different FCM vs apns-* ids —
    // dedupe by stable sms-ref-* / sms-gcm-* from getSmsLogicalDedupeKey.
    const dedupeKey =
      sendbirdMsgIdForDedupe != null
        ? `sendbird-msg-${sendbirdMsgIdForDedupe}`
        : smsDedupeKey ||
          (remoteMessage.messageId as string | undefined) ||
          (typeof gcmMessageId === "string" ? gcmMessageId : undefined);

    if (dedupeKey && this.displayedNotifications.has(dedupeKey)) {
      return;
    }

    if (dedupeKey) {
      this.displayedNotifications.add(dedupeKey);
      // Keep cache size limited
      if (this.displayedNotifications.size > this.NOTIFICATION_CACHE_SIZE) {
        const iterator = this.displayedNotifications.values();
        const firstItem = iterator.next().value;
        if (firstItem) {
          this.displayedNotifications.delete(firstItem);
        }
      }
    }

    try {
      // Normalize ignorePush to accept boolean or string
      const ignorePushVal = remoteMessage.data?.ignorePush;
      const ignorePushFlag =
        ignorePushVal === "true" ||
        ignorePushVal === true ||
        ignorePushVal === "1" ||
        ignorePushVal === 1;
      if (ignorePushFlag) {
        console.log(
          "🔕 [displayNotification] Ignore flag detected — checking notification type (foreground path)"
        );

        // Even when ignoring push notification, we still need to process the data
        // to update Redux store (unread counts, messages, etc.) so badge count updates
        const notificationData = remoteMessage.data || {};
        const isTextNotification =
          notificationData.click_action === "TEXT-RECEIVED" ||
          notificationData.reference_id ||
          notificationData.conversationId ||
          notificationData.conversation_id ||
          notificationData.vm_payload_type === "text-notification";

        if (isTextNotification) {
          console.log(
            "📱 [displayNotification] SMS notification - processing but SUPPRESSING UI due to ignorePush flag"
          );
          // Process the notification to update Redux store (unread counts, messages)
          handleTextNotification(remoteMessage);
          // DO NOT display a UI banner in foreground when ignorePush is true
          return;
        } else {
          console.log(
            "🚫 [displayNotification] Non-SMS notification with ignorePush, skipping display"
          );
          return;
        }
      }

      // Handle call notifications - send to VoIP bridge for processing
      if (
        remoteMessage.data.callUuid ||
        remoteMessage.data.uuid ||
        remoteMessage.data.vm_payload_type === "incoming_call_notification" ||
        remoteMessage.data.payload_callUuid
      ) {
        // Respect user preference: when disabled, do not invoke CallKit/SIP handling
        // from background or killed state (this can trigger iOS crash modal).
        if (Platform.OS === "ios" && AppState.currentState !== "active") {
          try {
            await rehydratePromise;
            const user = (store.getState() as any)?.userReducer?.user;
            if (user && user.enableMobileCallNotifications === 0) {
              console.log(
                "📞 [displayNotification] Call notification BLOCKED - Call notifications disabled",
                {
                  appState: AppState.currentState,
                  userId: user?.id,
                  payloadType: remoteMessage.data?.vm_payload_type
                }
              );
              return;
            }
          } catch (e) {
            console.warn(
              "📞 [displayNotification] Failed to check call notification preference; allowing call processing",
              e
            );
          }
        }

        console.log(
          "📞 [displayNotification] Call notification detected, processing via VoIP bridge:",
          {
            platform: Platform.OS,
            callUuid:
              remoteMessage.data.callUuid ||
              remoteMessage.data.payload_callUuid,
            payloadType: remoteMessage.data.vm_payload_type
          }
        );

        // Extract call data and send to VoIP bridge
        const callData: VoipCallData = {
          callUuid:
            remoteMessage.data.payload_callUuid ||
            remoteMessage.data.callUuid ||
            remoteMessage.data.uuid,
          callerName:
            remoteMessage.data.payload_callerName ||
            remoteMessage.data.callerName ||
            "Unknown Caller",
          callerNumber:
            remoteMessage.data.payload_callerNumber ||
            remoteMessage.data.callerNumber ||
            "Unknown Number",
          payload: remoteMessage.data
        };

        const voipBridge = VoipBridge.getInstance();
        voipBridge.handleVoipCall(callData).catch((error) => {
          console.error(
            "❌ [displayNotification] Error handling VoIP call:",
            error
          );
        });

        return;
      }

      // Process notification content - use same logic for both Sendbird and SMS
      let title: string;
      let body: string;
      const notificationData = { ...remoteMessage.data };
      const isVoicemail =
        notificationData.vm_payload_type === "voicemail" ||
        notificationData.vm_payload_type === "voicemail_notification" ||
        notificationData.click_action === "VOICEMAIL-RECEIVED" ||
        notificationData.click_action === "voicemail-received";

      // Check if this is a Sendbird notification
      let sendbirdData;
      try {
        if (remoteMessage.data.sendbird) {
          sendbirdData =
            typeof remoteMessage.data.sendbird === "string"
              ? JSON.parse(remoteMessage.data.sendbird)
              : remoteMessage.data.sendbird;
        }
      } catch (error) {
        console.error("Error parsing sendbird data:", error);
      }

      if (sendbirdData) {
        const state = store.getState();
        const user = (state as any)?.userReducer?.user;
        const customType =
          sendbirdData.channel?.custom_type ||
          sendbirdData.channel?.customType ||
          "";

        console.log(
          "🔔 [displayNotification] Checking notification preferences for Sendbird",
          {
            userId: user?.id,
            channelUrl: sendbirdData.channel?.channel_url,
            customType,
            willBlock: !shouldShowSendbirdNotification(customType, user)
          }
        );

        if (!shouldShowSendbirdNotification(customType, user)) {
          console.log(
            "🚫 [displayNotification] Sendbird notification BLOCKED - user notification prefs",
            {
              enableChatNotifications: user?.enableChatNotifications,
              enableAllNewMessageNotifications:
                user?.enableAllNewMessageNotifications,
              enableDirectMessageNotifications:
                user?.enableDirectMessageNotifications,
              channelUrl: sendbirdData.channel?.channel_url,
              customType,
              messageId: remoteMessage.messageId
            }
          );
          return;
        }

        // Channel creation notifications should not be shown.
        const notificationBody =
          remoteMessage.notification?.body || remoteMessage.data?.message || "";
        const notificationTitle =
          remoteMessage.notification?.title || remoteMessage.data?.title || "";
        const hasMessage = !!(
          remoteMessage.data?.message ||
          notificationBody ||
          sendbirdData.message_id ||
          sendbirdData.messageId
        );
        const hasSender = !!(
          sendbirdData.sender?.name ||
          sendbirdData.sender?.user_id ||
          sendbirdData.sender?.userId
        );

        // Only block if it's clearly a channel creation event (no message AND no sender AND has keywords).
        const channelCreationKeywords = [
          "channel created",
          "created channel",
          "joined channel",
          "channel joined",
          "new channel"
        ];
        const bodyLower = notificationBody.toLowerCase();
        const titleLower = notificationTitle.toLowerCase();
        const isChannelCreation = channelCreationKeywords.some(
          (keyword) =>
            bodyLower.includes(keyword) || titleLower.includes(keyword)
        );

        // Only block ADMIN messages if they don't have actual content.
        const isSystemMessage =
          (sendbirdData.message_type === "ADMIN" ||
            sendbirdData.type === "ADMIN") &&
          !hasMessage;

        // Block only if: (no message AND no sender) OR (has channel creation keywords).
        if ((!hasMessage && !hasSender) || isChannelCreation) {
          console.log(
            "🚫 [displayNotification] Sendbird notification BLOCKED - Channel creation event",
            {
              channelUrl: sendbirdData.channel?.channel_url,
              channelName: sendbirdData.channel?.name,
              hasMessage,
              hasSender,
              isChannelCreation,
              isSystemMessage,
              messageId: remoteMessage.messageId,
              body: notificationBody,
              title: notificationTitle
            }
          );
          return;
        }

        // Block system messages only if they have no content.
        if (isSystemMessage) {
          console.log(
            "🚫 [displayNotification] Sendbird notification BLOCKED - System message with no content",
            {
              channelUrl: sendbirdData.channel?.channel_url,
              messageId: remoteMessage.messageId
            }
          );
          return;
        }

        if (Platform.OS === "ios") {
          const sbMidEarly =
            extractSendbirdMessageIdFromRemoteMessage(remoteMessage);
          if (sbMidEarly != null) {
            const { skip, reason } = shouldSkipIosDuplicateLocalBanner(
              sbMidEarly,
              undefined
            );
            if (skip) {
              console.log(
                "[IOS_NOTIF_SOUND_TRACE] NotificationManager.skipSendbirdNotifee",
                {
                  sendbirdMessageId: sbMidEarly,
                  reason,
                  source: "NotificationManager.displayNotification"
                }
              );
              return;
            }
          }
        }

        // Process Sendbird notification with special formatting
        const processed = this.processNotificationContent(remoteMessage);
        const sendbirdProcessed = this.processSendbirdNotificationContent(
          processed.title,
          processed.body,
          sendbirdData
        );
        title = sendbirdProcessed.title;
        body = sendbirdProcessed.body;

        this.logSendbirdHtmlTrace("displayNotification.sendbirdProcessed", {
          appState: AppState.currentState,
          title,
          body,
          bodyLooksHtml: this.bodyLooksLikeHtml(body),
          messageId: remoteMessage.messageId,
          channelUrl: sendbirdData.channel?.channel_url
        });
      } else if (
        notificationData.click_action === "TEXT-RECEIVED" ||
        notificationData.conversationId ||
        notificationData.conversation_id
      ) {
        // Check user notification preferences before displaying SMS notifications.
        const state = store.getState();
        const user = (state as any)?.userReducer?.user;
        const smsNotificationsEnabled =
          user?.enableMobileTextNotifications === 1;

        console.log(
          "🔔 [displayNotification] Checking SMS notification preferences (independent from Chat Messages)",
          {
            smsNotificationsEnabled,
            userId: user?.id,
            willBlock: !smsNotificationsEnabled
          }
        );

        // SMS Messages toggle controls thread SMS notifications - no relation to Chat Messages.
        if (!smsNotificationsEnabled) {
          console.log(
            "🚫 [displayNotification] SMS notification BLOCKED - SMS Messages is disabled",
            {
              smsEnabled: smsNotificationsEnabled,
              messageId: remoteMessage.messageId
            }
          );
          // Still process for Redux updates (badge count) but don't display.
          handleTextNotification(remoteMessage);
          return;
        }

        // Process SMS/text notification - use same format as Sendbird direct messages
        console.log("📱📱📱 [displayNotification] SMS NOTIFICATION DETECTED!", {
          hasClickAction: !!notificationData.click_action,
          hasReferenceId: !!notificationData.reference_id,
          hasConversationId: !!notificationData.conversationId,
          peerName: notificationData.peerName,
          from: notificationData.from,
          // Log ALL data to find where media/GIF info is
          FULL_notificationData: notificationData,
          FULL_remoteData: remoteMessage.data,
          notificationBody: remoteMessage.notification?.body,
          smsNotificationsEnabled
        });

        // Resolve contact / conversation name (same logic as SMS thread list).
        title = resolveSmsSenderDisplayName(
          notificationData.from as string | undefined,
          notificationData.peerName as string | undefined,
          {
            systemNotificationTitle: remoteMessage.notification?.title,
            notificationBody: remoteMessage.notification?.body,
            conversationId:
              notificationData.reference_id ||
              notificationData.conversationId ||
              notificationData.conversation_id,
            fcmSenderId: (remoteMessage as { from?: string }).from
          }
        );

        // Process body - get raw body first
        body =
          remoteMessage.notification?.body ||
          remoteMessage.data.body ||
          remoteMessage.data.message ||
          remoteMessage.data.text ||
          "";

        // Remove sender prefix from body if it exists (like Sendbird does)
        const colonIndex = body.indexOf(":");
        if (colonIndex > 0) {
          body = body.substring(colonIndex + 1).trim();
        }

        // Clean HTML from body
        body = this.cleanHtmlFromText(body);

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
              // Some payloads can be comma-separated URLs.
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

        // Check for GIF/media FIRST (before checking empty body)
        // Try multiple possible locations and formats for media URLs.
        const mediaUrls = normalizeMediaUrls(
          notificationData.mediaUrls ||
            notificationData.media_urls ||
            remoteMessage.data.mediaUrls ||
            remoteMessage.data.media_urls
        );

        console.log("📱 [displayNotification] SMS notification debug:", {
          originalBody: body,
          hasMediaUrls: mediaUrls.length > 0,
          mediaUrlsValue: mediaUrls,
          mediaUrlsCount: mediaUrls.length,
          notificationDataKeys: Object.keys(notificationData),
          remoteDataKeys: Object.keys(remoteMessage.data || {})
        });

        // Helper function to check if URL is a GIF
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

        // If we have mediaUrls, show GIF message regardless of body content
        if (mediaUrls.length > 0) {
          const firstUrl = mediaUrls[0]?.toLowerCase() || "";
          const isGif = checkIfGif(firstUrl);

          console.log("📱 [displayNotification] GIF check:", {
            firstUrl: firstUrl.substring(0, 100),
            isGif,
            mediaUrlsCount: mediaUrls.length
          });

          if (isGif) {
            body = "Received a GIF 🎞️";
            console.log(
              "✅ [displayNotification] SMS GIF detected via mediaUrls!",
              {
                reason: "media_url_matches_gif_patterns"
              }
            );
          } else {
            body = "Received an attachment 📎";
            console.log(
              "✅ [displayNotification] SMS attachment detected via mediaUrls!",
              {
                reason: "media_present_but_not_gif"
              }
            );
          }
        } else if (!body.trim()) {
          // If body is empty, try to fetch latest message via API to check for media.
          const conversationId = parseInt(
            notificationData.reference_id ||
              notificationData.conversationId ||
              "0",
            10
          );
          const accessToken = state.authReducer?.accessToken;
          const userId = user?.id;

          if (conversationId && accessToken && userId) {
            try {
              const messagesResponse = await getMessagesForConversation(
                accessToken,
                userId,
                conversationId,
                1,
                5,
                true
              );
              const latestMessage = messagesResponse.records?.[0];

              if (
                latestMessage?.mediaUrls &&
                latestMessage.mediaUrls.length > 0
              ) {
                const firstUrl = latestMessage.mediaUrls[0];
                const isGif = checkIfGif(firstUrl);

                if (isGif) {
                  body = "Received a GIF 🎞️";
                  console.log(
                    "✅ [displayNotification] SMS GIF detected via latest message fetch",
                    {
                      reason: "latest_message_media_url_matches_gif_patterns",
                      firstUrl: String(firstUrl || "").substring(0, 100)
                    }
                  );
                } else {
                  body = "Received an attachment 📎";
                  console.log(
                    "ℹ️ [displayNotification] Latest message has media but not GIF",
                    {
                      reason: "latest_message_media_not_gif",
                      firstUrl: String(firstUrl || "").substring(0, 100)
                    }
                  );
                }
              } else {
                body = "Received an attachment 📎";
                console.log(
                  "ℹ️ [displayNotification] Latest message has no mediaUrls, using attachment fallback",
                  { reason: "latest_message_no_media_urls" }
                );
              }
            } catch (error) {
              console.error(
                "📱 [displayNotification] Error fetching message for GIF detection:",
                error
              );
              body = "Received an attachment 📎";
            }
          } else {
            body = "Received an attachment 📎";
            console.log(
              "ℹ️ [displayNotification] Missing conversation/auth context, using attachment fallback",
              {
                reason:
                  "missing_conversation_or_auth_for_latest_message_lookup",
                conversationId,
                hasAccessToken: !!accessToken,
                hasUserId: !!userId
              }
            );
          }
        }

        // Ensure reference_id is set from conversationId if missing
        if (!notificationData.reference_id && notificationData.conversationId) {
          notificationData.reference_id =
            notificationData.conversationId.toString();
        }
        if (
          !notificationData.reference_id &&
          notificationData.conversation_id
        ) {
          notificationData.reference_id =
            notificationData.conversation_id.toString();
        }

        // Ensure click_action is set
        if (!notificationData.click_action) {
          notificationData.click_action = "TEXT-RECEIVED";
        }
      } else if (isVoicemail) {
        title =
          remoteMessage.notification?.title ||
          remoteMessage.data?.title ||
          "Voicemail received";
        body =
          remoteMessage.notification?.body ||
          remoteMessage.data?.body ||
          remoteMessage.data?.message ||
          "";
        notificationData.click_action = "VOICEMAIL-RECEIVED";
        notificationData.vm_payload_type = "voicemail";
      } else if (
        notificationData.vm_payload_type === "missed_call" ||
        notificationData.click_action === "CALL-EVENT-MISSED" ||
        notificationData.click_action === "MISSED-CALL" ||
        notificationData.click_action === "missed-call" ||
        notificationData.click_action === "MISSED-CALL-RECEIVED"
      ) {
        const missedCallUuid = extractCallUuidFromMissedCallPayload(
          notificationData
        );
        if (missedCallUuid) {
          markMissedCallHandledByServer(missedCallUuid);
        }
        // Missed call notification - ensure click_action for navigation on tap
        const callerLabel = resolveMissedCallCallerLabel({
          ...(remoteMessage.data || {}),
          title: remoteMessage.notification?.title,
          body: remoteMessage.notification?.body
        });
        title = "Missed Call";
        body = callerLabel;
        notificationData.callerName = callerLabel;
        notificationData.click_action =
          notificationData.click_action || "CALL-EVENT-MISSED";
        notificationData.vm_payload_type =
          notificationData.vm_payload_type || "missed_call";
      } else {
        // Default processing for other notification types
        const processed = this.processNotificationContent(remoteMessage);
        title = processed.title;
        body = processed.body;
      }

      console.log("📝 [displayNotification] Final processed content:", {
        title,
        body
      });

      const notificationConfig: any = {
        title,
        body,
        data: notificationData
      };

      if (Platform.OS === "ios" && sendbirdData) {
        const sbId = extractSendbirdMessageIdFromRemoteMessage(remoteMessage);
        if (sbId != null) {
          notificationConfig.id = `sendbird-${sbId}`;
        }
      }

      if (Platform.OS === "android") {
        // Get current badge count and increment it for the notification
        let notificationBadgeCount = 1; // Default to 1 for new notification
        try {
          const currentBadge = await notifee.getBadgeCount();
          notificationBadgeCount = currentBadge + 1;
        } catch (error) {
          console.log(
            "⚠️ [displayNotification] Could not get current badge count, using default"
          );
          console.error(error);
        }

        notificationConfig.android = {
          channelId: this.androidChannelId,
          smallIcon: "ic_launcher",
          importance: AndroidImportance.HIGH,
          pressAction: {
            id: "default"
          },
          // Add badge count to notification
          badgeCount: notificationBadgeCount,
          // Show notification count in the notification itself
          number: notificationBadgeCount,
          timestamp: Date.now(),
          showTimestamp: true,
          visibility: 1
        };
      } else if (Platform.OS === "ios") {
        notificationConfig.ios = {
          sound: "default",
          critical: false,
          interruptionLevel: "timeSensitive",
          foregroundPresentationOptions: {
            alert: true,
            badge: true,
            sound: true,
            banner: true,
            list: true
          }
        };
      }

      const sbMidTrace =
        extractSendbirdMessageIdFromRemoteMessage(remoteMessage);
      console.log(
        "[IOS_NOTIF_SOUND_TRACE] NotificationManager.notifee.display",
        {
          sendbirdMessageId: sbMidTrace,
          notifeeId: notificationConfig.id ?? null,
          fcmMessageId: remoteMessage.messageId
        }
      );

      // 🔍 DUPLICATE TRACKING: Log right before Notifee display
      console.log(
        "🔍🔍🔍 [displayNotification] CALLING notifee.displayNotification() - NotificationManager",
        {
          messageId: remoteMessage.messageId,
          title: notificationConfig.title,
          body: notificationConfig.body?.substring(0, 50),
          clickAction: notificationData.click_action,
          channelUrl: notificationData.channelUrl,
          platform: Platform.OS,
          timestamp: Date.now()
        }
      );
      console.log(
        "🔔 [displayNotification] Displaying notification via Notifee"
      );

      // iOS Sendbird: re-check MMKV immediately before Notifee await (SDK may have reserved id
      // while this function was processing prefs/formatting after the earlier skip check).
      if (Platform.OS === "ios" && sendbirdData) {
        const midFinal =
          extractSendbirdMessageIdFromRemoteMessage(remoteMessage);
        if (midFinal != null) {
          const { skip, reason } = shouldSkipIosDuplicateLocalBanner(
            midFinal,
            undefined
          );
          if (skip) {
            console.log(
              "[IOS_NOTIF_SOUND_TRACE] NotificationManager.skipSendbirdNotifee.finalGate",
              {
                sendbirdMessageId: midFinal,
                reason,
                source: "NotificationManager.displayNotification"
              }
            );
            return;
          }
        }
      }

      await notifee.displayNotification(notificationConfig);

      if (Platform.OS === "ios" && sendbirdData) {
        const sbMid = extractSendbirdMessageIdFromRemoteMessage(remoteMessage);
        if (sbMid != null) {
          recordSendbirdLocalNotifeeShown(sbMid);
        }
      }

      console.log(
        "🔍🔍🔍 [displayNotification] ✅ notifee.displayNotification() COMPLETED",
        {
          messageId: remoteMessage.messageId,
          timestamp: Date.now()
        }
      );

      // For text notifications, also process the data to update Redux store (unread counts, messages)
      // This ensures badge count updates immediately when notification arrives
      // Note: We already process in onMessage, but this is a safety net for iOS native delegate path
      if (
        notificationData.click_action === "TEXT-RECEIVED" ||
        notificationData.conversationId ||
        notificationData.conversation_id ||
        notificationData.reference_id
      ) {
        console.log(
          "📱 [displayNotification] Processing text notification data for Redux update:",
          {
            reference_id: notificationData.reference_id,
            conversationId:
              notificationData.conversationId ||
              notificationData.conversation_id,
            click_action: notificationData.click_action
          }
        );
        // Process the notification to update Redux store (unread counts, messages)
        // This will trigger badge count update via SendbirdContextProvider subscription
        handleTextNotification(remoteMessage);
      }

      console.log(
        "✅ [displayNotification] Notification displayed successfully"
      );
    } catch (_error) {
      console.error(
        "❌ [displayNotification] Error displaying notification:",
        _error
      );
    }
  }

  private logSendbirdHtmlTrace(
    stage: string,
    payload: Record<string, unknown>
  ): void {
    console.log(`[SENDBIRD_HTML_TRACE] ${stage}`, payload);
  }

  private bodyLooksLikeHtml(text: string): boolean {
    if (!text) {
      return false;
    }
    return /<[^>]+>|&nbsp;|&lt;|&gt;|&amp;|&quot;|&#39;|&apos;/i.test(text);
  }

  private processNotificationContent(remoteMessage: any): {
    title: string;
    body: string;
  } {
    let sendbirdData;
    let title = "";
    let body = "";

    try {
      if (remoteMessage.data.sendbird) {
        sendbirdData =
          typeof remoteMessage.data.sendbird === "string"
            ? JSON.parse(remoteMessage.data.sendbird)
            : remoteMessage.data.sendbird;
      }
    } catch (error) {
      console.error("Error parsing sendbird data:", error);
    }

    const possibleSendbirdBody =
      remoteMessage.notification?.body ||
      remoteMessage.data?.message ||
      remoteMessage.data?.body ||
      "";
    if (!sendbirdData && this.bodyLooksLikeHtml(String(possibleSendbirdBody))) {
      this.logSendbirdHtmlTrace("processNotificationContent.noSendbirdDictButHtmlBody", {
        possibleSendbirdBodyPreview: String(possibleSendbirdBody).slice(0, 200),
        hasSendbirdKeyInData: remoteMessage.data?.sendbird != null,
        clickAction: remoteMessage.data?.click_action
      });
    }

    console.log(`${Platform.OS} remoteMessage`, remoteMessage);

    if (sendbirdData) {
      const messageContent =
        remoteMessage.data?.message ||
        remoteMessage.notification?.body ||
        remoteMessage.data?.body ||
        "";

      this.logSendbirdHtmlTrace("processNotificationContent.sendbirdInput", {
        messageSource: remoteMessage.data?.message
          ? "data.message"
          : remoteMessage.notification?.body
            ? "notification.body"
            : remoteMessage.data?.body
              ? "data.body"
              : "empty",
        messageContentPreview: String(messageContent).slice(0, 200),
        messageContentLooksHtml: this.bodyLooksLikeHtml(String(messageContent)),
        notificationTitle: remoteMessage.notification?.title
      });

      const { title: processedTitle, body: processedBody } =
        this.processSendbirdNotificationContent(
          remoteMessage.notification?.title || "",
          messageContent,
          sendbirdData
        );
      title = processedTitle;
      body = processedBody;

      this.logSendbirdHtmlTrace("processNotificationContent.sendbirdOutput", {
        title,
        bodyPreview: String(body).slice(0, 200),
        bodyLooksHtml: this.bodyLooksLikeHtml(String(body))
      });
    } else {
      title =
        remoteMessage.notification?.title ||
        remoteMessage.data.title ||
        "New Message";
      body =
        remoteMessage.notification?.body ||
        remoteMessage.data.body ||
        remoteMessage.data.message ||
        "";
      body = this.cleanHtmlFromText(body);
    }

    return { title, body };
  }

  private processSendbirdNotificationContent(
    title: string,
    body: string,
    sendbirdData: any
  ): { title: string; body: string } {
    // Simplified: Use channel name as title, message content as body
    const notificationTitle =
      sendbirdData.channel?.name || title || "New Message";
    let notificationBody = body;

    try {
      const sendbirdType =
        (sendbirdData?.type ||
          sendbirdData?.message_type ||
          sendbirdData?.messageType) ??
        "";
      const isFileMessage =
        String(sendbirdType).toUpperCase() === "FILE" ||
        (Array.isArray(sendbirdData?.files) && sendbirdData.files.length > 0);

      // Remove sender prefix if present (format: "Sender: message")
      const colonIndex = body.indexOf(":");
      const messagePart =
        colonIndex > 0 ? body.substring(colonIndex + 1).trim() : body;

      this.logSendbirdHtmlTrace("processSendbirdNotificationContent.beforeStrip", {
        rawBodyPreview: String(body).slice(0, 200),
        messagePartPreview: String(messagePart).slice(0, 200),
        hadSenderPrefix: colonIndex > 0,
        messagePartLooksHtml: this.bodyLooksLikeHtml(String(messagePart)),
        customType: sendbirdData.custom_type,
        sendbirdType
      });

      notificationBody = this.stripHtmlTags(messagePart);

      this.logSendbirdHtmlTrace("processSendbirdNotificationContent.afterStrip", {
        notificationBodyPreview: String(notificationBody).slice(0, 200),
        stillLooksHtml: this.bodyLooksLikeHtml(String(notificationBody))
      });

      // Check for GIF
      if (isFileMessage) {
        notificationBody = "Received an attachment 📎";
      } else if (sendbirdData.custom_type === "MESSAGE_GIF") {
        notificationBody = "Received a GIF 🎞️";
      } else if (!notificationBody.trim()) {
        notificationBody = "Sent a message";
      }
    } catch (error) {
      console.error("Error processing notification content:", error);
    }

    return { title: notificationTitle, body: notificationBody };
  }

  private processMessageBody(
    body: string,
    senderName: string,
    sendbirdData: any
  ): string {
    const sendbirdType =
      (sendbirdData?.type ||
        sendbirdData?.message_type ||
        sendbirdData?.messageType) ??
      "";
    const isFileMessage =
      String(sendbirdType).toUpperCase() === "FILE" ||
      (Array.isArray(sendbirdData?.files) && sendbirdData.files.length > 0);

    if (isFileMessage) {
      return `${senderName}: Received an attachment 📎`;
    }

    if (sendbirdData.custom_type) {
      switch (sendbirdData.custom_type) {
        case "MESSAGE_GIF":
          return `${senderName}: Received an attachment 📎`;
        case "MEETING_INVITE":
          return `${senderName}: Invited you to a meeting`;
        default:
          return this.cleanHtmlFromText(body);
      }
    }

    return this.cleanHtmlFromText(body);
  }

  private cleanHtmlFromText(text: string): string {
    if (!text) return "";

    // Extract sender name and message content if in format "Sender: <html content>"
    const colonIndex = text.indexOf(":");
    if (colonIndex > 0) {
      const senderName = text.substring(0, colonIndex).trim();
      const messageContent = text.substring(colonIndex + 1).trim();

      // Clean the message content
      const cleanedContent = this.stripHtmlTags(messageContent);

      // Return in format "Sender: Message"
      return `${senderName}: ${cleanedContent}`;
    }

    // If not in the expected format, just clean the whole text
    return this.stripHtmlTags(text);
  }

  private stripHtmlTags(html: string): string {
    if (!html) return "";

    const inputLooksHtml = this.bodyLooksLikeHtml(html);

    // Simple HTML tag removal (a more comprehensive solution would use a proper HTML parser)
    let cleaned = html.replace(/<[^>]+>/g, "");

    // Replace common HTML entities
    cleaned = cleaned.replace(/&nbsp;/g, " ");
    cleaned = cleaned.replace(/&amp;/g, "&");
    cleaned = cleaned.replace(/&lt;/g, "<");
    cleaned = cleaned.replace(/&gt;/g, ">");
    cleaned = cleaned.replace(/&quot;/g, '"');
    cleaned = cleaned.replace(/&#39;/g, "'");
    cleaned = cleaned.replace(/&apos;/g, "'");

    // Remove extra whitespace
    cleaned = cleaned.replace(/\s+/g, " ").trim();

    if (inputLooksHtml || this.bodyLooksLikeHtml(cleaned)) {
      this.logSendbirdHtmlTrace("stripHtmlTags", {
        inputPreview: html.slice(0, 200),
        outputPreview: cleaned.slice(0, 200),
        inputLooksHtml,
        outputStillLooksHtml: this.bodyLooksLikeHtml(cleaned)
      });
    }

    return cleaned;
  }
}

export default new NotificationManager();
