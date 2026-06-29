import { store } from "../../store/global-store";
import { State } from "store/types.ts";
import { SipClientSettings } from "./jssip/SlimSipClient";

export function buildSlimSipSettings(
  callUuid: string,
  direction: "inbound" | "outbound"
): SipClientSettings | null {
  const globalState = store.getState() as unknown as State;
  const { authReducer, userReducer } = globalState;

  if (!authReducer.isLoggedIn || !userReducer.user) {
    return null;
  }

  return {
    routeOptions: {
      direction,
      callUuid
    },
    pcConfig: {
      bundlePolicy: "max-compat",
      iceServers: [
        {
          urls: [
            "stun:stun.l.google.com:19302",
            "stun:stun1.l.google.com:19302",
            "stun:stun2.l.google.com:19302",
            "stun:stun3.l.google.com:19302",
            "stun:stun4.l.google.com:19302"
          ]
        }
      ],
      iceTransportPolicy: "all"
    },
    token: authReducer.accessToken,
    sipUri: `sip:${userReducer.user.peerName}@dev-sip.voxo.co`,
    name: "User",
    wsUrl: "wss://api.voxo.co/webrtc",
    password: userReducer.user.peerSecret
  };
}

export function hasSlimSipCredentials(): boolean {
  return buildSlimSipSettings("probe", "outbound") != null;
}
