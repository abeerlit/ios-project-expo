import React, {
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Platform, AppState, InteractionManager } from "react-native";
import { useSelector, useStore, useDispatch } from "react-redux";
import { toast } from "@backpackapp-io/react-native-toast";

// Sendbird imports
import SendbirdChat, {
  ConnectionHandler,
  PushTriggerOption,
  SendbirdChatWith
} from "@sendbird/chat";
import {
  GroupChannel,
  GroupChannelCollection,
  GroupChannelCollectionParams,
  GroupChannelCreateParams,
  GroupChannelFilter,
  GroupChannelHandler,
  GroupChannelListOrder,
  GroupChannelListQuery,
  GroupChannelListQueryParams,
  GroupChannelModule,
  HiddenChannelFilter,
  MessageCollection,
  MessageFilter,
  MyMemberStateFilter,
  GroupChannelHideParams
} from "@sendbird/chat/groupChannel";
import {
  BaseMessage,
  FileMessageCreateParams,
  MessageType,
  MultipleFilesMessageCreateParams,
  UserMessageCreateParams,
  ReplyType
} from "@sendbird/chat/message";

// Local imports
import { SEND_BIRD_APP_ID } from "@env";
import { Logger } from "shared/utils/Logger.ts";
import { getAppNotificationsChannelName } from "shared/branding/appBrand.ts";
import { isHtml } from "shared/utils/utils.ts";
import { MessageCache, ThreadCache } from "./messageCache.ts";
import {
  preloadMessageImages,
  runChatMediaCacheMigration,
  sanitizeChatMediaCache
} from "./chatMediaCache.ts";
import {
  runSmsMediaCacheMigration,
  sanitizeSmsMediaCache
} from "features/text/utils/smsMediaCache.ts";
import { UnreadCountCache } from "./unreadCountCache.ts";
import { State } from "store/types.ts";
import { SendbirdContext } from "features/chat/utils/SendbirdContext.ts";
import { ChatMessage, CustomChannelType } from "features/chat/types.ts";
import { FilteredChannel, FilteredDMChannel } from "../types.ts";
import NotificationManager from "core/notifications/NotificationManager.ts";
import * as sendbirdActions from "store/sendbird/actions.ts";
import * as directoryActions from "store/directory/actions.ts";
import * as userActions from "store/users/actions.ts";
import notifee, { AndroidImportance } from "@notifee/react-native";
import {
  drainIosInitialNotificationForDedup,
  forgetSendbirdNotifeeDedupMessageId,
  recordSendbirdLocalNotifeeShown,
  recordSendbirdMessageFromSystemPush,
  shouldSkipIosDuplicateLocalBanner,
  syncIosDeliveredSendbirdIdsForDedup
} from "features/chat/utils/sendbirdNotificationDedup.ts";
import {
  getChannelsNeedingPushTriggerApply,
  getSendbirdNotificationPrefsSignature,
  pushTriggerForChannel,
  SendbirdNotificationUserPrefs,
  shouldShowSendbirdNotificationForChannel
} from "features/chat/utils/sendbirdNotificationPrefs.ts";
import { syncChatNotificationPrefsToNative } from "core/notifications/iosChatNotificationPrefsCache.ts";

// Initialize logger and Sendbird instance
const logger = new Logger("SendbirdContextProvider");
let sendbirdInstance: SendbirdChatWith<GroupChannelModule[]>;

/** Local Notifee banners only — same messageId must not display twice (iOS + Android). */
const displayedNotificationMessageIds = new Set<number>();
const NOTIFICATION_DEDUP_CACHE_SIZE = 100;
const NOTIFICATION_DEDUP_EXPIRY_MS = 30000;

// TS Note: We are casting all the message types to ChatMessage from BaseMessage because that's what Sendbird sends

/** True if message is a thread reply (has a parent). Main chat must exclude these. */
function isThreadReply(m: ChatMessage): boolean {
  const msg = m as BaseMessage & { parent_message_id?: number | string };
  const pid = msg.parentMessageId ?? msg.parent_message_id;
  if (pid == null) return false;
  const n = typeof pid === "number" ? pid : Number(pid);
  return !Number.isNaN(n) && n !== 0;
}

/** Pending Sendbird messages use `messageId === 0`; disambiguate with `reqId`. */
type ReqIdentifiedMessage = { reqId?: string; messageId: number };

function dedupeChatMessages(list: ChatMessage[]): ChatMessage[] {
  return list.filter((item, index, self) => {
    return (
      index ===
      self.findIndex((obj) => {
        const i = item as ReqIdentifiedMessage;
        const o = obj as ReqIdentifiedMessage;
        if (i.messageId !== 0) {
          return o.messageId === i.messageId;
        }
        if (i.reqId && o.reqId) {
          return o.reqId === i.reqId;
        }
        return o.messageId === i.messageId;
      })
    );
  });
}

function replaceOrPrependByReqId(
  prev: ChatMessage[],
  finalMsg: ChatMessage
): ChatMessage[] {
  const rid = (finalMsg as ReqIdentifiedMessage).reqId;
  if (rid) {
    const idx = prev.findIndex(
      (m) => (m as ReqIdentifiedMessage).reqId === rid
    );
    if (idx >= 0) {
      const next = [...prev];
      next[idx] = finalMsg;
      return dedupeChatMessages(next);
    }
  }
  return dedupeChatMessages([finalMsg, ...prev]);
}

/** Exclude thread replies so they never appear in the main channel list. */
function onlyMainChannelMessages(msgs: ChatMessage[]): ChatMessage[] {
  const replies = msgs.filter((m) => isThreadReply(m));
  const out = msgs.filter((m) => !isThreadReply(m));
  if (replies.length > 0) {
    console.warn(
      "[ReplyFilter] onlyMainChannelMessages filtered OUT replies:",
      {
        total: msgs.length,
        repliesCount: replies.length,
        afterFilter: out.length,
        replyIds: replies.map((r) => (r as BaseMessage).messageId),
        sampleReply: replies[0]
          ? {
              messageId: (replies[0] as BaseMessage).messageId,
              parentMessageId: (replies[0] as BaseMessage).parentMessageId,
              parent_message_id: (
                replies[0] as BaseMessage & { parent_message_id?: number }
              ).parent_message_id
            }
          : null
      }
    );
  }
  return out;
}

/** Merge main-channel lists by messageId (later lists win); sort newest first. */
function mergeMainChannelMessageLists(
  ...lists: ChatMessage[][]
): ChatMessage[] {
  const map = new Map<number, ChatMessage>();
  for (const list of lists) {
    for (const m of onlyMainChannelMessages(list)) {
      const id = (m as BaseMessage).messageId;
      if (id == null) continue;
      map.set(id, m);
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
  );
}

const PUSH_TRIGGER_APPLY_CONCURRENCY = 8;

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const queue = [...items];
  const poolSize = Math.min(concurrency, queue.length);

  await Promise.all(
    Array.from({ length: poolSize }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item) {
          await worker(item);
        }
      }
    })
  );
}

