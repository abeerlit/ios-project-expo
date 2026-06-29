// React Imports
import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef
} from "react";
import { View, Platform } from "react-native";
import {
  Gesture,
  GestureDetector,
  ScrollView
} from "react-native-gesture-handler";
import { HomeScrollGestureContext } from "../context/HomeScrollGestureContext.tsx";
import messaging from "@react-native-firebase/messaging";

// Hooks
import { useSelector, useDispatch } from "react-redux";
import { useDebounceFn, useRequest } from "ahooks";
import { useTheme } from "hooks/use-theme.ts";
import { useStableTopBarAvatar } from "hooks/use-stable-top-bar-avatar.ts";
import { usePermissions } from "core/permissions/use-permissions.ts";
import { useSendbirdContext } from "features/chat/utils/SendbirdContext.ts";
import { useNotifications } from "hooks/use-notifications.ts";
import * as userActions from "store/users/actions.ts";
import { store } from "store/global-store.ts";
import { normalizeUserDnd } from "shared/utils/user-dnd.ts";
import * as textActions from "store/text/actions.ts";
import { NotificationToken } from "core/notifications/NotificationManager.ts";

// Typesf
import { State } from "store/types.ts";
import { GroupChannel } from "@sendbird/chat/groupChannel";
import {
  CustomChannelType,
  NormalizedPublicChannel,
  FilteredDMChannel,
  FilteredChannel
} from "features/chat/types.ts";
import { SendbirdChannel } from "shared/api/chat/types.ts";

// API
import { getAgentQueues, queueAgentDND } from "shared/api/queues/methods.ts";
import { getPublicChannels } from "shared/api/chat/methods.ts";

// Components
import { Screen } from "shared/components/utils/Screen.tsx";
import { TopBar } from "shared/components/TopBar.tsx";
import { WhiteSpace } from "shared/components/utils/Whitespace.tsx";
import SearchBar from "shared/components/utils/SearchBar.tsx";
import SearchResults from "../components/SearchResults";
import ChannelsSection from "../components/ChannelsSection";
import DirectMessagesSection from "../components/DirectMessagesSection";
import CallCenterSection from "../components/CallCenterSection";

// Utils
import { Logger } from "shared/utils/Logger.ts";
import { toast } from "@backpackapp-io/react-native-toast";
import { findContactByPhoneNumber } from "features/calling/utils/contact-lookup.ts";

// Styles
import { homeStyles } from "../styles/home-styles.ts";
import { padding } from "core/theme/theme.ts";

const logger = new Logger("Home");

