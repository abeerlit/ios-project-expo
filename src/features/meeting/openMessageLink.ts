import { Linking } from "react-native";
import { toast } from "@backpackapp-io/react-native-toast";
import { Routes } from "core/navigation/types/types.ts";
import { isVoxoMeetUrl, normalizeMeetLinkUrl } from "features/meeting/meetJoinUtils.ts";

type MessageLinkNavigation = {
  navigate: (name: string, params?: object) => void;
};

/** Open meet.voxo.co in the in-app Meetings screen; other links in the system browser. */
export function openMessageLink(
  href: string,
  navigation: MessageLinkNavigation
): void {
  const normalized = normalizeMeetLinkUrl(href);
  if (isVoxoMeetUrl(normalized)) {
    navigation.navigate(Routes.Meetings, { meetURL: normalized });
    return;
  }
  void Linking.openURL(href).catch(() => {
    toast.error("Could not open link");
  });
}
