import { AppState, NativeModules, NativeEventEmitter, Platform } from "react-native";

type VoxoNotificationsNativeModule = {
  viewingConversation?: (conversationId: string | null) => void;
  flushPendingNotificationEvents?: () => Promise<boolean>;
  getListenerDiagnostics?: () => Promise<NativeListenerDiagnostics>;
};

export type NativeListenerDiagnostics = {
  hasListeners: boolean;
  hasPendingPayload: boolean;
  hasPendingRemoteNotifee: boolean;
  hasPendingConversationUpdated: boolean;
  pendingConversationId?: string | null;
  listenerModulePtr?: string | null;
  delegateModulePtr?: string | null;
  callerModulePtr?: string | null;
  listenerMatchesDelegate?: boolean;
};

export type JsListenerDiagnostics = {
  source: string;
  timestamp: string;
  nativeModuleAvailable: boolean;
  eventEmitterReady: boolean;
  jsListenerCount: number;
  jsListenerKeys: string[];
  native: NativeListenerDiagnostics | null;
  ready: boolean;
};

function getVoxoNotificationsModule(): VoxoNotificationsNativeModule | undefined {
  const modules = NativeModules as Record<
    string,
    VoxoNotificationsNativeModule | undefined
  >;
  return modules.VoxoNotificationsModule ?? modules.RCTVoxoNotificationsModule;
}

type NotificationPressCallback = (payload: any) => void;
type ConversationUpdateCallback = (data: {
  conversationId: string;
  click_action?: string;
  text?: string;
  from?: string;
  peerName?: string;
}) => void;
type CallEndedRemotelyCallback = (data: { callUUID: string }) => void;
type SmsNotificationCallback = (data: {
  conversationId: string;
  peerName: string;
  from: string;
  title: string;
  body: string;
  mediaUrls: string[];
  userInfo: any;
}) => void;

class VoxoNotificationManager {
  private eventEmitter: NativeEventEmitter | null = null;
  private listeners: Map<string, () => void> = new Map();
  private warnedMissingNativeModule = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private coldStartDiagnosticsLogged = false;
  private pendingEnsureCallbacks: Array<() => void> = [];
  private ensureRetryActive = false;

  private ensureEventEmitter(): NativeEventEmitter | null {
    if (Platform.OS !== "ios") {
      return null;
    }
    const nativeModule = getVoxoNotificationsModule();
    if (!nativeModule) {
      if (!this.warnedMissingNativeModule) {
        this.warnedMissingNativeModule = true;
        console.warn(
          "[VoxoNotificationManager] VoxoNotificationsModule not in NativeModules — listeners deferred"
        );
      }
      this.eventEmitter = null;
      return null;
    }
    if (!this.eventEmitter) {
      const mod =
        NativeModules.VoxoNotificationsModule ??
        NativeModules.RCTVoxoNotificationsModule;
      if (!mod) {
        return null;
      }
      this.eventEmitter = new NativeEventEmitter(mod);
      console.log(
        "📱 [VoxoNotificationManager] NativeEventEmitter created for VoxoNotificationsModule"
      );
    }
    return this.eventEmitter;
  }

  private replaceListener(key: string, attach: () => () => void): () => void {
    const existing = this.listeners.get(key);
    if (existing) {
      existing();
      this.listeners.delete(key);
    }
    const removeListener = attach();
    this.listeners.set(key, removeListener);
    console.log(
      `📱 [VoxoNotificationManager] listener attached key=${key} total=${this.listeners.size}`
    );
    return removeListener;
  }

  removeListenersByKeys(keys: string[]): void {
    for (const key of keys) {
      const removeListener = this.listeners.get(key);
      if (removeListener) {
        removeListener();
        this.listeners.delete(key);
        console.log(
          `📱 [VoxoNotificationManager] listener removed key=${key} remaining=${this.listeners.size}`
        );
      }
    }
  }

  async getNativeListenerDiagnostics(): Promise<NativeListenerDiagnostics | null> {
    const mod = getVoxoNotificationsModule();
    if (Platform.OS !== "ios" || !mod?.getListenerDiagnostics) {
      return null;
    }
    try {
      return await mod.getListenerDiagnostics();
    } catch (e) {
      console.warn(
        "[VoxoNotificationManager] getListenerDiagnostics failed:",
        e
      );
      return null;
    }
  }

