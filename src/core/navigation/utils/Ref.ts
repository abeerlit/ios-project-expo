import {
  createNavigationContainerRef,
  CommonActions
} from "@react-navigation/native";
import { ParamListBase } from "@react-navigation/native";
import { Routes } from "../types/types.ts";

type NavigationParams = {
  [key: string]: any;
};

export const navigationRef = createNavigationContainerRef<ParamListBase>();

export function navigate(name: string, params?: NavigationParams) {
  const interval = setInterval(() => {
    if (navigationRef.isReady()) {
      navigationRef.navigate(name as keyof ParamListBase, params);
      clearInterval(interval);
    }
  }, 250);
}

// Navigate or replace.
export function navigateOrReplace(name: string, params?: NavigationParams) {
  console.log(
    "🧭 [navigateOrReplace] Navigating to:",
    name,
    "with params:",
    params
  );

  const interval = setInterval(() => {
    if (navigationRef.isReady()) {
      const currentRoute = navigationRef.getCurrentRoute();

      console.log(
        "🧭 [navigateOrReplace] Current route:",
        currentRoute?.name,
        "Current params:",
        currentRoute?.params
      );

      if (currentRoute?.name === name) {
        const currentParams = (currentRoute.params as any) || {};
        const newParams = params || {};

        const currentChannelUrl = currentParams.channelUrl;
        const newChannelUrl = newParams.channelUrl;
        const currentConversationId = currentParams.conversationId;
        const newConversationId = newParams.conversationId;

        const paramsChanged =
          (newChannelUrl && currentChannelUrl !== newChannelUrl) ||
          (newConversationId && currentConversationId !== newConversationId);

        console.log(
          "🧭 [navigateOrReplace] Already on target route. Params changed?",
          paramsChanged
        );

        if (paramsChanged) {
          const uniqueKey = `${name}-${Date.now()}-${Math.random()}`;
          console.log(
            "🧭 [navigateOrReplace] Navigating with unique key:",
            uniqueKey
          );

          navigationRef.dispatch(
            CommonActions.navigate({
              name: name as keyof ParamListBase,
              params: newParams,
              key: uniqueKey
            })
          );
        } else {
          console.log(
            "🧭 [navigateOrReplace] Params unchanged, skipping navigation"
          );
        }
      } else {
        navigationRef.dispatch(
          CommonActions.navigate({
            name: name as keyof ParamListBase,
            params
          })
        );
      }
      clearInterval(interval);
    }
  }, 250);
}

export function getCurrentRoute() {
  if (navigationRef.isReady()) {
    return navigationRef.getCurrentRoute();
  }
  return null;
}

export function goBack() {
  if (navigationRef.isReady()) {
    if (navigationRef?.canGoBack()) {
      navigationRef.goBack();
    } else {
      navigationRef.navigate(Routes.Home);
    }
  }
}
