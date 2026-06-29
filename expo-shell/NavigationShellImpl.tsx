import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import * as SplashScreen from "expo-splash-screen";
import { BootPlaceholder } from "./BootPlaceholder.tsx";
import { toast } from "@backpackapp-io/react-native-toast";
import { GOOGLE_CLIENT_ID } from "@env";
import {
  NATIVE_TELEPHONY_ENABLED,
  NATIVE_NOTIFICATIONS_ENABLED,
  MEETINGS_NATIVE_ENABLED
} from "./runtimeFlags.ts";
import { NotificationsBootstrap } from "./NotificationsBootstrap.tsx";
import { IosCallKitBootstrap } from "./IosCallKitBootstrap.tsx";
import { debugLog } from "./debugLog";
import { BootStoreContext, type BootStoreBundle } from "./BootStoreContext";
import { getGlobalStoreBridge } from "./globalStoreBridge";
import {
  consumePendingMeetLink,
  isMeetDeepLink,
  peekPendingMeetLink,
  setPendingMeetLink
} from "./meetDeepLink.ts";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type ShellModules = {
  store: BootStoreBundle["store"];
  rehydratePromise: BootStoreBundle["rehydratePromise"];
  googleClientId: string | undefined;
  Provider: React.ComponentType<{ store: unknown; children: React.ReactNode }>;
  SafeAreaProvider: React.ComponentType<{ children: React.ReactNode }>;
  NavigationContainer: React.ComponentType<{
    children: React.ReactNode;
    ref: unknown;
    onReady: () => void;
    onStateChange: () => void;
  }>;
  QueryClientProvider: React.ComponentType<{
    client: unknown;
    children: React.ReactNode;
  }>;
  QueryClient: new () => unknown;
  GestureHandlerRootView: React.ComponentType<{
    style?: object;
    children: React.ReactNode;
  }>;
  StatusBar: React.ComponentType<{
    barStyle: "light-content" | "dark-content";
    backgroundColor: string;
    translucent: boolean;
  }>;
  Platform: { OS: string };
  useSafeAreaInsets: () => { top: number };
  Navigation: React.ComponentType<object>;
  navigationRef: {
    current: unknown;
    getCurrentRoute: () => { name?: string } | undefined;
    isReady: () => boolean;
    navigate: (name: string, params?: object) => void;
  };
  Routes: { Meetings: string };
  DrawerProvider: React.ComponentType<{ children: React.ReactNode }>;
  MeetingActiveProvider: React.ComponentType<{ children: React.ReactNode }>;
  SendbirdContextProvider: React.ComponentType<{ children: React.ReactNode }>;
  Toasts: React.ComponentType;
  useOnlineManager: () => void;
  useSelector: <T,>(fn: (s: unknown) => T) => T;
  GoogleSignin: { configure: (o: object) => void };
  userActions: { REFRESH_USER_PROFILE: string };
  SoftphoneProvider: React.ComponentType<{ children: React.ReactNode }>;
  ActiveCallBanner: React.ComponentType<{ currentRouteName?: string }>;
  ActiveMeetingBanner: React.ComponentType<{ currentRouteName?: string }>;
};

