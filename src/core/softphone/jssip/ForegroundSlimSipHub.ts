import { AppState } from "react-native";
import { SlimSipClient } from "./SlimSipClient";
import { SipSession } from "./SipSession";
import { buildSlimSipSettings } from "../slimSipSettings.ts";
import { iosCallFlowLog } from "../iosCallFlowLog.ts";

export type ForegroundIncomingHandler = (args: {
  sipSession: SipSession;
  callUuid: string;
  remoteUri: string;
  remoteDisplayName: string;
}) => void;

/**
 * Single JsSIP UA while iOS app is foreground and mobile call notifications are off.
 * Replaces SessionManager WebSocket REGISTER for outbound + WS INVITE.
 */
export class ForegroundSlimSipHub {
  private static instance: ForegroundSlimSipHub | null = null;

  private client: SlimSipClient | null = null;
  private hubCallUuid = "foreground-ws-hub";
  private registered = false;
  private connecting: Promise<void> | null = null;
  private incomingHandler: ForegroundIncomingHandler | null = null;
  private newSessionListenerAttached = false;

  static getInstance(): ForegroundSlimSipHub {
    if (!ForegroundSlimSipHub.instance) {
      ForegroundSlimSipHub.instance = new ForegroundSlimSipHub();
    }
    return ForegroundSlimSipHub.instance;
  }

  /** Hub registered while app is foreground (call notifs off WS path). */
  isActive(): boolean {
    return (
      this.client != null &&
      this.registered &&
      AppState.currentState === "active"
    );
  }

  getClient(): SlimSipClient | null {
    return this.client;
  }

  setIncomingHandler(handler: ForegroundIncomingHandler | null): void {
    this.incomingHandler = handler;
  }

  private attachIncomingListener(): void {
    if (!this.client || this.newSessionListenerAttached) {
      return;
    }
    const ua = this.client.getUa();
    if (!ua) {
      return;
    }
    ua.on("newRTCSession", (data: any) => {
      const rtcSession = data?.session;
      const isIncoming =
        data?.originator === "remote" || rtcSession?.direction === "incoming";
      if (!rtcSession || !isIncoming) {
        return;
      }

      // Call notifs off: WS INVITE UI only when app is foreground — no CallKit in background.
      if (AppState.currentState !== "active") {
        iosCallFlowLog("foreground-hub", "WS INVITE ignored (app background)", {
          callUuid:
            rtcSession._request?.getHeader?.("XCID") ||
            rtcSession._request?.getHeader?.("X-UUID") ||
            "unknown"
        });
        try {
          rtcSession.terminate({
            status_code: 480,
            reason_phrase: "Temporarily Unavailable"
          });
        } catch {
          // ignore
        }
        return;
      }

      const remoteUri =
        rtcSession.remote_identity?.uri?.toString?.() ||
        String(rtcSession.remote_identity?.uri || "");
      const remoteDisplayName =
        rtcSession.remote_identity?.display_name || remoteUri;
      const req = rtcSession._request;
      const callUuid =
        rtcSession.data?.uuid ||
        req?.getHeader?.("X-UUID") ||
        req?.getHeader?.("XCID") ||
        req?.getHeader?.("Xcid") ||
        req?.getHeader?.("X-Cid") ||
        `ws-${Date.now()}`;

      const sipSession = new SipSession(rtcSession, ua, {
        pcConfig: this.client!.getPcConfig(),
        callUuid: String(callUuid)
      });

      iosCallFlowLog("foreground-hub", "incoming WS INVITE", {
        callUuid: String(callUuid),
        remoteUri
      });

      this.incomingHandler?.({
        sipSession,
        callUuid: String(callUuid),
        remoteUri,
        remoteDisplayName
      });
    });
    this.newSessionListenerAttached = true;
  }

  async connect(): Promise<void> {
    if (AppState.currentState !== "active") {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }
    if (this.registered && this.client) {
      return;
    }

    this.connecting = (async () => {
      const settings = buildSlimSipSettings(this.hubCallUuid, "outbound");
      if (!settings) {
        throw new Error("Cannot connect foreground SlimSip hub — not logged in");
      }

      if (this.client) {
        try {
          await this.client.dispose();
        } catch {
          // ignore
        }
      }

      this.client = new SlimSipClient(settings);
      this.newSessionListenerAttached = false;
      this.attachIncomingListener();

      const ua = this.client.getUa();
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Foreground SlimSip hub register timeout"));
        }, 15000);

        ua.once("registered", () => {
          clearTimeout(timeout);
          this.registered = true;
          iosCallFlowLog("foreground-hub", "registered", {});
          resolve();
        });

        ua.once("registrationFailed", (data: any) => {
          clearTimeout(timeout);
          reject(data ?? new Error("registrationFailed"));
        });

        void this.client!.ensureUaStarted().catch(reject);
      });
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async disconnect(): Promise<void> {
    this.registered = false;
    this.newSessionListenerAttached = false;
    if (this.client) {
      try {
        await this.client.dispose();
      } catch {
        // ignore
      }
      this.client = null;
    }
    iosCallFlowLog("foreground-hub", "disconnected", {});
  }

  async placeOutboundCall(
    destination: string,
    callUuid: string,
    outboundNumberId?: string
  ): Promise<SipSession> {
    if (!this.client || !this.registered) {
      await this.connect();
    }
    if (!this.client) {
      throw new Error("Foreground SlimSip hub not connected");
    }

    const ua = this.client.getUa();
    const rtcSessionPromise = new Promise<SipSession>((resolve) => {
      ua.once("newRTCSession", (establishedSession: any) => {
        const rtcSession = establishedSession.session;
        if (rtcSession.direction !== "outgoing") {
          return;
        }
        const sipSession = new SipSession(rtcSession, ua, {
          pcConfig: this.client!.getPcConfig(),
          callUuid
        });
        resolve(sipSession);
      });
    });

    const extraHeaders = ["X-VoxoConnect-Call-Uuid: " + callUuid];
    if (outboundNumberId) {
      extraHeaders.push(
        "X-VoxoConnect-Outbound-Number-ID: " + outboundNumberId
      );
    }

    ua.call(`sip:${destination}@dev-sip.voxo.co`, {
      data: {
        originalNumber: `sip:${destination}@dev-sip.voxo.co`,
        uuid: callUuid
      },
      extraHeaders,
      mediaConstraints: { audio: true, video: false },
      rtcOfferConstraints: { mandatory: { OfferToReceiveVideo: false } }
    });

    return rtcSessionPromise;
  }
}
