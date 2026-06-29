/**
 * Normalize iOS APNs userInfo / Notifee tap payloads into the shape handleNotificationPress expects.
 */
export function normalizeNotificationPressPayload(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const payload = raw as Record<string, unknown>;
  const notifeeBlock = payload.__notifee_notification as
    | Record<string, unknown>
    | undefined;
  const notifeeData =
    notifeeBlock?.data &&
    typeof notifeeBlock.data === "object" &&
    !Array.isArray(notifeeBlock.data)
      ? (notifeeBlock.data as Record<string, unknown>)
      : {};

  const data: Record<string, unknown> = {};
  const nested = payload.data;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    Object.assign(data, nested as Record<string, unknown>);
  }

  const topKeys = [
    "sendbird",
    "click_action",
    "clickAction",
    "channelUrl",
    "messageId",
    "parentMessageId",
    "parent_message_id",
    "reference_id",
    "referenceId",
    "conversationId",
    "conversation_id"
  ] as const;

  for (const key of topKeys) {
    const value = payload[key];
    if (value !== undefined && value !== null) {
      data[key] = value;
    }
  }

  Object.assign(data, notifeeData);

  const channelUrl =
    (data.channelUrl as string | undefined) ??
    (payload.channelUrl as string | undefined) ??
    (notifeeData.channelUrl as string | undefined);

  const click_action =
    (data.click_action as string | undefined) ??
    (payload.click_action as string | undefined) ??
    (notifeeData.click_action as string | undefined) ??
    (data.clickAction as string | undefined) ??
    (payload.clickAction as string | undefined);

  if (channelUrl) {
    data.channelUrl = channelUrl;
  }
  if (click_action) {
    data.click_action = click_action;
  }

  return {
    ...payload,
    ...data,
    data,
    ...(channelUrl ? { channelUrl } : {}),
    ...(click_action ? { click_action } : {}),
    title:
      (payload.title as string | undefined) ??
      (notifeeBlock?.title as string | undefined),
    body:
      (payload.body as string | undefined) ??
      (notifeeBlock?.body as string | undefined)
  };
}

export function extractSendbirdChannelUrlFromPressPayload(
  payload: Record<string, unknown>
): string | undefined {
  const data =
    payload.data &&
    typeof payload.data === "object" &&
    !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : undefined;

  const channelUrl = payload.channelUrl ?? data?.channelUrl;
  if (typeof channelUrl === "string" && channelUrl.length > 0) {
    return channelUrl;
  }

  const sendbirdValue = payload.sendbird ?? data?.sendbird;
  if (!sendbirdValue) {
    return undefined;
  }

  let sendbirdData: Record<string, unknown> | null = null;
  try {
    sendbirdData =
      typeof sendbirdValue === "string"
        ? (JSON.parse(sendbirdValue) as Record<string, unknown>)
        : (sendbirdValue as Record<string, unknown>);
  } catch {
    return undefined;
  }

  const channel = sendbirdData.channel as Record<string, unknown> | undefined;
  const nested = channel?.channel_url;
  if (typeof nested === "string" && nested.length > 0) {
    return nested;
  }
  const flat = sendbirdData.channel_url ?? sendbirdData.channelUrl;
  if (typeof flat === "string" && flat.length > 0) {
    return flat;
  }
  return undefined;
}