async function loadShellModules(
  storeBundle: NonNullable<React.ContextType<typeof BootStoreContext>>
): Promise<ShellModules> {
  const steps: string[] = [];
  const runStep = (name: string, fn: () => void) => {
    steps.push(name);
    debugLog("B", "NavigationShellImpl.tsx:step", "require step start", {
      step: name,
      index: steps.length
    });
    try {
      fn();
      debugLog("B", "NavigationShellImpl.tsx:step", "require step ok", { step: name });
    } catch (e) {
      debugLog("B", "NavigationShellImpl.tsx:step", "require step FAIL", {
        step: name,
        err: e instanceof Error ? e.message : String(e)
      });
      throw e;
    }
  };

  const store = storeBundle.store as ShellModules["store"];
  const rehydratePromise = storeBundle.rehydratePromise;
  debugLog("C", "NavigationShellImpl.tsx:store", "using boot bundle", {
    hasStore: !!store,
    fromBridge: !!getGlobalStoreBridge()?.store
  });
  await tick();

  let Provider: ShellModules["Provider"];
  let useSelector: ShellModules["useSelector"];
  let SafeAreaProvider: ShellModules["SafeAreaProvider"];
  let useSafeAreaInsets: ShellModules["useSafeAreaInsets"];
  let NavigationContainer: ShellModules["NavigationContainer"];
  let QueryClient: ShellModules["QueryClient"];
  let QueryClientProvider: ShellModules["QueryClientProvider"];
  let GestureHandlerRootView: ShellModules["GestureHandlerRootView"];
  let StatusBar: ShellModules["StatusBar"];
  let Platform: ShellModules["Platform"];
  let GoogleSignin: ShellModules["GoogleSignin"];
  let Toasts: ShellModules["Toasts"];
  let navigationRef: ShellModules["navigationRef"];
  let Routes: ShellModules["Routes"];
  let useOnlineManager: ShellModules["useOnlineManager"];
  let userActions: ShellModules["userActions"];
  let Navigation: ShellModules["Navigation"];
  let DrawerProvider: ShellModules["DrawerProvider"];
  let MeetingActiveProvider: ShellModules["MeetingActiveProvider"];
  let SendbirdContextProvider: ShellModules["SendbirdContextProvider"];
  let SoftphoneProvider: ShellModules["SoftphoneProvider"];
  let ActiveCallBanner: ShellModules["ActiveCallBanner"];
  let ActiveMeetingBanner: ShellModules["ActiveMeetingBanner"];

  runStep("react-redux", () => {
    ({ Provider, useSelector } = require("react-redux"));
  });
  await tick();
  runStep("safe-area", () => {
    ({ SafeAreaProvider, useSafeAreaInsets } = require("react-native-safe-area-context"));
  });
  await tick();
  runStep("navigation-native", () => {
    ({ NavigationContainer } = require("@react-navigation/native"));
  });
  await tick();
  runStep("react-query", () => {
    ({ QueryClient, QueryClientProvider } = require("@tanstack/react-query"));
  });
  await tick();
  runStep("react-native", () => {
    ({ StatusBar, Platform } = require("react-native"));
  });
  await tick();
  runStep("gesture-handler", () => {
    ({ GestureHandlerRootView } = require("react-native-gesture-handler"));
  });
  await tick();
  runStep("google-signin", () => {
    ({ GoogleSignin } = require("@react-native-google-signin/google-signin"));
  });
  await tick();
  runStep("toasts", () => {
    ({ Toasts } = require("@backpackapp-io/react-native-toast"));
  });
  await tick();
  runStep("navigationRef", () => {
    ({ navigationRef } = require("core/navigation/utils/Ref.ts"));
  });
  await tick();
  runStep("Routes", () => {
    ({ Routes } = require("core/navigation/types/types.ts"));
  });
  await tick();
  runStep("useOnlineManager", () => {
    ({ useOnlineManager } = require("hooks/use-online-manager.ts"));
    userActions = require("store/users/actions.ts");
  });
  await tick();

  runStep("Navigation.tsx", () => {
    const navMod = require("core/navigation/Navigation.tsx") as {
      Navigation?: ShellModules["Navigation"];
      default?: ShellModules["Navigation"];
    };
    Navigation = navMod.Navigation ?? navMod.default;
    if (Navigation == null) {
      debugLog("B", "NavigationShellImpl.tsx", "Navigation module keys", {
        keys: Object.keys(navMod ?? {})
      });
      throw new Error("Navigation export missing from core/navigation/Navigation.tsx");
    }
  });
  await tick();
  runStep("DrawerProvider", () => {
    ({ DrawerProvider } = require("core/drawer/DrawerProvider.tsx"));
  });
  await tick();
  runStep("MeetingActiveProvider", () => {
    ({ MeetingActiveProvider } = require("features/meeting/MeetingActiveContext.tsx"));
  });
  await tick();
  runStep("SendbirdContextProvider", () => {
    const sendbirdMod = require("features/chat/utils/SendbirdContextProvider.tsx") as {
      SendbirdContextProvider?: ShellModules["SendbirdContextProvider"];
      default?: ShellModules["SendbirdContextProvider"];
    };
    SendbirdContextProvider =
      sendbirdMod.SendbirdContextProvider ?? sendbirdMod.default;
    if (SendbirdContextProvider == null) {
      throw new Error("SendbirdContextProvider export missing");
    }
  });
  await tick();

  runStep("SoftphoneProvider", () => {
    SoftphoneProvider = NATIVE_TELEPHONY_ENABLED
      ? require("core/softphone/SoftphoneProvider.tsx").SoftphoneProvider
      : ({ children }: { children: React.ReactNode }) => <>{children}</>;
  });

  runStep("ActiveCallBanner", () => {
    ActiveCallBanner = NATIVE_TELEPHONY_ENABLED
      ? require("features/calling/components/ActiveCallBanner.tsx").ActiveCallBanner
      : () => null;
  });

  runStep("ActiveMeetingBanner", () => {
    if (!MEETINGS_NATIVE_ENABLED) {
      ActiveMeetingBanner = () => null;
      return;
    }
    const mod = require("features/calling/components/ActiveMeetingBanner.tsx") as {
      ActiveMeetingBanner?: ShellModules["ActiveMeetingBanner"];
      default?: ShellModules["ActiveMeetingBanner"];
    };
    ActiveMeetingBanner =
      mod.ActiveMeetingBanner ?? mod.default ?? (() => null);
  });

  return {
    store,
    rehydratePromise,
    googleClientId: GOOGLE_CLIENT_ID as string | undefined,
    Provider,
    SafeAreaProvider,
    NavigationContainer,
    QueryClientProvider,
    QueryClient,
    GestureHandlerRootView,
    StatusBar,
    Platform,
    useSafeAreaInsets,
    Navigation,
    navigationRef,
    Routes,
    DrawerProvider,
    MeetingActiveProvider,
    SendbirdContextProvider,
    Toasts,
    useOnlineManager,
    useSelector,
    GoogleSignin,
    userActions,
    SoftphoneProvider,
    ActiveCallBanner,
    ActiveMeetingBanner
  };
}