export function SendbirdContextProvider({ children }: { children: ReactNode }) {
  // =========== State Management ===========
  // Channel States
  const [channelsCollection, setChannelsCollection] =
    useState<GroupChannelCollection | null>(null);
  const [currentChannel, setCurrentChannel] = useState<GroupChannel | null>(
    null
  );
  const [channels, setChannels] = useState<GroupChannel[]>([]);
  const channelsRef = useRef<GroupChannel[]>([]);
  channelsRef.current = channels;
  const currentChannelRef = useRef<GroupChannel | null>(null);
  // Track recently incremented channels to prevent onChannelChanged from overwriting (unused for now)
  const _recentlyIncrementedChannelsRef = useRef<Set<string>>(new Set());
  // Track recent refreshChannel calls for deduplication (prevents duplicate FCM processing)
  const recentRefreshCallsRef = useRef<Map<string, number>>(new Map());

  // Track fetch conditions
  const hasFetchedOnFirstLaunchRef = useRef(false);
  const lastChannelFetchTimeRef = useRef(0);
  const lastAppliedPrefsSignatureRef = useRef<string | null>(null);
  const appliedPushTriggerChannelUrlsRef = useRef<Set<string>>(new Set());
  const isApplyingNotificationPrefsRef = useRef(false);
  const applyPrefsInFlightSignatureRef = useRef<string | null>(null);
  const prevChannelCountRef = useRef(0);
  const profileUpdateRefreshScheduledRef = useRef(false);
  const recentlyCheckedChannelsRef = useRef<Set<string>>(new Set());
  const previousAppStateRef = useRef<string>(AppState.currentState);
  const fetchChannelsRef = useRef<(() => Promise<void>) | null>(null);
  const isFirstLaunchProcessingRef = useRef(true);

  // ✅ ANDROID DEDUPLICATION: Track processed events to prevent duplicate handling
  // const processedEventsRef = useRef<Set<string>>(new Set());
  // const PROCESSED_EVENT_CACHE_SIZE = 100;

  // Helper function to check and mark event as processed (Android only)
  // const isEventProcessed = (eventKey: string): boolean => {
  //   if (Platform.OS !== "android") {
  //     return false; // Skip deduplication on iOS
  //   }

  //   if (processedEventsRef.current.has(eventKey)) {
  //     return true; // Already processed
  //   }

  //   // Add to processed set
  //   processedEventsRef.current.add(eventKey);

  //   // Limit cache size to prevent memory leaks
  //   if (processedEventsRef.current.size > PROCESSED_EVENT_CACHE_SIZE) {
  //     const firstKey = processedEventsRef.current.values().next().value;
  //     processedEventsRef.current.delete(firstKey);
  //   }

  //   return false;
  // };

  // Message States
  const [messageCollection, setMessageCollection] =
    useState<MessageCollection | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [reFetchThread, setReFetchThread] = useState(false);
  const [isFetchingMessages, setIsFetchingMessages] = useState(false);

  // Thread States
  const [activeThreadId, setActiveThreadId] = useState<number | null>(null);
  const [activeParentMessage, setActiveParentMessage] =
    useState<BaseMessage | null>(null);
  const [threadMessages, setThreadMessages] = useState<ChatMessage[]>([]);
  const [isFetchingThread, setIsFetchingThread] = useState(false);

  // Ref to track activeThreadId for event handlers (avoids closure issues)
  const activeThreadIdRef = useRef<number | null>(null);

  // Keep ref in sync with state
  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
    // logger.debug("Active thread ID updated:", activeThreadId);
  }, [activeThreadId]);

  useEffect(() => {
    void (async () => {
      await runChatMediaCacheMigration();
      await sanitizeChatMediaCache();
      await runSmsMediaCacheMigration();
      await sanitizeSmsMediaCache();
    })();
  }, []);

  // Connection States
  const [isConnected, setIsConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [fetchingChannels, setFetchingChannels] = useState<boolean>(false);

  // Typing States
  const [typingUsers, setTypingUsers] = useState<Record<string, any[]>>({});

  // Track registered push tokens for cleanup on logout
  const registeredPushTokensRef = useRef<
    Array<{
      token: string;
      os: "ios" | "android" | "windows" | "web" | "macos";
    }>
  >([]);

  // Store previousLastSync before updating it (needed for new channel detection)
  const previousLastSyncRef = useRef<number>(0);

  // Redux States and Dispatch
  const dispatch = useDispatch();
  const dispatchSendbird = useCallback(
    (action: any) => (dispatch as any)(action),
    [dispatch]
  );
  const store = useStore<State>();
  const { user } = useSelector(({ userReducer }: State) => userReducer);
  const { isLoggedIn, accessToken } = useSelector(
    ({ authReducer }: State) => authReducer
  );
  const { directory, companyContacts, personalContacts } = useSelector(
    ({ directoryReducer }: State) => directoryReducer
  );
  const { channels: cachedChannels, lastSync: _lastSync } = useSelector(
    ({ sendbirdReducer }: State) => sendbirdReducer
  );

  const [filteredGroupChannels, setFilteredGroupChannels] = useState<
    FilteredChannel[]
  >([]);
  const [filteredDMChannels, setFilteredDMChannels] = useState<
    FilteredDMChannel[]
  >([]);

  if (!sendbirdInstance) {
    sendbirdInstance = SendbirdChat.init({
      appId: SEND_BIRD_APP_ID,
      modules: [new GroupChannelModule()]
    });
  }

  // =========== Utility Functions ===========
  // Serialize GroupChannel to plain object for Redux/MMKV storage
  const serializeChannel = (
    channel: GroupChannel,
    isFirstLaunch: boolean = false
  ) => {
    try {
      // Preserve customUnreadCount from Redux state if it exists
      const reduxChannel = cachedChannels.find(
        (ch: any) => ch.url === channel.url
      );

      let channelName: string;
      if (channel.name && channel.name.trim()) {
        channelName = channel.name;
      } else if (
        reduxChannel?.name &&
        reduxChannel.name !== "Unnamed Channel"
      ) {
        channelName = reduxChannel.name;
      } else if (channel.members && channel.members.length > 0) {
        channelName =
          channel.members
            .map((m) => m.nickname || m.userId)
            .filter(Boolean)
            .join(", ") || "Unnamed Channel";
      } else {
        channelName = "Unnamed Channel";
      }

      const reduxUnreadCount = reduxChannel?.customUnreadCount;
      const persistentUnreadCount = UnreadCountCache.getUnreadCount(
        channel.url
      );
      const sendbirdUnreadCount = channel.unreadMessageCount || 0;

      let customUnreadCount: number;
      let unreadMessageCountCustom: number;

      if (isFirstLaunch) {
        customUnreadCount = sendbirdUnreadCount;
        unreadMessageCountCustom = sendbirdUnreadCount;
        // logger.debug(
        //   "🚀 [serializeChannel] First launch - using Sendbird unread count:",
        //   {
        //     channelName,
        //     sendbirdUnreadCount,
        //     reduxUnreadCount,
        //     persistentUnreadCount
        //   }
        // );
      } else {
        if (reduxUnreadCount != null && reduxUnreadCount > 0) {
          customUnreadCount = reduxUnreadCount;
        } else if (persistentUnreadCount != null && persistentUnreadCount > 0) {
          customUnreadCount = persistentUnreadCount;
        } else if (sendbirdUnreadCount > 0) {
          customUnreadCount = sendbirdUnreadCount;
        } else {
          customUnreadCount = reduxUnreadCount ?? persistentUnreadCount ?? 0;
        }

        if (
          sendbirdUnreadCount > (reduxUnreadCount || 0) &&
          sendbirdUnreadCount > (persistentUnreadCount || 0)
        ) {
          customUnreadCount = sendbirdUnreadCount;
          unreadMessageCountCustom = sendbirdUnreadCount;
          logger.debug(
            "🔍 [serializeChannel] Sendbird count higher than cache:",
            { channelName, unreadMessageCountCustom }
          );
        }
      }
      if (Platform.OS === "android") {
        const isViewingThisChannel =
          currentChannelRef.current?.url === channel.url;
        if (isViewingThisChannel) {
          customUnreadCount = 0;
        }
      }

      return {
        url: channel.url,
        name: channelName,
        customType: channel.customType,
        coverUrl: channel.coverUrl,
        createdAt: channel.createdAt,
        memberCount: channel.memberCount,
        lastMessage: channel.lastMessage
          ? {
              message: channel.lastMessage.message,
              createdAt: channel.lastMessage.createdAt,
              messageType: channel.lastMessage.messageType
            }
          : null,
        unreadMessageCount: channel.unreadMessageCount,
        customUnreadCount: customUnreadCount,
        members: channel.members.map((m) => ({
          userId: m.userId,
          nickname: m.nickname,
          profileUrl: m.profileUrl
        })),
        isPublic: channel.isPublic,
        isFrozen: channel.isFrozen,
        isHidden: channel.isHidden
      };
    } catch (error) {
      logger.error("Error serializing channel:", error);
      return null;
    }
  };

  // Create a minimal GroupChannel-like object from cached data for instant display
  const createMockChannelFromCache = (cached: any): any => {
    return {
      url: cached.url,
      name: cached.name,
      customType: cached.customType,
      coverUrl: cached.coverUrl,
      createdAt: cached.createdAt,
      memberCount: cached.memberCount,
      lastMessage: cached.lastMessage,
      unreadMessageCount: cached.unreadMessageCount || 0,
      members: cached.members || [],
      isPublic: cached.isPublic,
      isFrozen: cached.isFrozen,
      isHidden: cached.isHidden,
      // Flag to indicate this is cached data
      _isCached: true
    };
  };

  const ensureUniqueChannels = (channels: GroupChannel[]) => {
    return channels.filter(
      (item, index, self) =>
        index === self.findIndex((obj) => obj.url === item.url)
    );
  };

  // =========== Connection Management ===========
  const connect = async (userId: number) => {
    registeredPushTokensRef.current = [];
    try {
      await sendbirdInstance.connect(String(userId));
      const isOpen =
        sendbirdInstance.connectionState === "OPEN" &&
        sendbirdInstance.currentUser != null;
      if (!isOpen) {
        throw new Error(
          `Sendbird connect finished but connection is ${sendbirdInstance.connectionState}`
        );
      }
      setIsConnected(true);
    } catch (error) {
      console.log("isSendBird Connected Error", error);
      setIsConnected(false);
      throw error;
    }
  };

  const disconnect = async () => {
    const state = store.getState();
    const reduxChannels = state?.sendbirdReducer?.channels || [];

    const unreadCountsToPreserve: { [key: string]: number } = {};
    reduxChannels.forEach((ch: any) => {
      if (ch.customUnreadCount && ch.customUnreadCount > 0) {
        unreadCountsToPreserve[ch.url] = ch.customUnreadCount;
      }
    });
    UnreadCountCache.setAllUnreadCounts(unreadCountsToPreserve);

    // Clear cached data from Redux
    dispatchSendbird(sendbirdActions.clearSendbirdData());
    logger.debug("Cleared cached Sendbird data from Redux");

    try {
      const canUnregisterTokens =
        sendbirdInstance.currentUser !== null &&
        sendbirdInstance.connectionState === "OPEN";

      if (canUnregisterTokens) {
        const tokensToUnregister = [...registeredPushTokensRef.current];
        for (const tokenInfo of tokensToUnregister) {
          try {
            if (tokenInfo.os === "ios") {
              await sendbirdInstance.unregisterAPNSPushTokenForCurrentUser(
                tokenInfo.token
              );
            } else {
              await sendbirdInstance.unregisterFCMPushTokenForCurrentUser(
                tokenInfo.token
              );
            }
            logger.debug(
              `Unregistered ${tokenInfo.os} push token on disconnect`
            );
          } catch (error: any) {
            const errorMessage = error?.message || String(error || "");
            if (
              errorMessage.includes("access token") ||
              errorMessage.includes("Invalid") ||
              errorMessage.includes("unauthorized")
            ) {
              logger.debug(
                `Skipping token unregistration - access token invalid (expected during logout):`,
                tokenInfo.os
              );
            } else {
              logger.debug(
                `Could not unregister ${tokenInfo.os} push token:`,
                error
              );
            }
          }
        }
      } else {
        logger.debug(
          "Skipping push token unregistration in disconnect - Sendbird not connected"
        );
      }
    } catch (error: any) {
      const errorMessage = error?.message || String(error || "");
      if (
        !errorMessage.includes("access token") &&
        !errorMessage.includes("Invalid") &&
        !errorMessage.includes("unauthorized")
      ) {
        logger.debug("Error during push token cleanup:", error);
      }
    }

    registeredPushTokensRef.current = [];

    // Reset fetch flags so channels load on next login
    hasFetchedOnFirstLaunchRef.current = false;
    lastChannelFetchTimeRef.current = 0;
    lastAppliedPrefsSignatureRef.current = null;
    appliedPushTriggerChannelUrlsRef.current = new Set();
    isApplyingNotificationPrefsRef.current = false;
    applyPrefsInFlightSignatureRef.current = null;
    prevChannelCountRef.current = 0;

    await sendbirdInstance.disconnect();

    setIsConnected(false);
    setChannelsCollection(null);
    setCurrentChannel(null);
    setMessages([]);
    setChannels([]);
    setFilteredGroupChannels([]);
    setFilteredDMChannels([]);

    console.log(
      "🚪 [SendbirdContext] All local state cleared (channels, messages, etc.)"
    );

    // Check Redux state after clearing
    const stateAfter = store.getState();
    const reduxChannelsAfter = stateAfter?.sendbirdReducer?.channels || [];
    console.log(
      "🚪 [SendbirdContext] Redux channels after clearSendbirdData:",
      {
        channelCount: reduxChannelsAfter.length,
        channels: reduxChannelsAfter
      }
    );

    await NotificationManager.clearBadge();
    console.log(
      "🚪 [SendbirdContext] ========================================"
    );
  };

  const scheduleInitialChannelFetch = () => {
    if (hasFetchedOnFirstLaunchRef.current) return;
    hasFetchedOnFirstLaunchRef.current = true;
    lastChannelFetchTimeRef.current = Date.now();
    if (fetchChannelsRef.current) {
      void fetchChannelsRef.current();
    }
  };

  const retryConnect = async (
    userId: number,
    retries: number = 5,
    delay: number = 2000
  ) => {
    for (let i = 0; i < retries; i++) {
      try {
        await connect(userId);
        logger.debug("Sendbird Connected", {
          userId: sendbirdInstance.currentUser?.userId,
          connectionState: sendbirdInstance.connectionState
        });
        scheduleInitialChannelFetch();
        return;
      } catch (error) {
        logger.error(
          `Error with Sendbird Connection (attempt ${i + 1})`,
          error
        );
        if (i < retries - 1) {
          logger.debug(`Retrying connection in ${delay / 1000} seconds...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 2;
        }
      }
    }
    logger.error("Failed to connect to Sendbird after multiple attempts");
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  const getRateLimitRetryMs = (error: unknown): number => {
    const message =
      (error as { message?: string })?.message ?? String(error ?? "");
    const match = message.match(/retry_after:\s*([0-9.]+)s/i);
    if (match?.[1]) {
      return Math.ceil(parseFloat(match[1]) * 1000) + 50;
    }
    return 200;
  };

  const applyPushTriggerToChannel = useCallback(
    async (
      channel: GroupChannel,
      prefsUser?: SendbirdNotificationUserPrefs | null
    ) => {
      const currentUser =
        prefsUser ?? (store.getState() as State).userReducer?.user;
      if (
        !sendbirdInstance ||
        !currentUser?.tenantId ||
        !channel?.url ||
        typeof channel.setMyPushTriggerOption !== "function"
      ) {
        return;
      }

      const desiredOption = pushTriggerForChannel(
        channel.customType,
        currentUser
      );
      if (channel.myPushTriggerOption === desiredOption) {
        appliedPushTriggerChannelUrlsRef.current.add(channel.url);
        return;
      }

      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await channel.setMyPushTriggerOption(desiredOption);
          appliedPushTriggerChannelUrlsRef.current.add(channel.url);
          return;
        } catch (error) {
          const message =
            (error as { message?: string })?.message ?? String(error ?? "");
          if (message.includes("Too many requests") && attempt < 3) {
            await sleep(getRateLimitRetryMs(error));
            continue;
          }
          logger.error(
            "❌ [NotificationPrefs] Error applying push trigger to channel:",
            { channelUrl: channel.url, error }
          );
          return;
        }
      }
    },
    [sendbirdInstance, store]
  );

  const applyPushTriggersToChannels = useCallback(
    async (
      channelList: GroupChannel[],
      prefsUser: SendbirdNotificationUserPrefs
    ) => {
      const channelsToUpdate = getChannelsNeedingPushTriggerApply(
        channelList,
        prefsUser
      ) as GroupChannel[];

      if (channelsToUpdate.length === 0) {
        return;
      }

      isApplyingNotificationPrefsRef.current = true;
      try {
        await runWithConcurrency(
          channelsToUpdate,
          PUSH_TRIGGER_APPLY_CONCURRENCY,
          (channel) => applyPushTriggerToChannel(channel, prefsUser)
        );
        logger.debug("✅ [NotificationPrefs] Applied push triggers to channels", {
          updatedCount: channelsToUpdate.length,
          totalChannels: channelList.length,
          enableChatNotifications: prefsUser.enableChatNotifications,
          enableAllNewMessageNotifications:
            prefsUser.enableAllNewMessageNotifications,
          enableDirectMessageNotifications:
            prefsUser.enableDirectMessageNotifications
        });
      } finally {
        isApplyingNotificationPrefsRef.current = false;
      }
    },
    [applyPushTriggerToChannel]
  );

  const applySendbirdNotificationPrefs = useCallback(
    async (options?: { force?: boolean }) => {
      if (!sendbirdInstance) {
        return;
      }

      const currentUser = (store.getState() as State).userReducer?.user;
      if (!currentUser?.tenantId) {
        return;
      }

      const signature = getSendbirdNotificationPrefsSignature(currentUser);
      syncChatNotificationPrefsToNative(currentUser);

      if (
        !options?.force &&
        signature &&
        lastAppliedPrefsSignatureRef.current === signature
      ) {
        return;
      }

      if (
        !options?.force &&
        signature &&
        applyPrefsInFlightSignatureRef.current === signature
      ) {
        return;
      }

      if (signature) {
        lastAppliedPrefsSignatureRef.current = signature;
        applyPrefsInFlightSignatureRef.current = signature;
        appliedPushTriggerChannelUrlsRef.current = new Set();
      }

      try {
        try {
          await sendbirdInstance.setPushTriggerOption(PushTriggerOption.OFF);
        } catch (error) {
          logger.error(
            "❌ [NotificationPrefs] Error setting global push trigger:",
            error
          );
        }

        const channelList = channelsRef.current;
        if (channelList.length > 0) {
          await applyPushTriggersToChannels(channelList, currentUser);
        }
      } catch (error) {
        logger.error(
          "❌ [NotificationPrefs] Error applying channel push triggers:",
          error
        );
      } finally {
        if (applyPrefsInFlightSignatureRef.current === signature) {
          applyPrefsInFlightSignatureRef.current = null;
        }
      }
    },
    [sendbirdInstance, applyPushTriggersToChannels, store]
  );

  // =========== Channel Management ===========
  const findChannelByName = useCallback(
    async (channelName: string): Promise<GroupChannel | null> => {
      if (!user?.tenantId || !channelName.trim()) {
        return null;
      }

      logger.debug("findChannelByName(): searching for channel:", channelName);

      try {
        const params: GroupChannelListQueryParams = {
          includeEmpty: true,
          myMemberStateFilter: MyMemberStateFilter.JOINED,
          order: GroupChannelListOrder.LATEST_LAST_MESSAGE,
          limit: 20,
          customTypesFilter: [CustomChannelType.groupChannel(user.tenantId)],
          channelNameContainsFilter: channelName
        };

        const query: GroupChannelListQuery =
          sendbirdInstance?.groupChannel.createMyGroupChannelListQuery(params);
        const channels: GroupChannel[] = await query?.next();

        return channels.find((channel) => channel.name === channelName) || null;
      } catch (error) {
        logger.error("Error finding channel by name:", error);
        return null;
      }
    },
    [user?.tenantId, sendbirdInstance?.groupChannel]
  );

  const createOrJoinChannel = useCallback(
    async (
      channelName: string,
      channelDescription: string,
      isPrivate: boolean
    ): Promise<{
      success: boolean;
      channelUrl?: string;
      error?: string;
      created: boolean;
    }> => {
      if (!user?.tenantId || !channelName.trim()) {
        return {
          success: false,
          error: "Channel name is required",
          created: false
        };
      }

      logger.debug("createOrJoinChannel(): processing channel:", channelName);

      try {
        // First, check if channel already exists
        const existingChannel = await findChannelByName(channelName);

        if (existingChannel) {
          logger.debug("Channel already exists, returning existing channel");
          return {
            success: true,
            channelUrl: existingChannel.url,
            created: false
          };
        }

        // Create new channel if it doesn't exist
        const params: GroupChannelCreateParams = {
          name: channelName,
          operatorUserIds: [user.id.toString()],
          isPublic: !isPrivate,
          isDistinct: false,
          customType: CustomChannelType.groupChannel(user.tenantId),
          data: channelDescription
        };

        const newChannel: GroupChannel =
          await sendbirdInstance.groupChannel.createChannel(params);

        if (!newChannel) {
          return {
            success: false,
            error: "Failed to create channel",
            created: false
          };
        }

        // Update channels list
        setChannels((prevChannels) =>
          ensureUniqueChannels([newChannel, ...prevChannels])
        );

        const serializedChannel = serializeChannel(newChannel);
        if (serializedChannel && serializedChannel.url) {
          dispatchSendbird(
            sendbirdActions.updateChannel(serializedChannel as any)
          );
          logger.debug(
            "✅ [createOrJoinChannel] Channel added to Redux with name:",
            {
              channelUrl: newChannel.url,
              channelName: newChannel.name,
              serializedName: serializedChannel.name
            }
          );
        }

        try {
          await fetchChannels();
        } catch (error) {
          logger.debug("Error refreshing channels after creation:", error);
        }

        await applyPushTriggerToChannel(newChannel);

        logger.debug("Channel created successfully:", newChannel.name);
        return { success: true, channelUrl: newChannel.url, created: true };
      } catch (error) {
        logger.error("Error creating or joining channel:", error);
        return {
          success: false,
          error: "Failed to create channel",
          created: false
        };
      }
    },
    [
      user?.tenantId,
      user?.id,
      sendbirdInstance?.groupChannel,
      findChannelByName,
      applyPushTriggerToChannel
    ]
  );

  const createOrJoinDMChannel = useCallback(
    async (
      userIds: string[]
    ): Promise<{
      success: boolean;
      channelUrl?: string;
      error?: string;
      created?: boolean;
    }> => {
      if (!user?.tenantId || !userIds.length) {
        return {
          success: false,
          error: "User IDs are required",
          created: false
        };
      }

      logger.debug(
        "createOrJoinDMChannel(): processing DM with users:",
        userIds
      );

      try {
        // Ensure current user is included and create a sorted set for comparison
        const allUserIds = Array.from(
          new Set([...userIds, user.id.toString()])
        );
        const sortedUserIds = allUserIds.sort();

        // First, check if DM channel already exists with exactly these users
        const existingDM = filteredDMChannels.find((dm) => {
          if (!dm.memberUserIds) return false;
          const sortedDMUserIds = [...dm.memberUserIds].sort();
          return (
            sortedDMUserIds.length === sortedUserIds.length &&
            sortedDMUserIds.every((id, index) => id === sortedUserIds[index])
          );
        });

        if (existingDM) {
          logger.debug("DM channel already exists, returning existing channel");
          return { success: true, channelUrl: existingDM.url, created: false };
        }

        // Create new DM channel if it doesn't exist
        const params: GroupChannelCreateParams = {
          invitedUserIds: allUserIds,
          isPublic: false,
          isDistinct: true,
          customType: CustomChannelType.dmChannel(user.tenantId)
        };

        const newChannel: GroupChannel =
          await sendbirdInstance.groupChannel.createChannel(params);

        if (!newChannel) {
          return { success: false, error: "Failed to create DM channel" };
        }

        // Update channels list
        setChannels((prevChannels) =>
          ensureUniqueChannels([newChannel, ...prevChannels])
        );

        // ✅ FIX: Ensure channel is updated in Redux with proper name
        // This ensures the channel appears in the flatlist with correct name
        const serializedChannel = serializeChannel(newChannel);
        if (serializedChannel && serializedChannel.url) {
          dispatchSendbird(
            sendbirdActions.updateChannel(serializedChannel as any)
          );
          logger.debug(
            "✅ [createOrJoinDMChannel] Channel added to Redux with name:",
            {
              channelUrl: newChannel.url,
              channelName: newChannel.name,
              serializedName: serializedChannel.name
            }
          );
        }

        try {
          await fetchChannels();
        } catch (error) {
          logger.debug("Error refreshing channels after DM creation:", error);
        }

        logger.debug("DM channel created successfully:", newChannel.url);
        return { success: true, channelUrl: newChannel.url, created: true };
      } catch (error) {
        logger.error("Error creating or joining DM channel:", error);
        return { success: false, error: "Failed to create DM channel" };
      }
    },
    [
      user?.tenantId,
      user?.id,
      sendbirdInstance?.groupChannel,
      filteredDMChannels,
      applyPushTriggerToChannel
    ]
  );

  // Find existing DM channel without creating it
  const findExistingDMChannel = useCallback(
    (userIds: string[]): GroupChannel | null => {
      if (!user?.id || !userIds.length || !user?.tenantId) {
        return null;
      }

      // Ensure current user is included and create a sorted set for comparison
      const allUserIds = Array.from(new Set([...userIds, user.id.toString()]));
      const sortedUserIds = allUserIds.sort();
      const dmChannelCustomType = CustomChannelType.dmChannel(user.tenantId);
      const personalChannelCustomType = CustomChannelType.personalChannel(
        user.tenantId
      );

      // Find existing DM channel with exactly these users
      const existingDM = channels.find((channel) => {
        const isDM =
          channel.customType === dmChannelCustomType ||
          channel.customType === personalChannelCustomType ||
          channel.isDistinct === true;

        if (!isDM || !channel.members) return false;

        const memberIds = channel.members.map((m) => m.userId);
        const sortedMemberIds = memberIds.sort();
        return (
          sortedMemberIds.length === sortedUserIds.length &&
          sortedMemberIds.every((id, index) => id === sortedUserIds[index])
        );
      });

      return existingDM || null;
    },
    [user?.id, user?.tenantId, channels]
  );

  // Get preview messages for a channel
  const getChannelPreviewMessages = useCallback(
    async (channelUrl: string): Promise<ChatMessage[]> => {
      try {
        logger.debug("getChannelPreviewMessages(): fetching for", channelUrl);

        const channel = await sendbirdInstance.groupChannel.getChannel(
          channelUrl
        );

        if (!channel) {
          logger.error("Channel not found:", channelUrl);
          return [];
        }

        const messages = await channel.getMessagesByTimestamp(
          new Date().getTime(),
          {
            prevResultSize: 20,
            nextResultSize: 0,
            reverse: true
          }
        );

        return messages as ChatMessage[];
      } catch (error) {
        logger.error("Error fetching preview messages:", error);
        return [];
      }
    },
    [sendbirdInstance?.groupChannel]
  );

  const enterChannel = useCallback(
    async (channelUrl: string) => {
      const enterStartTime = Date.now();
      console.warn("⏱️ [enterChannel] START:", {
        channelUrl,
        timestamp: enterStartTime
      });
      try {
        if (currentChannelRef.current?.url === channelUrl) {
          logger.debug(
            "⚠️ [enterChannel] Already viewing this channel, skipping re-entry:",
            {
              channelUrl,
              timestamp: Date.now()
            }
          );
          return;
        }

        logger.debug("🚪 [enterChannel] ENTERING channel:", {
          channelUrl,
          currentChannelRef: currentChannelRef.current?.url,
          timestamp: Date.now()
        });

        // Wait for connection if not connected yet (important for killed-state notification opens).
        const checkConnection = () => {
          return isConnected || sendbirdInstance.connectionState === "OPEN";
        };

        if (!checkConnection()) {
          logger.debug("⏳ [enterChannel] Waiting for Sendbird connection...", {
            channelUrl,
            isConnected,
            connecting,
            connectionState: sendbirdInstance.connectionState
          });

          // Wait up to ~10 seconds for Sendbird to connect.
          let attempts = 0;
          const maxAttempts = 20; // 20 * 500ms = 10 seconds
          while (!checkConnection() && attempts < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            attempts++;
          }

          if (!checkConnection()) {
            logger.error(
              "❌ [enterChannel] Sendbird not connected after waiting",
              {
                channelUrl,
                attempts,
                connectionState: sendbirdInstance.connectionState
              }
            );
            throw new Error("Sendbird connection is required");
          }

          logger.debug("✅ [enterChannel] Sendbird connected, proceeding");
        }

        setCurrentChannel(null);
        setMessageCollection(null);
        setMessages([]);

        const cachedMessages = MessageCache.getCachedMessages(channelUrl);
        console.warn(
          "⏱️ [enterChannel] After cache check:",
          Date.now() - enterStartTime,
          "ms",
          { hasCached: !!cachedMessages?.length }
        );
        if (cachedMessages && cachedMessages.length > 0) {
          const filtered = onlyMainChannelMessages(cachedMessages);
          const replyCount = cachedMessages.length - filtered.length;
          console.warn("[ReplyFilter] enterChannel setMessages from cache:", {
            channelUrl,
            cachedCount: cachedMessages.length,
            afterFilter: filtered.length,
            replyCount,
            replyIds:
              replyCount > 0
                ? cachedMessages
                    .filter((m) => isThreadReply(m))
                    .map((m) => (m as BaseMessage).messageId)
                : []
          });
          setMessages(filtered);
          InteractionManager.runAfterInteractions(() => {
            preloadMessageImages(filtered, accessToken ?? undefined, "full");
          });
        } else {
          setMessages([]);
        }
        console.warn(
          "⏱️ [enterChannel] After setMessages (cached):",
          Date.now() - enterStartTime,
          "ms"
        );

        // Cached channel.
        console.warn(
          "⏱️ [enterChannel] Before getChannel:",
          Date.now() - enterStartTime,
          "ms"
        );
        const cachedChannel = channels.find((c) => c.url === channelUrl);
        let channel;
        if (cachedChannel) {
          channel = await sendbirdInstance.groupChannel.getChannel(channelUrl);
        } else {
          channel = await sendbirdInstance.groupChannel.getChannel(channelUrl);
        }
        console.warn(
          "⏱️ [enterChannel] After getChannel:",
          Date.now() - enterStartTime,
          "ms"
        );
        try {
          await channel.markAsRead();
          console.warn(
            "⏱️ [enterChannel] markAsRead completed:",
            Date.now() - enterStartTime,
            "ms"
          );
        } catch (err) {
          logger.error("❌ [enterChannel] markAsRead error:", err);
        }

        const refreshedChannel = channel;

        if (
          refreshedChannel.members &&
          refreshedChannel.members.length > 0 &&
          user?.id
        ) {
          const hasUpdates = checkAndUpdateMemberProfiles(
            refreshedChannel,
            "enterChannel"
          );
          if (hasUpdates) {
            logger.debug(
              "🔄 [enterChannel] Profile updates detected, refreshing channel again:",
              channelUrl
            );
            try {
              const reRefreshedChannel =
                await sendbirdInstance.groupChannel.getChannel(channelUrl);
              setCurrentChannel(reRefreshedChannel);
              setChannels((prevChannels) => {
                const updatedChannels = prevChannels.filter(
                  (chn) => chn.url !== reRefreshedChannel.url
                );
                return ensureUniqueChannels([
                  reRefreshedChannel,
                  ...updatedChannels
                ] as GroupChannel[]);
              });
              logger.debug(
                "✅ [enterChannel] Channel re-refreshed with updated profiles"
              );
            } catch (error) {
              logger.error(
                "❌ [enterChannel] Error re-refreshing channel:",
                error
              );
            }
          }
        }

        // Reset custom unread count in Redux when entering channel
        dispatchSendbird(sendbirdActions.resetChannelUnread(channelUrl));
        UnreadCountCache.clearUnreadCount(channelUrl);
        logger.debug(
          "🔄 [enterChannel] Reset custom unread count for channel",
          channelUrl
        );

        // Update channels array with the refreshed channel (which has unreadMessageCount = 0)
        setChannels((prevChannels) => {
          const res = prevChannels.map((chn) =>
            chn.url === refreshedChannel.url
              ? (refreshedChannel as GroupChannel)
              : chn
          );
          return ensureUniqueChannels(res);
        });
        setCurrentChannel(refreshedChannel);

        console.warn(
          "⏱️ [enterChannel] COMPLETE:",
          Date.now() - enterStartTime,
          "ms"
        );
        logger.debug(
          "✅ [enterChannel] Channel marked as read, unread count:",
          {
            channelUrl,
            unreadCount: refreshedChannel.unreadMessageCount
          }
        );
      } catch (err) {
        logger.error("❌ [enterChannel] Failed to enter channel:", {
          channelUrl,
          error: err,
          isConnected,
          connecting
        });
      }
    },
    [sendbirdInstance, isConnected, connecting, accessToken]
  );

  const leaveChannel = useCallback(() => {
    logger.debug("🚪 [leaveChannel] Leaving Channel:", {
      channelName: currentChannel?.name,
      channelUrl: currentChannel?.url,
      hadChannel: !!currentChannel
    });

    const hadChannel = !!currentChannel;
    setCurrentChannel(null);
    setMessages([]);
    currentChannelRef.current = null;
    logger.debug("✅ [leaveChannel] Channel cleared, ref set to null");

    // OPTIMIZE: Fetch channels once when leaving chat screen
    if (hadChannel && isConnected && !fetchingChannels) {
      const timeSinceLastFetch = Date.now() - lastChannelFetchTimeRef.current;
      // Only fetch if it's been > 5 seconds since last fetch (avoid rapid refetches)
      if (timeSinceLastFetch > 5000 && fetchChannelsRef.current) {
        logger.debug("🔄 [leaveChannel] Fetching channels after leaving chat");
        lastChannelFetchTimeRef.current = Date.now();
        void fetchChannelsRef.current();
      } else if (timeSinceLastFetch <= 5000) {
        logger.debug(
          "⏭️ [leaveChannel] Skipping fetch - recent fetch within 5s"
        );
      }
    }
  }, [currentChannel, isConnected, fetchingChannels, fetchChannelsRef]);

  // Load cached messages for instant display before entering channel
  const loadCachedMessages = useCallback((channelUrl: string): boolean => {
    const cachedMessages = MessageCache.getCachedMessages(channelUrl);
    if (cachedMessages && cachedMessages.length > 0) {
      logger.debug("📦 [loadCachedMessages] Loading cached messages:", {
        channelUrl,
        count: cachedMessages.length
      });
      setMessages(onlyMainChannelMessages(cachedMessages));
      return true; // Indicates messages were loaded
    }
    return false; // No cached messages
  }, []);

  // Helper function to check and update member profiles
  const checkAndUpdateMemberProfiles = useCallback(
    (channel: GroupChannel, source: string): boolean => {
      if (!user?.id || !channel.members || channel.members.length === 0) {
        logger.debug(
          `🔍 [${source}] No members or user to check in channel:`,
          channel.url
        );
        return false;
      }

      const state = store.getState();
      const currentDirectory = state.directoryReducer.directory || [];
      let hasUpdates = false;

      channel.members.forEach((member) => {
        if (
          member.profileUrl &&
          member.userId &&
          parseInt(member.userId) !== user.id
        ) {
          const directoryContact = currentDirectory.find(
            (contact: any) =>
              contact.userId?.toString() === member.userId &&
              contact.type === "company"
          );

          // logger.debug(`🔍 [${source}] Checking member profile:`, {
          //   userId: member.userId,
          //   memberNickname: member.nickname,
          //   memberProfileUrl: member.profileUrl,
          //   hasDirectoryContact: !!directoryContact,
          //   directoryAvatar: directoryContact?.avatarPath || "null",
          //   profilesMatch: directoryContact?.avatarPath === member.profileUrl,
          //   channelUrl: channel.url
          // });

          // If member's profileUrl is different from directory, update it
          if (
            directoryContact &&
            directoryContact.avatarPath !== member.profileUrl
          ) {
            logger.debug(`🔄 [${source}] PROFILE UPDATE DETECTED:`, {
              userId: member.userId,
              memberNickname: member.nickname,
              oldAvatar: directoryContact.avatarPath || "null",
              newAvatar: member.profileUrl,
              channelUrl: channel.url,
              source: source
            });

            dispatch({
              type: directoryActions.UPDATE_COMPANY_CONTACT,
              payload: {
                userId: member.userId,
                updates: {
                  avatarPath: member.profileUrl,
                  avatarThumbnailPath: member.profileUrl
                }
              }
            });

            hasUpdates = true;
          } else if (!directoryContact) {
            logger.debug(`⚠️ [${source}] Member not found in directory:`, {
              userId: member.userId,
              memberNickname: member.nickname,
              channelUrl: channel.url
            });
          }
        }
      });

      if (hasUpdates) {
        logger.debug(
          `✅ [${source}] Updated directory with profile changes for channel:`,
          channel.url
        );
        // Force a re-render by updating a dummy state that triggers re-processing
        // The directory change will automatically trigger processChannels via the useEffect
      }

      return hasUpdates;
    },
    [user?.id, dispatch, store]
  );

  const fetchChannels = async () => {
    if (fetchingChannels) return;

    setFetchingChannels(true);
    logger.debug("fetchChannels(): fetching channels from Sendbird");
    try {
      const tenantId = user?.tenantId;
      const groupChannelFilter = new GroupChannelFilter({
        includeEmpty: true,
        customTypesFilter: [
          `Open_${tenantId}`,
          `DM_${tenantId}`,
          `DM_${tenantId}_PERSONAL`
        ],
        hiddenChannelFilter: HiddenChannelFilter.ALL,
        myMemberStateFilter: MyMemberStateFilter.ALL
      });

      const collectionParameters: GroupChannelCollectionParams = {
        filter: groupChannelFilter,
        limit: 100,
        order: GroupChannelListOrder.LATEST_LAST_MESSAGE
      };

      const collection =
        sendbirdInstance.groupChannel.createGroupChannelCollection(
          collectionParameters
        );

      const personalChannel = await fetchOrCreatePersonalChannel();
      const fetchedChannels = await collection.loadMore();

      // console.log(fetchedChannels?.filter((item) => item.name == "Abeer Homie Quan"))
      // console.log(personalChannel?.map((item) => item.name == "Abeer Homie Quan"))

      const allChannels = [personalChannel, ...fetchedChannels];

      logger.debug("fetchChannels(): fetched", allChannels.length, "channels");

      // OPTIMIZE: Only check for profile updates if directory is loaded
      let totalProfileUpdates = 0;
      if (user?.id && directory.length > 0) {
        // Only check first 20 channels to avoid performance hit
        const channelsToCheck = allChannels.slice(0, 20);
        channelsToCheck.forEach((channel) => {
          const hasUpdates = checkAndUpdateMemberProfiles(
            channel,
            "fetchChannels"
          );
          if (hasUpdates) {
            totalProfileUpdates++;
          }
        });

        if (totalProfileUpdates > 0) {
          logger.debug(
            `🔄 [fetchChannels] Found ${totalProfileUpdates} channels with profile updates`
          );
          // OPTIMIZE: Debounce the refresh - only refresh once even if multiple updates
          if (!profileUpdateRefreshScheduledRef.current) {
            profileUpdateRefreshScheduledRef.current = true;
            setTimeout(async () => {
              profileUpdateRefreshScheduledRef.current = false;
              try {
                logger.debug(
                  "🔄 [fetchChannels] Refreshing channels after profile updates"
                );
                await fetchChannels();
              } catch (error) {
                logger.error(
                  "❌ [fetchChannels] Error refreshing channels:",
                  error
                );
              }
            }, 2000);
          }
        }
      }

      setChannels(allChannels);

      // Determine if this is first launch (before hasFetchedOnFirstLaunchRef is set to true)
      const isFirstLaunch = isFirstLaunchProcessingRef.current;
      if (isFirstLaunch) {
        isFirstLaunchProcessingRef.current = false; // Mark as processed
      }

      const serializedChannels = allChannels
        .map((channel) => serializeChannel(channel, isFirstLaunch))
        .filter(Boolean)
        .filter((ch: any) => ch && ch.url);

      // OPTIMIZE: Log summary instead of individual channels
      if (isFirstLaunch) {
        const totalUnread = serializedChannels.reduce(
          (sum: number, ch: any) => sum + (ch.customUnreadCount || 0),
          0
        );
        logger.debug(
          `✅ [fetchChannels] First launch serialization complete: ${serializedChannels.length} channels, ${totalUnread} total unread`
        );
      }

      // Capture previousLastSync BEFORE updating it (needed for new channel detection in processChannels)
      const stateBeforeSync = store.getState();
      previousLastSyncRef.current =
        stateBeforeSync.sendbirdReducer?.lastSync || 0;

      dispatchSendbird(
        sendbirdActions.storeChannels(serializedChannels as any[])
      );
      dispatchSendbird(sendbirdActions.setLastSync(Date.now()));
      logger.debug(
        "fetchChannels(): saved",
        serializedChannels.length,
        "serialized channels to Redux"
      );

      const unreadCountsToSync: { [key: string]: number } = {};
      serializedChannels.forEach((ch: any) => {
        if (ch.customUnreadCount && ch.customUnreadCount > 0) {
          unreadCountsToSync[ch.url] = ch.customUnreadCount;
        }
      });
      if (Object.keys(unreadCountsToSync).length > 0) {
        UnreadCountCache.setAllUnreadCounts(unreadCountsToSync);
        logger.debug(
          "📦 [fetchChannels] Synced unread counts to persistent cache:",
          Object.keys(unreadCountsToSync).length
        );
      }

      lastChannelFetchTimeRef.current = Date.now();

      collection.dispose();

      await applySendbirdNotificationPrefs({ force: true });
    } catch (error) {
      logger.error("fetchChannels(): ERROR fetching channels:", error);
    } finally {
      setFetchingChannels(false);
    }
  };

  // Store function reference for use in leaveChannel
  fetchChannelsRef.current = fetchChannels;

  const hideDmChannel = useCallback(
    async (channelUrl: string) => {
      if (!sendbirdInstance?.groupChannel || !channelUrl) {
        return;
      }
      try {
        const channel = await sendbirdInstance.groupChannel.getChannel(
          channelUrl
        );
        const hideParams: GroupChannelHideParams = {
          hidePreviousMessages: false,
          allowAutoUnhide: true
        };
        await channel.hide(hideParams);
        logger.debug("hideDmChannel(): channel hidden", { channelUrl });

        // Match web: hidden DMs drop off Home immediately (processChannels also filters !isHidden).
        setChannels((prev) => prev.filter((c) => c.url !== channelUrl));
        dispatchSendbird(sendbirdActions.removeChannel(channelUrl));

        // Do not call fetchChannels() here. A full reload re-sorts every channel and
        // dispatches 80+ STORE_CHANNELS rows, which reshuffles the Home list and jumps ScrollView.
        // SDK onChannelHidden + local removal + removeChannel keep UI/Redux aligned; the next routine
        // fetch (foreground, debounced refresh, etc.) will reconcile with the server.
      } catch (error) {
        logger.error("hideDmChannel(): failed", error);
        toast.error("Couldn't hide conversation");
      }
    },
    [sendbirdInstance?.groupChannel, dispatchSendbird]
  );

  const preloadAllChannelMessages = async (channelsToPreload: any[]) => {
    try {
      logger.debug(
        "🚀 [preloadAllChannelMessages] Starting background preload:",
        {
          count: channelsToPreload.length
        }
      );

      // Process channels in batches to avoid overwhelming the server
      const BATCH_SIZE = 5; // Optimized: 5 channels at a time (up from 3)
      const BATCH_DELAY_MS = 500; // Optimized: 500ms between batches (down from 1000ms)

      for (let i = 0; i < channelsToPreload.length; i += BATCH_SIZE) {
        const batch = channelsToPreload.slice(i, i + BATCH_SIZE);

        // Process batch in parallel
        await Promise.all(
          batch.map(async (channelData) => {
            try {
              const channelUrl = channelData.url;

              // Skip if already cached
              const cached = MessageCache.getCachedMessages(channelUrl);
              if (cached && cached.length > 0) {
                // logger.debug("⏭️ [preloadAllChannelMessages] Already cached:", channelUrl);
                return;
              }

              // Fetch fresh GroupChannel instance from Sendbird
              const channel = await sendbirdInstance.groupChannel.getChannel(
                channelUrl
              );

              // Create temporary collection to fetch messages (exclude thread replies from main view)
              const filter = new MessageFilter({ replyType: ReplyType.NONE });
              const collection = channel.createMessageCollection({
                filter,
                prevResultLimit: 14,
                nextResultLimit: 0,
                startingPoint: Date.now()
              });

              if (collection.hasPrevious) {
                const messages = await collection.loadPrevious();
                const chatMessages = messages as unknown as ChatMessage[];

                if (chatMessages.length > 0) {
                  MessageCache.setCachedMessages(channel.url, chatMessages);
                  // logger.debug("✅ [preloadAllChannelMessages] Cached messages:", {
                  //   channelUrl: channel.url,
                  //   channelName: channel.name,
                  //   count: chatMessages.length
                  // });
                }
              }

              collection.dispose();
            } catch (_error) {
              // logger.error("❌ [preloadAllChannelMessages] Error preloading channel:", {
              //   channelUrl: channelData?.url,
              //   error
              // });
            }
          })
        );

        // Wait before next batch (except for last batch)
        if (i + BATCH_SIZE < channelsToPreload.length) {
          await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
        }
      }

      logger.debug("🎉 [preloadAllChannelMessages] Preload complete:", {
        total: channelsToPreload.length
      });
    } catch (error) {
      logger.error("❌ [preloadAllChannelMessages] Fatal error:", error);
    }
  };

  const fetchOrCreatePersonalChannel = async () => {
    logger.debug("fetchOrCreatePersonalChannel(): fetching personal channel");
    const tenantId = user?.tenantId;

    const groupChannelFilter = new GroupChannelFilter({
      includeEmpty: true,
      customTypesFilter: [`DM_${tenantId}_PERSONAL`],
      hiddenChannelFilter: HiddenChannelFilter.ALL
    });

    const collectionParameters: GroupChannelCollectionParams = {
      filter: groupChannelFilter,
      limit: 5,
      order: GroupChannelListOrder.LATEST_LAST_MESSAGE
    };

    const collection =
      sendbirdInstance.groupChannel.createGroupChannelCollection(
        collectionParameters
      );
    const res = await collection.loadMore();

    if (!res.length) {
      const params: GroupChannelCreateParams = {
        invitedUserIds: [`${user?.id}`],
        name: user?.extName,
        isPublic: false,
        isDistinct: true,
        customType: CustomChannelType.personalChannel(tenantId || -1),
        operatorUserIds: [user?.id.toString() || ""]
      };
      return sendbirdInstance?.groupChannel.createChannel(params);
    }

    collection.dispose();
    return res[0];
  };

  // =========== Thread Management ===========
  const setActiveThread = useCallback(
    (parentMessageId: number, parentMessage?: BaseMessage) => {
      logger.debug("[Thread Cache] Setting active thread:", parentMessageId);
      setActiveThreadId(parentMessageId);
      if (parentMessage) {
        setActiveParentMessage(parentMessage);
      }
    },
    []
  );

  const clearActiveThread = useCallback(() => {
    logger.debug(
      "[Thread Cache] Clearing active thread, was:",
      activeThreadIdRef.current
    );
    setActiveThreadId(null);
    setActiveParentMessage(null);
    setThreadMessages([]);
  }, []);

  /** Load thread replies from cache into state (sync). Used on mount before API sync. */
  const loadThreadFromCache = useCallback(
    (channelUrl: string, parentMessageId: number | string) => {
      const cached = ThreadCache.getThreadMessages(channelUrl, parentMessageId);
      setThreadMessages(cached ?? []);
      if (cached && cached.length > 0) {
        logger.debug(
          "[loadThreadFromCache] Loaded cached replies:",
          cached.length
        );
      }
    },
    []
  );

  /** Mark channel as read by URL. Works even when currentChannel is not set yet. */
  const markChannelAsRead = useCallback(
    async (channelUrl: string): Promise<void> => {
      if (!sendbirdInstance || !channelUrl) return;
      try {
        const channel = await sendbirdInstance.groupChannel.getChannel(
          channelUrl
        );
        await channel.markAsRead();
        logger.debug("[markChannelAsRead] Marked channel as read:", channelUrl);
      } catch (err) {
        logger.debug("[markChannelAsRead] Error:", err);
      }
    },
    []
  );

  const fetchThreadMessages = useCallback(
    async (parentMessage: BaseMessage, channelUrlParam?: string) => {
      if (!parentMessage || isFetchingThread) return;

      // Type guard to ensure the message has thread functionality
      if (!("getThreadedMessagesByTimestamp" in parentMessage)) {
        logger.error("Message does not support threading");
        return;
      }

      const channelUrl = channelUrlParam ?? currentChannel?.url;
      if (!channelUrl) return;

      // Cache was already loaded by loadThreadFromCache; re-read for merge with fresh
      const cached = ThreadCache.getThreadMessages(
        channelUrl,
        parentMessage.messageId
      );

      setIsFetchingThread(true);
      try {
        logger.debug(
          "Fetching thread messages for parent:",
          parentMessage.messageId
        );

        const result = await (
          parentMessage as ChatMessage
        ).getThreadedMessagesByTimestamp(parentMessage.createdAt, {
          prevResultSize: 200,
          nextResultSize: 200,
          isInclusive: true,
          reverse: true,
          includeParentMessageInfo: true,
          includeMetaArray: true,
          includeReactions: true
        });

        const freshMessages = (result.threadedMessages || []) as ChatMessage[];
        // Merge: use fresh as base, add any from cache not in fresh (e.g. just received via onMessageReceived)
        const freshIds = new Set(freshMessages.map((m) => m.messageId));
        const fromCache = (cached || []).filter(
          (m) => !freshIds.has(m.messageId)
        );
        const merged = [...freshMessages, ...fromCache].sort(
          (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
        );

        setThreadMessages(merged);
        ThreadCache.setThreadMessages(
          channelUrl,
          parentMessage.messageId,
          merged
        );
      } catch (error) {
        logger.error("Failed to fetch thread messages:", error);
        toast.error("Failed to load thread messages");
      } finally {
        setIsFetchingThread(false);
      }
    },
    [currentChannel?.url]
  );

  const refreshChannel = useCallback(
    async (channelUrl: string, unreadCountFromFCM?: number) => {
      try {
        // DEDUPLICATION: Skip if same channel was refreshed in last 200ms (blocks rapid duplicate FCM)
        const now = Date.now();
        const lastRefresh = recentRefreshCallsRef.current.get(channelUrl);
        if (lastRefresh && now - lastRefresh < 200) {
          return; // Skip duplicate refresh
        }
        recentRefreshCallsRef.current.set(channelUrl, now);
        // Clean old entries
        if (recentRefreshCallsRef.current.size > 20) {
          const entries = Array.from(recentRefreshCallsRef.current.entries());
          entries
            .slice(0, 10)
            .forEach(([key]) => recentRefreshCallsRef.current.delete(key));
        }

        const isViewingThisChannel =
          currentChannelRef.current?.url === channelUrl;

        // OPTIMIZATION: Skip API calls if user is viewing this channel
        // SDK's onMessageReceived already handles real-time messages
        if (isViewingThisChannel) {
          // Just fire-and-forget markAsRead, no state updates needed
          void currentChannelRef.current?.markAsRead();
          return;
        }

        // Check if Sendbird is connected
        const checkConnection = () => {
          return isConnected || sendbirdInstance.connectionState === "OPEN";
        };

        // If not connected and we have FCM unread count, use it immediately
        if (!checkConnection() && unreadCountFromFCM !== undefined) {
          setChannels((prevChannels) => {
            const existingChannel = prevChannels.find(
              (chn) => chn.url === channelUrl
            );
            if (existingChannel) {
              const updatedChannel = {
                ...existingChannel,
                unreadMessageCount: unreadCountFromFCM
              } as GroupChannel;
              const updatedChannels = prevChannels.filter(
                (chn) => chn.url !== channelUrl
              );
              return ensureUniqueChannels([
                updatedChannel,
                ...updatedChannels
              ] as GroupChannel[]);
            }
            return prevChannels;
          });
          return;
        }

        const refreshedChannel = await sendbirdInstance.groupChannel.getChannel(
          channelUrl
        );

        setChannels((prevChannels) => {
          const updatedChannels = prevChannels.filter(
            (chn) => chn.url !== refreshedChannel.url
          );
          return ensureUniqueChannels([
            refreshedChannel,
            ...updatedChannels
          ] as GroupChannel[]);
        });
      } catch (error) {
        logger.error("❌ [refreshChannel] Error refreshing channel:", error);
      }
    },
    [sendbirdInstance]
  );

  // Refresh only the new messages - optimized for speed.
  const refreshCurrentChannelMessages = useCallback(async () => {
    if (!currentChannel || !sendbirdInstance) {
      logger.debug(
        "⚠️ [refreshCurrentChannelMessages] No current channel or sendbird instance"
      );
      return;
    }

    try {
      // FIRST: Restore currentChannelRef immediately so real-time messages work
      if (!currentChannelRef.current) {
        currentChannelRef.current = currentChannel;
        logger.debug(
          "🔄 [refreshCurrentChannelMessages] Restored currentChannelRef immediately"
        );
      }

      // Get the timestamp of latest message we have (or use 0 if no messages).
      const latestMessageTimestamp =
        messages.length > 0
          ? Math.max(...messages.map((m) => m.createdAt || 0))
          : 0;

      logger.debug(
        "🔄 [refreshCurrentChannelMessages] Fetching new messages after timestamp:",
        {
          channelUrl: currentChannel.url,
          latestMessageTimestamp,
          currentMessagesCount: messages.length
        }
      );

      // Fetch messages newer than our latest message.
      const newMessages = await currentChannel.getMessagesByTimestamp(
        latestMessageTimestamp,
        {
          prevResultSize: 0,
          nextResultSize: 30,
          isInclusive: false
        }
      );

      if (newMessages.length > 0) {
        logger.debug("✅ [refreshCurrentChannelMessages] Found new messages:", {
          count: newMessages.length,
          channelUrl: currentChannel.url
        });

        // Update messages state immediately.
        setMessages((prevMessages) => {
          const messageMap = new Map(
            prevMessages.map((msg) => [msg.messageId, msg])
          );

          newMessages.forEach((msg) => {
            messageMap.set(msg.messageId, msg as ChatMessage);
          });

          const merged = Array.from(messageMap.values()).sort(
            (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
          );
          const updatedMessages = onlyMainChannelMessages(merged);

          if (currentChannel.url && updatedMessages.length > 0) {
            MessageCache.setCachedMessages(currentChannel.url, updatedMessages);
          }

          return updatedMessages;
        });

        // FIX: Mark as read and wait for it to complete (not fire-and-forget)
        // This ensures the server knows we've read the messages
        await currentChannel.markAsRead();
        logger.debug(
          "✅ [refreshCurrentChannelMessages] Channel marked as read on server"
        );

        // FIX: Reset custom unread count in Redux (same as enterChannel does)
        dispatchSendbird(
          sendbirdActions.resetChannelUnread(currentChannel.url)
        );
        UnreadCountCache.clearUnreadCount(currentChannel.url);
        logger.debug(
          "🔄 [refreshCurrentChannelMessages] Reset custom unread count for channel",
          currentChannel.url
        );

        // FIX: Refresh the channel to get updated unread count (should be 0 after markAsRead)
        const refreshedChannel = await sendbirdInstance.groupChannel.getChannel(
          currentChannel.url
        );

        // FIX: Update channels array with refreshed channel (which has unreadMessageCount = 0)
        setChannels((prevChannels) => {
          const res = prevChannels.map((chn) =>
            chn.url === refreshedChannel.url
              ? (refreshedChannel as GroupChannel)
              : chn
          );
          return ensureUniqueChannels(res);
        });

        // FIX: Update currentChannel with refreshed channel
        setCurrentChannel(refreshedChannel);

        logger.debug(
          "✅ [refreshCurrentChannelMessages] Channel refreshed, unread count:",
          {
            channelUrl: currentChannel.url,
            unreadCount: refreshedChannel.unreadMessageCount
          }
        );
      } else {
        logger.debug(
          "ℹ️ [refreshCurrentChannelMessages] No new messages found"
        );

        // FIX: Even if no new messages, mark as read and reset unread count
        // This handles the case where messages arrived while app was in background
        // but were already fetched by real-time handlers
        await currentChannel.markAsRead();
        dispatchSendbird(
          sendbirdActions.resetChannelUnread(currentChannel.url)
        );
        UnreadCountCache.clearUnreadCount(currentChannel.url);

        // Refresh channel to get updated unread count
        const refreshedChannel = await sendbirdInstance.groupChannel.getChannel(
          currentChannel.url
        );
        setChannels((prevChannels) => {
          const res = prevChannels.map((chn) =>
            chn.url === refreshedChannel.url
              ? (refreshedChannel as GroupChannel)
              : chn
          );
          return ensureUniqueChannels(res);
        });
        setCurrentChannel(refreshedChannel);

        logger.debug(
          "✅ [refreshCurrentChannelMessages] Channel marked as read (no new messages), unread count:",
          {
            channelUrl: currentChannel.url,
            unreadCount: refreshedChannel.unreadMessageCount
          }
        );
      }
    } catch (error) {
      logger.error(
        "❌ [refreshCurrentChannelMessages] Error fetching new messages:",
        error
      );
    }
  }, [currentChannel, sendbirdInstance, messages, dispatchSendbird]);

  // =========== Message Management ===========
  const sendUserMessage = (message: UserMessageCreateParams) => {
    const sendStartTime = Date.now();
    console.warn("⏱️ [sendUserMessage] START:", {
      timestamp: sendStartTime,
      channelUrl: currentChannel?.url
    });

    if (!currentChannel) {
      logger.error("Can't send message as channel is not set");
      return;
    }

    console.warn(
      "⏱️ [sendUserMessage] Calling SDK:",
      Date.now() - sendStartTime,
      "ms"
    );
    const requestHandler = currentChannel.sendUserMessage(message);
    const tempId = Math.floor(10000000 + Math.random() * 90000000);

    // Create a temporary message
    const newMessage: any = {
      messageId: tempId,
      createdAt: new Date().getTime(),
      data: "",
      customType: "sending",
      messageType: MessageType.USER,
      sender: {
        userId: user?.id.toString()
      },
      parentMessageId: message.parentMessageId,
      updatedAt: 0,
      isUserMessage: () => true,
      isAdminMessage: () => false,
      isMultipleFileMessage: () => false,
      isFileMessage: () => false,
      ...message
    };

    // Add to appropriate cache based on context
    const currentActiveThreadId = activeThreadIdRef.current;
    if (
      message.parentMessageId &&
      message.parentMessageId === currentActiveThreadId
    ) {
      logger.debug("[Thread Cache] Adding temp message to active thread");
      // Add to thread cache if sending to active thread
      setThreadMessages((prev) => {
        const prevMessages = [newMessage, ...prev];
        return prevMessages.filter(
          (item, index, self) =>
            index === self.findIndex((obj) => obj.messageId === item.messageId)
        );
      });
    } else if (!message.parentMessageId) {
      // Add to main messages if not a thread reply
      setMessages((prev) => {
        const prevMessages = [newMessage, ...prev];
        return prevMessages.filter(
          (item, index, self) =>
            index === self.findIndex((obj) => obj.messageId === item.messageId)
        );
      });
    }

    requestHandler?.onSucceeded((message) => {
      console.warn(
        "⏱️ [sendUserMessage] onSucceeded:",
        Date.now() - sendStartTime,
        "ms",
        { messageId: message.messageId }
      );
      setChannels((prevChannels) => {
        const updatedChannels = prevChannels.filter(
          (chn) => chn.url !== currentChannel.url
        );
        return ensureUniqueChannels([
          currentChannel,
          ...updatedChannels
        ] as GroupChannel[]);
      });

      if (message.parentMessageId) {
        // Update thread cache if this is for the active thread
        if (message.parentMessageId === currentActiveThreadId) {
          logger.debug(
            "[Thread Cache] Replacing temp message with real message in thread"
          );
          setThreadMessages((prev) => {
            const prevMessages = [...prev];
            const tempMessageIndex = prevMessages.findIndex(
              (item) => item.messageId === tempId
            );
            if (tempMessageIndex > -1) {
              prevMessages[tempMessageIndex] = message as ChatMessage;
            }
            return prevMessages.filter(
              (item, index, self) =>
                index ===
                self.findIndex((obj) => obj.messageId === item.messageId)
            );
          });
        }

        // Update parent message's thread info in main messages
        setMessages((prev) => {
          const newMessages = [...prev];
          const parentMessageIndex = newMessages.findIndex(
            (item) => item.messageId === message.parentMessageId
          );
          if (parentMessageIndex > -1) {
            const parentMessage = newMessages[parentMessageIndex];
            if (parentMessage.threadInfo) {
              parentMessage.threadInfo.replyCount += 1;
              parentMessage.threadInfo.lastRepliedAt = Date.now();
            } else {
              parentMessage.threadInfo = {
                replyCount: 1,
                memberCount: 0,
                mostRepliedUsers: [],
                unreadReplyCount: 0,
                isPushNotificationEnabled: false,
                lastRepliedAt: Date.now(),
                updatedAt: Date.now()
              };
            }
          }
          return newMessages;
        });
        setReFetchThread((prev) => !prev);
        return;
      }

      // Update main messages for non-thread messages
      setMessages((prev) => {
        const prevMessages = [message, ...prev].filter(
          (item, index, self) =>
            index === self.findIndex((obj) => obj.messageId === item.messageId)
        );
        const withoutTemp = prevMessages.filter(
          (item) => item.messageId !== tempId
        ) as ChatMessage[];
        const main = onlyMainChannelMessages(withoutTemp);
        if (currentChannel.url && main.length > 0) {
          MessageCache.setCachedMessages(currentChannel.url, main);
        }
        return withoutTemp;
      });
    });

    requestHandler?.onFailed(() => {
      setMessages((prev) => prev.filter((item) => item.messageId !== tempId));
    });
  };

  const sendFileMessage = (message: FileMessageCreateParams) => {
    if (!currentChannel) {
      logger.error("Can't send message as channel is not set");
      return;
    }

    const requestHandler = currentChannel.sendFileMessage(message);

    requestHandler?.onPending((pendingMessage) => {
      const pm = pendingMessage as ChatMessage;
      const currentActiveThreadId = activeThreadIdRef.current;
      if (
        pm.parentMessageId &&
        pm.parentMessageId === currentActiveThreadId
      ) {
        setThreadMessages((prev) => dedupeChatMessages([pm, ...prev]));
      } else if (!pm.parentMessageId) {
        setMessages((prev) => dedupeChatMessages([pm, ...prev]));
      }
    });

    requestHandler?.onSucceeded((message) => {
      logger.debug("Message Sent Successfully");
      setChannels((prevChannels) => {
        const updatedChannels = prevChannels.filter(
          (chn) => chn.url !== currentChannel.url
        );
        return ensureUniqueChannels([
          currentChannel,
          ...updatedChannels
        ] as GroupChannel[]);
      });

      const currentActiveThreadId = activeThreadIdRef.current;
      const finalMsg = message as ChatMessage;

      if (
        message.parentMessageId &&
        message.parentMessageId === currentActiveThreadId
      ) {
        logger.debug("[Thread Cache] File message succeeded (thread)");
        setThreadMessages((prev) =>
          replaceOrPrependByReqId(prev, finalMsg)
        );

        setMessages((prev) => {
          const newMessages = [...prev];
          const parentMessageIndex = newMessages.findIndex(
            (item) => item.messageId === message.parentMessageId
          );
          if (parentMessageIndex > -1) {
            const parentMessage = newMessages[parentMessageIndex];
            if (parentMessage.threadInfo) {
              parentMessage.threadInfo.replyCount += 1;
              parentMessage.threadInfo.lastRepliedAt = Date.now();
            } else {
              parentMessage.threadInfo = {
                replyCount: 1,
                memberCount: 0,
                mostRepliedUsers: [],
                unreadReplyCount: 0,
                isPushNotificationEnabled: false,
                lastRepliedAt: Date.now(),
                updatedAt: Date.now()
              };
            }
          }
          return newMessages;
        });
        setReFetchThread((prev) => !prev);
      } else if (!message.parentMessageId) {
        setMessages((prev) => {
          const prevMessages = replaceOrPrependByReqId(prev, finalMsg);
          const main = onlyMainChannelMessages(prevMessages);
          if (currentChannel.url && main.length > 0) {
            MessageCache.setCachedMessages(currentChannel.url, main);
          }
          return prevMessages;
        });
      }
      return true;
    });

    requestHandler?.onFailed((err, failedMsg) => {
      const rid = failedMsg
        ? (failedMsg as ReqIdentifiedMessage).reqId
        : undefined;
      if (rid) {
        setMessages((prev) =>
          prev.filter((m) => (m as ReqIdentifiedMessage).reqId !== rid)
        );
        setThreadMessages((prev) =>
          prev.filter((m) => (m as ReqIdentifiedMessage).reqId !== rid)
        );
      }
      logger.debug("Error Sending File Message", err);
      return false;
    });
  };

  const sendMultipleFileMessage = (
    messages: MultipleFilesMessageCreateParams
  ) => {
    if (!currentChannel) {
      logger.error("Can't send message as channel is not set");
      return;
    }

    const requestHandler = currentChannel.sendMultipleFilesMessage(messages);

    requestHandler?.onPending((pendingMessage) => {
      const pm = pendingMessage as ChatMessage;
      const currentActiveThreadId = activeThreadIdRef.current;
      if (
        pm.parentMessageId &&
        pm.parentMessageId === currentActiveThreadId
      ) {
        setThreadMessages((prev) => dedupeChatMessages([pm, ...prev]));
      } else if (!pm.parentMessageId) {
        setMessages((prev) => dedupeChatMessages([pm, ...prev]));
      }
    });

    requestHandler?.onSucceeded((message) => {
      logger.debug("Message Sent Successfully");
      setChannels((prevChannels) => {
        const updatedChannels = prevChannels.filter(
          (chn) => chn.url !== currentChannel.url
        );
        return ensureUniqueChannels([
          currentChannel,
          ...updatedChannels
        ] as GroupChannel[]);
      });

      const currentActiveThreadId = activeThreadIdRef.current;
      const finalMsg = message as ChatMessage;

      if (
        message.parentMessageId &&
        message.parentMessageId === currentActiveThreadId
      ) {
        logger.debug("[Thread Cache] Multi-file message succeeded (thread)");
        setThreadMessages((prev) =>
          replaceOrPrependByReqId(prev, finalMsg)
        );

        setMessages((prev) => {
          const newMessages = [...prev];
          const parentMessageIndex = newMessages.findIndex(
            (item) => item.messageId === message.parentMessageId
          );
          if (parentMessageIndex > -1) {
            const parentMessage = newMessages[parentMessageIndex];
            if (parentMessage.threadInfo) {
              parentMessage.threadInfo.replyCount += 1;
              parentMessage.threadInfo.lastRepliedAt = Date.now();
            } else {
              parentMessage.threadInfo = {
                replyCount: 1,
                memberCount: 0,
                mostRepliedUsers: [],
                unreadReplyCount: 0,
                isPushNotificationEnabled: false,
                lastRepliedAt: Date.now(),
                updatedAt: Date.now()
              };
            }
          }
          return newMessages;
        });
        setReFetchThread((prev) => !prev);
      } else if (!message.parentMessageId) {
        setMessages((prev) => {
          const prevMessages = replaceOrPrependByReqId(prev, finalMsg);
          const main = onlyMainChannelMessages(prevMessages);
          if (currentChannel.url && main.length > 0) {
            MessageCache.setCachedMessages(currentChannel.url, main);
          }
          return prevMessages;
        });
      }
      return true;
    });

    requestHandler?.onFailed((err, failedMsg) => {
      const rid = failedMsg
        ? (failedMsg as ReqIdentifiedMessage).reqId
        : undefined;
      if (rid) {
        setMessages((prev) =>
          prev.filter((m) => (m as ReqIdentifiedMessage).reqId !== rid)
        );
        setThreadMessages((prev) =>
          prev.filter((m) => (m as ReqIdentifiedMessage).reqId !== rid)
        );
      }
      logger.debug("Error Sending Multiple File Message", err);
      return false;
    });
  };

  const editUserMessage = async (message: string, messageId: number) => {
    if (!currentChannel) {
      logger.error("Can't send message as channel is not set");
      return;
    }

    try {
      const res = await currentChannel.updateUserMessage(messageId, {
        message
      });

      // Update main messages (for non-thread messages); keep list free of thread replies
      setMessages((prevMessages) =>
        onlyMainChannelMessages(
          prevMessages.map((msg) => (msg.messageId === messageId ? res : msg))
        )
      );

      // Update thread messages if this is a thread reply
      // This ensures the message is updated even if the thread is not currently active
      if (res.parentMessageId) {
        const currentActiveThreadId = activeThreadIdRef.current;
        if (currentActiveThreadId === res.parentMessageId) {
          logger.debug(
            "[Thread Cache] Updating edited message in active thread"
          );
          setThreadMessages((prevMessages) =>
            prevMessages.map((msg) =>
              msg.messageId === messageId ? (res as ChatMessage) : msg
            )
          );
        }
        setReFetchThread((prev) => !prev);
      } else {
        // Check if editing the parent message itself while thread is open
        const currentActiveThreadId = activeThreadIdRef.current;
        if (currentActiveThreadId === messageId) {
          logger.debug(
            "✅ [editUserMessage] Updating parent message in active thread",
            {
              messageId: messageId,
              messageContent: (res as any).message
            }
          );
          setActiveParentMessage(res);
        }
      }

      setChannels((prevChannels) => {
        const updatedChannels = prevChannels.filter(
          (chn) => chn.url !== currentChannel.url
        );
        return ensureUniqueChannels([
          currentChannel,
          ...updatedChannels
        ] as GroupChannel[]);
      });
    } catch (error) {
      logger.error("Error editing message", error);
      toast.error("Error editing message");
    }
  };

  const deleteUserMessage = async (
    message: BaseMessage,
    channelUrl: string
  ) => {
    try {
      logger.debug("Deleting message: ", message);
      if (channelUrl === currentChannel?.url) {
        await currentChannel.deleteMessage(message);

        MessageCache.removeMessageFromChannelCache(
          channelUrl,
          message.messageId
        );
        ThreadCache.removeMessageFromThreadCachesForChannel(
          channelUrl,
          message.messageId
        );

        // Update main messages
        setMessages((prev) =>
          prev.filter((item) => item.messageId !== message.messageId)
        );

        // Also remove from thread cache if this is a thread message in the active thread
        const currentActiveThreadId = activeThreadIdRef.current;
        if (message.parentMessageId === currentActiveThreadId) {
          logger.debug(
            "[Thread Cache] Removing deleted message from active thread"
          );
          setThreadMessages((prev) =>
            prev.filter((item) => item.messageId !== message.messageId)
          );
        }

        if (message.parentMessageId) setReFetchThread((prev) => !prev);
        logger.debug("Message Deleted");
      }
    } catch (e) {
      toast.error("Error deleting message");
      logger.error("Error deleting message", e);
    }
  };

  const leaveChannelPermanently = async (channel: GroupChannel) => {
    try {
      await channel.leave();
      setChannels((prevChannels) =>
        prevChannels.filter((c) => c.url !== channel.url)
      );
      logger.debug("Left Channel Permanently: ", channel.name);
    } catch (error) {
      logger.error("Error leaving channel permanently: ", error);
      throw error;
    }
  };

  const deleteChannel = async (channel: GroupChannel) => {
    try {
      await channel.delete();
      setChannels((prevChannels) =>
        prevChannels.filter((c) => c.url !== channel.url)
      );
      dispatchSendbird(sendbirdActions.removeChannel(channel.url));
      logger.debug("Deleted Channel: ", channel.name);

      try {
        await fetchChannels();
      } catch (error) {
        logger.debug("Error refreshing channels after deletion:", error);
      }
    } catch (error) {
      logger.error("Error deleting channel: ", error);
      throw error;
    }
  };

  const reactionEvent = async (
    message: BaseMessage,
    reaction: string,
    userId: string
  ) => {
    const foundReaction = message.reactions.find((r) => r.key === reaction);
    const userInReaction = foundReaction?.userIds.includes(userId);

    if (userInReaction) {
      await currentChannel?.deleteReaction(message, reaction);
    } else {
      await currentChannel?.addReaction(message, reaction);
    }

    if (!currentChannel) return;

    const fetchedMessage = await sendbirdInstance.message.getMessage({
      messageId: message.messageId,
      channelUrl: currentChannel.url,
      channelType: currentChannel.channelType,
      includeReactions: true,
      includeMetaArray: true,
      includeThreadInfo: true
    });

    setMessages(
      (prev) =>
        prev.map((item) =>
          item.messageId === message.messageId
            ? (fetchedMessage as BaseMessage)
            : item
        ) as ChatMessage[]
    );

    // Also update thread cache if this is a thread message in the active thread
    const currentActiveThreadId = activeThreadIdRef.current;
    if (
      fetchedMessage &&
      "parentMessageId" in fetchedMessage &&
      fetchedMessage.parentMessageId === currentActiveThreadId
    ) {
      logger.debug("[Thread Cache] Updating reaction in active thread");
      setThreadMessages((prev) =>
        prev.map((item) =>
          item.messageId === message.messageId
            ? (fetchedMessage as ChatMessage)
            : item
        )
      );
    }
  };

  // Fetching Previous Messages
  const fetchMoreMessages = async () => {
    if (messageCollection?.hasPrevious && !isFetchingMessages) {
      try {
        setIsFetchingMessages(true);
        const newMessages = await messageCollection.loadPrevious();

        setMessages((prevMessages) => {
          const messageMap = new Map(
            prevMessages.map((msg) => [msg.messageId, msg])
          );
          newMessages.forEach((msg) =>
            messageMap.set(msg.messageId, msg as ChatMessage)
          );
          const merged = Array.from(messageMap.values()).sort(
            (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
          ) as ChatMessage[];
          const updatedMessages = onlyMainChannelMessages(merged);

          if (currentChannel?.url && updatedMessages.length > 0) {
            MessageCache.setCachedMessages(currentChannel.url, updatedMessages);
          }

          return updatedMessages;
        });
      } catch (error) {
        console.error("Error loading more messages:", error);
      } finally {
        setIsFetchingMessages(false);
      }
    }
  };

  // Fetching Later Messages
  const fetchNewMessages = async () => {
    if (messageCollection?.hasNext) {
      try {
        logger.debug("Fetching new messages");
        const newMessages = await messageCollection.loadNext();
        setMessages((prevMessages) => {
          const messageMap = new Map(
            prevMessages.map((msg) => [msg.messageId, msg])
          );
          newMessages.forEach((msg) =>
            messageMap.set(msg.messageId, msg as ChatMessage)
          );
          const merged = Array.from(messageMap.values()).sort(
            (a, b) => (a.createdAt || 0) - (b.createdAt || 0)
          );
          return onlyMainChannelMessages(merged);
        });
      } catch (error) {
        console.error("Error loading new messages:", error);
      }
    }
  };

  // =========== Notification Management ===========
  const displaySendbirdNotification = async (
    channel: GroupChannel,
    message: BaseMessage
  ) => {
    let iosDedupReserved = false;
    try {
      console.log("[IOS_NOTIF_SOUND_TRACE] displaySendbirdNotification.enter", {
        messageId: message.messageId,
        channelUrl: channel.url,
        appState: AppState.currentState
      });
      const currentAppState = AppState.currentState;
      const isBackgroundOrInactive =
        currentAppState === "background" || currentAppState === "inactive";

      // iOS background/inactive: system APNs + VoxoNotificationExtension (NSE) show the banner.
      // WebSocket onMessageReceived must not also post Notifee — that caused duplicate notifications.
      if (Platform.OS === "ios" && isBackgroundOrInactive) {
        recordSendbirdMessageFromSystemPush(message.messageId);
        logger.debug(
          "🚫 [displaySendbirdNotification] iOS background/inactive — skip Notifee (system APNs + NSE)",
          {
            appState: currentAppState,
            channelUrl: channel.url,
            messageId: message.messageId
          }
        );
        return;
      }

      if (Platform.OS === "ios") {
        await drainIosInitialNotificationForDedup();
        await syncIosDeliveredSendbirdIdsForDedup();
      }

      if (Platform.OS === "android") {
        logger.debug(
          "✅ [displaySendbirdNotification] Android - Showing notification via Notifee",
          {
            appState: currentAppState,
            channelUrl: channel.url,
            messageId: message.messageId,
            isForeground: currentAppState === "active"
          }
        );
      }

      const state = store.getState() as State;
      const user = state.userReducer?.user;

      if (!shouldShowSendbirdNotificationForChannel(channel, user)) {
        logger.debug(
          "🚫 [displaySendbirdNotification] Sendbird notification BLOCKED - user notification prefs",
          {
            enableChatNotifications: user?.enableChatNotifications,
            enableAllNewMessageNotifications:
              user?.enableAllNewMessageNotifications,
            enableDirectMessageNotifications:
              user?.enableDirectMessageNotifications,
            channelUrl: channel.url,
            channelName: channel.name,
            messageId: message.messageId,
            customType: channel.customType
          }
        );
        return;
      }

      // CHANNEL-LEVEL NOTIFICATION SETTINGS: Respect myPushTriggerOption.
      const channelPushOption = channel.myPushTriggerOption;

      // Check if current user is mentioned (needed for MENTION_ONLY check).
      const activeUserId = String(state.userReducer?.user?.id || "");
      const msgForMentionCheck = message as any;
      const mentionedIds = msgForMentionCheck.mentionedUserIds || [];
      const mentionedList = msgForMentionCheck.mentionedUsers || [];
      const isUserMentioned =
        mentionedIds.some((id: string) => String(id) === activeUserId) ||
        mentionedList.some((u: any) => String(u.userId) === activeUserId);

      const desiredPushOption = pushTriggerForChannel(channel.customType, user);

      if (channelPushOption === "off") {
        if (desiredPushOption === PushTriggerOption.ALL) {
          logger.debug(
            "⚠️ [displaySendbirdNotification] Channel push trigger OFF but user prefs allow — reconciling and showing",
            {
              channelUrl: channel.url,
              channelName: channel.name,
              messageId: message.messageId,
              pushOption: channelPushOption,
              customType: channel.customType
            }
          );
          void applyPushTriggerToChannel(channel, user);
        } else {
          logger.debug(
            "🚫 [displaySendbirdNotification] Notification BLOCKED - Channel notifications set to OFF",
            {
              channelUrl: channel.url,
              channelName: channel.name,
              messageId: message.messageId,
              pushOption: channelPushOption
            }
          );
          return;
        }
      }

      if (channelPushOption === "mention_only" && !isUserMentioned) {
        logger.debug(
          "🚫 [displaySendbirdNotification] Notification BLOCKED - Channel set to MENTIONS ONLY and user not mentioned",
          {
            channelUrl: channel.url,
            channelName: channel.name,
            messageId: message.messageId,
            pushOption: channelPushOption,
            isUserMentioned
          }
        );
        return;
      }

      if (message.messageType === MessageType.ADMIN) {
        const messageText = ((message as any).message || "").toLowerCase();
        const isChannelCreationMessage =
          !messageText ||
          messageText.trim().length === 0 ||
          messageText.includes("joined") ||
          messageText.includes("channel created") ||
          messageText.includes("created channel") ||
          messageText.includes("is created") ||
          messageText.includes("the channel is created");

        if (isChannelCreationMessage) {
          logger.debug(
            "🚫 [displaySendbirdNotification] Sendbird notification BLOCKED - Channel creation/join message",
            {
              channelUrl: channel.url,
              messageId: message.messageId,
              messageText: (message as any).message
            }
          );
          return;
        }
      }

      const messageWithSender = message as any;
      const sender = messageWithSender.sender;
      const senderName =
        sender?.nickname || sender?.name || sender?.userId || "";

      let messageContent = "";
      const customType = messageWithSender.customType;
      const isThreadReply = !!message.parentMessageId;

      // Check if current user is mentioned
      const currentUserId = String(user?.id || "");
      const mentionedUserIds = messageWithSender.mentionedUserIds || [];
      const mentionedUsers = messageWithSender.mentionedUsers || [];
      const isMentioned =
        mentionedUserIds.some((id: string) => String(id) === currentUserId) ||
        mentionedUsers.some((u: any) => String(u.userId) === currentUserId);

      // Check for GIF first
      if (customType === "MESSAGE_GIF") {
        messageContent = "Received a GIF 🎞️";
      } else if (customType === "MEETING_INVITE") {
        messageContent = "Invited you to a meeting";
      } else if (message.messageType === MessageType.USER) {
        messageContent = messageWithSender.message || "";

        // Strip HTML tags if message contains HTML
        if (messageContent && isHtml(messageContent)) {
          messageContent = messageContent.replace(/<[^>]+>/g, "");
          messageContent = messageContent.replace(/&nbsp;/g, " ");
          messageContent = messageContent.replace(/&amp;/g, "&");
          messageContent = messageContent.replace(/&lt;/g, "<");
          messageContent = messageContent.replace(/&gt;/g, ">");
          messageContent = messageContent.replace(/&quot;/g, '"');
          messageContent = messageContent.replace(/&#39;/g, "'");
          messageContent = messageContent.replace(/&apos;/g, "'");
          messageContent = messageContent.replace(/\s+/g, " ").trim();
        }

        if (!messageContent.trim()) {
          const metaArrays = messageWithSender.metaArrays || [];
          const hasGifMeta = metaArrays.some(
            (meta: any) =>
              meta.key === "url" ||
              meta.key === "gif_url" ||
              meta.key === "title"
          );
          if (hasGifMeta) {
            messageContent = "Received an attachment 📎";
          } else {
            messageContent = "Sent a message";
          }
        }
      } else if (message.messageType === MessageType.FILE) {
        messageContent = "Received an attachment 📎";
      } else {
        messageContent = "New message";
      }

      if (isMentioned && customType !== "MEETING_INVITE") {
        messageContent = "You were mentioned";
      }

      if (isThreadReply) {
        messageContent = `Reply: ${messageContent}`;
      }

      // Format notifications:
      // - DM:    Title = Sender,  Body = message
      // - Group: Title = Channel, Body = "Sender: message"
      const isDM =
        !!user?.tenantId &&
        (channel.customType === CustomChannelType.dmChannel(user.tenantId) ||
          channel.customType ===
            CustomChannelType.personalChannel(user.tenantId));

      const notificationTitle = isDM
        ? senderName || channel.name || "New Message"
        : channel.name || "New Message";

      const notificationBody =
        !isDM && senderName
          ? `${senderName}: ${messageContent}`
          : messageContent;

      if (Platform.OS === "ios") {
        const { skip, reason } = shouldSkipIosDuplicateLocalBanner(
          message.messageId,
          message.createdAt
        );
        if (skip) {
          console.log(
            "[IOS_NOTIF_SOUND_TRACE] displaySendbirdNotification.skip",
            {
              messageId: message.messageId,
              channelUrl: channel.url,
              reason
            }
          );
          logger.debug(
            "🚫 [displaySendbirdNotification] iOS — skip duplicate local banner",
            {
              messageId: message.messageId,
              channelUrl: channel.url,
              reason
            }
          );
          return;
        }
      }

      // Dedupe before showing: duplicate onMessageReceived (or FCM + SDK on Android bg)
      // must not post two local notifications for the same messageId.
      if (displayedNotificationMessageIds.has(message.messageId)) {
        logger.debug(
          "🚫 [displaySendbirdNotification] Skipping - notification already displayed for this messageId",
          {
            messageId: message.messageId,
            channelUrl: channel.url,
            platform: Platform.OS
          }
        );
        return;
      }
      displayedNotificationMessageIds.add(message.messageId);
      if (
        displayedNotificationMessageIds.size > NOTIFICATION_DEDUP_CACHE_SIZE
      ) {
        const idsToRemove = Array.from(displayedNotificationMessageIds).slice(
          0,
          20
        );
        idsToRemove.forEach((id) => displayedNotificationMessageIds.delete(id));
      }
      setTimeout(() => {
        displayedNotificationMessageIds.delete(message.messageId);
      }, NOTIFICATION_DEDUP_EXPIRY_MS);

      // iOS: record Sendbird message id in MMKV *before* any Notifee await so APNs → NotificationManager
      // cannot post a second banner while createChannel/display yield (same id as dedup key).
      if (Platform.OS === "ios") {
        recordSendbirdLocalNotifeeShown(message.messageId);
        iosDedupReserved = true;
      }

      const channelId = await notifee.createChannel({
        id: "voxo-notifications",
        name: getAppNotificationsChannelName(),
        importance: AndroidImportance.HIGH,
        sound: "default",
        vibration: true,
        vibrationPattern: [300, 500]
      });
      const notificationData: any = {
        channelUrl: channel.url,
        messageId: String(message.messageId),
        click_action: "SENDBIRD-RECEIVED"
      };

      // Add parentMessageId if this is thread reply.
      if (isThreadReply && message.parentMessageId) {
        notificationData.parentMessageId = String(message.parentMessageId);
        notificationData.parent_message_id = String(message.parentMessageId);
      }

      const notificationConfig: any = {
        id: `sendbird-${message.messageId}`,
        title: notificationTitle,
        body: notificationBody,
        data: notificationData
      };

      if (Platform.OS === "android") {
        notificationConfig.android = {
          channelId,
          importance: AndroidImportance.HIGH,
          pressAction: { id: "default" },
          smallIcon: "ic_launcher",
          showWhen: true,
          timestamp: Date.now(),
          visibility: 1,
          ongoing: false,
          autoCancel: true,
          sound: "default",
          vibrationPattern: [300, 500]
        };
      } else {
        // iOS: Notifee presents banner + sound (native APNs UI is suppressed in willPresent for remote pushes).
        // When this runs after the same message was already handled via APNs/MMKV dedup, we never reach here.
        notificationConfig.ios = {
          sound: "default",
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

      console.log(
        "[IOS_NOTIF_SOUND_TRACE] SendbirdContextProvider.notifee.display",
        {
          messageId: message.messageId,
          notifeeId: `sendbird-${message.messageId}`,
          channelUrl: channel.url,
          appState: AppState.currentState
        }
      );

      const notificationId = await notifee.displayNotification(
        notificationConfig
      );

      logger.debug("✅ [displaySendbirdNotification] Notification displayed", {
        notificationId,
        platform: Platform.OS,
        appState: AppState.currentState,
        channelUrl: channel.url,
        messageId: message.messageId
      });
    } catch (error) {
      if (Platform.OS === "ios" && iosDedupReserved) {
        forgetSendbirdNotifeeDedupMessageId(message.messageId);
      }
      logger.error("❌ [displaySendbirdNotification] Error:", error);
    }
  };

  const setPushNotification = async (
    enable: boolean,
    os: "ios" | "android" | "windows" | "web" | "macos",
    token: string
  ) => {
    try {
      const checkConnection = () => {
        return isConnected || sendbirdInstance?.connectionState === "OPEN";
      };

      if (!checkConnection()) {
        let attempts = 0;
        const maxAttempts = 20;

        while (!checkConnection() && attempts < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          attempts++;
        }
      }

      if (enable) {
        if (!sendbirdInstance.currentUser) {
          throw new Error(
            "Cannot register push token: Sendbird user not connected"
          );
        }

        const existingTokenIndex = registeredPushTokensRef.current.findIndex(
          (t) => t.token === token && t.os === os
        );

        if (os === "ios") {
          try {
            const registrationPromise =
              sendbirdInstance.registerAPNSPushTokenForCurrentUser(token);
            const timeoutPromise = new Promise((_, reject) =>
              setTimeout(
                () =>
                  reject(new Error("Registration timeout after 10 seconds")),
                10000
              )
            );

            const result = await Promise.race([
              registrationPromise,
              timeoutPromise
            ]);
            console.log("result", result);
          } catch (error: any) {
            logger.error(
              "❌ [setPushNotification] Error registering APNs token",
              {
                error: error?.message || error,
                errorCode: error?.code,
                currentUserId: sendbirdInstance.currentUser?.userId,
                connectionState: sendbirdInstance?.connectionState,
                tokenPreview: `${token.substring(0, 20)}...${token.substring(
                  token.length - 10
                )}`,
                isTimeout: error?.message?.includes("timeout")
              }
            );

            throw error; // Re-throw to be caught by outer catch
          }
        } else {
          try {
            await sendbirdInstance.registerFCMPushTokenForCurrentUser(token);
            console.log(
              "✅ [setPushNotification] FCM token registered successfully"
            );
          } catch (error: any) {
            console.error(
              "❌ [setPushNotification] Error registering FCM token",
              error
            );
            throw error;
          }
        }

        // Only add to tracking ref if not already there.
        if (existingTokenIndex < 0) {
          registeredPushTokensRef.current.push({ token, os });
          logger.debug(
            `✅ Registered ${os} push token with Sendbird (new registration)`,
            {
              currentUserId: sendbirdInstance.currentUser?.userId
            }
          );
        } else {
          logger.debug(
            `✅ Re-registered ${os} push token with Sendbird (preference changed)`,
            {
              currentUserId: sendbirdInstance.currentUser?.userId
            }
          );
          console.log(
            `✅ [setPushNotification] Token re-registered (already in tracking)`,
            {
              currentUserId: sendbirdInstance.currentUser?.userId,
              os
            }
          );
        }
      } else {
        if (os === "ios") {
          await sendbirdInstance.unregisterAPNSPushTokenForCurrentUser(token);
        } else {
          await sendbirdInstance.unregisterFCMPushTokenForCurrentUser(token);
        }

        registeredPushTokensRef.current =
          registeredPushTokensRef.current.filter(
            (t) => !(t.token === token && t.os === os)
          );
      }
    } catch (error: any) {
      console.error("❌❌❌ [setPushNotification] FATAL ERROR", {
        error: error?.message || error,
        currentUserId: sendbirdInstance?.currentUser?.userId,
        enable,
        os
      });
    }
  };

  // =========== Event Handlers ===========
  const groupChannelHandler = new GroupChannelHandler({
    onMessageReceived: async (channel, message) => {
      // // ✅ ANDROID DEDUPLICATION: Check if this message was already processed
      // const eventKey = `messageReceived:${channel.url}:${message.messageId}`;
      // if (isEventProcessed(eventKey)) {
      //   logger.debug("🚫 [onMessageReceived] Skipping duplicate message", {
      //     channelUrl: channel.url,
      //     messageId: message.messageId
      //   });
      //   return;
      // }

      const msgStartTime = Date.now();

      if (Platform.OS === "ios") {
        console.log("[IOS_NOTIF_SOUND_TRACE] onMessageReceived", {
          messageId: message.messageId,
          channelUrl: channel.url
        });
      }

      logger.debug("📩 [onMessageReceived] Message arrived:", {
        messageId: message.messageId,
        parentMessageId: message.parentMessageId,
        channelUrl: channel.url,
        channelName: channel.name,
        currentChannelUrl: currentChannelRef.current?.url,
        currentChannelName: currentChannelRef.current?.name,
        hasCurrentChannelRef: !!currentChannelRef.current,
        isCurrentChannel: channel.url === currentChannelRef.current?.url,
        willMarkAsRead: channel.url === currentChannelRef.current?.url,
        willIncrementUnread:
          channel.url !== currentChannelRef.current?.url &&
          !message.parentMessageId,
        channelUnreadCount: (channel as GroupChannel).unreadMessageCount
      });

      // Check for profile updates from message sender.
      const sender = (message as any).sender;

      if (
        sender?.profileUrl &&
        sender?.userId &&
        user?.id &&
        parseInt(sender.userId) !== user.id
      ) {
        const state = store.getState();
        const currentDirectory = state.directoryReducer.directory || [];
        const directoryContact = currentDirectory.find(
          (contact: any) =>
            contact.userId?.toString() === sender.userId &&
            contact.type === "company"
        );

        if (
          directoryContact &&
          directoryContact.avatarPath !== sender.profileUrl
        ) {
          logger.debug(
            "🔄 [onMessageReceived] PROFILE UPDATE DETECTED FROM MESSAGE SENDER:",
            {
              userId: sender.userId,
              senderNickname: sender.nickname,
              oldAvatar: directoryContact.avatarPath || "null",
              newAvatar: sender.profileUrl,
              channelUrl: channel.url,
              messageId: message.messageId
            }
          );

          dispatch({
            type: directoryActions.UPDATE_COMPANY_CONTACT,
            payload: {
              userId: sender.userId,
              updates: {
                avatarPath: sender.profileUrl,
                avatarThumbnailPath: sender.profileUrl
              }
            }
          });

          logger.debug(
            "🔄 [onMessageReceived] Refreshing channel after profile update:",
            channel.url
          );
          try {
            const refreshedChannel =
              await sendbirdInstance.groupChannel.getChannel(channel.url);
            setChannels((prevChannels) => {
              const updatedChannels = prevChannels.filter(
                (chn) => chn.url !== refreshedChannel.url
              );
              return ensureUniqueChannels([
                refreshedChannel,
                ...updatedChannels
              ] as GroupChannel[]);
            });
            logger.debug(
              "✅ [onMessageReceived] Channel refreshed with updated sender profile"
            );
          } catch (error) {
            logger.error(
              "❌ [onMessageReceived] Error refreshing channel:",
              error
            );
          }
        }
      }

      const currentChannelFromRef = currentChannelRef.current;
      const currentActiveThreadId = activeThreadIdRef.current;

      if (message.parentMessageId) {
        logger.debug(
          "[Thread Message] Parent ID:",
          message.parentMessageId,
          "Active Thread ID:",
          currentActiveThreadId
        );

        // Always cache reply in ThreadCache (viewing or not)
        ThreadCache.addThreadMessage(
          channel.url,
          message.parentMessageId,
          message as ChatMessage
        );

        setReFetchThread((prev) => !prev);

        // Handle thread message for active thread
        if (
          currentActiveThreadId &&
          message.parentMessageId === currentActiveThreadId
        ) {
          logger.debug("[Thread Cache] Adding message to active thread cache");
          setThreadMessages((prev) => {
            const prevMessages = [message as ChatMessage, ...prev];
            return prevMessages.filter(
              (item, index, self) =>
                index ===
                self.findIndex((obj) => obj.messageId === item.messageId)
            );
          });
        } else {
          logger.debug(
            "[Thread Cache] Message not for active thread, skipping cache update"
          );
        }

        const isViewingChannel = channel.url === currentChannelFromRef?.url;

        if (isViewingChannel) {
          const isViewingThisThread =
            currentActiveThreadId === message.parentMessageId;
          const isOwnMessage =
            (message as any).sender?.userId === user?.id?.toString();

          // Refresh channel early so notifications use up-to-date push trigger state.
          let refreshedChannel =
            (await sendbirdInstance.groupChannel.getChannel(
              channel.url
            )) as GroupChannel;
          const channelGroupChannel = channel as GroupChannel;
          if (channelGroupChannel.lastMessage) {
            refreshedChannel.lastMessage = channelGroupChannel.lastMessage;
          }

          console.log(
            "🔍 [onMessageReceived] isViewingThisThread:",
            isViewingThisThread
          );
          console.log("🔍 [onMessageReceived] isOwnMessage:", isOwnMessage);

          if (!isViewingThisThread && !isOwnMessage) {
            await displaySendbirdNotification(refreshedChannel, message);
            // Increment custom unread count for thread notification
            dispatchSendbird(
              sendbirdActions.incrementChannelUnread(channel.url)
            );
            const currentCount = UnreadCountCache.getUnreadCount(channel.url);
            UnreadCountCache.setUnreadCount(channel.url, currentCount + 1);
            logger.debug(
              "📈 [onMessageReceived] Incremented custom unread count for thread",
              channel.url
            );
          } else if (isOwnMessage) {
            // logger.debug("⏭️ [onMessageReceived] Skipping notification for own thread message");
          } else {
            // Viewing the thread - mark as read and reset badge count
            await (channel as GroupChannel).markAsRead();
            dispatchSendbird(sendbirdActions.resetChannelUnread(channel.url));
            UnreadCountCache.setUnreadCount(channel.url, 0);
            refreshedChannel =
              (await sendbirdInstance.groupChannel.getChannel(
                channel.url
              )) as GroupChannel;
            if (channelGroupChannel.lastMessage) {
              refreshedChannel.lastMessage = channelGroupChannel.lastMessage;
            }
          }

          const parentMessage = await sendbirdInstance.message.getMessage({
            messageId: message.parentMessageId,
            channelUrl: channel.url,
            channelType: channel.channelType,
            includeThreadInfo: true,
            includeMetaArray: true,
            includeReactions: true
          });
          setMessages((prevMessages) => {
            const updated = prevMessages.map((msg) =>
              msg.messageId === message.parentMessageId ? parentMessage : msg
            ) as ChatMessage[];
            // Persist updated parent with reply count to MessageCache
            if (channel.url && updated.length > 0) {
              MessageCache.setCachedMessages(
                channel.url,
                onlyMainChannelMessages(updated)
              );
            }
            return updated;
          });

          // Update channels with refreshed channel
          setChannels((prevChannels) => {
            const channelIndex = prevChannels.findIndex(
              (chn) => chn.url === refreshedChannel.url
            );
            if (channelIndex === -1) {
              return [refreshedChannel, ...prevChannels];
            }
            // Only update if channel actually changed.
            const existingChannel = prevChannels[channelIndex];
            if (
              existingChannel.unreadMessageCount ===
                refreshedChannel.unreadMessageCount &&
              existingChannel.lastMessage?.createdAt ===
                refreshedChannel.lastMessage?.createdAt
            ) {
              return prevChannels;
            }
            const newChannels = [...prevChannels];
            newChannels[channelIndex] = refreshedChannel;
            return newChannels;
          });

          // ✅ FIX: Update Redux with the channel that has correct lastMessage.createdAt
          const serializedChannel = serializeChannel(refreshedChannel);
          if (serializedChannel) {
            dispatchSendbird(
              sendbirdActions.updateChannel(serializedChannel as any)
            );
            logger.debug(
              "✅ [onMessageReceived] Thread message - Channel updated in Redux with new lastMessage.createdAt:",
              {
                channelUrl: refreshedChannel.url,
                lastMessageCreatedAt: refreshedChannel.lastMessage?.createdAt
              }
            );
          }
        } else {
          // User is NOT viewing this channel, refresh to get updated unread count
          const refreshedChannel =
            (await sendbirdInstance.groupChannel.getChannel(
              channel.url
            )) as GroupChannel;

          // ✅ FIX: Preserve the updated lastMessage from the event parameter
          // The channel parameter already has the correct lastMessage.createdAt
          const channelGroupChannel = channel as GroupChannel;
          if (channelGroupChannel.lastMessage) {
            refreshedChannel.lastMessage = channelGroupChannel.lastMessage;
          }

          const isOwnMessage =
            (message as any).sender?.userId === user?.id?.toString();
          const isViewingThisThread =
            activeThreadIdRef.current === message.parentMessageId;

          // If user is on Thread screen viewing this thread, mark as read and skip notification
          if (isViewingThisThread && !isOwnMessage) {
            await (channel as GroupChannel).markAsRead();
            dispatchSendbird(sendbirdActions.resetChannelUnread(channel.url));
            UnreadCountCache.setUnreadCount(channel.url, 0);
            // Refetch channel after markAsRead so refreshedChannel has unreadMessageCount 0 for setChannels
            const refetched = (await sendbirdInstance.groupChannel.getChannel(
              channel.url
            )) as GroupChannel;
            if (channelGroupChannel.lastMessage) {
              refetched.lastMessage = channelGroupChannel.lastMessage;
            }
            Object.assign(refreshedChannel, {
              unreadMessageCount: refetched.unreadMessageCount
            });
          } else if (!isOwnMessage) {
            // Display notification - user not viewing this channel (skip own messages)
            await displaySendbirdNotification(refreshedChannel, message);
            // Increment custom unread count for thread in non-viewed channel
            dispatchSendbird(
              sendbirdActions.incrementChannelUnread(channel.url)
            );
            const currentCount = UnreadCountCache.getUnreadCount(channel.url);
            UnreadCountCache.setUnreadCount(channel.url, currentCount + 1);
            logger.debug(
              "📈 [onMessageReceived] Incremented custom unread count for thread in non-viewed channel",
              channel.url
            );
          }

          // Update parent message reply count in cache so reply count shows when user opens channel
          try {
            const parentMessage = await sendbirdInstance.message.getMessage({
              messageId: message.parentMessageId,
              channelUrl: channel.url,
              channelType: channel.channelType,
              includeThreadInfo: true,
              includeMetaArray: true,
              includeReactions: true
            });
            const existingCachedMessages =
              MessageCache.getCachedMessages(channel.url) || [];
            const mainOnly = onlyMainChannelMessages(existingCachedMessages);
            const parentIndex = mainOnly.findIndex(
              (msg) => msg.messageId === message.parentMessageId
            );
            if (parentIndex >= 0) {
              const updated = [...mainOnly];
              updated[parentIndex] = parentMessage as ChatMessage;
              MessageCache.setCachedMessages(channel.url, updated);
            } else if (mainOnly.length > 0) {
              // Parent not in cache; merge parent into cache (e.g. from notification)
              const merged = [parentMessage as ChatMessage, ...mainOnly].filter(
                (item, index, self) =>
                  index ===
                  self.findIndex((obj) => obj.messageId === item.messageId)
              );
              MessageCache.setCachedMessages(
                channel.url,
                onlyMainChannelMessages(merged)
              );
            }
          } catch (err) {
            logger.debug(
              "[onMessageReceived] Could not update parent in cache (not viewing):",
              err
            );
          }

          // Update channels with refreshed channel
          setChannels((prevChannels) => {
            const channelIndex = prevChannels.findIndex(
              (chn) => chn.url === refreshedChannel.url
            );
            if (channelIndex === -1) {
              return [refreshedChannel, ...prevChannels];
            }
            // Only update if channel actually changed.
            const existingChannel = prevChannels[channelIndex];
            if (
              existingChannel.unreadMessageCount ===
                refreshedChannel.unreadMessageCount &&
              existingChannel.lastMessage?.createdAt ===
                refreshedChannel.lastMessage?.createdAt
            ) {
              return prevChannels;
            }
            const newChannels = [...prevChannels];
            newChannels[channelIndex] = refreshedChannel;
            return newChannels;
          });

          // ✅ FIX: Update Redux with the channel that has correct lastMessage.createdAt
          const serializedChannel = serializeChannel(refreshedChannel);
          if (serializedChannel) {
            dispatchSendbird(
              sendbirdActions.updateChannel(serializedChannel as any)
            );
            logger.debug(
              "✅ [onMessageReceived] Thread message (not viewing) - Channel updated in Redux with new lastMessage.createdAt:",
              {
                channelUrl: refreshedChannel.url,
                lastMessageCreatedAt: refreshedChannel.lastMessage?.createdAt
              }
            );
          }
        }
        return;
      }

      const isViewingChannel = channel.url === currentChannelFromRef?.url;

      if (isViewingChannel) {
        logger.debug(
          "👀 [onMessageReceived] Message for CURRENTLY VIEWED channel, marking as read",
          {
            currentChannelRef: currentChannelFromRef?.url,
            channelUrl: channel.url
          }
        );
        // User is viewing this channel and chat screen focused, mark as read
        console.warn(
          "⏱️ [onMessageReceived] Before setMessages:",
          Date.now() - msgStartTime,
          "ms"
        );
        setMessages((prev) => {
          const prevMessages = [message, ...prev];
          const deduped = prevMessages.filter(
            (item, index, self) =>
              index ===
              self.findIndex((obj) => obj.messageId === item.messageId)
          ) as ChatMessage[];
          const updatedMessages = onlyMainChannelMessages(deduped);
          const replyCount = deduped.length - updatedMessages.length;
          if (replyCount > 0 || isThreadReply(message as ChatMessage)) {
            console.warn("[ReplyFilter] onMessageReceived (viewing channel):", {
              incomingMessageId: message.messageId,
              incomingIsReply: isThreadReply(message as ChatMessage),
              dedupedCount: deduped.length,
              afterFilter: updatedMessages.length,
              replyCount
            });
          }

          if (channel.url && updatedMessages.length > 0) {
            MessageCache.setCachedMessages(channel.url, updatedMessages);
          }

          return updatedMessages;
        });
        console.warn(
          "⏱️ [onMessageReceived] After setMessages:",
          Date.now() - msgStartTime,
          "ms"
        );

        currentChannelFromRef
          ?.markAsRead()
          .catch((err) =>
            logger.error("❌ [onMessageReceived] markAsRead error:", err)
          );
        console.warn(
          "⏱️ [onMessageReceived] markAsRead fired (non-blocking):",
          Date.now() - msgStartTime,
          "ms"
        );

        // Refresh channel to get updated unread count (should be 0)
        console.warn(
          "⏱️ [onMessageReceived] Before getChannel:",
          Date.now() - msgStartTime,
          "ms"
        );
        const refreshedChannel =
          (await sendbirdInstance.groupChannel.getChannel(
            channel.url
          )) as GroupChannel;
        console.warn(
          "⏱️ [onMessageReceived] After getChannel:",
          Date.now() - msgStartTime,
          "ms"
        );

        // ✅ FIX: Preserve the updated lastMessage from the event parameter
        // The channel parameter already has the correct lastMessage.createdAt
        const channelGroupChannel = channel as GroupChannel;
        if (channelGroupChannel.lastMessage) {
          refreshedChannel.lastMessage = channelGroupChannel.lastMessage;
        }

        // Update channels with refreshed channel (unread count = 0)
        setChannels((prevChannels) => {
          const updatedChannels = prevChannels.filter(
            (chn) => chn.url !== refreshedChannel.url
          );
          return ensureUniqueChannels([
            refreshedChannel,
            ...updatedChannels
          ] as GroupChannel[]);
        });

        // ✅ FIX: Update Redux with the channel that has correct lastMessage.createdAt
        const serializedChannel = serializeChannel(refreshedChannel);
        if (serializedChannel) {
          dispatchSendbird(
            sendbirdActions.updateChannel(serializedChannel as any)
          );
          logger.debug(
            "✅ [onMessageReceived] Regular message (viewing) - Channel updated in Redux with new lastMessage.createdAt:",
            {
              channelUrl: refreshedChannel.url,
              lastMessageCreatedAt: refreshedChannel.lastMessage?.createdAt
            }
          );
        }
      } else {
        // User is NOT viewing this channel, so unread count should increment
        // Refresh channel to get the latest unread count from Sendbird
        const refreshedChannel =
          (await sendbirdInstance.groupChannel.getChannel(
            channel.url
          )) as GroupChannel;

        // ✅ FIX: Preserve the updated lastMessage from the event parameter
        // The channel parameter already has the correct lastMessage.createdAt
        const channelGroupChannel = channel as GroupChannel;
        if (channelGroupChannel.lastMessage) {
          refreshedChannel.lastMessage = channelGroupChannel.lastMessage;
        }

        const isOwnMessage =
          (message as any).sender?.userId === user?.id?.toString();

        if (!isOwnMessage) {
          await displaySendbirdNotification(refreshedChannel, message);

          dispatchSendbird(sendbirdActions.incrementChannelUnread(channel.url));
          const currentCount = UnreadCountCache.getUnreadCount(channel.url);
          UnreadCountCache.setUnreadCount(channel.url, currentCount + 1);
          logger.debug(
            "📈 [onMessageReceived] Incremented custom unread count for channel",
            channel.url
          );
        }

        // ✅ FIX: Update message cache with new message even when not viewing channel
        // This ensures the message is available when user opens the chat
        const existingCachedMessages =
          MessageCache.getCachedMessages(channel.url) || [];
        const messageExists = existingCachedMessages.some(
          (msg) => msg.messageId === message.messageId
        );
        if (!messageExists) {
          const updatedCachedMessages = [
            message as ChatMessage,
            ...existingCachedMessages
          ].filter(
            (item, index, self) =>
              index ===
              self.findIndex((obj) => obj.messageId === item.messageId)
          );
          MessageCache.setCachedMessages(channel.url, updatedCachedMessages);
          logger.debug(
            "💾 [onMessageReceived] Updated message cache for non-viewed channel:",
            {
              channelUrl: channel.url,
              messageId: message.messageId,
              cachedCount: updatedCachedMessages.length
            }
          );
        }

        setChannels((prevChannels) => {
          const updatedChannels = prevChannels.filter(
            (chn) => chn.url !== refreshedChannel.url
          );
          const newChannels = ensureUniqueChannels([
            refreshedChannel,
            ...updatedChannels
          ] as GroupChannel[]);

          // logger.debug("✅ [onMessageReceived] Channels state updated:", {
          //   totalChannels: newChannels.length,
          //   channelsWithUnread: newChannels.filter(c => c.unreadMessageCount > 0).length,
          //   updatedChannelUnread: refreshedChannel.unreadMessageCount
          // });

          return newChannels;
        });

        // ✅ FIX: Update Redux with the channel that has correct lastMessage.createdAt
        const serializedChannel = serializeChannel(refreshedChannel);
        if (serializedChannel) {
          dispatchSendbird(
            sendbirdActions.updateChannel(serializedChannel as any)
          );
          logger.debug(
            "✅ [onMessageReceived] Regular message (not viewing) - Channel updated in Redux with new lastMessage.createdAt:",
            {
              channelUrl: refreshedChannel.url,
              lastMessageCreatedAt: refreshedChannel.lastMessage?.createdAt
            }
          );
        }
      }
    },
    onMessageUpdated: (channel, message) => {
      logger.debug(
        "[Message Updated] Message ID:",
        message.messageId,
        "Parent ID:",
        message.parentMessageId,
        "Current Active Thread ID:",
        activeThreadIdRef.current
      );
      const currentChannelFromRef = currentChannelRef.current;
      const currentActiveThreadId = activeThreadIdRef.current;

      // Handle thread reply update for active thread
      if (
        currentActiveThreadId &&
        message.parentMessageId === currentActiveThreadId
      ) {
        logger.debug(
          "[Thread Cache] Updating thread reply in active thread cache"
        );
        setThreadMessages((prevMessages) =>
          prevMessages.map((msg) =>
            msg.messageId === message.messageId ? (message as ChatMessage) : msg
          )
        );
      }

      // Handle parent message update when thread is open
      logger.debug("[Parent Message Check]", {
        hasActiveThread: !!currentActiveThreadId,
        messageHasNoParent: !message.parentMessageId,
        messageIdMatchesThread: message.messageId === currentActiveThreadId,
        messageId: message.messageId,
        activeThreadId: currentActiveThreadId
      });

      if (
        currentActiveThreadId &&
        !message.parentMessageId &&
        message.messageId === currentActiveThreadId
      ) {
        logger.debug(
          "✅ [Thread Cache] UPDATING parent message in active thread cache",
          {
            messageId: message.messageId,
            messageContent: (message as any).message
          }
        );
        setActiveParentMessage(message);
      } else {
        logger.debug(
          "❌ [Thread Cache] NOT updating parent message - conditions not met"
        );
      }

      if (channel.url === currentChannelFromRef?.url) {
        setMessages((prevMessages) => {
          const updated = prevMessages.map((msg) =>
            msg.messageId === message.messageId ? message : msg
          ) as ChatMessage[];
          return onlyMainChannelMessages(updated);
        });
      }
    },
    onMessageDeleted: (channel, messageId) => {
      logger.debug("[Message Deleted] Message ID:", messageId);
      MessageCache.removeMessageFromChannelCache(channel.url, messageId);
      ThreadCache.removeMessageFromThreadCachesForChannel(
        channel.url,
        messageId
      );
      const currentChannelFromRef = currentChannelRef.current;
      const currentActiveThreadId = activeThreadIdRef.current;

      // Handle thread message deletion for active thread
      if (currentActiveThreadId) {
        logger.debug(
          "[Thread Cache] Removing message from active thread cache if present"
        );
        setThreadMessages((prevMessages) =>
          prevMessages.filter((msg) => msg.messageId !== messageId)
        );
      }

      if (channel.url === currentChannelFromRef?.url) {
        setMessages((prevMessages) =>
          prevMessages.filter((msg) => msg.messageId !== messageId)
        );
      }
    },
    onReactionUpdated: async (channel, reactionEvent) => {
      logger.debug("Reaction Updated", {
        channelUrl: channel.url,
        messageId: reactionEvent.messageId,
        userId: reactionEvent.userId,
        key: reactionEvent.key,
        operation: reactionEvent.operation
      });

      const currentChannelFromRef = currentChannelRef.current;
      const isViewingChannel = channel.url === currentChannelFromRef?.url;
      const isOwnReaction = reactionEvent.userId === user?.id?.toString();

      // Show notification if NOT viewing this channel and NOT own reaction
      // Only show for ADD operations (operation is null or not delete)
      const isAddOperation =
        !reactionEvent.operation || reactionEvent.operation !== "delete";
      // Check user notification preferences before displaying reaction notification.
      const state = store.getState() as State;
      const currentUser = state.userReducer?.user;
      const chatNotificationsEnabled =
        currentUser?.enableChatNotifications === 1;

      if (
        !isViewingChannel &&
        !isOwnReaction &&
        isAddOperation &&
        chatNotificationsEnabled
      ) {
        try {
          // Get reactor's name
          const reactor = (channel as GroupChannel).members.find(
            (m) => m.userId === reactionEvent.userId
          );
          const reactorName = reactor?.nickname || "Someone";

          // Fetch message to check if it is thread message.
          let parentMessageId: string | undefined;
          try {
            const reactedMessage = await sendbirdInstance.message.getMessage({
              messageId: reactionEvent.messageId,
              channelUrl: channel.url,
              channelType: channel.channelType
            });
            // Check if this message is thread reply (has parentMessageId).
            if (reactedMessage && (reactedMessage as any).parentMessageId) {
              parentMessageId = String((reactedMessage as any).parentMessageId);
              logger.debug(
                "📍 [onReactionUpdated] Reaction is on a thread message, parentMessageId:",
                parentMessageId
              );
            }
          } catch (fetchError) {
            logger.debug(
              "⚠️ [onReactionUpdated] Could not fetch message for thread check:",
              fetchError
            );
          }

          const channelId = await notifee.createChannel({
            id: "voxo-notifications",
            name: getAppNotificationsChannelName(),
            importance: AndroidImportance.HIGH
          });

          const notificationData: Record<string, string> = {
            channelUrl: channel.url,
            messageId: String(reactionEvent.messageId),
            click_action: "SENDBIRD-RECEIVED"
          };

          if (parentMessageId) {
            notificationData.parentMessageId = parentMessageId;
          }

          await notifee.displayNotification({
            title: channel.name || "Reaction",
            body: `${reactorName} reacted ${reactionEvent.key} to a message`,
            android: {
              channelId,
              importance: AndroidImportance.HIGH,
              pressAction: { id: "default" },
              smallIcon: "ic_launcher"
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
            data: notificationData
          });

          logger.debug(
            "✅ [onReactionUpdated] Reaction notification displayed",
            { parentMessageId: parentMessageId || "none" }
          );
        } catch (error) {
          logger.error(
            "❌ [onReactionUpdated] Error displaying notification:",
            error
          );
        }
      } else if (!chatNotificationsEnabled) {
        logger.debug(
          "🚫 [onReactionUpdated] Reaction notification BLOCKED - Chat Messages is disabled"
        );
      }

      // Only update UI if viewing this channel
      if (!isViewingChannel) return;

      const { messageId } = reactionEvent;

      try {
        // Fetch the updated message with reactions from Sendbird
        const fetchedMessage = await sendbirdInstance.message.getMessage({
          messageId: messageId,
          channelUrl: channel.url,
          channelType: channel.channelType,
          includeReactions: true,
          includeMetaArray: true,
          includeThreadInfo: true
        });

        // Handle reactions for active thread
        const currentActiveThreadId = activeThreadIdRef.current;

        // FIRST: Handle parent message reaction in thread view
        if (
          currentActiveThreadId &&
          fetchedMessage &&
          "messageId" in fetchedMessage &&
          fetchedMessage.messageId === currentActiveThreadId
        ) {
          logger.debug(
            "[Thread Cache] Updating reactions for parent message in thread"
          );
          setActiveParentMessage(fetchedMessage as BaseMessage);
        }

        // SECOND: Handle thread reply message reactions
        if (
          currentActiveThreadId &&
          fetchedMessage &&
          "parentMessageId" in fetchedMessage &&
          fetchedMessage.parentMessageId === currentActiveThreadId
        ) {
          logger.debug(
            "[Thread Cache] Updating reactions for reply message in active thread"
          );
          setThreadMessages((prevMessages) =>
            prevMessages.map((message) =>
              message.messageId === messageId
                ? (fetchedMessage as ChatMessage)
                : message
            )
          );
        }

        setMessages((prevMessages) =>
          onlyMainChannelMessages(
            prevMessages.map((message) =>
              message.messageId === messageId
                ? (fetchedMessage as ChatMessage)
                : message
            )
          )
        );
      } catch (error) {
        logger.error("Error fetching updated message with reactions:", error);
      }
    },
    onTypingStatusUpdated: (channel) => {
      try {
        const currentTypingUsers = channel.getTypingUsers();

        setTypingUsers((prevTypingUsers) => {
          const updatedTypingUsers = { ...prevTypingUsers };

          if (currentTypingUsers.length > 0) {
            updatedTypingUsers[channel.url] = currentTypingUsers;
          } else {
            delete updatedTypingUsers[channel.url];
          }

          return updatedTypingUsers;
        });
      } catch (error) {
        logger.error("Error updating typing status:", error);
      }
    },
    onUserJoined: async (channel, joinedUser) => {
      // ✅ ANDROID DEDUPLICATION: Check if this event was already processed
      // Use channel + user only (no timestamp) to catch rapid fire duplicates
      // const eventKey = `userJoined:${channel.url}:${joinedUser.userId}`;
      // if (isEventProcessed(eventKey)) {
      //   logger.debug("🚫 [onUserJoined] Skipping duplicate event", {
      //     channelUrl: channel.url,
      //     userId: joinedUser.userId
      //   });
      //   return;
      // }

      const groupChannel = channel as GroupChannel;
      const serializedChannel = serializeChannel(groupChannel);

      // Check if current user is the one who joined (was added to channel)
      const isCurrentUser =
        joinedUser?.userId &&
        user?.id &&
        parseInt(joinedUser.userId) === user.id;

      if (!isCurrentUser) {
        toast.success(`${joinedUser.nickname} joined the channel`);
      }

      if (isCurrentUser) {
        logger.debug("🆕 [onUserJoined] Current user was added to channel:", {
          channelUrl: channel.url,
          channelName: channel.name
        });

        // Add channel to channels list if not already present
        setChannels((prevChannels) => {
          const channelExists = prevChannels.some(
            (ch) => ch.url === channel.url
          );
          if (channelExists) {
            // Update existing channel
            return prevChannels.map((ch) =>
              ch.url === channel.url ? groupChannel : ch
            );
          } else {
            // Add new channel to the beginning of the list
            logger.debug(
              "✅ [onUserJoined] Adding new channel to channels list"
            );
            return ensureUniqueChannels([groupChannel, ...prevChannels]);
          }
        });

        // Display notification when user is added to a channel (even in background)
        try {
          const state = store.getState() as State;
          const currentUser = state.userReducer?.user;
          const chatNotificationsEnabled =
            currentUser?.enableChatNotifications === 1;

          if (chatNotificationsEnabled) {
            let channelName = channel.name;
            let creatorUserId = groupChannel.creator?.userId;

            if (
              sendbirdInstance &&
              (!channelName ||
                creatorUserId == null ||
                creatorUserId === "")
            ) {
              try {
                const refreshedChannel =
                  await sendbirdInstance.groupChannel.getChannel(channel.url);
                if (!channelName) {
                  channelName = refreshedChannel.name;
                }
                if (creatorUserId == null || creatorUserId === "") {
                  creatorUserId = refreshedChannel.creator?.userId;
                }
                logger.debug(
                  "🔄 [onUserJoined] Refreshed channel for name/creator:",
                  channelName
                );
              } catch (_error) {
                logger.warn(
                  "⚠️ [onUserJoined] Could not refresh channel, using fallback name"
                );
              }
            }

            const channelNameMissing = !channelName;
            channelName = channelName || "a channel";

            const creatorIdNum =
              creatorUserId != null && creatorUserId !== ""
                ? parseInt(String(creatorUserId), 10)
                : NaN;
            const isChannelCreator =
              user?.id != null &&
              !Number.isNaN(creatorIdNum) &&
              creatorIdNum === user.id;

            const notificationBody = isChannelCreator
              ? channelNameMissing
                ? "You created this channel."
                : `You created ${channelName} channel`
              : `You were added in ${channelName}`;

            const currentAppState = AppState.currentState;
            const isBackgroundOrInactive =
              currentAppState === "background" ||
              currentAppState === "inactive";

            logger.debug(
              "🔔 [onUserJoined] Displaying notification for channel addition",
              {
                channelUrl: channel.url,
                channelName: channelName,
                originalChannelName: channel.name,
                appState: currentAppState,
                isBackground: isBackgroundOrInactive,
                isChannelCreator
              }
            );

            // Display notification using Notifee (works in both foreground and background)
            await notifee.displayNotification({
              title: channelName,
              body: notificationBody,
              data: {
                channelUrl: channel.url,
                click_action: "SENDBIRD-RECEIVED",
                type: "channel_added"
              },
              android: {
                channelId: "voxo-notifications",
                importance: AndroidImportance.HIGH,
                pressAction: { id: "default" },
                smallIcon: "ic_launcher"
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
              }
            });

            logger.debug(
              "✅ [onUserJoined] Notification displayed for channel addition"
            );
          } else {
            logger.debug(
              "🚫 [onUserJoined] Notification skipped - Chat Messages disabled"
            );
          }
        } catch (error) {
          logger.error(
            "❌ [onUserJoined] Error displaying notification:",
            error
          );
        }
      }

      if (serializedChannel && serializedChannel.url) {
        // Check if channel already exists in Redux before updating
        const state = store.getState() as State;
        const existingChannel = state.sendbirdReducer?.channels?.find(
          (ch: any) => ch.url === channel.url
        );
        const channelExistedBefore = !!existingChannel;
        const existingUnreadCount = existingChannel?.customUnreadCount || 0;

        dispatchSendbird(
          sendbirdActions.updateChannel(serializedChannel as any)
        );
        logger.debug("✅ [onUserJoined] Channel updated in Redux with name:", {
          channelUrl: channel.url,
          channelName: serializedChannel.name,
          sendbirdName: channel.name,
          isCurrentUser,
          channelExistedBefore,
          existingUnreadCount
        });
        if (isCurrentUser) {
          dispatchSendbird(sendbirdActions.resetChannelUnread(channel.url));
          dispatchSendbird(sendbirdActions.incrementChannelUnread(channel.url));
          UnreadCountCache.setUnreadCount(channel.url, 1);
          logger.debug(
            "📈 [onUserJoined] Set initial unread count to 1 for newly added channel",
            {
              channelUrl: channel.url,
              wasNewChannel: !channelExistedBefore,
              previousUnreadCount: existingUnreadCount
            }
          );
        }
      }
    },
    onUserLeft: async (channel: GroupChannel, leftUser: any) => {
      const isCurrentUser =
        leftUser?.userId && user?.id && parseInt(leftUser.userId) === user.id;

      if (isCurrentUser) {
        logger.debug("🚪 [onUserLeft] Current user was removed from channel:", {
          channelUrl: channel.url,
          channelName: channel.name
        });

        // Remove channel from local state
        setChannels((prevChannels) =>
          prevChannels.filter((c) => c.url !== channel.url)
        );

        // Remove from Redux
        dispatchSendbird(sendbirdActions.removeChannel(channel.url));

        // Clear unread count cache
        UnreadCountCache.clearUnreadCount(channel.url);

        // If viewing this channel, navigate away
        if (currentChannelRef.current?.url === channel.url) {
          leaveChannel();
        }

        logger.debug("✅ [onUserLeft] Channel removed from state and Redux");
      } else {
        // Another user left - just update the channel
        const serializedChannel = serializeChannel(channel as GroupChannel);
        if (serializedChannel && serializedChannel.url) {
          dispatchSendbird(
            sendbirdActions.updateChannel(serializedChannel as any)
          );
          logger.debug("🔄 [onUserLeft] Updated channel after user left:", {
            channelUrl: channel.url,
            leftUserId: leftUser?.userId
          });
        }
      }
    },
    onChannelDeleted: (channelUrl) => {
      logger.debug("🗑️ [onChannelDeleted] Channel deleted:", channelUrl);
      setChannels((prevChannels) =>
        prevChannels.filter((c) => c.url !== channelUrl)
      );
      dispatchSendbird(sendbirdActions.removeChannel(channelUrl));
      logger.debug(
        "✅ [onChannelDeleted] Channel removed from state and Redux immediately"
      );
    },
    onChannelHidden: (channel) => {
      const channelUrl = channel.url;
      logger.debug("👁️ [onChannelHidden] Channel hidden (SDK):", channelUrl);
      setChannels((prevChannels) =>
        prevChannels.filter((c) => c.url !== channelUrl)
      );
      dispatchSendbird(sendbirdActions.removeChannel(channelUrl));
    },
    onChannelChanged: (channel) => {
      if (isApplyingNotificationPrefsRef.current) {
        return;
      }

      const isViewingThisChannel =
        currentChannelRef.current?.url === channel.url;
      const sendbirdUnreadCount =
        (channel as GroupChannel).unreadMessageCount || 0;

      logger.debug("🔄 [onChannelChanged] Channel updated:", {
        channelUrl: channel.url,
        channelName: channel.name,
        sendbirdUnreadCount,
        isViewingThisChannel,
        hasName: channel.name !== null && channel.name !== undefined
      });

      // Check for profile updates in channel members and update directory
      const groupChannel = channel as GroupChannel;
      const hasProfileUpdates = checkAndUpdateMemberProfiles(
        groupChannel,
        "onChannelChanged"
      );

      if (hasProfileUpdates) {
        logger.debug(
          "🔄 [onChannelChanged] Profile updates detected, refreshing channel:",
          channel.url
        );
        // Refresh the channel to ensure we have the latest member data
        sendbirdInstance.groupChannel
          .getChannel(channel.url)
          .then((refreshedChannel) => {
            setChannels((prevChannels) => {
              const updatedChannels = prevChannels.filter(
                (chn) => chn.url !== refreshedChannel.url
              );
              return ensureUniqueChannels([
                refreshedChannel,
                ...updatedChannels
              ] as GroupChannel[]);
            });
            logger.debug(
              "✅ [onChannelChanged] Channel refreshed with updated profiles"
            );
          })
          .catch((_error) => {
            logger.error(
              "❌ [onChannelChanged] Error refreshing channel:",
              _error
            );
          });
      }

      const serializedChannel = serializeChannel(channel as GroupChannel);
      if (serializedChannel && serializedChannel.url) {
        dispatchSendbird(
          sendbirdActions.updateChannel(serializedChannel as any)
        );
        // logger.debug("✅ [onChannelChanged] Channel updated in Redux with name:", { channelUrl: channel.url, channelName: serializedChannel.name, sendbirdName: channel.name, wasCached: !!cachedChannels.find((ch: any) => ch.url === channel.url)});
      }

      if (!isViewingThisChannel && sendbirdUnreadCount === 0) {
        logger.debug(
          "⚠️ [onChannelChanged] User not viewing channel and Sendbird unread is 0, preserving custom unread count"
        );
        setChannels((prevChannels) => {
          const channelIndex = prevChannels.findIndex(
            (c) => c.url === channel.url
          );
          if (channelIndex === -1) {
            return [channel as GroupChannel, ...prevChannels];
          }
          const updatedChannels = [...prevChannels];
          const existingChannel = updatedChannels[channelIndex];
          const updatedChannel = channel as GroupChannel;
          (updatedChannel as any).unreadMessageCount =
            existingChannel.unreadMessageCount || 0;
          updatedChannels[channelIndex] = updatedChannel;
          return updatedChannels;
        });
        return;
      }

      setChannels((prevChannels) => {
        const channelIndex = prevChannels.findIndex(
          (c) => c.url === channel.url
        );
        if (channelIndex === -1) {
          return [channel as GroupChannel, ...prevChannels];
        }
        const updatedChannels = [...prevChannels];
        updatedChannels[channelIndex] = channel as GroupChannel;
        return updatedChannels;
      });
    }
  });

  // =========== Effects ===========
  // Load cached channels IMMEDIATELY on mount (before Sendbird connects)
  useEffect(() => {
    if (cachedChannels.length > 0 && channels.length === 0) {
      logger.debug(
        "Loading",
        cachedChannels.length,
        "cached channels from Redux"
      );

      // INSTANT: Show cached data immediately (no skeleton, no waiting for connection!)
      const mockChannels = cachedChannels.map(createMockChannelFromCache);
      setChannels(mockChannels as any);
      logger.debug(
        "Displayed",
        mockChannels.length,
        "cached channels instantly (pre-connection)"
      );
    }
  }, [cachedChannels, channels.length]);

  // Update cached channels with real Sendbird objects after connection
  useEffect(() => {
    const updateWithRealChannels = async () => {
      // OPTIMIZE: Skip on first launch - fetchChannels will provide fresh data immediately
      // This saves 1-2 seconds by avoiding 66 redundant API calls
      if (!hasFetchedOnFirstLaunchRef.current) {
        logger.debug(
          "⏭️ [updateWithRealChannels] Skipping on first launch - fetchChannels will provide fresh data"
        );
        return;
      }

      if (cachedChannels.length > 0 && isConnected && channels.length > 0) {
        // Only update if we're showing cached mock data
        const hasMockData = channels.some((ch: any) => ch._isCached);
        if (!hasMockData) return;

        logger.debug("Updating cached channels with real Sendbird objects");

        try {
          const channelPromises = cachedChannels.map(async (cached: any) => {
            try {
              return await sendbirdInstance.groupChannel.getChannel(cached.url);
            } catch (_error) {
              // logger.warn("Failed to load cached channel:", cached.url);
              // return null;
            }
          });

          const loadedChannels = (await Promise.all(channelPromises)).filter(
            Boolean
          ) as GroupChannel[];

          if (loadedChannels.length > 0) {
            setChannels(loadedChannels);
            logger.debug(
              "Updated with",
              loadedChannels.length,
              "real Sendbird channels"
            );
          }
        } catch (error) {
          logger.error("Error loading cached channels:", error);
        }
      }
    };

    updateWithRealChannels();
  }, [cachedChannels, isConnected, channels.length]);

  // Connection Effect
  useEffect(() => {
    if (connecting || !isLoggedIn || !user?.id) return;

    const initializeConnection = async () => {
      try {
        setConnecting(true);
        if (user?.id) {
          await retryConnect(user?.id);
        }
      } catch (error) {
        logger.error("Failed to initialize connection:", error);
        setIsConnected(false);
      } finally {
        setConnecting(false);
      }
    };

    const connectionHandler = new ConnectionHandler({
      onConnected: (userId: string) => {
        logger.debug("User connected:", userId);
        setIsConnected(true);
        setConnecting(false);

        // Sync current user avatar from Sendbird (cross-device: e.g. updated on iOS, open Android)
        try {
          const profileUrl = sendbirdInstance?.currentUser?.profileUrl;
          const u = store.getState()?.userReducer?.user;
          if (
            profileUrl &&
            typeof profileUrl === "string" &&
            profileUrl !== u?.avatarPath
          ) {
            dispatch({
              type: userActions.UPDATE_USER,
              payload: {
                avatarPath: profileUrl,
                avatarMediaVersion: Date.now()
              }
            });
            logger.debug(
              "Synced current user avatar from Sendbird to Redux (cross-device)"
            );
          }
        } catch (e) {
          logger.debug("Sync avatar from Sendbird failed:", e);
        }

        // OPTIMIZE: Prioritize preloading first 20 channels for faster initial display
        // Lazy load remaining channels after initial load completes
        if (cachedChannels.length > 0) {
          const priorityChannels = cachedChannels.slice(0, 20);
          void preloadAllChannelMessages(priorityChannels as GroupChannel[]);

          // Lazy load remaining channels after 3 seconds
          if (cachedChannels.length > 20) {
            setTimeout(() => {
              const remainingChannels = cachedChannels.slice(20);
              logger.debug(
                `🔄 [Lazy Load] Preloading remaining ${remainingChannels.length} channels`
              );
              void preloadAllChannelMessages(
                remainingChannels as GroupChannel[]
              );
            }, 3000);
          }
        }

        // OPTIMIZE: Only fetch on first launch (not every connection)
        if (!hasFetchedOnFirstLaunchRef.current) {
          logger.debug("🔄 [onConnected] First launch - fetching channels");
          hasFetchedOnFirstLaunchRef.current = true;
          lastChannelFetchTimeRef.current = Date.now();
          void fetchChannels();
        } else {
          logger.debug(
            "⏭️ [onConnected] Skipping fetch - already fetched on first launch"
          );
        }
      },
      onDisconnected: (userId: string) => {
        logger.debug("User disconnected:", userId);
        setIsConnected(false);
        setConnecting(false);
      },
      onReconnectStarted: () => {
        logger.debug("Reconnection started");
        setIsConnected(false);
        setConnecting(false);
      },
      onReconnectSucceeded: () => {
        logger.debug("Reconnection succeeded");
        setIsConnected(true);
        setConnecting(false);

        // Sync current user avatar from Sendbird (cross-device).
        try {
          const profileUrl = sendbirdInstance?.currentUser?.profileUrl;
          const u = store.getState()?.userReducer?.user;
          if (
            profileUrl &&
            typeof profileUrl === "string" &&
            profileUrl !== u?.avatarPath
          ) {
            dispatch({
              type: userActions.UPDATE_USER,
              payload: {
                avatarPath: profileUrl,
                avatarMediaVersion: Date.now()
              }
            });
            logger.debug(
              "Synced current user avatar from Sendbird to Redux (reconnect)"
            );
          }
        } catch (e) {
          logger.debug("Sync avatar from Sendbird failed:", e);
        }

        // OPTIMIZE: Only fetch if app is in foreground
        const currentAppState = AppState.currentState;
        if (currentAppState === "active") {
          const timeSinceLastFetch =
            Date.now() - lastChannelFetchTimeRef.current;
          if (timeSinceLastFetch > 5000) {
            logger.debug(
              "🔄 [onReconnectSucceeded] App in foreground - fetching channels after reconnect"
            );
            lastChannelFetchTimeRef.current = Date.now();
            void fetchChannels();
          } else {
            logger.debug(
              "⏭️ [onReconnectSucceeded] Skipping fetch - recent fetch within 5s"
            );
          }
        } else {
          logger.debug(
            "⏭️ [onReconnectSucceeded] Skipping fetch - app not in foreground"
          );
        }
      },
      onReconnectFailed: async () => {
        // Guard: Only retry if user is still logged in.
        const state = store.getState();
        const currentUser = state?.userReducer?.user;
        const currentIsLoggedIn = state?.authReducer?.isLoggedIn;

        if (!currentIsLoggedIn || !currentUser?.id) {
          logger.debug("Skipping reconnect retry - user logged out");
          setIsConnected(false);
          return;
        }

        try {
          await retryConnect(currentUser.id, 5);
        } catch (error: any) {
          // Silently ignore access token errors - don't show to user
          const errorMessage = error?.message || String(error || "");
          if (
            !errorMessage.includes("access token") &&
            !errorMessage.includes("Invalid") &&
            !errorMessage.includes("unauthorized")
          ) {
            logger.debug("Reconnect retry failed:", error);
          }
        }
        setIsConnected(false);
      }
    });

    // ✅ FIX (Android): Remove any existing handlers BEFORE adding new ones
    // This prevents duplicate event firing when useEffect re-runs
    // if (Platform.OS === "android") {
    //   sendbirdInstance.removeConnectionHandler("VOXO_CONNECTION_HANDLER");
    //   sendbirdInstance.groupChannel.removeGroupChannelHandler(
    //     "VOXO_CHANNEL_HANDLER"
    //   );
    // }

    sendbirdInstance.addConnectionHandler(
      "VOXO_CONNECTION_HANDLER",
      connectionHandler
    );
    sendbirdInstance.groupChannel.addGroupChannelHandler(
      "VOXO_CHANNEL_HANDLER",
      groupChannelHandler
    );

    void initializeConnection();

    return () => {
      channelsCollection?.dispose();
      sendbirdInstance.removeConnectionHandler("VOXO_CONNECTION_HANDLER");
      sendbirdInstance.groupChannel.removeGroupChannelHandler(
        "VOXO_CHANNEL_HANDLER"
      );
    };
  }, [user?.id, isLoggedIn]);

  // Cleanup effect: Unregister push tokens and disconnect when user logs out
  useEffect(() => {
    if (!isLoggedIn || !user) {
      // User logged out - cleanup push tokens and disconnect
      const cleanup = async () => {
        try {
          // Only cleanup if we have registered tokens or are connected
          const hasRegisteredTokens =
            registeredPushTokensRef.current.length > 0;
          const isCurrentlyConnected = sendbirdInstance.currentUser !== null;

          if (hasRegisteredTokens || isCurrentlyConnected) {
            logger.debug("User logged out, cleaning up Sendbird push tokens");

            // Unregister all push tokens
            const tokensToUnregister = [...registeredPushTokensRef.current];
            for (const tokenInfo of tokensToUnregister) {
              try {
                if (tokenInfo.os === "ios") {
                  await sendbirdInstance.unregisterAPNSPushTokenForCurrentUser(
                    tokenInfo.token
                  );
                } else {
                  await sendbirdInstance.unregisterFCMPushTokenForCurrentUser(
                    tokenInfo.token
                  );
                }
                logger.debug(
                  `Unregistered ${tokenInfo.os} push token on logout`
                );
              } catch (error: any) {
                // Silently ignore access token errors during logout - this is expected
                const errorMessage = error?.message || String(error || "");
                if (
                  errorMessage.includes("access token") ||
                  errorMessage.includes("Invalid") ||
                  errorMessage.includes("unauthorized")
                ) {
                  logger.debug(
                    `Skipping token unregistration - access token invalid (expected during logout): ${tokenInfo.os}`
                  );
                } else {
                  logger.error(
                    `Error unregistering ${tokenInfo.os} push token on logout:`,
                    error
                  );
                }
              }
            }

            // Clear registered tokens
            registeredPushTokensRef.current = [];

            // Disconnect from Sendbird if connected
            if (isCurrentlyConnected) {
              try {
                await disconnect();
                logger.debug("Sendbird disconnected on logout");
              } catch (error) {
                logger.error("Error during disconnect:", error);
              }
            }
          }
        } catch (error) {
          logger.error("Error during logout cleanup:", error);
        }
      };

      void cleanup();
    }
  }, [isLoggedIn, user]);

  // Current channel ref effect (keep in sync with currentChannel state)
  useEffect(() => {
    const prevUrl = currentChannelRef.current?.url;
    const newUrl = currentChannel?.url;
    currentChannelRef.current = currentChannel;

    if (!currentChannel && prevUrl) {
      logger.debug("❌ [currentChannelRef] Ref CLEARED:", {
        wasViewingChannel: prevUrl,
        timestamp: Date.now()
      });
    } else if (currentChannel && prevUrl !== newUrl) {
      logger.debug("✅ [currentChannelRef] Ref SET:", {
        channelUrl: newUrl,
        timestamp: Date.now()
      });
    }
  }, [currentChannel]);

  useEffect(() => {
    const subscription = AppState.addEventListener(
      "change",
      async (nextAppState) => {
        if (nextAppState === "background") {
          previousAppStateRef.current = "background";
          if (currentChannelRef.current) {
            logger.debug(
              "📱 [AppState] App going to background, clearing currentChannelRef:",
              {
                wasViewingChannel: currentChannelRef.current.url,
                timestamp: Date.now()
              }
            );
            currentChannelRef.current = null;
          }
        } else if (
          nextAppState === "active" &&
          previousAppStateRef.current === "background"
        ) {
          logger.debug("📱 [AppState] App became active from background");

          // Sync current user avatar from Sendbird when app foregrounded (cross-device profile updates).
          if (sendbirdInstance?.currentUser != null) {
            try {
              const profileUrl = sendbirdInstance.currentUser.profileUrl;
              const u = store.getState()?.userReducer?.user;
              if (
                profileUrl &&
                typeof profileUrl === "string" &&
                profileUrl !== u?.avatarPath
              ) {
                dispatch({
                  type: userActions.UPDATE_USER,
                  payload: {
                    avatarPath: profileUrl,
                    avatarMediaVersion: Date.now()
                  }
                });
                logger.debug(
                  "📱 [AppState] Synced current user avatar from Sendbird (foreground)"
                );
              }
            } catch (e) {
              logger.debug(
                "Sync avatar from Sendbird on foreground failed:",
                e
              );
            }
          }

          // OPTIMIZE: Skip full channel fetch if user is viewing a channel
          // refreshCurrentChannelMessages (called from SendbirdChatContent) will handle fetching new messages for that channel
          if (currentChannel) {
            logger.debug(
              "⏭️ [AppState] Skipping fetch - user is viewing a channel, refreshCurrentChannelMessages will handle it"
            );
            previousAppStateRef.current = nextAppState;
            return;
          }

          // OPTIMIZE: Only proceed if connection is ready or we're still connecting
          // Don't retry if connection hasn't been established yet (first launch)
          if (
            !isConnected &&
            !connecting &&
            !hasFetchedOnFirstLaunchRef.current
          ) {
            logger.debug(
              "⏭️ [AppState] Skipping fetch - connection not established yet (first launch)"
            );
            previousAppStateRef.current = nextAppState;
            return;
          }

          // Only fetch if it's been > 5 seconds since last fetch
          const lastFetchTime = lastChannelFetchTimeRef.current;
          const timeSinceLastFetch = Date.now() - lastFetchTime;

          if (timeSinceLastFetch < 5000) {
            logger.debug(
              "⏭️ [AppState] Skipping fetch - recent fetch within 5s"
            );
            previousAppStateRef.current = nextAppState;
            return;
          }

          const fetchChannelsWithRetry = async (attempt: number = 0) => {
            const maxAttempts = 3;
            const delay = 500;

            if (attempt >= maxAttempts) {
              logger.warn(
                "⚠️ [AppState] Failed to fetch channels after max attempts"
              );
              return;
            }

            if (isConnected && sendbirdInstance) {
              try {
                await fetchChannels();
                logger.debug("✅ [AppState] Channels fetched successfully", {
                  attempt: attempt + 1
                });
              } catch (error) {
                logger.error("❌ [AppState] Error fetching channels:", error);
                if (attempt < maxAttempts - 1) {
                  setTimeout(() => {
                    fetchChannelsWithRetry(attempt + 1);
                  }, delay);
                }
              }
            } else {
              if (attempt < maxAttempts - 1) {
                logger.debug(
                  "⏳ [AppState] Connection not ready, retrying in",
                  delay,
                  "ms",
                  {
                    attempt: attempt + 1,
                    isConnected,
                    hasSendbirdInstance: !!sendbirdInstance
                  }
                );
                setTimeout(() => {
                  fetchChannelsWithRetry(attempt + 1);
                }, delay);
              } else {
                logger.warn(
                  "⚠️ [AppState] Connection not ready after max attempts"
                );
              }
            }
          };

          fetchChannelsWithRetry();
        }
        previousAppStateRef.current = nextAppState;
      }
    );

    return () => {
      subscription.remove();
    };
  }, [
    isConnected,
    connecting,
    sendbirdInstance,
    fetchChannels,
    currentChannel
  ]);

  // Apply server-side push mutes when user notification prefs change (background).
  useEffect(() => {
    if (!sendbirdInstance || !user?.tenantId) {
      return;
    }

    if (channels.length === 0 && !hasFetchedOnFirstLaunchRef.current) {
      return;
    }

    const timer = setTimeout(() => {
      void applySendbirdNotificationPrefs();
    }, 50);

    return () => clearTimeout(timer);
  }, [
    user?.enableDirectMessageNotifications,
    user?.enableAllNewMessageNotifications,
    user?.enableChatNotifications,
    sendbirdInstance,
    user?.tenantId,
    applySendbirdNotificationPrefs
  ]);

  // Newly joined/created channels only — avoid re-muting the full list on each message.
  useEffect(() => {
    const currentCount = channels.length;
    if (currentCount <= prevChannelCountRef.current) {
      prevChannelCountRef.current = currentCount;
      return;
    }

    const newChannels = channels.filter(
      (channel) => !appliedPushTriggerChannelUrlsRef.current.has(channel.url)
    );
    prevChannelCountRef.current = currentCount;

    if (newChannels.length === 0 || !sendbirdInstance || !user?.tenantId) {
      return;
    }

    void runWithConcurrency(
      newChannels,
      PUSH_TRIGGER_APPLY_CONCURRENCY,
      (channel) => applyPushTriggerToChannel(channel, user)
    );
  }, [channels.length, sendbirdInstance, user?.tenantId, applyPushTriggerToChannel]);

  useEffect(() => {
    if (!currentChannel || messageCollection) return;

    const setupMessageCollection = async () => {
      // ⏱️ DM TIMING LOGS - Message Collection timing
      const msgCollectionStartTime = Date.now();
      console.log(
        `⏱️ [DM-TIMING] setupMessageCollection START: ${currentChannel.url}`
      );

      // Check if we have cached messages - if so, skip network fetch for instant load
      const cachedMessages = MessageCache.getCachedMessages(currentChannel.url);
      const hasCachedMessages = cachedMessages && cachedMessages.length > 0;

      try {
        void currentChannel.markAsRead();
        const filter = new MessageFilter({ replyType: ReplyType.NONE });
        const collection = currentChannel.createMessageCollection({
          filter,
          prevResultLimit: 14,
          nextResultLimit: 14,
          startingPoint: Date.now()
        });
        console.log(
          `⏱️ [DM-TIMING] MessageCollection created: ${
            Date.now() - msgCollectionStartTime
          }ms`
        );

        if (hasCachedMessages) {
          // Show cached messages instantly for fast UI (exclude thread replies)
          const cachedFiltered = onlyMainChannelMessages(cachedMessages);
          console.warn(
            "[ReplyFilter] setupMessageCollection setMessages from cache:",
            {
              channelUrl: currentChannel.url,
              cachedCount: cachedMessages.length,
              afterFilter: cachedFiltered.length,
              replyCount: cachedMessages.length - cachedFiltered.length
            }
          );
          setMessages((prev) =>
            mergeMainChannelMessageLists(prev, cachedFiltered)
          );
          InteractionManager.runAfterInteractions(() => {
            preloadMessageImages(
              cachedFiltered,
              accessToken ?? undefined,
              "full"
            );
          });

          // Then fetch fresh messages in background to get any new ones (e.g., from notification)
          if (collection.hasPrevious) {
            collection
              .loadPrevious()
              .then((freshMessages) => {
                const chatMessages = freshMessages as unknown as ChatMessage[];
                if (chatMessages.length > 0) {
                  const mainOnly = onlyMainChannelMessages(chatMessages);
                  console.warn(
                    "[ReplyFilter] setupMessageCollection setMessages from loadPrevious:",
                    {
                      channelUrl: currentChannel.url,
                      freshCount: chatMessages.length,
                      afterFilter: mainOnly.length,
                      replyCount: chatMessages.length - mainOnly.length
                    }
                  );
                  setMessages((prev) => {
                    const merged = mergeMainChannelMessageLists(
                      prev,
                      mainOnly
                    );
                    if (currentChannel.url && merged.length > 0) {
                      MessageCache.setCachedMessages(
                        currentChannel.url,
                        merged
                      );
                    }
                    return merged;
                  });
                  logger.debug(
                    "🔄 [setupMessageCollection] Updated with fresh messages:",
                    {
                      channelUrl: currentChannel.url,
                      cachedCount: cachedMessages.length,
                      freshCount: chatMessages.length
                    }
                  );
                }
              })
              .catch((err) =>
                logger.error(
                  "❌ [setupMessageCollection] Background fetch error:",
                  err
                )
              );
          }
        } else if (collection.hasPrevious) {
          const messages = await collection.loadPrevious();
          const chatMessages = messages as unknown as ChatMessage[];
          const mainOnly = onlyMainChannelMessages(chatMessages);
          setMessages((prev) => {
            const merged = mergeMainChannelMessageLists(prev, mainOnly);
            if (currentChannel.url && merged.length > 0) {
              MessageCache.setCachedMessages(currentChannel.url, merged);
              logger.debug("💾 [setupMessageCollection] Cached messages:", {
                channelUrl: currentChannel.url,
                count: merged.length
              });
            }
            return merged;
          });
        }

        setMessageCollection(collection);
      } catch (e) {
        logger.error("Error setting up message collection:", e);
      }
    };

    void setupMessageCollection();
  }, [currentChannel, messageCollection, accessToken]);

  // Add this after fetchChannels function
  // Memoize channels hash to avoid unnecessary processing
  const channelsHash = useMemo(() => {
    const hasChannels = channels.length > 0;
    const hasTenantId = !!user?.tenantId;
    const hash =
      !hasChannels || !hasTenantId
        ? ""
        : channels
            .map((c) => {
              const reduxCh = cachedChannels.find(
                (ch: any) => ch.url === c.url
              );
              return `${c.url}:${c.lastMessage?.createdAt || 0}:${
                c.unreadMessageCount || 0
              }:${reduxCh?.customUnreadCount || 0}`;
            })
            .sort()
            .join("|");
    return hash;
  }, [channels, cachedChannels, user?.tenantId]);

  // Create directory hash to detect directory changes (like profile updates)
  const directoryHash = useMemo(() => {
    const hash = !directory.length
      ? ""
      : directory
          .filter((contact) => contact.userId && contact.type === "company")
          .map(
            (contact) =>
              `${contact.userId}:${contact.avatarPath || ""}:${
                contact.avatarThumbnailPath || ""
              }`
          )
          .sort()
          .join("|");
    return hash;
  }, [directory]);

  // Hash from company+personal contacts so DM list avatars update when 5s loop / fetch updates them
  const companyPersonalHash = useMemo(() => {
    const company = companyContacts || [];
    const personal = personalContacts || [];
    const all = [...company, ...personal].filter((c: any) => c?.userId != null);
    if (!all.length) return "";
    return all
      .map(
        (c: any) =>
          `${c.userId}:${c.avatarPath || ""}:${c.avatarThumbnailPath || ""}`
      )
      .sort()
      .join("|");
  }, [companyContacts, personalContacts]);

  // Combined hash: reprocess when channels, directory, company/personal avatars, or user avatar change
  const processingHash = useMemo(() => {
    return `${channelsHash}|${directoryHash}|${companyPersonalHash}|${
      user?.avatarPath ?? ""
    }`;
  }, [channelsHash, directoryHash, companyPersonalHash, user?.avatarPath]);

  const processChannels = useCallback(() => {
    if (!user?.tenantId) {
      isProcessingRef.current = false; // Reset processing flag on early return to allow retry
      return;
    }

    // Store previousLastSync for future use (currently unused due to commented code)
    const _previousLastSync = previousLastSyncRef.current;

    const contacts = (() => {
      const company = companyContacts || [];
      const personal = personalContacts || [];
      const combined = [...company, ...personal].filter(
        (c: any) => c?.userId != null
      );
      if (combined.length > 0) return combined;
      return directory.filter((contact: any) => contact.userId);
    })();
    const cachedChannelsMap = new Map<string, any>();
    cachedChannels.forEach((ch: any) => {
      if (ch.url) {
        cachedChannelsMap.set(ch.url, ch);
      }
    });

    const contactsByUserIdMap = new Map<string, (typeof contacts)[0]>();
    contacts.forEach((contact) => {
      if (contact.userId) {
        contactsByUserIdMap.set(contact.userId.toString(), contact);
      }
    });

    const processGroupChannel = (channel: GroupChannel): any => {
      // OPTIMIZE: Only check profile updates for channels we haven't checked recently
      const channelUrl = channel.url;
      if (!recentlyCheckedChannelsRef.current.has(channelUrl)) {
        const hasUpdates = checkAndUpdateMemberProfiles(
          channel,
          "processGroupChannel"
        );
        if (hasUpdates) {
          recentlyCheckedChannelsRef.current.add(channelUrl);
          // Clear after 5 minutes
          setTimeout(() => {
            recentlyCheckedChannelsRef.current.delete(channelUrl);
          }, 5 * 60 * 1000);
          // Update the map with fresh directory data after profile update
          const state = store.getState();
          const updatedDirectory = state.directoryReducer.directory || [];
          updatedDirectory.forEach((contact: any) => {
            if (contact.userId && contact.type === "company") {
              contactsByUserIdMap.set(contact.userId.toString(), contact);
            }
          });
          logger.debug(
            "🔄 [processGroupChannel] Profile updates detected, updated contacts map"
          );
        }
      }

      // ✅ PERFORMANCE: Use Set for O(1) membership checks instead of array.includes() which is O(n)
      const channelMemberIdsSet = new Set(
        channel.members.map((member) => member.userId)
      );
      const memberUserIds: string[] = [];

      contactsByUserIdMap.forEach((contact, userId) => {
        if (channelMemberIdsSet.has(userId)) {
          memberUserIds.push(userId);
        }
      });

      const reduxChannel = cachedChannelsMap.get(channel.url);
      let channelName =
        reduxChannel?.name && reduxChannel.name !== "Unnamed Channel"
          ? reduxChannel.name
          : channel.name;
      if (!channelName && channel.members?.length > 0) {
        channelName = channel.members
          .map((m) => m.nickname || m.userId)
          .filter(Boolean)
          .join(", ");
      }
      channelName = channelName || "Unnamed Channel";

      const finalUnreadCount =
        (channel.unreadMessageCount || 0) >
        (reduxChannel?.customUnreadCount || 0)
          ? channel.unreadMessageCount || 0
          : reduxChannel?.customUnreadCount || 0;

      // const hasNoMessages = !channel.lastMessage;
      // const sendbirdUnreadCount = channel.unreadMessageCount || 0;

      // const joinedAtMs = (channel as any).joinedAt ? ((channel as any).joinedAt * 1000) : 0;
      // const myLastReadMs = channel.myLastRead || 0;
      // const timeDifference = myLastReadMs - joinedAtMs;
      // const VIEW_THRESHOLD_MS = 1000;

      // const hasActuallyViewed = myLastReadMs > 0 && timeDifference > VIEW_THRESHOLD_MS;
      // const wasJoinedAfterLastSync = joinedAtMs > 0 && joinedAtMs > previousLastSync;
      // const wouldGet1Count = wasJoinedAfterLastSync && hasNoMessages && sendbirdUnreadCount === 0 && finalUnreadCount === 0 && !hasActuallyViewed;

      // if (wouldGet1Count) {
      //   finalUnreadCount = 1;
      //   dispatchSendbird(sendbirdActions.incrementChannelUnread(channel.url));
      //   UnreadCountCache.setUnreadCount(channel.url, 1);
      //   logger.debug("📈 [processGroupChannel] Set unread count to 1 for newly added channel:", {
      //     channelUrl: channel.url,
      //     channelName: channelName,
      //     joinedAt: new Date(joinedAtMs).toISOString(),
      //     myLastRead: myLastReadMs > 0 ? new Date(myLastReadMs).toISOString() : null,
      //     timeDifferenceSeconds: (timeDifference / 1000).toFixed(2),
      //     previousLastSync: new Date(previousLastSync).toISOString(),
      //     createdAt: new Date(channel.createdAt || 0).toISOString(),
      //     hasNoMessages,
      //     sendbirdUnreadCount,
      //     hasActuallyViewed
      //   });
      // } else if (wasJoinedAfterLastSync && hasNoMessages && hasActuallyViewed) {
      //   logger.debug("⏭️ [processGroupChannel] Skipping unread count 1 - channel already viewed (myLastRead significantly after joinedAt):", {
      //     channelUrl: channel.url,
      //     channelName: channelName,
      //     timeDifferenceSeconds: (timeDifference / 1000).toFixed(2)
      //   });
      // }

      return {
        name: channelName,
        url: channel.url,
        unreadCount: finalUnreadCount,
        isPublic: channel.isPublic,
        muted: channel.myPushTriggerOption === PushTriggerOption.OFF,
        memberUserIds,
        lastMessageAt: channel.lastMessage?.createdAt || channel.createdAt || 0
        // wouldGet1Count: wouldGet1Count
      };
    };

    // Helper function to process a single group channel

    // Helper function to process a single DM channel
    const processDMChannel = (
      channel: GroupChannel
    ): FilteredDMChannel | null => {
      const isPersonal =
        channel.customType === CustomChannelType.personalChannel(user.tenantId);

      if (isPersonal) {
        // ✅ PERFORMANCE: O(1) lookup
        const reduxChannel = cachedChannelsMap.get(channel.url);
        // FIX: Prioritize Sendbird when it's higher than Redux (same logic as group channels)

        // if(user.extName == 'Abeer Homie Quan'){
        //   console.log("Dm_Channel_unread_Count")
        //    console.log({name: user.extName,sendBirdUnreadCount: channel.unreadMessageCount, reduxUnreadCount: reduxChannel?.customUnreadCount})
        // }

        const finalUnreadCount =
          (channel.unreadMessageCount || 0) >
          (reduxChannel?.customUnreadCount || 0)
            ? channel.unreadMessageCount || 0
            : reduxChannel?.customUnreadCount || 0;

        return {
          name: user.extName,
          avatar: user.avatarPath || "",
          url: channel.url,
          connectionStatus: "online",
          unreadCount: finalUnreadCount,
          personal: true,
          memberUserIds: [user.id.toString()],
          lastMessageAt:
            channel.lastMessage?.createdAt || channel.createdAt || 0
        };
      }

      const members = channel.members.filter(
        (member) => parseInt(member.userId) !== user.id
      );

      // OPTIMIZE: Only check profile updates for channels we haven't checked recently
      const channelUrl = channel.url;

      if (!recentlyCheckedChannelsRef.current.has(channelUrl)) {
        const hasUpdates = checkAndUpdateMemberProfiles(
          channel,
          "processDMChannel"
        );

        if (hasUpdates) {
          recentlyCheckedChannelsRef.current.add(channelUrl);
          // Clear after 5 minutes
          setTimeout(() => {
            recentlyCheckedChannelsRef.current.delete(channelUrl);
          }, 5 * 60 * 1000);
          logger.debug(
            "🔄 [processDMChannel] Profile updates detected in DM channel:",
            channel.url
          );
          // Refresh directory reference
          const state = store.getState();
          const updatedDirectory = state.directoryReducer.directory || [];
          // Update contactsByUserIdMap with fresh data
          updatedDirectory.forEach((contact: any) => {
            if (contact.userId && contact.type === "company") {
              contactsByUserIdMap.set(contact.userId.toString(), contact);
            }
          });
          logger.debug(
            "🔄 [processDMChannel] Updated contacts map with fresh directory data"
          );
        }
      }

      const memberContacts: typeof contacts = [];
      members.forEach((member) => {
        const contact = contactsByUserIdMap.get(member.userId);
        if (contact) {
          memberContacts.push(contact);
        }
      });

      const reduxChan = cachedChannelsMap.get(channel.url);

      // FIX: Prioritize Sendbird when it's higher than Redux (same logic as group channels)
      const finalUnreadCount =
        (channel.unreadMessageCount || 0) > (reduxChan?.customUnreadCount || 0)
          ? channel.unreadMessageCount || 0
          : reduxChan?.customUnreadCount || 0;

      if (!memberContacts.length) {
        const memberUserIds = members.map((m) => m.userId);
        const memberName = members
          .map((m) => m.nickname || m.userId)
          .join(", ");
        return {
          avatar: members[0]?.profileUrl || "",
          name: memberName || channel.name || "Unnamed",
          connectionStatus: members[0]?.connectionStatus || "offline",
          url: channel.url,
          unreadCount: finalUnreadCount,
          memberUserIds,
          lastMessageAt:
            channel.lastMessage?.createdAt || channel.createdAt || 0
        };
      }

      const memberUserIds = memberContacts.map((contact) =>
        contact.userId!.toString()
      );
      const memberName = memberContacts
        .map((member) => member.name.trim())
        .join(", ");

      return {
        avatar:
          memberContacts[0]?.avatarThumbnailPath ||
          memberContacts[0]?.avatarPath ||
          "",
        name: memberName || channel.name || "Unnamed",
        connectionStatus: members[0]?.connectionStatus || "offline",
        url: channel.url,
        unreadCount: finalUnreadCount,
        memberUserIds,
        lastMessageAt: channel.lastMessage?.createdAt || channel.createdAt || 0
      };
    };

    const seenChannels = new Set<string>();
    const seenDMs = new Set<string>();
    const groupChannels: GroupChannel[] = [];
    const dmChannels: GroupChannel[] = [];

    channels.forEach((channel) => {
      const isGroupChannel =
        channel.customType !== CustomChannelType.dmChannel(user.tenantId) &&
        channel.customType === CustomChannelType.groupChannel(user.tenantId);
      const isDm =
        channel.customType === CustomChannelType.dmChannel(user.tenantId) ||
        channel.customType === CustomChannelType.personalChannel(user.tenantId);

      if (isDm && channel.name === "Abeer Homie Quan") {
        // console.log("Dm_Channel_unread_Count_Raw")
        // console.log(channel)
      }

      if (isGroupChannel && !seenChannels.has(channel.url)) {
        seenChannels.add(channel.url);
        groupChannels.push(channel);
      } else if (isDm && !seenDMs.has(channel.url) && !channel.isHidden) {
        seenDMs.add(channel.url);
        dmChannels.push(channel);
      }
    });

    const sortedGroupChannelsRaw = [...groupChannels].sort((a, b) => {
      // ✅ FIX: Use channel.createdAt as fallback for new channels without messages
      // This ensures newly added channels appear at the top of the list
      const aTime = a.lastMessage?.createdAt || a.createdAt || 0;
      const bTime = b.lastMessage?.createdAt || b.createdAt || 0;
      return bTime - aTime; // Most recent first
    });

    const sortedDMChannelsRaw = [...dmChannels].sort((a, b) => {
      const aTime = a.lastMessage?.createdAt || a.createdAt || 0;
      const bTime = b.lastMessage?.createdAt || b.createdAt || 0;
      return bTime - aTime;
    });

    const processedGroupChannels = sortedGroupChannelsRaw
      .map(processGroupChannel)
      .filter(
        (channel) =>
          channel &&
          channel.url &&
          typeof channel.url === "string" &&
          channel.url.length > 0
      );

    const processedDMChannels = sortedDMChannelsRaw
      .map((channel) => processDMChannel(channel))
      .filter(
        (channel): channel is FilteredDMChannel =>
          channel !== null &&
          !!channel.url &&
          typeof channel.url === "string" &&
          channel.url.length > 0
      );

    // Filter out all variations of unnamed channels.
    const isUnnamedChannel = (name: string | undefined) => {
      if (!name) return true;
      const lower = name.toLowerCase().trim();
      return (
        lower === "unnamed channel" ||
        lower === "unnamed-channel" ||
        lower === "unnamed" ||
        lower.startsWith("unnamed")
      );
    };

    // Filter out unnamed channels (sorting already done above)
    const sortedGroupChannels = processedGroupChannels.filter(
      (ch) => !isUnnamedChannel(ch.name)
    );

    const sortedDMChannels = processedDMChannels.filter(
      (ch) => !isUnnamedChannel(ch.name)
    );

    // console.log("sortedGroupChannels---->",JSON.stringify(sortedGroupChannels, null, 2))

    setFilteredGroupChannels(sortedGroupChannels);
    setFilteredDMChannels(sortedDMChannels);
    isProcessingRef.current = false;
  }, [
    channels,
    cachedChannels,
    user?.tenantId,
    user?.id,
    user?.extName,
    user?.avatarPath,
    directory,
    companyContacts,
    personalContacts
  ]);

  const lastProcessedChannelsRef = useRef<string>("");
  const isProcessingRef = useRef<boolean>(false);

  useEffect(() => {
    if (
      processingHash &&
      processingHash !== lastProcessedChannelsRef.current &&
      !isProcessingRef.current
    ) {
      lastProcessedChannelsRef.current = processingHash;
      isProcessingRef.current = true;
      processChannels();
    }
  }, [processingHash, processChannels]);
  const [totalUnreadCount, setTotalUnreadCount] = useState(0);

  const prevSmsUnreadRef = useRef<number>(-1);
  const prevSendbirdUnreadRef = useRef<number>(-1);

  const calculateBadge = useCallback(() => {
    const state = store.getState();
    const currentTextReducer = state.textReducer;
    const currentConversations = currentTextReducer.conversations || [];
    const currentSendbirdReducer = state.sendbirdReducer;
    const reduxChannels = currentSendbirdReducer.channels || [];

    const currentUnreadSum = currentConversations.reduce(
      (sum: number, conv: any) => sum + (conv?.unreadCount || 0),
      0
    );

    // Use customUnreadCount from Redux instead of SDK's unreliable unreadMessageCount
    // This prevents badge from dropping when notifications are dismissed
    const sendbirdUnread = reduxChannels.reduce(
      (acc: number, channel: any) => acc + (channel.customUnreadCount || 0),
      0
    );

    // Total unread = Sendbird + SMS
    const total = sendbirdUnread + currentUnreadSum;

    prevSmsUnreadRef.current = currentUnreadSum;
    prevSendbirdUnreadRef.current = sendbirdUnread;

    setTotalUnreadCount(total);
  }, [store, channels]);

  useEffect(() => {
    calculateBadge();
    let timeoutId: NodeJS.Timeout | null = null;
    const unsubscribe = store.subscribe(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      timeoutId = setTimeout(() => {
        // console.log(
        //   "🔄 [SendbirdContext] Redux store changed, recalculating badge"
        // );
        calculateBadge();
        timeoutId = null;
      }, 50);
    });

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      unsubscribe();
    };
  }, [store, calculateBadge]);

  useEffect(() => {
    if (channels.length > 0) {
      calculateBadge();
    }
  }, [channels, calculateBadge]);

  useEffect(() => {
    if (totalUnreadCount >= 0) {
      NotificationManager.setBadgeCount(totalUnreadCount)
        .then(() => {})
        .catch((error) => {
          console.error(
            "❌ [SendbirdContext] Error setting badge count:",
            error
          );
        });

      if (Platform.OS === "android") {
        setTimeout(() => {
          NotificationManager.setBadgeCount(totalUnreadCount)
            .then(() => {})
            .catch((error) => {
              console.error(
                "❌ [SendbirdContext] Error setting badge count (retry):",
                error
              );
            });
        }, 300);
      }
    }
  }, [totalUnreadCount]);

  const filteredMessages = onlyMainChannelMessages(messages);
  if (messages.length !== filteredMessages.length) {
    console.warn(
      "[ReplyFilter] Context value: raw had replies, exposing filtered",
      {
        rawCount: messages.length,
        filteredCount: filteredMessages.length,
        diff: messages.length - filteredMessages.length
      }
    );
  }

  return (
    <SendbirdContext.Provider
      value={{
        // Main chat sees only parent messages; replies are hidden and only show in thread view
        messages: filteredMessages,
        channels,
        sendbirdInstance,
        channelsCollection,
        messageCollection,
        currentChannel,
        connecting,
        isConnected,
        reFetchThread,
        isFetchingMessages,
        typingUsers,
        connect,
        disconnect,
        enterChannel,
        leaveChannel,
        setPushNotification,
        applySendbirdNotificationPrefs,
        sendUserMessage,
        sendFileMessage,
        sendMultipleFileMessage,
        editUserMessage,
        deleteUserMessage,
        reactionEvent,
        fetchChannels,
        fetchMoreMessages,
        fetchNewMessages,
        findChannelByName,
        createOrJoinChannel,
        createOrJoinDMChannel,
        findExistingDMChannel,
        getChannelPreviewMessages,
        filteredGroupChannels,
        filteredDMChannels,
        leaveChannelPermanently,
        deleteChannel,
        activeThreadId,
        activeParentMessage,
        threadMessages,
        setActiveThread,
        clearActiveThread,
        loadThreadFromCache,
        markChannelAsRead,
        fetchThreadMessages,
        refreshChannel,
        refreshCurrentChannelMessages,
        loadCachedMessages,
        isFetchingThread,
        totalUnreadCount,
        isChannelsLoading: fetchingChannels,
        hideDmChannel
      }}
    >
      {children}
    </SendbirdContext.Provider>
  );
}
