import React, { useEffect, useRef, useState } from "react";
import { Linking, LogBox, NativeModules, Platform, StatusBar, View } from "react-native";
import { Provider, useSelector } from "react-redux";
import * as Sentry from "@sentry/react-native";
import ConfigureStore, { rehydratePromise } from "store/global-store.ts";
import * as userActions from "store/users/actions.ts";
import { useOnlineManager } from "hooks/use-online-manager.ts";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Toasts } from "@backpackapp-io/react-native-toast";
import { toast } from "@backpackapp-io/react-native-toast";
import { Navigation } from "core/navigation/Navigation.tsx";
import { navigationRef } from "core/navigation/utils/Ref.ts";
import { Routes } from "core/navigation/types/types.ts";
import { DrawerProvider } from "core/drawer/DrawerProvider.tsx";
import { SendbirdContextProvider } from "features/chat/utils/SendbirdContextProvider.tsx";
import { SoftphoneProvider } from "core/softphone/SoftphoneProvider.tsx";
import { setupWebRTCPolyfill } from "core/softphone/webrtc-polyfill";
import { USE_VOXO_MOBILE_APPROACH } from "@core/config/callApproach";
import { getAppDisplayName } from "shared/branding/appBrand.ts";
import {
  installRecentsEarlyCapture,
  primeIosCallKitModule
} from "core/softphone/iosRecentsEarly.ts";
import { ActiveCallBanner } from "features/calling/components/ActiveCallBanner.tsx";
import { ActiveMeetingBanner } from "features/calling/components/ActiveMeetingBanner.tsx";
import { MeetingActiveProvider } from "features/meeting/MeetingActiveContext.tsx";
import NotificationManager from "core/notifications/NotificationManager.ts";
import { syncChatNotificationPrefsToNative } from "core/notifications/iosChatNotificationPrefsCache.ts";
import { State } from "store/types.ts";

setupWebRTCPolyfill();

/** Keeps iOS UserDefaults in sync with Redux for PushKit / CallKit when user disables background incoming calls. */
function IosEnableMobileCallNotificationsSync() {
  const user = useSelector((s: State) => s.userReducer.user);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const mod = NativeModules.VoxoNotificationsModule as
      | { setEnableMobileCallNotifications?: (enabled: boolean) => void }
      | undefined;
    if (!mod?.setEnableMobileCallNotifications) return;
    const enabled = !user || user.enableMobileCallNotifications !== 0;
    mod.setEnableMobileCallNotifications(enabled);
  }, [user?.id, user?.enableMobileCallNotifications]);
  return null;
}

/** Keeps App Group chat notification prefs in sync for NSE (background/killed Sendbird pushes). */
function IosChatNotificationPrefsSync() {
  const user = useSelector((s: State) => s.userReducer.user);
  useEffect(() => {
    if (Platform.OS !== "ios" || !user?.tenantId) return;
    syncChatNotificationPrefsToNative(user);
  }, [
    user?.id,
    user?.tenantId,
    user?.enableChatNotifications,
    user?.enableAllNewMessageNotifications,
    user?.enableDirectMessageNotifications
  ]);
  return null;
}

// ====== REDUX STORE SETUP ====== //
// persistor
const { store } = ConfigureStore();

// Add basic navigation breadcrumbs
const addNavigationBreadcrumb = () => {
  const currentRouteName = navigationRef.current?.getCurrentRoute()?.name;
  if (currentRouteName) {
    Sentry.addBreadcrumb({
      category: "navigation",
      message: `Navigated to ${currentRouteName}`,
      data: { routeName: currentRouteName }
    });
  }
};

LogBox.ignoreLogs([
  "Saw setTimeout with duration 300000ms",
  "`new NativeEventEmitter()` was called",
  "EventEmitter.",
  "Require cycle: node_modules",
  "Error evaluating injectedJavaScript"
]);

const MEET_HOST = "meet.voxo.co";

const extractMeetTokenFromURL = (url: string): string | null => {
  const query = url.split("?")[1] ?? "";
  if (!query) return null;

  // Supports key-only links like https://meet.voxo.co/?abc-123
  if (!query.includes("=")) {
    const token = decodeURIComponent(query.split("&")[0] ?? "").trim();
    return token || null;
  }

  // Supports normal query params like ?token=abc-123
  const params = new URLSearchParams(query);
  const knownTokenKeys = ["token", "room", "roomId", "id", "t"];
  for (const key of knownTokenKeys) {
    const value = params.get(key);
    if (value?.trim()) return value.trim();
  }

  // Fallback: first non-empty param value
  for (const [, value] of params.entries()) {
    if (value?.trim()) return value.trim();
  }

  return null;
};