function ShellApp({ M }: { M: ShellModules }) {
  return (
    <M.Provider store={M.store}>
      <ShellAppInner M={M} />
    </M.Provider>
  );
}

function ShellAppInner({ M }: { M: ShellModules }) {
  debugLog("D", "NavigationShellImpl.tsx:ShellAppInner", "render", {
    hasStore: !!M?.store,
    hasNavigation: !!M?.Navigation
  });
  const insets = M.useSafeAreaInsets();
  const [currentRouteName, setCurrentRouteName] = useState<string>();
  const lastHandledMeetURL = useRef<string | null>(null);
  const isMeetingsRoute = currentRouteName === M.Routes.Meetings;
  const openMeetingScreen = useCallback(
    (meetURL: string): boolean => {
      if (!M.navigationRef.isReady()) return false;
      M.navigationRef.navigate(M.Routes.Meetings, { meetURL });
      return true;
    },
    [M]
  );
  const isLoggedIn = M.useSelector(
    (s: { authReducer: { isLoggedIn: boolean } }) => s.authReducer.isLoggedIn
  );
  const accessToken = M.useSelector(
    (s: { authReducer: { accessToken?: string } }) => s.authReducer.accessToken
  );
  const notificationsBootstrapReady =
    isLoggedIn && !!accessToken?.trim();
  M.useOnlineManager();
  const queryClient = useMemo(() => new M.QueryClient(), [M]);

  // Bind native notification tap listeners as soon as the shell mounts (before login gate).
  useEffect(() => {
    if (!NATIVE_NOTIFICATIONS_ENABLED || M.Platform.OS !== "ios") {
      return;
    }
    void import("core/notifications/NotificationManager.ts").then(
      ({ default: NotificationManager }) => {
        NotificationManager.ensureIosNativeListeners();
      }
    );
  }, [M]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await M.rehydratePromise;
      if (cancelled) return;
      if (NATIVE_NOTIFICATIONS_ENABLED && M.Platform.OS === "ios") {
        const { default: NotificationManager } = await import(
          "core/notifications/NotificationManager.ts"
        );
        NotificationManager.ensureIosNativeListeners();
      }
      const { authReducer } = M.store.getState();
      if (authReducer.isLoggedIn && authReducer.accessToken?.trim()) {
        M.store.dispatch({ type: M.userActions.REFRESH_USER_PROFILE });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [M]);

  useEffect(() => {
    const handleDeepLink = (url: string | null) => {
      if (!url || !isMeetDeepLink(url)) return;
      if (lastHandledMeetURL.current === url) return;
      lastHandledMeetURL.current = url;
      setPendingMeetLink(url);
      openMeetingScreen(url);
      toast.success("Meeting link opened in app");
    };

    void Linking.getInitialURL().then((url) => handleDeepLink(url));
    const subscription = Linking.addEventListener("url", ({ url }) =>
      handleDeepLink(url)
    );
    return () => subscription.remove();
  }, [M, openMeetingScreen]);

  useEffect(() => {
    if (!M.navigationRef.isReady()) return;
    const pending = peekPendingMeetLink();
    if (!pending?.url) return;
    if (openMeetingScreen(pending.url)) {
      consumePendingMeetLink();
    }
  }, [M, currentRouteName, openMeetingScreen]);

  const onNavChange = useCallback(() => {
    if (__DEV__) {
      const name = M.navigationRef.getCurrentRoute()?.name;
      if (name) console.log("[Navigation]", name);
    }
    setCurrentRouteName(M.navigationRef.getCurrentRoute()?.name);
  }, [M]);

  const onNavReady = useCallback(() => {
    onNavChange();
    if (NATIVE_NOTIFICATIONS_ENABLED && M.Platform.OS === "ios") {
      void import("core/notifications/NotificationManager.ts").then(
        ({ default: NotificationManager }) => {
          NotificationManager.ensureIosNativeListeners();
        }
      );
    }
  }, [M, onNavChange]);

  const mainView = (
    <View
      style={{
        flex: 1,
        backgroundColor: isMeetingsRoute ? "#131314" : "white",
        paddingTop: M.Platform.OS === "android" ? 0 : insets.top
      }}
    >
      {NATIVE_TELEPHONY_ENABLED ? (
        <M.ActiveCallBanner currentRouteName={currentRouteName} />
      ) : null}
      {MEETINGS_NATIVE_ENABLED ? (
        <M.ActiveMeetingBanner currentRouteName={currentRouteName} />
      ) : null}
      <M.Navigation />
    </View>
  );

  const shell = NATIVE_TELEPHONY_ENABLED ? (
    <>
      <IosCallKitBootstrap useSelector={M.useSelector} />
      <M.SoftphoneProvider>
        <M.DrawerProvider>
          <M.MeetingActiveProvider>{mainView}</M.MeetingActiveProvider>
        </M.DrawerProvider>
      </M.SoftphoneProvider>
    </>
  ) : (
    <M.DrawerProvider>
      <M.MeetingActiveProvider>{mainView}</M.MeetingActiveProvider>
    </M.DrawerProvider>
  );

  return (
    <M.NavigationContainer
      ref={M.navigationRef as never}
      onReady={onNavReady}
      onStateChange={onNavChange}
    >
      <M.QueryClientProvider client={queryClient}>
        <M.GestureHandlerRootView style={{ flex: 1 }}>
          <M.StatusBar
            barStyle={isMeetingsRoute ? "light-content" : "dark-content"}
            backgroundColor={isMeetingsRoute ? "#131314" : "white"}
            translucent={false}
          />
          <M.SendbirdContextProvider>
            {NATIVE_NOTIFICATIONS_ENABLED && notificationsBootstrapReady ? (
              <NotificationsBootstrap />
            ) : null}
            {shell}
          </M.SendbirdContextProvider>
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
            <M.Toasts />
          </View>
        </M.GestureHandlerRootView>
      </M.QueryClientProvider>
    </M.NavigationContainer>
  );
}

export default function NavigationShellImpl() {
  const storeBundle = useContext(BootStoreContext);
  const [M, setM] = useState<ShellModules | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeBundle?.store) {
      debugLog("C", "NavigationShellImpl.tsx", "waiting for BootStoreContext", {});
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const mods = await loadShellModules(storeBundle);
        if (!cancelled) {
          setM(mods);
          void SplashScreen.hideAsync();
        }
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          debugLog("A", "NavigationShellImpl.tsx:load", "loadShellModules failed", {
            err: msg,
            stack: e instanceof Error ? e.stack?.slice(0, 400) : undefined
          });
          setError(msg);
          void SplashScreen.hideAsync();
          console.error("[NavigationShellImpl] load failed", e);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeBundle]);

  if (error) {
    return (
      <View style={styles.errorRoot}>
        <Text style={styles.errorTitle}>Navigation failed to load</Text>
        <Text style={styles.errorMsg}>{error}</Text>
      </View>
    );
  }

  if (!storeBundle?.store || !M) {
    return <BootPlaceholder />;
  }

  const { SafeAreaProvider } = M;
  return (
    <SafeAreaProvider>
      <ShellApp M={M} />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  errorRoot: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#FFFFFF"
  },
  errorTitle: { fontSize: 18, fontWeight: "600", color: "#FCA5A5" },
  errorMsg: { fontSize: 13, color: "#E4E4E7", marginTop: 8 },
  devRoute: {
    position: "absolute",
    bottom: 8,
    left: 8,
    right: 8,
    alignItems: "center",
    zIndex: 10000
  },
  devRouteText: {
    fontSize: 11,
    color: "#18181B",
    backgroundColor: "rgba(255,255,255,0.95)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4
  }
});
