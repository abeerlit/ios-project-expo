import { GroupChannel } from "@sendbird/chat/groupChannel";
import { PushTriggerOption } from "@sendbird/chat";
import { CustomChannelType } from "features/chat/types.ts";

export type SendbirdNotificationUserPrefs = {
  enableChatNotifications?: 0 | 1 | null;
  enableAllNewMessageNotifications?: 0 | 1 | null;
  enableDirectMessageNotifications?: 0 | 1 | null;
  tenantId?: number | null;
};

export type SendbirdPushPrefsPayload = {
  enableChatNotifications: 0 | 1;
  enableAllNewMessageNotifications: 0 | 1;
  enableDirectMessageNotifications: 0 | 1;
  tenantId: number;
};

export function isGroupChannelCustomType(
  customType: string | undefined,
  tenantId: number | null | undefined
): boolean {
  if (!tenantId || !customType) {
    return false;
  }
  return customType === CustomChannelType.groupChannel(tenantId);
}

export function isDmChannelCustomType(
  customType: string | undefined,
  tenantId: number | null | undefined
): boolean {
  if (!tenantId || !customType) {
    return false;
  }
  return (
    customType === CustomChannelType.dmChannel(tenantId) ||
    customType === CustomChannelType.personalChannel(tenantId)
  );
}

/**
 * Whether a Sendbird banner should be shown for this channel given user prefs.
 */
export function shouldShowSendbirdNotification(
  customType: string | undefined,
  user: SendbirdNotificationUserPrefs | null | undefined
): boolean {
  if (!user) {
    return false;
  }

  const chatEnabled = user.enableChatNotifications === 1;
  const allNewMessagesEnabled = user.enableAllNewMessageNotifications === 1;
  const directOnlyEnabled = user.enableDirectMessageNotifications === 1;

  if (!chatEnabled) {
    return false;
  }

  if (directOnlyEnabled) {
    return isDmChannelCustomType(customType, user.tenantId);
  }

  if (!allNewMessagesEnabled) {
    return false;
  }

  return true;
}

export function shouldShowSendbirdNotificationForChannel(
  channel: Pick<GroupChannel, "customType">,
  user: SendbirdNotificationUserPrefs | null | undefined
): boolean {
  return shouldShowSendbirdNotification(channel.customType, user);
}

/** Push trigger for a single channel from current user prefs. */
export function pushTriggerForChannel(
  customType: string | undefined,
  user: SendbirdNotificationUserPrefs | null | undefined
): PushTriggerOption {
  return shouldShowSendbirdNotification(customType, user)
    ? PushTriggerOption.ALL
    : PushTriggerOption.OFF;
}

export function getSendbirdNotificationPrefsSignature(
  user: SendbirdNotificationUserPrefs | null | undefined
): string | null {
  if (!user?.tenantId) {
    return null;
  }
  return [
    user.tenantId,
    user.enableChatNotifications ?? 0,
    user.enableAllNewMessageNotifications ?? 0,
    user.enableDirectMessageNotifications ?? 0
  ].join(":");
}

type PushTriggerChannel = Pick<
  GroupChannel,
  "customType" | "url" | "myPushTriggerOption"
> & {
  setMyPushTriggerOption?: GroupChannel["setMyPushTriggerOption"];
};

/**
 * Channels that need a Sendbird push-trigger API call for the current prefs.
 */
export function getChannelsNeedingPushTriggerApply(
  channelList: PushTriggerChannel[],
  user: SendbirdNotificationUserPrefs | null | undefined
): PushTriggerChannel[] {
  if (!user?.tenantId) {
    return [];
  }

  const chatEnabled = user.enableChatNotifications === 1;
  const directOnlyEnabled = user.enableDirectMessageNotifications === 1;

  return channelList.filter((channel) => {
    if (
      !channel?.url ||
      typeof channel.setMyPushTriggerOption !== "function"
    ) {
      return false;
    }

    const desiredOption = pushTriggerForChannel(channel.customType, user);
    if (channel.myPushTriggerOption === desiredOption) {
      return false;
    }

    if (!chatEnabled || directOnlyEnabled) {
      return true;
    }

    // All-new messages: reconcile both group channels and DMs.
    return (
      isGroupChannelCustomType(channel.customType, user.tenantId) ||
      isDmChannelCustomType(channel.customType, user.tenantId)
    );
  });
}

export function toSendbirdPushPrefsPayload(
  user: SendbirdNotificationUserPrefs | null | undefined
): SendbirdPushPrefsPayload | null {
  if (!user?.tenantId) {
    return null;
  }
  return {
    enableChatNotifications: user.enableChatNotifications === 1 ? 1 : 0,
    enableAllNewMessageNotifications:
      user.enableAllNewMessageNotifications === 1 ? 1 : 0,
    enableDirectMessageNotifications:
      user.enableDirectMessageNotifications === 1 ? 1 : 0,
    tenantId: user.tenantId
  };
}