function AppContent() {
  const insets = useSafeAreaInsets();
  const [currentRouteName, setCurrentRouteName] = useState<string>();
  const isMeetingsRoute = currentRouteName === Routes.Meetings;
  const lastHandledMeetURL = useRef<string | null>(null);
  useOnlineManager();
  const queryClient = new QueryClient();
  const openMeetingScreen = (meetURL: string): boolean => {
    if (!navigationRef.isReady()) return false;
    navigationRef.navigate(Routes.Meetings as never, { meetURL } as never);
    return true;
  };

  // After persisted Redux loads, refresh user from server (dnd, avatar, etc.) — matches web jwt/bootstrap.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await rehydratePromise;
      if (cancelled) return;
      const { authReducer } = store.getState();
      if (authReducer.isLoggedIn && authReducer.accessToken?.trim()) {
        store.dispatch({ type: userActions.REFRESH_USER_PROFILE });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleNavigationStateChange = () => {
    addNavigationBreadcrumb();
    const routeName = navigationRef.getCurrentRoute()?.name;
    setCurrentRouteName(routeName);
  };

  // Sync USE_VOXO_MOBILE_APPROACH to native so AppDelegate knows whether to report CallKit in foreground
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const mod = NativeModules.VoxoNotificationsModule;
    if (mod?.setUseVoxoMobileCallApproach) {
      mod.setUseVoxoMobileCallApproach(USE_VOXO_MOBILE_APPROACH);
    }
  }, []);

  // Bind iOS native notification listeners as early as possible (before Home mounts).
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    NotificationManager.ensureIosNativeListeners();
  }, []);

  /** Redundant with index.js bootstrap; idempotent — killed-state Recents if Entry loads before index path. */
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    void (async () => {
      try {
        await primeIosCallKitModule(getAppDisplayName());
        installRecentsEarlyCapture();
      } catch (e) {
        console.warn("[Entrypoint] iOS CallKit early prime failed:", e);
      }
    })();
  }, []);

  // Handle iOS universal links for meet.voxo.co (cold and warm start)
  useEffect(() => {
    const handleDeepLink = (url: string | null, source: "initial" | "runtime") => {
      if (!url) return;
      if (!url.includes(MEET_HOST)) return;
      if (lastHandledMeetURL.current === url) return;
      lastHandledMeetURL.current = url;

      const token = extractMeetTokenFromURL(url);
      (global as any).__VOXO_PENDING_MEET_LINK__ = { url, token };

      Sentry.addBreadcrumb({
        category: "deep-link",
        message: `Handled meet universal link (${source})`,
        data: { url, token }
      });

      const opened = openMeetingScreen(url);
      if (!opened) {
        // Navigation may not be mounted yet (cold start); pending link is retried below.
      }
      toast.success("Meeting link opened in app");
    };

    void Linking.getInitialURL().then((url) => handleDeepLink(url, "initial"));
    const subscription = Linking.addEventListener("url", ({ url }) =>
      handleDeepLink(url, "runtime")
    );

    return () => {
      subscription.remove();
    };
  }, []);

  // Retry pending meet links once navigation is ready.
  useEffect(() => {
    if (!navigationRef.isReady()) return;

    const pending = (global as any).__VOXO_PENDING_MEET_LINK__;
    if (!pending?.url) return;

    if (openMeetingScreen(pending.url)) {
      delete (global as any).__VOXO_PENDING_MEET_LINK__;
    }
  }, [currentRouteName]);

  return (
    <Provider store={store}>
      <IosEnableMobileCallNotificationsSync />
      <IosChatNotificationPrefsSync />
      <NavigationContainer
        ref={navigationRef}
        onReady={handleNavigationStateChange}
        onStateChange={handleNavigationStateChange}
      >
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <StatusBar 
              barStyle={isMeetingsRoute ? "light-content" : "dark-content"}
              backgroundColor={isMeetingsRoute ? "#131314" : "white"}
              translucent={false}
            />
            <SendbirdContextProvider>
              <SoftphoneProvider>
                <DrawerProvider>
                  <MeetingActiveProvider>
                    <View
                      style={{
                        flex: 1,
                        backgroundColor: isMeetingsRoute ? "#131314" : "white",
                        paddingTop: Platform.OS === "android" ? 0 : insets.top
                      }}
                    >
                      <ActiveCallBanner currentRouteName={currentRouteName} />
                      <ActiveMeetingBanner currentRouteName={currentRouteName} />
                      <Navigation />
                    </View>
                  </MeetingActiveProvider>
                </DrawerProvider>
              </SoftphoneProvider>
            </SendbirdContextProvider>
            <View
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 9999,
                pointerEvents: "box-none"
              }}
            >
              <Toasts />
            </View>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </NavigationContainer>
    </Provider>
  );
}

function Entrypoint() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

export default Entrypoint;
