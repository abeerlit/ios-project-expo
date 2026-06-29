/**
 * Stable keys for SMS (TEXT-RECEIVED) pushes so duplicate iOS deliveries
 * (FCM onMessage + native willPresent, or double native forwards) do not
 * double Notifee banners or Redux unread increments.
 *
 * For TEXT-RECEIVED we prefer reference_id + normalized body so the same logical
 * message matches whether it arrived via Firebase (stable messageId) or APNs
 * (synthetic apns-* ids).
 */

function normalizeSmsBody(remoteMessage: {
  data?: Record<string, unknown>;
  notification?: { title?: string; body?: string };
}): string {
  const data = remoteMessage.data || {};
  return String(
    remoteMessage.notification?.body ??
      data.body ??
      data.message ??
      data.text ??
      ""
  )
    .slice(0, 256)
    .trim();
}

function mediaFingerprint(data: Record<string, unknown>): string {
  const mediaRaw = data.mediaUrls ?? data.media_urls;
  if (typeof mediaRaw === "string") {
    return mediaRaw.slice(0, 160);
  }
  if (Array.isArray(mediaRaw)) {
    return mediaRaw.join(",").slice(0, 160);
  }
  return "";
}

export function getSmsLogicalDedupeKey(remoteMessage: {
  data?: Record<string, unknown>;
  notification?: { title?: string; body?: string };
  messageId?: string;
}): string | undefined {
  const data = remoteMessage.data || {};

  const isSmsThread =
    data.click_action === "TEXT-RECEIVED" ||
    (!!data.reference_id && !data.channelUrl && !data.sendbird) ||
    (!!(data.conversationId || data.conversation_id) &&
      !data.channelUrl &&
      !data.sendbird);

  if (!isSmsThread) {
    return undefined;
  }

  const ref = String(
    data.reference_id ?? data.conversationId ?? data.conversation_id ?? ""
  ).trim();

  // Primary: same conversation + same visible body (or media) for TEXT-RECEIVED
  if (data.click_action === "TEXT-RECEIVED" && ref.length > 0) {
    const body = normalizeSmsBody(remoteMessage);
    const mediaPart = mediaFingerprint(data);
    return `sms-ref-${ref}-${body || mediaPart || "empty"}`;
  }

  const gcm =
    (data["gcm.message_id"] as string | undefined) ||
    (data["google.message_id"] as string | undefined);
  if (typeof gcm === "string" && gcm.length > 0) {
    return `sms-gcm-${gcm}`;
  }

  const mid = remoteMessage.messageId;
  if (typeof mid === "string" && mid.length > 0 && !mid.startsWith("apns-")) {
    return `sms-msg-${mid}`;
  }

  if (ref.length > 0) {
    const body = normalizeSmsBody(remoteMessage);
    const mediaPart = mediaFingerprint(data);
    return `sms-ref-${ref}-${body || mediaPart || "empty"}`;
  }

  return undefined;
}
