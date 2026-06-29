import { NativeModules, Platform } from "react-native";

type VoxoDtmfSidetoneNative = {
  playSidetone: (digit: string) => void;
};

/**
 * Local DTMF sidetone via AVAudioEngine on the same audio session as WebRTC (iOS only).
 * Does not replace SIP/RTP DTMF — only gives audible feedback in the earpiece/speaker path.
 */
export function playDtmfSidetoneIos(tones: string): void {
  if (Platform.OS !== "ios" || !tones?.length) {
    return;
  }
  const mod = NativeModules.VOXODtmfSidetone as
    | VoxoDtmfSidetoneNative
    | undefined;
  if (!mod?.playSidetone) {
    return;
  }
  const ch = tones[0];
  if (!/[0-9*#ABCD]/i.test(ch)) {
    return;
  }
  try {
    mod.playSidetone(ch);
  } catch {
    /* non-fatal */
  }
}