  async collectDiagnostics(source: string): Promise<JsListenerDiagnostics> {
    const nativeModuleAvailable = !!getVoxoNotificationsModule();
    const eventEmitterReady = !!this.eventEmitter;
    const jsListenerKeys = Array.from(this.listeners.keys());
    const native = await this.getNativeListenerDiagnostics();
    const ready =
      nativeModuleAvailable &&
      jsListenerKeys.length > 0 &&
      (native?.hasListeners ?? false);

    return {
      source,
      timestamp: new Date().toISOString(),
      nativeModuleAvailable,
      eventEmitterReady,
      jsListenerCount: jsListenerKeys.length,
      jsListenerKeys,
      native,
      ready
    };
  }

  async logListenerDiagnostics(source: string): Promise<JsListenerDiagnostics> {
    const diag = await this.collectDiagnostics(source);
    const nativePart = diag.native
      ? `native.hasListeners=${diag.native.hasListeners} listenerPtr=${diag.native.listenerModulePtr ?? "?"} delegatePtr=${diag.native.delegateModulePtr ?? "?"} match=${diag.native.listenerMatchesDelegate ?? "?"} pending(tap=${diag.native.hasPendingPayload} notifee=${diag.native.hasPendingRemoteNotifee} conv=${diag.native.hasPendingConversationUpdated})`
      : "native=unavailable";
    const status = diag.ready ? "✅ READY" : "⚠️ NOT READY";
    console.log(
      `[IOS_NOTIF_LISTENERS] ${status} source=${source} jsCount=${diag.jsListenerCount} keys=[${diag.jsListenerKeys.join(", ")}] ${nativePart} module=${diag.nativeModuleAvailable} emitter=${diag.eventEmitterReady}`
    );
    return diag;
  }

  scheduleListenerDiagnosticsOnColdStart(source: string): void {
    if (this.coldStartDiagnosticsLogged) {
      return;
    }
    this.coldStartDiagnosticsLogged = true;
    const logOnce = () => {
      void this.logListenerDiagnostics(source);
    };
    logOnce();
    setTimeout(logOnce, 500);
    setTimeout(logOnce, 2000);
    setTimeout(logOnce, 5000);
  }

  ensureNativeModuleWithRetry(
    onReady: () => void,
    maxAttempts = 20,
    delayMs = 250
  ): void {
    if (Platform.OS !== "ios") {
      return;
    }
    this.pendingEnsureCallbacks.push(onReady);
    if (this.ensureRetryActive) {
      return;
    }
    this.ensureRetryActive = true;

    let attempt = 0;
    const flushReady = () => {
      const callbacks = [...this.pendingEnsureCallbacks];
      this.pendingEnsureCallbacks = [];
      this.ensureRetryActive = false;
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      this.warnedMissingNativeModule = false;
      for (const cb of callbacks) {
        cb();
      }
      void this.logListenerDiagnostics(
        `ensureNativeModuleWithRetry:ready:attempt-${attempt}`
      );
    };

    const tryAttach = () => {
      if (getVoxoNotificationsModule()) {
        flushReady();
        return;
      }
      attempt += 1;
      if (attempt >= maxAttempts) {
        this.pendingEnsureCallbacks = [];
        this.ensureRetryActive = false;
        console.warn(
          `[VoxoNotificationManager] Native module unavailable after ${maxAttempts} retries`
        );
        return;
      }
      this.retryTimer = setTimeout(tryAttach, delayMs);
    };

    tryAttach();
  }

  setViewingConversation(conversationId: string | null): void {
    const mod = getVoxoNotificationsModule();
    if (Platform.OS === "ios" && mod?.viewingConversation) {
      mod.viewingConversation(conversationId);
    }
  }

  async flushPendingNativeEvents(): Promise<void> {
    const mod = getVoxoNotificationsModule();
    if (Platform.OS !== "ios" || !mod?.flushPendingNotificationEvents) {
      return;
    }
    try {
      await mod.flushPendingNotificationEvents();
      console.log(
        "📱 [VoxoNotificationManager] flushPendingNotificationEvents completed"
      );
    } catch (e) {
      console.warn(
        "[VoxoNotificationManager] flushPendingNotificationEvents failed:",
        e
      );
    }
  }

