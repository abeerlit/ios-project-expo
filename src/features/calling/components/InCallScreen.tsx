import React, { useEffect } from "react";
import { View, StyleSheet, Alert, TouchableOpacity } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "hooks/use-theme.ts";
import { padding, borderRadius, fontSize } from "core/theme/theme.ts";
import { Button } from "shared/components/Button.tsx";
import { Text } from "shared/components/Text.tsx";
import { WhiteSpace } from "shared/components/utils/Whitespace.tsx";
import { useSoftphone } from "core/softphone/useSoftphone.ts";
import { CallControlButton } from "./CallControlButton.tsx";
import { CallTimer } from "./CallTimer.tsx";
import { Avatar } from "shared/components/Avatar.tsx";
import { LoadingSpinner } from "shared/components/LoadingSpinner.tsx";
import { useContactLookup } from "../hooks/useContactLookup.ts";
import { Logger } from "shared/utils/Logger.ts";
import { toast } from "@backpackapp-io/react-native-toast";
import { useDrawer } from "core/drawer/DrawerContext.tsx";
import {
  TransferContactDrawer,
  TransferContact
} from "./TransferContactDrawer.tsx";
import { TransferStateDrawer } from "./TransferStateDrawer.tsx";
import {
  TransferOptionsDrawer,
  TransferType
} from "./TransferOptionsDrawer.tsx";
import { MergeCallDrawer } from "./MergeCallDrawer.tsx";
import { CallState } from "core/softphone/types.ts";
import { RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import { AuthParams } from "core/navigation/navigators/AuthenticatedStack.tsx";
import { ConferenceParticipantsDrawer } from "./ConferenceParticipantsDrawer.tsx";
import { InCallKeypadDrawer } from "./InCallKeypadDrawer.tsx";
import { phoneNumberFormatter } from "shared/utils/utils.ts";
import Icon from "shared/components/Icon.tsx";

const logger = new Logger("InCallScreen: ");

function transferSuccessLabel(contact: TransferContact): string {
  const name = contact.name.trim();
  return name.length > 0 ? name : phoneNumberFormatter(contact.number);
}

interface InCallScreenProps {
  callId?: string;
  /** When rendered inside Keypad tab — hide "Back to app" (stack route only). */
  embedded?: boolean;
}

export function InCallScreen({ callId, embedded = false }: InCallScreenProps) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { openDrawer, closeDrawer } = useDrawer();
  const navigation = useNavigation();
  const route = useRoute<RouteProp<AuthParams, "InCallScreen">>();

  const {
    calls,
    activeCallId,
    getCallById,
    hangupCall,
    muteCall,
    unmuteCall,
    holdCall,
    unholdCall,
    setSpeaker,
    transferCall,
    startAttendedTransfer,
    cancelAttendedTransfer,
    mergeAttendedTransfer,
    setInCallScreenMinimized
  } = useSoftphone();

  // Prefer the row keyed by activeCallId (matches controls + merge canonical leg).
  let activeCall: (typeof calls)[string] | null = null;
  if (activeCallId && calls[activeCallId]) {
    activeCall = calls[activeCallId];
  } else if (activeCallId) {
    activeCall = getCallById(activeCallId) ?? null;
  }

  // If no current call but we have a callId param, try to find it
  if (!activeCall && callId && calls[callId]) {
    activeCall = calls[callId];
  }

  // During transfers, show the active call (either parent or child)
  if (!activeCall) {
    const transferCall = Object.values(calls).find(
      (call) => call.childSessionId || call.parentSessionId
    );
    if (transferCall) {
      activeCall = transferCall;
    }
  }

  // Fallback to any non-ended call
  if (!activeCall) {
    const activeCalls = Object.values(calls).filter(
      (call) =>
        call.state !== CallState.ENDED && call.state !== CallState.FAILED
    );
    if (activeCalls.length > 0) {
      activeCall = activeCalls[0];
    }
  }

  // Helper functions
  const getPhoneNumber = (remoteUri: string): string => {
    const match = remoteUri?.match(/^sip:(.+)@/);
    return match ? match[1] : remoteUri;
  };

  const getContactName = (displayName: string, remoteUri: string): string => {
    if (displayName && displayName !== remoteUri) {
      return displayName;
    }
    const match = remoteUri?.match(/^sip:(.+)@/);
    return match ? match[1] : remoteUri;
  };

  // Check if this is a VoIP call (after activeCall is determined)
  const isVoipCall = activeCall?.voipPayload !== undefined;

  useEffect(() => {
    console.log("🟠 [InCallScreen] 📞 Component rendered:", {
      callId,
      activeCallId,
      activeCall: activeCall
        ? {
            sessionId: activeCall.sessionId,
            state: activeCall.state,
            connected: activeCall.connected,
            answerTime: activeCall.answerTime,
            remoteDisplayName: activeCall.remoteDisplayName
          }
        : null,
      allCalls: Object.keys(calls).map((key) => ({
        sessionId: calls[key].sessionId,
        state: calls[key].state,
        connected: calls[key].connected
      })),
      willShowAcceptDecline: activeCall?.state === CallState.INCOMING,
      timestamp: new Date().toISOString()
    });
  }, [callId, activeCallId, activeCall, calls]);

  // Navigate back only when there is no active call (activeCallId cleared).
  // Close any in-call drawer (keypad, transfer, etc.) when call ends.
  useEffect(() => {
    const hasLiveCall = Object.values(calls).some(
      (c) =>
        c.state === CallState.INCOMING ||
        c.state === CallState.OUTGOING ||
        c.state === CallState.CONNECTING ||
        c.state === CallState.CONNECTED ||
        c.state === CallState.HOLDING ||
        c.state === CallState.HELD
    );

    // Some flows (e.g. CallKit Recents start-call) can briefly have a live outgoing call
    // while activeCallId is not yet set; don't auto-close the screen in that case.
    if (!activeCallId && !hasLiveCall) {
      closeDrawer();
      const timer = setTimeout(() => {
        navigation.goBack();
      }, 500);

      return () => clearTimeout(timer);
    }
  }, [activeCallId, calls, navigation, closeDrawer]);

  // Get connection quality for VoIP calls
  const getConnectionQuality = (): "excellent" | "good" | "fair" | "poor" => {
    if (!isVoipCall) return "excellent";
    return "good";
  };

  // Single control target: when activeCallId resolves, drive mute/hold from it (not a sibling leg).
  const currentCallId =
    activeCallId && calls[activeCallId]
      ? activeCallId
      : activeCall?.parentSessionId
      ? activeCall.parentSessionId
      : activeCall?.sessionId;

  // Extract phone number and look up contact information
  const phoneNumber = activeCall ? getPhoneNumber(activeCall.remoteUri) : "";
  const contactInfo = useContactLookup(phoneNumber);

  // Use contact name/avatar: prefer preloaded (from Keypad), then lookup, then SIP
  const displayName =
    activeCall?.contactDisplayName ||
    contactInfo?.name ||
    (activeCall
      ? getContactName(activeCall.remoteDisplayName, activeCall.remoteUri)
      : "");
  const avatarPath =
    activeCall?.contactAvatarPath ?? contactInfo?.avatarPath ?? undefined;

  const handleMute = async () => {
    if (!currentCallId || !activeCall) return;
    try {
      if (activeCall.isMuted) {
        await unmuteCall(currentCallId);
      } else {
        await muteCall(currentCallId);
      }
    } catch (error) {
      logger.error("Failed to toggle mute:", error);
      toast.error("Error toggling mute for the call");
    }
  };

  const handleHold = async () => {
    if (!currentCallId || !activeCall) return;
    try {
      if (activeCall.isOnHold) {
        await unholdCall(currentCallId);
      } else {
        await holdCall(currentCallId);
      }
    } catch (error) {
      logger.error("Failed to toggle hold:", error);
      Alert.alert("Error", "Unable to toggle hold. Please try again.");
    }
  };

  const handleHangup = async () => {
    if (!currentCallId) return;
    try {
      await hangupCall(currentCallId);
    } catch (error) {
      logger.error("Failed to hang up call:", error);
      Alert.alert("Error", "Unable to end the call. Please try again.");
    }
  };

  const handleAudio = async () => {
    if (!currentCallId || !activeCall) return;
    try {
      await setSpeaker(currentCallId, !activeCall.isSpeakerOn);
    } catch (error) {
      logger.error("Failed to toggle speaker:", error);
      toast.error("Error toggling speakerphone");
    }
  };

  const handleKeypad = () => {
    if (!activeCall?.sessionId) return;
    if (!activeCall.connected) {
      toast.error("Wait for the call to connect before using the keypad");
      return;
    }
    openDrawer(
      <InCallKeypadDrawer
        callId={activeCall.sessionId}
        onClose={closeDrawer}
      />,
      0.7
    );
  };

  const handleAddCall = () => {
    if (!currentCallId || !activeCall) return;
    logger.debug("Add People: opening contact picker", {
      currentCallId,
      activeCallSessionId: activeCall.sessionId,
      activeCallState: activeCall.state
    });

    openDrawer(
      <TransferContactDrawer
        onContactSelected={handleAddCallContactSelected}
        onCancel={closeDrawer}
        title="Add Person to Call"
      />,
      0.9
    );
  };

  const handleAddCallContactSelected = async (contact: TransferContact) => {
    if (!currentCallId) return;

    logger.debug("Add People: contact selected", {
      currentCallId,
      targetNumber: contact.number,
      targetName: contact.name
    });

    const addPersonLabel = transferSuccessLabel(contact);

    // Swap the sheet to a connecting state immediately. The previous flow called
    // closeDrawer() then awaited SIP (hold + INVITE), which clears drawerContent for
    // several seconds — users saw a white/empty gap or a blank sheet edge.
    openDrawer(
      <View style={styles.addPersonLoadingInner}>
        <LoadingSpinner size={40} />
        <WhiteSpace height={padding.lg} />
        <Text
          color="color-colors-text-text-primary"
          size={fontSize.lg}
          weight="semiBold"
          align="center"
        >
          {`Adding ${addPersonLabel}…`}
        </Text>
        <WhiteSpace height={padding.sm} />
        <Text
          color="color-colors-text-text-secondary"
          size={fontSize.md}
          align="center"
        >
          Placing the call
        </Text>
      </View>,
      0.45,
      {
        preventSwipeClose: true,
        preventBackdropClose: true,
        onHardwareBackPress: () => true
      }
    );

    try {
      const newCallId = await startAttendedTransfer(
        currentCallId,
        contact.number,
        { displayName: contact.name }
      );
      logger.debug("Add People: startAttendedTransfer returned", {
        parentCallId: currentCallId,
        childCallId: newCallId
      });

      if (newCallId) {
        openDrawer(
          <MergeCallDrawer
            parentSessionIdHint={currentCallId}
            childSessionIdHint={newCallId}
            onMerge={handleMergeCall}
            onCancel={() => handleCancelMerge(newCallId)}
          />,
          0.45,
          {
            preventSwipeClose: true,
            preventBackdropClose: true,
            onHardwareBackPress: () => {
              void handleCancelMerge(newCallId);
            }
          }
        );
      }
    } catch (error) {
      logger.error("Failed to add call:", error);
      toast.error("Failed to add person to call");
      closeDrawer();
    }
  };

  const handleMergeCall = async () => {
    try {
      logger.debug("Add People: merge requested from drawer", {
        activeCallId,
        calls: Object.values(calls).map((call) => ({
          sessionId: call.sessionId,
          callId: call.callId,
          state: call.state,
          parentSessionId: call.parentSessionId,
          childSessionId: call.childSessionId
        }))
      });
      await mergeAttendedTransfer("conferenceMerge");
      closeDrawer();
      toast.success("Call merged successfully");
    } catch (error) {
      logger.error("Failed to merge call:", error);
      toast.error("Failed to merge call");
    }
  };

  const handleCancelMerge = async (callIdToCancel: string) => {
    logger.debug("Add People: cancel merge requested", {
      callIdToCancel,
      currentCallId
    });
    try {
      if (currentCallId) {
        await cancelAttendedTransfer(currentCallId);
      }
      closeDrawer();
    } catch (error) {
      logger.error("Failed to cancel merge:", error);
      toast.error("Failed to cancel");
    }
  };

  const handleTransfer = () => {
    if (!currentCallId || !activeCall) return;

    openDrawer(
      <TransferContactDrawer
        onContactSelected={handleContactSelected}
        onCancel={closeDrawer}
      />,
      0.9
    );
  };

  const handleContactSelected = (contact: TransferContact) => {
    if (!currentCallId) return;

    openDrawer(
      <TransferOptionsDrawer
        contact={contact}
        onTransferTypeSelected={(transferType) =>
          handleTransferTypeSelected(contact, transferType)
        }
        onCancel={closeDrawer}
      />,
      0.9,
      {
        preventSwipeClose: true,
        preventBackdropClose: true,
        onHardwareBackPress: () => closeDrawer()
      }
    );
  };

  const handleTransferTypeSelected = async (
    contact: TransferContact,
    transferType: TransferType
  ) => {
    if (!currentCallId) return;

    const label = transferSuccessLabel(contact);
    const loadingSubtitle =
      transferType === "blind" ? "Completing transfer" : "Placing the call";
    const loadingTitle =
      transferType === "blind"
        ? `Transferring to ${label}…`
        : `Calling ${label}…`;

    openDrawer(
      <View style={styles.addPersonLoadingInner}>
        <LoadingSpinner size={40} />
        <WhiteSpace height={padding.lg} />
        <Text
          color="color-colors-text-text-primary"
          size={fontSize.lg}
          weight="semiBold"
          align="center"
        >
          {loadingTitle}
        </Text>
        <WhiteSpace height={padding.sm} />
        <Text
          color="color-colors-text-text-secondary"
          size={fontSize.md}
          align="center"
        >
          {loadingSubtitle}
        </Text>
      </View>,
      0.45,
      {
        preventSwipeClose: true,
        preventBackdropClose: true,
        onHardwareBackPress: () => true
      }
    );

    try {
      if (transferType === "blind") {
        await transferCall(currentCallId, contact.number);
        toast.success(`Call transferred to ${label}`);
        closeDrawer();
      } else if (transferType === "attended") {
        await startAttendedTransfer(currentCallId, contact.number, {
          displayName: contact.name
        });

        openDrawer(
          <TransferStateDrawer onCancel={handleTransferCancel} />,
          0.9,
          {
            preventSwipeClose: true,
            preventBackdropClose: true,
            onHardwareBackPress: () => {
              void handleTransferCancel();
            }
          }
        );
      }
    } catch (error) {
      logger.error("Transfer failed:", error);
      toast.error("Transfer failed. Please try again.");
      closeDrawer();
    }
  };

  const handleTransferCancel = async () => {
    try {
      const parentCall = Object.values(calls).find(
        (call) => call.childSessionId
      );
      if (parentCall?.childSessionId) {
        const childCall = calls[parentCall.childSessionId];
        if (childCall) {
          await cancelAttendedTransfer(parentCall.sessionId);
        }
      }
      closeDrawer();
    } catch (error) {
      logger.error("Error cancelling transfer:", error);
    }
  };

  const handleViewParticipants = () => {
    if (!currentCallId || !activeCall || !activeCall.conferenceId) return;

    openDrawer(
      <ConferenceParticipantsDrawer
        callId={activeCall.callId}
        conferenceId={activeCall.conferenceId}
        onClose={closeDrawer}
      />,
      0.9
    );
  };

  const handleBackToApp = () => {
    setInCallScreenMinimized(true);
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    navigation.navigate("BottomTabNavigator" as never);
  };

  if (!activeCall) {
    const destination = route.params?.destination?.trim() || "";
    const shellName = (route.params?.displayName || destination || "Calling").trim();
    const shellAvatar = route.params?.avatarPath || null;
    const showDialingShell = !!destination;

    if (!showDialingShell) {
      const isConnecting = !!activeCallId;
      return (
        <View
          style={[
            styles.container,
            { paddingTop: insets.top + padding.lg, paddingBottom: insets.bottom }
          ]}
        >
          <View style={styles.content}>
            <WhiteSpace height={padding["4xl"]} />
            <View style={styles.loadingContainer}>
              <LoadingSpinner size={40} />
              <WhiteSpace height={padding.lg} />
              <Text
                color="color-colors-text-text-secondary"
                size={fontSize.lg}
                weight="medium"
                align="center"
              >
                {isConnecting ? "Connecting..." : "Call Ended"}
              </Text>
              <WhiteSpace height={padding.md} />
              <Text
                color="color-colors-text-text-tertiary"
                size={fontSize.sm}
                weight="regular"
                align="center"
              >
                {isConnecting
                  ? "Setting up your call..."
                  : "Returning to previous screen..."}
              </Text>
            </View>
          </View>
        </View>
      );
    }

    // Full in-call UI shell while SIP stack is initializing/registering/dialing.
    const controlsDisabled = true;
    return (
      <View
        style={[
          styles.container,
          { paddingTop: 25, paddingBottom: insets.bottom }
        ]}
      >
        {!embedded ? (
          <TouchableOpacity
            style={styles.backToAppButton}
            onPress={() => {}}
            disabled
          >
            <Icon name="chevron-left" size={18} type="outline" />
            <Text
              color="color-colors-text-text-tertiary"
              size={fontSize.sm}
              weight="semiBold"
            >
              Back to app
            </Text>
          </TouchableOpacity>
        ) : null}
        <View style={styles.content}>
          <View style={styles.headerActions} />
          <WhiteSpace height={padding.xl} />
          <Avatar
            size={80}
            borderRadius={borderRadius.full}
            name={shellName}
            source={shellAvatar || undefined}
          />
          <WhiteSpace height={padding.xl} />
          <Text
            color="color-colors-text-text-primary"
            size={fontSize["2xl"]}
            weight="semiBold"
            align="center"
          >
            {shellName}
          </Text>
          <WhiteSpace height={padding.sm} />
          <View style={styles.phoneNumberContainer}>
            <Text
              color="color-colors-text-text-secondary"
              size={fontSize.lg}
              weight="medium"
              align="center"
            >
              {destination}
            </Text>
          </View>
          <WhiteSpace height={padding.md} />
          <Text
            color="color-colors-text-text-secondary"
            size={fontSize.lg}
            weight="medium"
            align="center"
          >
            Dialing...
          </Text>
          <WhiteSpace height={padding.sm} />
          <Text
            color="color-colors-text-text-tertiary"
            size={fontSize.sm}
            weight="regular"
            align="center"
          >
            Setting up your call...
          </Text>
        </View>

        <View style={styles.controlsGrid}>
          <View style={styles.controlsRow}>
            <CallControlButton
              icon={"volume-max"}
              label="Speaker"
              onPress={() => {}}
              disabled={controlsDisabled}
            />
            <CallControlButton
              icon="dots-grid"
              label="Keypad"
              onPress={() => {}}
              disabled={controlsDisabled}
            />
            <CallControlButton
              icon="microphone-off-02"
              label="Mute"
              onPress={() => {}}
              disabled={controlsDisabled}
            />
          </View>
          <WhiteSpace height={padding.xl} />
          <View style={styles.controlsRow}>
            <CallControlButton
              icon="phone-outgoing-01"
              label="Transfer"
              onPress={() => {}}
              disabled={controlsDisabled}
            />
            <CallControlButton
              icon="users-01"
              label="Add Person"
              onPress={() => {}}
              disabled={controlsDisabled}
            />
            <CallControlButton
              icon="phone-pause"
              label="Hold"
              onPress={() => {}}
              disabled={controlsDisabled}
            />
          </View>
        </View>

        <View style={styles.bottomSection}>
          <Button
            type="primary"
            onPress={() => {}}
            disabled
            containerStyle={[
              styles.endCallButton,
              { opacity: 0.55 },
              {
                backgroundColor:
                  theme.colors[
                    "component-colors-components-buttons-primary-error-button-primary-error-bg"
                  ]
              }
            ]}
            size={fontSize.md}
            weight="semiBold"
          >
            End Call
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        { paddingTop: 25, paddingBottom: insets.bottom }
      ]}
    >
      {!embedded ? (
        <TouchableOpacity
          style={styles.backToAppButton}
          onPress={handleBackToApp}
        >
          <Icon name="chevron-left" size={18} type="outline" />
          <Text
            color="color-colors-text-text-secondary"
            size={fontSize.sm}
            weight="semiBold"
          >
            Back to app
          </Text>
        </TouchableOpacity>
      ) : null}
      <View style={styles.content}>
        <View style={styles.headerActions}>
         
        </View>
        <WhiteSpace height={padding.xl} />

        <Avatar
          size={80}
          borderRadius={borderRadius.full}
          name={displayName}
          source={avatarPath || undefined}
        />
        <WhiteSpace height={padding.xl} />

        <Text
          color="color-colors-text-text-primary"
          size={fontSize["2xl"]}
          weight="semiBold"
          align="center"
        >
          {displayName}
        </Text>

        <WhiteSpace height={padding.sm} />

        <View style={styles.phoneNumberContainer}>
          <Text
            color="color-colors-text-text-secondary"
            size={fontSize.lg}
            weight="medium"
            align="center"
          >
            {phoneNumber}
          </Text>
          {isVoipCall && (
            <View style={styles.voipIndicator}>
              <Text
                color="color-colors-text-text-tertiary"
                size={fontSize.xs}
                weight="medium"
              >
                VoIP
              </Text>
            </View>
          )}
        </View>

        {activeCall.recording && (
          <>
            <WhiteSpace height={padding.xs} />
            <Text
              color="color-colors-text-text-tertiary"
              size={fontSize.sm}
              weight="medium"
              align="center"
            >
              🔴 Recording
            </Text>
          </>
        )}

        {activeCall.conferencing && (
          <>
            <WhiteSpace height={padding.xs} />
            <Text
              color="color-colors-text-text-tertiary"
              size={fontSize.sm}
              weight="medium"
              align="center"
            >
              📞 Conference Call
            </Text>
          </>
        )}

        <WhiteSpace height={padding.sm} />

        <CallTimer
          startTime={activeCall.startTime}
          answerTime={activeCall.answerTime}
          callState={activeCall.state}
          isOnHold={activeCall.isOnHold}
          isVoipCall={isVoipCall}
          connectionQuality={getConnectionQuality()}
        />
      </View>

      {activeCall.state === CallState.INCOMING ? (
        <View style={styles.bottomSection}>
          <Button
            type="primary"
            onPress={handleHangup}
            containerStyle={[
              styles.endCallButton,
              {
                backgroundColor:
                  theme.colors[
                    "component-colors-components-buttons-primary-error-button-primary-error-bg"
                  ]
              }
            ]}
            size={fontSize.md}
            weight="semiBold"
          >
            Decline
          </Button>
        </View>
      ) : (
        <>
          <View style={styles.controlsGrid}>
            <View style={styles.controlsRow}>
              <CallControlButton
                icon={"volume-max"}
                label="Speaker"
                onPress={handleAudio}
                isActive={activeCall.isSpeakerOn}
              />
              <CallControlButton
                icon="dots-grid"
                label="Keypad"
                onPress={handleKeypad}
                disabled={!activeCall.connected}
              />
              <CallControlButton
                icon="microphone-off-02"
                label="Mute"
                onPress={handleMute}
                isActive={activeCall.isMuted}
              />
            </View>

            <WhiteSpace height={padding.xl} />

            <View style={styles.controlsRow}>
              {activeCall.conferencing ? (
                <>
                  <CallControlButton
                    icon="users-01"
                    label="Participants"
                    onPress={handleViewParticipants}
                  />
                  <CallControlButton
                    icon="phone-pause"
                    label="Hold"
                    onPress={handleHold}
                    isActive={activeCall.isOnHold}
                  />
                  <CallControlButton
                    icon="user-plus-01"
                    label="Add"
                    onPress={handleAddCall}
                  />
                </>
              ) : (
                <>
                  <CallControlButton
                    icon="phone-outgoing-01"
                    label="Transfer"
                    onPress={handleTransfer}
                  />
                  <CallControlButton
                    icon="users-01"
                    label="Add Person"
                    onPress={handleAddCall}
                  />
                  <CallControlButton
                    icon="phone-pause"
                    label="Hold"
                    onPress={handleHold}
                    isActive={activeCall.isOnHold}
                  />
                </>
              )}
            </View>
          </View>

          <View style={styles.bottomSection}>
            <Button
              type="primary"
              onPress={handleHangup}
              containerStyle={[
                styles.endCallButton,
                {
                  backgroundColor:
                    theme.colors[
                      "component-colors-components-buttons-primary-error-button-primary-error-bg"
                    ]
                }
              ]}
              size={fontSize.md}
              weight="semiBold"
            >
              End Call
            </Button>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: padding["3xl"],
    justifyContent: "space-between"
  },
  content: {
    alignItems: "center",
    width: "100%"
  },
  headerActions: {
    width: "100%",
    alignItems: "flex-start"
  },
  backToAppButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: padding.xs
  },
  controlsGrid: {
    alignItems: "center",
    width: "100%"
  },
  controlsRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: padding.md,
    gap: padding["3xl"]
  },
  bottomSection: {
    paddingTop: padding.lg,
    paddingBottom: padding.sm
  },
  incomingCallButtons: {
    flexDirection: "row",
    gap: padding.lg,
    width: "100%"
  },
  endCallButton: {
    paddingVertical: padding.lg,
    borderRadius: borderRadius.lg
  },
  answerButton: {
    flex: 1,
    paddingVertical: padding.lg,
    borderRadius: borderRadius.lg
  },
  declineButton: {
    flex: 1,
    paddingVertical: padding.lg,
    borderRadius: borderRadius.lg
  },
  loadingContainer: {
    alignItems: "center"
  },
  addPersonLoadingInner: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: padding.xl,
    minHeight: 200
  },
  phoneNumberContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: padding.sm
  },
  voipIndicator: {
    backgroundColor: "#F3F4F6",
    paddingHorizontal: padding.sm,
    paddingVertical: padding.xs,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    borderColor: "#D1D5DB"
  }
});
