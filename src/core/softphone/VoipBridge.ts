import { EventEmitter } from "events";
import { VoipCallData } from "../notifications/NotificationManager";
import { CallInfo, CallState, CallDirection } from "./types";
import { Logger } from "shared/utils/Logger.ts";
import BackgroundTaskManager from "../background/BackgroundTaskManager.ts";

const logger = new Logger("VoipBridge: ");

/**
 * VoipBridge handles the integration between VoIP push notifications
 * and the softphone system for incoming calls
 */
export class VoipBridge extends EventEmitter {
  private static instance: VoipBridge | null = null;
  private isInitialized: boolean = false;
  private voipCalls: Set<string> = new Set();
  private voipCallData: Map<string, VoipCallData> = new Map();
  /** Answers that arrived before SoftphoneProvider attached answerVoipCall listeners. */
  private pendingAnswerCallIds: Set<string> = new Set();

  private constructor() {
    super();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): VoipBridge {
    if (!VoipBridge.instance) {
      VoipBridge.instance = new VoipBridge();
    }
    return VoipBridge.instance;
  }

  /**
   * Initialize the VoIP bridge
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    // Initialize background task manager for iOS
    await BackgroundTaskManager.initialize();

    // VoIP Bridge initialized
    this.isInitialized = true;
    logger.debug("VoIP Bridge initialized with background task support");
  }

  public async handleVoipCall(callData: VoipCallData): Promise<void> {
    console.log("🟦 [VoipBridge] 📞 handleVoipCall called:", {
      callUuid: callData.callUuid,
      callerName: callData.callerName,
      callerNumber: callData.callerNumber,
      isInitialized: this.isInitialized,
      existingVoipCalls: Array.from(this.voipCalls),
      timestamp: new Date().toISOString()
    });

    if (!this.isInitialized) {
      console.error("🟦 [VoipBridge] 📞 ❌ VoIP Bridge not initialized");
      logger.error("VoIP Bridge not initialized");
      return;
    }

    try {
      console.log("🟦 [VoipBridge] 📞 Starting background task...");
      BackgroundTaskManager.startBackgroundTask();

      console.log(
        "🟦 [VoipBridge] 📞 Calling BackgroundTaskManager.handleIncomingVoipCall..."
      );
      await BackgroundTaskManager.handleIncomingVoipCall(callData.payload);
      console.log(
        "🟦 [VoipBridge] 📞 ✅ BackgroundTaskManager.handleIncomingVoipCall completed"
      );

      const callInfo: CallInfo = {
        id: callData.callUuid,
        state: CallState.INCOMING,
        direction: CallDirection.INCOMING,
        remoteDisplayName: callData.callerName,
        remoteUri: `sip:${callData.callerNumber}@dev-sip.voxo.co`,
        startTime: new Date(),
        isMuted: false,
        isOnHold: false,
        isSpeakerOn: false,
        isEmergency: false,
        // Store original VoIP payload for reference
        voipPayload: callData.payload,
        // Add VoIP-specific metadata
        audioState: "active"
      };

      console.log("🟦 [VoipBridge] 📞 Created CallInfo object:", {
        id: callInfo.id,
        state: callInfo.state,
        remoteDisplayName: callInfo.remoteDisplayName,
        remoteUri: callInfo.remoteUri
      });

      // Track this as a VoIP call and store the data
      this.voipCalls.add(callData.callUuid);
      this.voipCallData.set(callData.callUuid, callData);
      console.log(
        "🟦 [VoipBridge] 📞 Added to voipCalls Set. Total VoIP calls:",
        this.voipCalls.size
      );

      // Emit events that the softphone system can listen to
      console.log("🟦 [VoipBridge] 📞 Emitting 'incomingVoipCall' event...");
      this.emit("incomingVoipCall", callData.callUuid, callInfo);
      console.log("🟦 [VoipBridge] 📞 Emitting 'callStateChanged' event...");
      this.emit("callStateChanged", callData.callUuid, CallState.INCOMING);
      console.log("🟦 [VoipBridge] 📞 ✅ NEW CALL CREATED AND EVENTS EMITTED");

      // Start connection quality monitoring for VoIP calls
      this.startConnectionQualityMonitoring(callData.callUuid);
    } catch (error) {
      console.error("🟦 [VoipBridge] 📞 ❌ Error handling VoIP call:", error);
      logger.error("Error handling VoIP call:", error);
      // End background task on error
      BackgroundTaskManager.endBackgroundTask();
    }
  }

  /**
   * Start monitoring connection quality for a VoIP call
   */
  private startConnectionQualityMonitoring(callId: string): void {
    // In a real implementation, you would monitor WebRTC stats
    // For now, we'll simulate connection quality updates
    setTimeout(() => {
      this.emit("connectionQualityChanged", callId, "good");
    }, 2000);
  }