  addNotificationPressListener(
    callback: NotificationPressCallback
  ): () => void {
    const eventEmitter = this.ensureEventEmitter();
    if (Platform.OS !== "ios" || !eventEmitter) {
      if (Platform.OS === "ios") {
        console.warn(
          "[VoxoNotificationManager] Native module unavailable — notification press listener not registered"
        );
      }
      return () => {};
    }

    console.log(
      "📱 [VoxoNotificationManager] Adding notification press listener at:",
      new Date().toISOString()
    );

    return this.replaceListener("notificationPress", () => {
      const subscription = eventEmitter.addListener(
        "onNotificationPressed",
        (payload) => {
          console.log(
            "🔔 [VoxoNotificationManager] ⚡ Event received from native module:",
            {
              hasPayload: !!payload,
              payloadKeys: payload ? Object.keys(payload) : [],
              hasSendbird: !!payload?.sendbird,
              sendbirdKeys: payload?.sendbird
                ? Object.keys(payload.sendbird)
                : [],
              timestamp: new Date().toISOString()
            }
          );

          const isVoipNotification = payload.callUuid || payload.uuid;

          const isTextNotification =
            payload.data?.click_action === "TEXT-RECEIVED" ||
            payload.click_action === "TEXT-RECEIVED" ||
            payload.data?.conversationId ||
            payload.data?.conversation_id ||
            payload.data?.reference_id ||
            payload.data?.referenceId ||
            payload.conversationId ||
            payload.conversation_id ||
            payload.reference_id ||
            payload.referenceId;

          const clickAction =
            payload.click_action || payload.data?.click_action;
          const channelUrl = payload.channelUrl || payload.data?.channelUrl;
          const hasSendbirdKey =
            "sendbird" in payload ||
            (payload.data && "sendbird" in payload.data);

          const isSendbirdNotification =
            hasSendbirdKey ||
            payload.sendbird !== undefined ||
            payload.data?.sendbird !== undefined ||
            clickAction === "SENDBIRD-RECEIVED" ||
            (typeof channelUrl === "string" &&
              channelUrl.includes("sendbird_group_channel")) ||
            !!payload.__notifee_notification;

          const isVoicemailNotification =
            clickAction === "VOICEMAIL-EVENT-RECEIVE" ||
            clickAction === "VOICEMAIL-RECEIVED" ||
            clickAction === "voicemail-received" ||
            payload.data?.vm_payload_type === "voicemail" ||
            payload.data?.vm_payload_type === "voicemail_notification";

          const isMissedCallNotification =
            clickAction === "CALL-EVENT-MISSED" ||
            clickAction === "MISSED-CALL" ||
            clickAction === "missed-call" ||
            clickAction === "MISSED-CALL-RECEIVED" ||
            clickAction === "missed_call" ||
            payload.data?.vm_payload_type === "missed_call" ||
            payload.callCancelReason !== undefined ||
            (payload.title &&
              String(payload.title).toLowerCase().includes("missed call")) ||
            (payload.body &&
              String(payload.body).toLowerCase().includes("missed call"));

          if (
            isVoipNotification ||
            isTextNotification ||
            isSendbirdNotification ||
            isVoicemailNotification ||
            isMissedCallNotification
          ) {
            console.log(
              "📱 [VoxoNotificationManager] ✅ Notification press received - allowing through:",
              {
                isVoipNotification,
                isTextNotification,
                isSendbirdNotification,
                isVoicemailNotification,
                isMissedCallNotification,
                type: isVoipNotification
                  ? "VoIP"
                  : isTextNotification
                  ? "Text"
                  : isSendbirdNotification
                  ? "Sendbird"
                  : isVoicemailNotification
                  ? "Voicemail"
                  : "MissedCall",
                payloadKeys: Object.keys(payload || {}),
                dataKeys: payload?.data ? Object.keys(payload.data) : [],
                hasSendbird: !!payload.sendbird,
                clickAction,
                channelUrl
              }
            );
            callback(payload);
          } else {
            console.warn(
              "📱 [VoxoNotificationManager] ❌ Ignoring notification (not VoIP, text, or Sendbird):",
              {
                payloadKeys: Object.keys(payload || {}),
                dataKeys: payload?.data ? Object.keys(payload.data) : [],
                clickAction,
                channelUrl,
                sendbirdCheck: {
                  hasSendbirdKey,
                  sendbirdValue: payload?.sendbird || payload?.data?.sendbird,
                  sendbirdUndefined:
                    payload?.sendbird === undefined &&
                    payload?.data?.sendbird === undefined,
                  hasNotifeeBlock: !!payload?.__notifee_notification
                }
              }
            );
          }
        }
      );

      void this.flushPendingNativeEvents();

      return () => subscription.remove();
    });
  }

