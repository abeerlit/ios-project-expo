import type { DailyParticipant } from "@daily-co/react-native-daily-js";
import type { MediaStreamTrack } from "@daily-co/react-native-webrtc";

/** Raised hand from `userData.hr` (same as web / participants list). */
export const participantHandRaised = (p: DailyParticipant | undefined): boolean =>
  !!(p?.userData as Record<string, unknown> | undefined)?.hr;

/** Display initials when camera is off (multi-word: first letter of up to 3 words). */
export const initialsFromUserName = (raw: string): string => {
  const name = raw.trim();
  if (!name) return "?";
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return words
      .slice(0, 3)
      .map((w) => (w[0] ? w[0].toUpperCase() : ""))
      .join("");
  }
  return name.slice(0, 2).toUpperCase();
};

export const trackMediaLive = (
  track:
    | DailyParticipant["tracks"]["video"]
    | DailyParticipant["tracks"]["audio"]
    | undefined
): boolean => {
  if (!track) return false;
  const { state } = track;
  return (
    state === "playable" ||
    state === "loading" ||
    state === "sendable" ||
    state === "interrupted"
  );
};

/**
 * For screenVideo, Daily exposes both `track` and `persistentTrack`. Non-playable states
 * historically preferred `persistentTrack` first (Safari); on Android after remote stop,
 * that reference can be ended while the other is still live briefly — the layout gate
 * (which used `track ?? persistent` for liveness) stayed true but `DailyMediaView` got
 * a dead track and rendered an empty main stage. Prefer whichever is still `live`.
 */
function preferLiveScreenMediaTrack(
  a: MediaStreamTrack | undefined | null,
  b: MediaStreamTrack | undefined | null
): MediaStreamTrack | null {
  if (a?.readyState === "live") return a;
  if (b?.readyState === "live") return b;
  return null;
}

/**
 * MediaStream for DailyMediaView: prefer guaranteed-playable `track`, but when Daily
 * reports `loading` / `interrupted` / `sendable`, `persistentTrack` may still be set
 * (see DailyTrackState in daily-js types). Android often hits those after brief
 * background/foreground; only accepting `playable` made local tiles vanish.
 */
export const getPlayableTrack = (
  t: DailyParticipant["tracks"]["video"] | DailyParticipant["tracks"]["audio"] | undefined
): MediaStreamTrack | null => {
  if (!t || !trackMediaLive(t)) return null;
  if (t.state === "playable") {
    return t.track ?? t.persistentTrack ?? null;
  }
  return t.persistentTrack ?? t.track ?? null;
};

export const getVideoTrackForTile = (
  participant: DailyParticipant
): MediaStreamTrack | null => {
  const screen = participant.tracks?.screenVideo;
  if (screen && trackMediaLive(screen)) {
    return preferLiveScreenMediaTrack(screen.track, screen.persistentTrack);
  }
  return getPlayableTrack(participant.tracks?.video);
};

export const getScreenShareTrack = (
  participant: DailyParticipant | undefined
): MediaStreamTrack | null => {
  if (!participant) return null;
  const screen = participant.tracks?.screenVideo;
  if (!screen || !trackMediaLive(screen)) return null;
  return preferLiveScreenMediaTrack(screen.track, screen.persistentTrack);
};

/**
 * Whether the UI should keep the "remote screen share main stage" layout open.
 * Uses the same track selection as {@link getScreenShareTrack} so we never leave the
 * split layout mounted without a live screen {@link MediaStreamTrack} to render.
 */
export const hasRemoteScreenShareForLayout = (p: DailyParticipant): boolean => {
  if (p.local) return false;
  const sv = p.tracks?.screenVideo;
  if (!sv || sv.state === "off" || sv.state === "blocked") return false;
  if (p.screen === false) return false;

  if (getScreenShareTrack(p) == null) return false;

  if (sv.state === "interrupted") {
    return p.screen === true;
  }
  if (sv.state === "loading" || sv.state === "sendable") {
    return p.screen === true;
  }
  return true;
};

export const getCameraTrackForTile = (
  participant: DailyParticipant
): MediaStreamTrack | null => {
  return getPlayableTrack(participant.tracks?.video);
};

export const getAudioTrackForTile = (
  participant: DailyParticipant
): MediaStreamTrack | null => {
  return getPlayableTrack(participant.tracks?.audio);
};