  public handleCallAnswer(callId: string): void {
    console.log("🟦 [VoipBridge] 📞 handleCallAnswer called:", {
      callId,
      isVoipCall: this.isVoipCall(callId),
      voipCalls: Array.from(this.voipCalls),
      listenerCount: this.listenerCount("answerVoipCall"),
      timestamp: new Date().toISOString()
    });

    this.pendingAnswerCallIds.add(callId);
    if (this.listenerCount("answerVoipCall") > 0) {
      this.emit("answerVoipCall", callId);
      console.log("🟦 [VoipBridge] 📞 ✅ answerVoipCall event emitted");
    } else {
      console.warn(
        "🟦 [VoipBridge] 📞 answerVoipCall queued (no listeners yet):",
        callId
      );
    }
  }

  /** Replay answers queued during killed-state / deferred expo boot. */
  public drainPendingAnswerCallIds(): void {
    if (this.pendingAnswerCallIds.size === 0) {
      return;
    }
    const pending = [...this.pendingAnswerCallIds];
    console.warn(
      "🟦 [VoipBridge] 📞 draining pending answerVoipCall events:",
      pending
    );
    for (const callId of pending) {
      this.emit("answerVoipCall", callId);
    }
  }

  public clearPendingAnswer(callId: string): void {
    this.pendingAnswerCallIds.delete(callId);
  }

  public hasPendingAnswer(callId: string): boolean {
    return this.pendingAnswerCallIds.has(callId);
  }

  public getTrackedVoipCallIds(): string[] {
    return [...this.voipCalls];
  }

  /**
   * Handle call end from native UI
   * This is called when user ends the call from CallKeep
   */
  public handleCallEnd(callId: string): void {
    this.emit("endVoipCall", callId);
    this.voipCalls.delete(callId);
    this.voipCallData.delete(callId);
  }

  /**
   * Remove VoIP tracking without emitting endVoipCall (e.g. cancel attended transfer:
   * child leg ends but JS already updated UI / parent stays active).
   */
  public clearVoipCallTracking(callId: string): void {
    this.voipCalls.delete(callId);
    this.voipCallData.delete(callId);
  }

  /**
   * Check if a call is a VoIP call (not a direct SIP call)
   */
  public isVoipCall(callId: string): boolean {
    // Check if this call ID is tracked as a VoIP call
    return this.voipCalls.has(callId);
  }

  /**
   * Get VoIP call data for a call ID
   * This can be used to retrieve original VoIP payload
   */
  public getVoipCallData(callId: string): VoipCallData | null {
    return this.voipCallData.get(callId) || null;
  }

  /**
   * Cleanup
   */
  public dispose(): void {
    this.removeAllListeners();
    this.voipCalls.clear();
    this.voipCallData.clear();
    this.pendingAnswerCallIds.clear();
    this.isInitialized = false;
    VoipBridge.instance = null;
  }
}

// Export singleton instance
export default VoipBridge.getInstance();