  /**
   * Hook-owned listener (use-notifications) — bare-style attach without replaceListener
   * so NotificationManager re-setup does not tear it down.
   */
  addConversationUpdateListener(
    callback: ConversationUpdateCallback
  ): () => void {
    const eventEmitter = this.ensureEventEmitter();
    if (Platform.OS !== "ios" || !eventEmitter) {
      return () => {};
    }

    const existing = this.listeners.get("conversationUpdate");
    if (existing) {
      console.log(
        "[VoxoNotificationManager] conversationUpdate listener already attached — reusing"
      );
      return existing;
    }

    const subscription = eventEmitter.addListener(
      "onConversationUpdated",
      callback
    );
    void this.flushPendingNativeEvents();

    const removeListener = () => {
      subscription.remove();
      this.listeners.delete("conversationUpdate");
      console.log(
        `📱 [VoxoNotificationManager] listener removed key=conversationUpdate remaining=${this.listeners.size}`
      );
    };

    this.listeners.set("conversationUpdate", removeListener);
    console.log(
      `📱 [VoxoNotificationManager] listener attached key=conversationUpdate total=${this.listeners.size}`
    );
    return removeListener;
  }

  addCallEndedRemotelyListener(
    callback: CallEndedRemotelyCallback
  ): () => void {
    const eventEmitter = this.ensureEventEmitter();
    if (Platform.OS !== "ios" || !eventEmitter) {
      return () => {};
    }

    return this.replaceListener("callEndedRemotely", () => {
      const subscription = eventEmitter.addListener(
        "onCallEndedRemotely",
        (data: { callUUID: string }) => {
          console.warn(
            "📞 [VoxoNotificationManager] onCallEndedRemotely received:",
            data?.callUUID
          );
          callback(data);
        }
      );
      return () => subscription.remove();
    });
  }

  addRemoteNotificationForNotifeeListener(
    callback: (payload: { userInfo: Record<string, unknown> }) => void
  ): () => void {
    const eventEmitter = this.ensureEventEmitter();
    if (Platform.OS !== "ios" || !eventEmitter) {
      return () => {};
    }

    return this.replaceListener("remoteNotificationForNotifee", () => {
      const subscription = eventEmitter.addListener(
        "onRemoteNotificationForNotifee",
        callback
      );
      void this.flushPendingNativeEvents();
      return () => subscription.remove();
    });
  }

  addSmsNotificationListener(
    callback: SmsNotificationCallback,
    key = "smsNotification"
  ): () => void {
    const eventEmitter = this.ensureEventEmitter();
    if (Platform.OS !== "ios" || !eventEmitter) {
      return () => {};
    }

    const existing = this.listeners.get(key);
    if (existing && key === "smsNotificationHook") {
      console.log(
        `[VoxoNotificationManager] ${key} listener already attached — reusing`
      );
      return existing;
    }

    return this.replaceListener(key, () => {
      const subscription = eventEmitter.addListener(
        "onSMSNotificationReceived",
        callback
      );
      return () => subscription.remove();
    });
  }

  removeAllListeners(): void {
    if (Platform.OS !== "ios" || !this.eventEmitter) {
      return;
    }

    for (const removeListener of this.listeners.values()) {
      removeListener();
    }
    this.listeners.clear();

    this.eventEmitter.removeAllListeners("onNotificationPressed");
    this.eventEmitter.removeAllListeners("onConversationUpdated");
    this.eventEmitter.removeAllListeners("onSMSNotificationReceived");
    this.eventEmitter.removeAllListeners("onCallEndedRemotely");
    this.eventEmitter.removeAllListeners("onRemoteNotificationForNotifee");
    console.warn(
      "[VoxoNotificationManager] removeAllListeners — all JS subscriptions cleared"
    );
  }
}

const manager = new VoxoNotificationManager();

if (Platform.OS === "ios") {
  manager.scheduleListenerDiagnosticsOnColdStart("app-module-load");
  AppState.addEventListener("change", (state) => {
    if (state === "active") {
      void manager.logListenerDiagnostics("appState-active");
    }
  });
}

export default manager;
