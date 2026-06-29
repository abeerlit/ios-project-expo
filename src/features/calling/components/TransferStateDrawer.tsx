import React from "react";
import { StyleSheet, View } from "react-native";
import { useTheme } from "hooks/use-theme.ts";
import { borderRadius, fontSize, padding } from "core/theme/theme.ts";

// Component Imports
import { Text } from "shared/components/Text.tsx";
import { WhiteSpace } from "shared/components/utils/Whitespace.tsx";
import { Button } from "shared/components/Button.tsx";
import { Avatar } from "shared/components/Avatar.tsx";
import { LoadingSpinner } from "shared/components/LoadingSpinner.tsx";

// Context
import { useDrawer } from "core/drawer/DrawerContext.tsx";
import { useSoftphone } from "core/softphone/useSoftphone.ts";
import Icon from "shared/components/Icon.tsx";
import { Logger } from "shared/utils/Logger.ts";
import { CallState } from "core/softphone/types.ts";

interface TransferStateDrawerProps {
  onCancel?: () => void;
}

const logger = new Logger("TransferStateDrawer");

export const TransferStateDrawer = ({ onCancel }: TransferStateDrawerProps) => {
  const _theme = useTheme();
  const { closeDrawer } = useDrawer();
  const {
    calls,
    activeCallId,
    cancelAttendedTransfer,
    completeAttendedTransfer,
    swapAttendedTransferCalls
  } = useSoftphone();

  // Find transfer relationship calls
  const parentCall = Object.values(calls).find((call) => call.childSessionId);
  const childCall = parentCall?.childSessionId
    ? calls[parentCall.childSessionId]
    : null;

  const transferContextReady =
    !!parentCall &&
    !!parentCall.childSessionId &&
    !!calls[parentCall.childSessionId];

  const handleCancel = async () => {
    try {
      if (parentCall) {
        await cancelAttendedTransfer(parentCall.sessionId);
      } else if (activeCallId) {
        await cancelAttendedTransfer(activeCallId);
      }
      closeDrawer();
      if (onCancel) {
        onCancel();
      }
    } catch (error) {
      console.error("Error canceling transfer:", error);
      closeDrawer();
      if (onCancel) {
        onCancel();
      }
    }
  };

  if (!transferContextReady) {
    return (
      <View style={styles.container}>
        <View style={[styles.content, styles.loadingContent]}>
          <LoadingSpinner size={40} />
          <WhiteSpace height={padding.lg} />
          <Text
            size={fontSize.lg}
            weight="semiBold"
            align="center"
            color="color-colors-text-text-primary"
          >
            Connecting…
          </Text>
          <WhiteSpace height={padding.sm} />
          <Text
            size={fontSize.md}
            align="center"
            color="color-colors-text-text-secondary"
          >
            Setting up the transfer call
          </Text>
        </View>
        <View style={styles.buttonContainer}>
          <Button
            onPress={handleCancel}
            type="outline"
            style={styles.buttonWrapper}
          >
            Cancel
          </Button>
        </View>
      </View>
    );
  }

  // Determine which call to display - simple logic:
  // 1. If child is dialing/connecting, show it (to see dialing state)
  // 2. Otherwise, show whichever call is NOT on hold (the active one)
  const displayCall = (() => {
    if (!childCall) return parentCall;

    // Show child during initial dialing/connecting
    if (
      childCall.state === CallState.OUTGOING ||
      childCall.state === CallState.CONNECTING
    ) {
      logger.debug("TransferStateDrawer: Showing child (dialing)", {
        childState: childCall.state
      });
      return childCall;
    }

    // Show whichever call is active (not on hold)
    if (parentCall && !parentCall.isOnHold) {
      logger.debug("TransferStateDrawer: Showing parent (active)", {
        parentId: parentCall.sessionId,
        parentOnHold: parentCall.isOnHold,
        childOnHold: childCall.isOnHold
      });
      return parentCall;
    } else if (childCall && !childCall.isOnHold) {
      logger.debug("TransferStateDrawer: Showing child (active)", {
        childId: childCall.sessionId,
        parentOnHold: parentCall?.isOnHold,
        childOnHold: childCall.isOnHold
      });
      return childCall;
    }

    // Fallback to child if both are on hold (shouldn't happen)
    logger.warn("TransferStateDrawer: Both calls on hold, showing child", {
      parentOnHold: parentCall?.isOnHold,
      childOnHold: childCall?.isOnHold
    });
    return childCall;
  })();

  // Determine if we're showing parent or child
  const isShowingParent = displayCall?.sessionId === parentCall?.sessionId;
  const isShowingChild = displayCall?.sessionId === childCall?.sessionId;

  // Log the current display state for debugging
  logger.debug("TransferStateDrawer: Current display", {
    showingParent: isShowingParent,
    showingChild: isShowingChild,
    displayCallId: displayCall?.sessionId,
    displayCallState: displayCall?.state,
    displayCallOnHold: displayCall?.isOnHold
  });

  // Extract contact info from the displayed call
  const transferContact = displayCall
    ? {
        name: displayCall.remoteDisplayName || displayCall.remoteUri,
        number: displayCall.remoteUri,
        avatarPath: undefined // No avatar path available from call data
      }
    : null;

  const handleSwap = async () => {
    try {
      if (parentCall && childCall) {
        logger.debug("Swapping attended transfer calls", {
          parentCallId: parentCall.sessionId,
          childCallId: childCall.sessionId,
          currentActiveCallId: activeCallId,
          isShowingParent,
          isShowingChild
        });

        await swapAttendedTransferCalls(
          parentCall.sessionId,
          childCall.sessionId
        );

        // The display will automatically update based on hold states
        logger.debug(
          "Swap completed, display will show the newly active (not on hold) call"
        );
      } else {
        logger.warn("Cannot swap - parent or child call not found", {
          hasParent: !!parentCall,
          hasChild: !!childCall
        });
      }
    } catch (error) {
      logger.error("Error swapping transfer calls:", error);
    }
  };

  const handleTransfer = async () => {
    try {
      // Use the softphone context method to properly complete transfer
      await completeAttendedTransfer();
      closeDrawer();
    } catch (error) {
      console.error("Error completing transfer:", error);
      // Still close drawer even if complete fails
      closeDrawer();
    }
  };

  const getStateDisplay = () => {
    // Early return if no transfer is in progress
    if (!parentCall || !childCall || !transferContact) {
      return {
        title: "Transfer",
        subtitle: "No transfer in progress",
        showSwap: false,
        showTransfer: false,
        callLabel: ""
      };
    }

    // Determine call label and state based on which call is shown
    let callLabel = "";
    let callState = "";

    if (isShowingParent) {
      callLabel = "Original Call";
      // Use consistent state values
      if (
        parentCall.state === CallState.CONNECTED ||
        parentCall.state === CallState.HOLDING
      ) {
        callState = parentCall.isOnHold ? "On Hold" : "Connected";
      } else {
        callState = "Connected"; // Parent should always be connected during transfer
      }
    } else if (isShowingChild) {
      callLabel = "Transfer Call";
      if (childCall.state === CallState.CONNECTED) {
        callState = childCall.isOnHold ? "On Hold" : "Connected";
      } else if (
        childCall.state === CallState.OUTGOING ||
        childCall.state === CallState.CONNECTING
      ) {
        callState = "Dialing";
      } else {
        // Fallback - shouldn't happen
        callState = "Connected";
      }
    }

    // Global transfer state checks - these don't depend on which call is displayed
    // Show transfer button when child is connected
    const canTransfer = childCall.state === CallState.CONNECTED;
    // Show swap button when both calls are connected or holding (can swap between them)
    const canSwap =
      parentCall &&
      childCall &&
      (childCall.state === CallState.CONNECTED ||
        childCall.state === CallState.HOLDING) &&
      (parentCall.state === CallState.CONNECTED ||
        parentCall.state === CallState.HOLDING);

    // Debug logging
    logger.debug("TransferStateDrawer: State display calculation", {
      callState,
      callLabel,
      canSwap,
      canTransfer,
      isShowingParent,
      isShowingChild,
      parentState: parentCall?.state,
      childState: childCall?.state,
      parentOnHold: parentCall?.isOnHold,
      childOnHold: childCall?.isOnHold
    });

    switch (callState) {
      case "Dialing":
        return {
          title: "Dialing...",
          subtitle: `Attempting to reach ${transferContact.name}`,
          showSwap: false,
          showTransfer: false,
          callLabel
        };
      case "Connected":
        return {
          title: callState,
          subtitle: `${transferContact.name} - ${callLabel}`,
          showSwap: canSwap,
          showTransfer: canTransfer,
          callLabel
        };
      case "On Hold":
        return {
          title: callState,
          subtitle: `${transferContact.name} - ${callLabel}`,
          showSwap: canSwap,
          showTransfer: canTransfer,
          callLabel
        };
      default:
        return {
          title: callState || "Transfer",
          subtitle: `${transferContact.name} - ${callLabel}`,
          showSwap: false,
          showTransfer: false,
          callLabel
        };
    }
  };

  const stateDisplay = getStateDisplay();

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        {/* Contact Info */}
        <View style={styles.contactSection}>
          <WhiteSpace height={padding.xl} />
          <Avatar
            source={transferContact?.avatarPath}
            name={transferContact?.name || "Unknown"}
            size={64}
            borderRadius={borderRadius.md}
          />

          <WhiteSpace height={padding.xs} />

          <Text
            size={fontSize.md}
            align="center"
            color="color-colors-text-text-secondary"
          >
            {transferContact?.number || "Unknown number"}
          </Text>

          <WhiteSpace height={padding.lg} />

          {/* State Display */}
          <View style={styles.stateSection}>
            <Text
              size={fontSize.lg}
              weight="semiBold"
              align="center"
              color="color-colors-text-text-primary"
            >
              {stateDisplay.title}
            </Text>

            {stateDisplay.subtitle && (
              <>
                <WhiteSpace height={padding.xs} />
                <Text
                  size={fontSize.md}
                  align="center"
                  color="color-colors-text-text-secondary"
                >
                  {stateDisplay.subtitle}
                </Text>
              </>
            )}
          </View>
        </View>

        <WhiteSpace height={padding["4xl"]} />
      </View>

      {/* Action Buttons */}
      <View style={styles.buttonContainer}>
        {/* Swap Button - Only show when connected */}
        {stateDisplay.showSwap && (
          <Button
            onPress={handleSwap}
            type="text"
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: padding.sm
            }}
          >
            <Text weight={"medium"}>Swap</Text>
            <Icon name={"switch-horizontal-02"} />
          </Button>
        )}

        {/* Cancel Button */}
        <Button
          onPress={handleCancel}
          type={"outline"}
          style={styles.buttonWrapper}
        >
          Cancel
        </Button>

        <Button
          onPress={handleTransfer}
          type="primary"
          style={styles.buttonWrapper}
          disabled={!stateDisplay.showTransfer}
        >
          Transfer
        </Button>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1
  },
  content: {
    flex: 1,
    paddingHorizontal: padding["2xl"],
    alignItems: "center",
    justifyContent: "space-between"
  },
  loadingContent: {
    justifyContent: "center"
  },
  contactSection: {
    alignItems: "center",
    width: "100%"
  },
  stateSection: {
    alignItems: "center",
    width: "100%"
  },
  buttonContainer: {
    display: "flex",
    flexDirection: "row",
    paddingHorizontal: padding.xl,
    gap: padding.sm,
    paddingBottom: padding.xl
  },
  buttonRow: {
    flexDirection: "row",
    gap: padding.md
  },
  buttonWrapper: {
    flex: 1
  },
  actionButton: {
    paddingVertical: padding.md
  }
});