export function Home() {
  // =========================
  // HOOKS AND STATE MANAGEMENT
  // =========================
  const theme = useTheme();
  const dispatch = useDispatch();
  const { checkPermissions, requestAllPermissions, permissions } =
    usePermissions();
  const {
    channels,
    filteredGroupChannels,
    filteredDMChannels,
    setPushNotification,
    isConnected,
    connecting,
    isChannelsLoading
  } = useSendbirdContext();
  useNotifications();

  // Track notification permission from both local state and permissions hook
  const notificationPermissionFromHook =
    permissions?.notifications?.granted ?? false;
  const [notificationPermissionGranted, setNotificationPermissionGranted] =
    useState(false);
  const [
    prevNotificationPermissionGranted,
    setPrevNotificationPermissionGranted
  ] = useState(false);
  // Direct Firebase permission check (most reliable)
  const [firebasePermissionGranted, setFirebasePermissionGranted] =
    useState(false);

  // Local State
  const [searchVal, setSearchVal] = useState("");
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [publicChannels, setPublicChannels] = useState<GroupChannel[]>();
  const [, setSearching] = useState(false);

  // Redux State
  const { user, shouldResetTokenRegistration } = useSelector(
    (state: State) => state.userReducer
  );

  const { accessToken, isLoggedIn } = useSelector(
    (state: State) => state.authReducer
  );

  
  const { directory, personalContacts, companyContacts, phoneContacts } =
    useSelector((state: State) => state.directoryReducer);
  const { conversations: smsConversations, provisionedNumbers } = useSelector(
    (state: State) => state.textReducer
  );

  const [lastRegisteredToken, setLastRegisteredToken] =
    useState<NotificationToken | null>(null);

  // Track if we've already registered on first launch
  const hasRegisteredOnFirstLaunchRef = useRef(false);
  // Track if we've already tried to regenerate token after permission grant (Android only, first time)
  const hasTriedTokenRegenerationRef = useRef(false);
  // Track if registration is currently in progress to prevent concurrent calls
  const isRegisteringRef = useRef(false);
  // Track retry attempts
  const retryAttemptsRef = useRef(0);
  const MAX_RETRY_ATTEMPTS = 1; // Allow one retry on first launch
  const { avatarSource: topBarAvatarSource, avatarName: topBarAvatarName } =
    useStableTopBarAvatar();

  const { data, runAsync } = useRequest(
    () => getAgentQueues(accessToken, user?.peerName as string),
    {
      manual: true,
      onError: (error) => {
        logger.error("Failed to fetch agent queues:", error);
        toast.error("Error fetching queues");
      },
      onSuccess: (agentData) => {
        if (agentData?.extDND === undefined || agentData.extDND === null) {
          return;
        }
        const next = normalizeUserDnd(agentData.extDND);
        const current = normalizeUserDnd(
          store.getState().userReducer?.user?.dnd
        );
        if (next !== current) {
          dispatch(userActions.updateUser({ dnd: next }));
        }
      }
    }
  );

  const normalizePublicChannel = (
    raw: SendbirdChannel
  ): NormalizedPublicChannel => {
    const userMember = raw.members.find(
      (member) => member.user_id === user?.id.toString()
    );
    const hasJoined = userMember?.state === "joined";
    const res = {
      url: raw.channel_url,
      name: raw.name,
      customType: raw.custom_type,
      isPublic: raw.is_public,
      unreadMessageCount: raw.unread_message_count,
      createdAt: raw.created_at,
      joinedAt: hasJoined ? raw.created_at ?? 0 : 0
    };
    return res;
  };

  const handlePublicChannels = async (channelName: string) => {
    if (!user?.tenantId || !isConnected) {
      return;
    }
    const res = await getPublicChannels(
      user.tenantId.toString(),
      channelName
    );
    if (res && res.length) {
      const normalizedChannels = res.map((channel: SendbirdChannel) => {
        return normalizePublicChannel(channel);
      });
      setPublicChannels(normalizedChannels as GroupChannel[]);
    }
  };

  const { run } = useDebounceFn(handlePublicChannels, {
    wait: 500
  });

  const isChannelDM = useCallback(
    (channel: GroupChannel): boolean => {
      return (
        channel.customType ===
          CustomChannelType.dmChannel(user?.tenantId || -1) ||
        channel.customType ===
          CustomChannelType.personalChannel(user?.tenantId || -1)
      );
    },
    [user?.tenantId]
  );

  const formatDMChannel = useCallback(
    (channel: GroupChannel): FilteredDMChannel => {
      const members = channel.members.filter(
        (member) => parseInt(member.userId) !== user?.id
      );
      const memberContacts = directory.filter((contact) =>
        members.some((member) => contact.userId?.toString() === member.userId)
      );

      const isPersonal =
        channel.customType ===
        CustomChannelType.personalChannel(user?.tenantId || -1);

      if (isPersonal) {
        return {
          name: user?.extName || "",
          avatar: user?.avatarPath || "",
          url: channel.url,
          connectionStatus: "online",
          unreadCount: channel.unreadMessageCount,
          personal: true,
          memberUserIds: [user?.id?.toString() || ""]
        };
      }

      const memberName = memberContacts
        .map((member) => member.name.trim())
        .join(", ");
      const name =
        memberName.length > 30 ? `${memberName.slice(0, 30)}....` : memberName;

      const channelMemberIds = channel.members.map((member) => member.userId);
      const memberUserIds = directory
        .filter(
          (contact) =>
            contact.userId &&
            channelMemberIds.includes(contact.userId.toString())
        )
        .map((contact) => contact.userId!.toString());

      return {
        avatar:
          memberContacts[0]?.avatarThumbnailPath ||
          memberContacts[0]?.avatarPath ||
          "",
        name: name || channel.name,
        connectionStatus: members[0]?.connectionStatus || "offline",
        url: channel.url,
        unreadCount: channel.unreadMessageCount,
        memberUserIds
      };
    },
    [user?.id, user?.extName, user?.avatarPath, user?.tenantId, directory]
  );

  const formatGroupChannel = useCallback(
    (channel: GroupChannel): FilteredChannel => {
      // Get member user IDs from directory for this channel
      const channelMemberIds = channel.members?.map((member) => member.userId);
      const memberUserIds = directory
        .filter(
          (contact) =>
            contact.userId &&
            channelMemberIds?.includes(contact.userId.toString())
        )
        .map((contact) => contact.userId!.toString());

      return {
        name: channel.name,
        url: channel.url,
        unreadCount: channel.unreadMessageCount,
        isPublic: channel.isPublic,
        joined: channel.joinedAt !== 0,
        memberUserIds
      };
    },
    [directory]
  );

  const handleDNDToggle = useCallback(
    async (
      queueId: number,
      isReceivingQueueCalls: boolean,
      queueName: string
    ): Promise<void> => {
      if (!user?.peerName) {
        logger.error("Cannot toggle DND: No peer name available");
        return;
      }

      console.log("🔵 [Home] handleDNDToggle", {
        queueId,
        isReceivingQueueCalls,
        queueName
      });

      try {
        const newDndState = isReceivingQueueCalls;
        await queueAgentDND(user.peerName, queueId, newDndState);
        await runAsync();

        if (isReceivingQueueCalls) {
          toast.success(`You'll no longer receive calls from ${queueName}.`);
        } else {
          toast.success(`You'll now receive calls from ${queueName}.`);
        }
      } catch (error) {
        logger.error("Failed to toggle queue availability:", error);
        toast.error("Couldn't update queue call settings");
      }
    },
    [user?.peerName, runAsync]
  );

  const handleRefetch = useCallback(async (): Promise<void> => {
    await runAsync();
  }, [runAsync]);

  const handleSearchCancel = useCallback(() => {
    setSearchVal("");
  }, []);

  const handleSearchFocusChange = useCallback(
    async (isFocused: boolean) => {
      if (isFocused) {
        await run("");
      }
      setIsSearchFocused(isFocused);
    },
    [run]
  );

  const filteredResults = useMemo(() => {
    setSearching(true);
    if (!searchVal.trim()) {
      setSearching(false);
      return [];
    }

    const normalizedSearch = searchVal.toLowerCase().trim();
    const allChannel: GroupChannel[] = [...(publicChannels || []), ...channels];

    if (allChannel.length < 1) {
      setSearching(false);
      return [];
    }

    // Remove duplicates using Map (keeps the first occurrence)
    const channelMap = new Map<string, GroupChannel>();
    allChannel.forEach((channel) => {
      if (!channelMap.has(channel.url)) {
        channelMap.set(channel.url, channel);
      }
    });

    // Convert back to array, filter, and sort
    const filteredChannels = Array.from(channelMap.values())
      .filter((channel) => {
        // Check channel name
        if (
          channel.name &&
          typeof channel.name === "string" &&
          channel.name.toLowerCase().includes(normalizedSearch)
        ) {
          return true;
        }

        // Check member nicknames
        if (channel.members && channel.members.length > 0) {
          return channel.members.some((member) =>
            member.nickname?.toLowerCase().includes(normalizedSearch)
          );
        }

        return false;
      })
      .sort((a, b) => {
        const aTime = a.createdAt || 0;
        const bTime = b.createdAt || 0;
        return bTime - aTime;
      });

    setSearching(false);
    return filteredChannels;
  }, [searchVal, publicChannels, channels]);

  const orderedDMChannels = useMemo(() => {
    if (filteredDMChannels.length === 0) return [];

    const personalChannelIndex = filteredDMChannels.findIndex(
      (c) => c.personal === true
    );

    if (personalChannelIndex > -1) {
      const personalChannel = filteredDMChannels[personalChannelIndex];
      const otherChannels = [
        ...filteredDMChannels.slice(0, personalChannelIndex),
        ...filteredDMChannels.slice(personalChannelIndex + 1)
      ];
      const slicedChannels = otherChannels.slice(0, 9);
      return [...slicedChannels, personalChannel];
    }

    return filteredDMChannels;
  }, [filteredDMChannels]);

  // Function to check Firebase messaging permission directly (most reliable)
  // Note: requestPermission() returns current status without showing prompt if already determined
  const checkFirebasePermission = useCallback(async () => {
    try {
      const authStatus = await messaging().requestPermission();
      const enabled =
        authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
        authStatus === messaging.AuthorizationStatus.PROVISIONAL;

      logger.debug("🔍🔍🔍 [Home] Firebase permission check:", {
        authStatus,
        enabled,
        previousState: firebasePermissionGranted,
        authStatusName:
          authStatus === messaging.AuthorizationStatus.AUTHORIZED
            ? "AUTHORIZED"
            : authStatus === messaging.AuthorizationStatus.PROVISIONAL
            ? "PROVISIONAL"
            : authStatus === messaging.AuthorizationStatus.DENIED
            ? "DENIED"
            : authStatus === messaging.AuthorizationStatus.NOT_DETERMINED
            ? "NOT_DETERMINED"
            : "UNKNOWN"
      });

      const wasGranted = firebasePermissionGranted;
      setFirebasePermissionGranted(enabled);

      // Return true if permission was just granted
      return { enabled, justGranted: !wasGranted && enabled };
    } catch (error) {
      logger.error("🔍 [Home] Error checking Firebase permission:", error);
      return { enabled: false, justGranted: false };
    }
  }, [firebasePermissionGranted]);

  // Use Effects
  useEffect(() => {
    const initializePermissions = async (): Promise<void> => {
      try {
        await checkPermissions();

        const firebaseResult = await checkFirebasePermission();

        const result = await requestAllPermissions();
        const wasGranted = notificationPermissionGranted;
        setNotificationPermissionGranted(
          result.allGranted || result.results.notifications.granted
        );

        // Set prev state AFTER checking both Firebase and permissions hook
        // This ensures permissionJustGranted can detect the change
        setPrevNotificationPermissionGranted(wasGranted);

        if (firebaseResult.justGranted) {
          logger.debug("🔔 [Home] Firebase permission just granted");
        }

        // Log notification permission specifically for token registration
        if (result.results.notifications.granted) {
          logger.debug(
            "🔔 [Home] Notification permission granted - token registration will be triggered"
          );
        }

        if (!result.allGranted) {
          logger.warn("Not all permissions granted:", result.results);
        }
      } catch (error) {
        logger.error("Failed to check or request permissions:", error);
        toast.error("Error with app permissions");
        setNotificationPermissionGranted(false);
      }
    };
    void initializePermissions();
  }, [checkPermissions, requestAllPermissions, checkFirebasePermission]);

  const registerTokens = useCallback(async () => {
    if (!isLoggedIn || !accessToken?.trim() || !user?.id) {
      logger.debug(
        "⚠️ [Home] Not logged in — skipping Sendbird push token registration"
      );
      return;
    }

    if (!isConnected) {
      logger.debug(
        "⚠️ [Home] Sendbird not connected, skipping token registration"
      );
      return;
    }

    const hasPermission =
      firebasePermissionGranted ||
      notificationPermissionFromHook ||
      notificationPermissionGranted;

    if (!hasPermission) {
      logger.debug(
        "⚠️ [Home] No notification permission, skipping token registration"
      );
      return;
    }

    // Prevent concurrent registration calls
    if (isRegisteringRef.current) {
      logger.debug(
        "⏳ [Home] Token registration already in progress, skipping"
      );
      return;
    }

    isRegisteringRef.current = true;

    try {
      // Always fetch the latest token directly from Firebase (not from cached tokens array)
      let latestToken: string | null = null;
      const tokenType: "ios" | "android" =
        Platform.OS === "ios" ? "ios" : "android";
      const notificationTokenType: "ios_remote_notifications" | "android_fcm" =
        Platform.OS === "ios" ? "ios_remote_notifications" : "android_fcm";

      logger.debug("🔔 [Home] Fetching latest token from Firebase...");

      if (Platform.OS === "ios") {
        latestToken = await messaging().getAPNSToken();
        logger.debug("🔔 [Home] Latest token fetched from Firebase", {
          latestToken
        });
      } else {
        try {
          latestToken = await messaging().getToken();
        } catch (error: any) {
          const errorCode = error?.code || error?.message || "";
          const isServiceUnavailable =
            errorCode.includes("SERVICE_NOT_AVAILABLE") ||
            errorCode.includes("messaging/unknown") ||
            error?.message?.includes("SERVICE_NOT_AVAILABLE");

          if (isServiceUnavailable) {
            logger.warn(
              "⚠️ [Home] Android: Firebase service not available. Google Play Services may be unavailable or outdated.",
              {
                errorCode,
                errorMessage: error?.message
              }
            );
            return;
          }
          throw error;
        }
      }

      if (!latestToken) {
        logger.debug("⚠️ [Home] No token available from Firebase");
        return;
      }

      logger.debug("✅ [Home] Latest token fetched from Firebase", {
        tokenType: notificationTokenType,
        tokenLength: latestToken.length,
        tokenPreview: `${latestToken.substring(
          0,
          20
        )}...${latestToken.substring(latestToken.length - 10)}`
      });

      // Check if this is the same token we already registered
      if (
        lastRegisteredToken &&
        lastRegisteredToken.token === latestToken &&
        lastRegisteredToken.tokenType === notificationTokenType
      ) {
        logger.debug("🔄 [Home] Token unchanged, skipping registration", {
          tokenType: notificationTokenType
        });
        return;
      }

      // Register only the latest token with Sendbird
      logger.debug("🔔 [Home] Registering latest token with Sendbird", {
        tokenType: notificationTokenType,
        tokenLength: latestToken.length
      });

      try {
        // Await the registration to ensure it completes successfully
        await setPushNotification(true, tokenType, latestToken);

        // Verify registration was successful by checking if Sendbird is still connected
        if (!isConnected) {
          throw new Error("Sendbird disconnected after token registration");
        }

        logger.debug(
          "✅ [Home] Token registration with Sendbird completed successfully"
        );

        // Store the registered token
        const registeredToken: NotificationToken = {
          token: latestToken,
          tokenType: notificationTokenType,
          timestamp: Date.now()
        };

        setLastRegisteredToken(registeredToken);

        // Store in Redux
        dispatch({
          type: userActions.STORE_PUSH_ID,
          payload: {
            pushToken: latestToken,
            tokenType: notificationTokenType
          }
        });

        logger.debug(
          "✅ [Home] Latest token registered successfully with Sendbird and stored",
          {
            tokenType: notificationTokenType
          }
        );

        // Reset retry counter on success
        retryAttemptsRef.current = 0;
      } catch (error: any) {
        logger.error("❌ [Home] Error registering token with Sendbird:", {
          error: error?.message || error,
          tokenType: notificationTokenType,
          errorCode: error?.code,
          attempt: retryAttemptsRef.current + 1
        });

        // Retry once on first launch if we haven't exceeded max attempts
        if (retryAttemptsRef.current < MAX_RETRY_ATTEMPTS) {
          retryAttemptsRef.current++;
          isRegisteringRef.current = false; // Reset flag before retry
          logger.debug(
            `🔄 [Home] Retrying token registration (attempt ${
              retryAttemptsRef.current + 1
            }/${MAX_RETRY_ATTEMPTS + 1})`
          );

          // Wait a bit before retrying
          await new Promise((resolve) => setTimeout(resolve, 1000));

          // Retry registration
          return registerTokens();
        }

        // Don't update lastRegisteredToken on error so we can retry later if needed
        throw error;
      }
    } catch (error: any) {
      logger.error("❌ [Home] Error in registerTokens:", {
        error: error?.message || error,
        errorCode: error?.code
      });
    } finally {
      isRegisteringRef.current = false;
    }
  }, [
    firebasePermissionGranted,
    notificationPermissionGranted,
    notificationPermissionFromHook,
    lastRegisteredToken,
    dispatch,
    setPushNotification,
    isConnected,
    isLoggedIn,
    accessToken,
    user?.id
  ]);

  useEffect(() => {
    if (shouldResetTokenRegistration) {
      logger.debug(
        "🔄 [Home] Logout detected - resetting token registration state"
      );
      setLastRegisteredToken(null);
      hasRegisteredOnFirstLaunchRef.current = false;
      isRegisteringRef.current = false;
      retryAttemptsRef.current = 0;
    }
  }, [shouldResetTokenRegistration]);

  // Only register on first launch when conditions are met
  useEffect(() => {
    // Skip if already registered on first launch
    if (hasRegisteredOnFirstLaunchRef.current) {
      return;
    }

    const hasPermission =
      firebasePermissionGranted ||
      notificationPermissionFromHook ||
      notificationPermissionGranted;

    if (
      isLoggedIn &&
      !!accessToken?.trim() &&
      !!user?.id &&
      isConnected &&
      hasPermission &&
      !lastRegisteredToken
    ) {
      logger.debug("🚀 [Home] First launch - registering token");
      hasRegisteredOnFirstLaunchRef.current = true; // Mark as registered
      void registerTokens();
    }
  }, [
    isLoggedIn,
    accessToken,
    user?.id,
    isConnected,
    firebasePermissionGranted,
    notificationPermissionGranted,
    notificationPermissionFromHook,
    lastRegisteredToken
    // Removed registerTokens from dependencies to prevent re-runs
  ]);

  useEffect(() => {
    // Skip if already registered on first launch
    if (hasRegisteredOnFirstLaunchRef.current) {
      return;
    }

    if (Platform.OS !== "android" || !hasTriedTokenRegenerationRef.current) {
      return;
    }

    const hasPermission =
      firebasePermissionGranted ||
      notificationPermissionFromHook ||
      notificationPermissionGranted;

    if (
      isLoggedIn &&
      !!accessToken?.trim() &&
      !!user?.id &&
      hasPermission &&
      isConnected &&
      !lastRegisteredToken
    ) {
      logger.debug(
        "🔔 [Home] Android: First launch - checking for token after permission grant"
      );
      void registerTokens();
    }
  }, [
    isLoggedIn,
    accessToken,
    user?.id,
    firebasePermissionGranted,
    notificationPermissionGranted,
    notificationPermissionFromHook,
    isConnected,
    lastRegisteredToken
    // Removed registerTokens from dependencies
  ]);

  useEffect(() => {
    // Skip if already registered on first launch
    if (hasRegisteredOnFirstLaunchRef.current) {
      return;
    }

    const currentPermission =
      firebasePermissionGranted ||
      notificationPermissionFromHook ||
      notificationPermissionGranted;

    const permissionJustGranted =
      !prevNotificationPermissionGranted && currentPermission;

    if (permissionJustGranted) {
      logger.debug(
        "🔔 [Home] First launch - permission just granted, registering token",
        {
          isConnected,
          hasPermission: currentPermission,
          willWaitForSendbird: !isConnected
        }
      );

      if (Platform.OS === "android" && !hasTriedTokenRegenerationRef.current) {
        hasTriedTokenRegenerationRef.current = true;

        const regenerateToken = async () => {
          try {
            logger.debug(
              "🔔 [Home] Android: Requesting latest FCM token after permission granted"
            );
            const token = await messaging().getToken();
            if (token) {
              logger.debug(
                "✅ [Home] Android: Latest FCM token obtained, registering...",
                { isConnected }
              );
              // Small delay to ensure token is fully ready
              setTimeout(() => {
                // Only mark as registered if Sendbird is connected and registration succeeds
                // Otherwise, let the retry effect handle it
                if (
                  isLoggedIn &&
                  !!accessToken?.trim() &&
                  !!user?.id &&
                  isConnected
                ) {
                  hasRegisteredOnFirstLaunchRef.current = true;
                  void registerTokens();
                } else {
                  logger.debug(
                    "⏳ [Home] Sendbird not connected yet, retry effect will handle registration"
                  );
                }
              }, 500);
            } else {
              logger.warn(
                "⚠️ [Home] Android: No token returned after permission granted"
              );
            }
          } catch (error: any) {
            const errorCode = error?.code || error?.message || "";
            const isServiceUnavailable =
              errorCode.includes("SERVICE_NOT_AVAILABLE") ||
              errorCode.includes("messaging/unknown") ||
              error?.message?.includes("SERVICE_NOT_AVAILABLE");

            if (isServiceUnavailable) {
              logger.warn(
                "⚠️ [Home] Android: Firebase service not available (Google Play Services may be unavailable or outdated). Will retry later.",
                {
                  errorCode,
                  errorMessage: error?.message
                }
              );
              hasTriedTokenRegenerationRef.current = false;
            } else {
              logger.error(
                "❌ [Home] Android: Error requesting latest token after permission granted:",
                {
                  error,
                  errorCode,
                  errorMessage: error?.message
                }
              );
            }
          }
        };

        void regenerateToken();
      } else {
        // For iOS or if Android token regeneration already tried
        if (isLoggedIn && !!accessToken?.trim() && !!user?.id && isConnected) {
          hasRegisteredOnFirstLaunchRef.current = true;
          void registerTokens();
        } else {
          logger.debug(
            "⏳ [Home] Sendbird not connected yet, retry effect will handle registration"
          );
        }
      }
    }
    setPrevNotificationPermissionGranted(currentPermission);
  }, [
    isLoggedIn,
    accessToken,
    user?.id,
    firebasePermissionGranted,
    notificationPermissionGranted,
    notificationPermissionFromHook,
    prevNotificationPermissionGranted,
    lastRegisteredToken,
    isConnected // Add isConnected to dependencies
    // Removed registerTokens from dependencies
  ]);

  // Listen for token refresh and re-register with Sendbird when token changes
  useEffect(() => {
    if (Platform.OS !== "android" || !isConnected) {
      return;
    }

    if (!isLoggedIn || !accessToken?.trim() || !user?.id) {
      return;
    }

    const hasPermission =
      firebasePermissionGranted ||
      notificationPermissionFromHook ||
      notificationPermissionGranted;

    if (!hasPermission) {
      return;
    }

    // Listen for FCM token refresh on Android
    const unsubscribe = messaging().onTokenRefresh(async (refreshedToken) => {
      if (!isLoggedIn || !accessToken?.trim() || !user?.id) {
        return;
      }

      logger.debug(
        "🔄 [Home] FCM token refreshed, re-registering with Sendbird",
        {
          tokenLength: refreshedToken.length,
          tokenPreview: `${refreshedToken.substring(
            0,
            20
          )}...${refreshedToken.substring(refreshedToken.length - 10)}`
        }
      );

      if (
        lastRegisteredToken &&
        lastRegisteredToken.token === refreshedToken &&
        lastRegisteredToken.tokenType === "android_fcm"
      ) {
        logger.debug(
          "🔄 [Home] Refreshed token is same as last registered, skipping"
        );
        return;
      }

      try {
        await setPushNotification(true, "android", refreshedToken);

        if (!isConnected) {
          throw new Error("Sendbird disconnected after token registration");
        }

        const registeredToken: NotificationToken = {
          token: refreshedToken,
          tokenType: "android_fcm",
          timestamp: Date.now()
        };

        setLastRegisteredToken(registeredToken);

        // Store in Redux
        dispatch({
          type: userActions.STORE_PUSH_ID,
          payload: {
            pushToken: refreshedToken,
            tokenType: "android_fcm"
          }
        });

        logger.debug(
          "✅ [Home] Refreshed token registered successfully with Sendbird"
        );
      } catch (error: any) {
        logger.error(
          "❌ [Home] Error registering refreshed token with Sendbird:",
          {
            error: error?.message || error,
            errorCode: error?.code
          }
        );
      }
    });

    return () => {
      unsubscribe();
    };
  }, [
    isConnected,
    isLoggedIn,
    accessToken,
    user?.id,
    firebasePermissionGranted,
    notificationPermissionGranted,
    notificationPermissionFromHook,
    lastRegisteredToken,
    setPushNotification,
    dispatch
  ]);

  // Retry token registration when Sendbird connects after initial failure
  // This handles the case where Sendbird wasn't connected when we first tried to register
  useEffect(() => {
    const hasPermission =
      firebasePermissionGranted ||
      notificationPermissionFromHook ||
      notificationPermissionGranted;

    // Retry if:
    // 1. Sendbird is connected
    // 2. We have permission
    // 3. We haven't registered a token yet
    // 4. Not currently registering (prevent concurrent calls)
    if (
      isLoggedIn &&
      !!accessToken?.trim() &&
      !!user?.id &&
      isConnected &&
      hasPermission &&
      !lastRegisteredToken &&
      !isRegisteringRef.current
    ) {
      logger.debug(
        "🔄 [Home] Sendbird connected - retrying token registration",
        {
          hasRegisteredOnFirstLaunch: hasRegisteredOnFirstLaunchRef.current,
          isConnected,
          hasPermission
        }
      );
      void registerTokens();
    }
  }, [
    isLoggedIn,
    accessToken,
    user?.id,
    isConnected,
    firebasePermissionGranted,
    notificationPermissionGranted,
    notificationPermissionFromHook,
    lastRegisteredToken
    // Removed registerTokens from dependencies to prevent multiple re-runs
  ]);

  useEffect(() => {
    if (!isConnected || !user?.tenantId) {
      return;
    }
    run(searchVal);
  }, [searchVal, run, isConnected, user?.tenantId]);

  const enrichedSmsConversations = useMemo(() => {
    if (!smsConversations || smsConversations.length === 0) {
      return smsConversations;
    }

    return smsConversations.map((conversation) => {
      // If conversation already has a name, return as is
      if (conversation.conversationName) {
        return conversation;
      }

      // Get participants (excluding the source DID)
      const participants = conversation.participants
        ?.split(",")
        .filter((p) => p !== conversation.sourceDID);

      if (!participants || participants.length === 0) {
        return conversation;
      }

      // Look up contact names for all participants
      const participantNames = participants
        .map((phoneNumber) => {
          const contactInfo = findContactByPhoneNumber(
            phoneNumber,
            personalContacts || [],
            companyContacts || [],
            directory || [],
            phoneContacts || []
          );

          // Return contact name if found, otherwise return null
          return contactInfo ? contactInfo.name : null;
        })
        .filter((name) => name !== null) as string[];

      // If we found any contact names, use them
      if (participantNames.length > 0) {
        return {
          ...conversation,
          conversationName: participantNames.join(", ")
        };
      }

      // If no contacts found, return original conversation
      return conversation;
    });
  }, [
    smsConversations,
    personalContacts,
    companyContacts,
    directory,
    phoneContacts
  ]);

  // Initial fetch of agent queues
  useEffect(() => {
    if (user?.peerName && accessToken) {
      void runAsync();
    }
  }, []);

  const [hasFetchedSms, setHasFetchedSms] = useState(false);
  useEffect(() => {
    if (accessToken && !hasFetchedSms) {
      if (smsConversations.length === 0) {
        logger.debug("Fetching conversations - no cached data");
        dispatch(textActions.fetchConversations());
      }
      if (!provisionedNumbers || provisionedNumbers.length === 0) {
        logger.debug("Fetching provisioned numbers - no cached data");
        dispatch(textActions.fetchProvisionedNumbers());
      }
      setHasFetchedSms(true);
    }
  }, [
    accessToken,
    dispatch,
    smsConversations.length,
    provisionedNumbers,
    hasFetchedSms
  ]);

  // Combined search results: Sendbird channels + enriched SMS conversations
  const combinedSearchResults = useMemo(() => {
    if (!searchVal.trim()) {
      return filteredResults;
    }

    const normalizedSearch = searchVal.toLowerCase().trim();

    // Filter enriched SMS conversations by name or phone number
    const filteredSms = (enrichedSmsConversations || []).filter(
      (conv) =>
        conv.conversationName?.toLowerCase().includes(normalizedSearch) ||
        conv.participants?.toLowerCase().includes(normalizedSearch)
    );

    console.log("🔍 Combined Search:", {
      searchQuery: normalizedSearch,
      sendbirdResults: filteredResults.length,
      smsResults: filteredSms.length,
      totalEnrichedSms: enrichedSmsConversations?.length || 0
    });

    return [...filteredResults, ...filteredSms];
  }, [searchVal, filteredResults, enrichedSmsConversations]);

  const homeScrollNativeGesture = useMemo(() => Gesture.Native(), []);

  return (
    <Screen paddingHorizontal>
      <TopBar
        title="Home"
        avatarSource={topBarAvatarSource}
        avatarName={topBarAvatarName}
      />
      <WhiteSpace height={padding.md} />
      <SearchBar
        containerStyle={homeStyles.searchBarContainer}
        placeholder="Search"
        value={searchVal}
        onChangeText={setSearchVal}
        onCancel={handleSearchCancel}
        onFocusChange={handleSearchFocusChange}
      />
      <HomeScrollGestureContext.Provider value={homeScrollNativeGesture}>
        <GestureDetector gesture={homeScrollNativeGesture}>
          <ScrollView
            showsVerticalScrollIndicator={false}
            keyboardDismissMode="on-drag"
            contentContainerStyle={homeStyles.scrollContentContainer}
          >
            {isSearchFocused ? (
              <SearchResults
                results={combinedSearchResults}
                isChannelDM={isChannelDM}
                searchVal={searchVal}
                formatDMChannel={formatDMChannel}
                formatGroupChannel={formatGroupChannel}
              />
            ) : (
              <View style={homeStyles.accordionContainer}>
                <ChannelsSection
                  channels={filteredGroupChannels as FilteredChannel[]}
                  isLoading={connecting || isChannelsLoading}
                />
                <DirectMessagesSection
                  channels={orderedDMChannels}
                  enrichedSmsConversations={enrichedSmsConversations}
                />
                <CallCenterSection
                  data={data ? { ...data, paused: !!data.paused } : data}
                  handleDNDToggle={handleDNDToggle}
                  handleRefetch={handleRefetch}
                  theme={theme}
                />
              </View>
            )}
          </ScrollView>
        </GestureDetector>
      </HomeScrollGestureContext.Provider>
    </Screen>
  );
}
