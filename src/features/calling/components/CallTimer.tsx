import React, { useState, useEffect } from "react";
import { borderRadius, fontSize, padding } from "core/theme/theme.ts";
import { Text } from "shared/components/Text.tsx";
import { View } from "react-native";
import { useTheme } from "hooks/use-theme.ts";

interface CallTimerProps {
  startTime?: string;
  answerTime?: string;
  callState: string;
  /** True when local hold is active but state may still be `connected` (e.g. SlimSip/VoIP). */
  isOnHold?: boolean;
  isVoipCall?: boolean;
  connectionQuality?: "excellent" | "good" | "fair" | "poor";
}

const isActiveCallDuration = (callState: string): boolean =>
  callState === "connected" ||
  callState === "holding" ||
  callState === "held";

export function CallTimer({
  startTime,
  answerTime,
  callState,
  isOnHold = false,
  isVoipCall = false,
  connectionQuality
}: CallTimerProps) {
  const [duration, setDuration] = useState(0);
  const theme = useTheme();

  useEffect(() => {
    if (isActiveCallDuration(callState) && (answerTime || startTime)) {
      const tick = () => {
        const start = new Date(answerTime || startTime || "");
        const now = new Date();
        const diff = Math.floor((now.getTime() - start.getTime()) / 1000);
        setDuration(Math.max(0, diff));
      };
      tick();
      const interval = setInterval(tick, 1000);
      return () => clearInterval(interval);
    }
    setDuration(0);
  }, [answerTime, startTime, callState]);

  const formatDuration = (seconds: number): string => {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  };

  const getConnectionQualityIndicator = (quality: string): string => {
    switch (quality) {
      case "excellent":
        return "🟢";
      case "good":
        return "🟡";
      case "fair":
        return "🟠";
      case "poor":
        return "🔴";
      default:
        return "";
    }
  };

  const showOnHoldLabel =
    callState === "holding" ||
    callState === "held" ||
    (callState === "connected" && isOnHold);

  const getMainLineText = (): string => {
    switch (callState) {
      case "connecting":
        return isVoipCall ? "Connecting via VoIP..." : "Connecting...";
      case "connected": {
        const durationText = formatDuration(duration);
        if (isVoipCall && connectionQuality) {
          const qualityIndicator =
            getConnectionQualityIndicator(connectionQuality);
          return `${durationText} ${qualityIndicator}`;
        }
        return durationText;
      }
      case "holding":
      case "held": {
        const durationText = formatDuration(duration);
        if (isVoipCall && connectionQuality) {
          const qualityIndicator =
            getConnectionQualityIndicator(connectionQuality);
          return `${durationText} ${qualityIndicator}`;
        }
        return durationText;
      }
      case "incoming":
        return isVoipCall ? "Incoming VoIP Call" : "Incoming Call";
      case "outgoing":
        return isVoipCall ? "Calling via VoIP..." : "Calling...";
      default:
        return "00:00";
    }
  };

  return (
    <View
      style={{
        borderWidth: 0.25,
        paddingHorizontal: padding.xs,
        borderRadius: borderRadius.sm,
        paddingVertical: padding.xs,
        backgroundColor: theme.colors["color-colors-background-bg-secondary"],
        borderColor: theme.colors.grey
      }}
    >
      {showOnHoldLabel && (
        <Text
          color="color-colors-text-text-secondary"
          size={fontSize.xs}
          weight="semiBold"
          align="center"
        >
          On hold
        </Text>
      )}
      {showOnHoldLabel && (
        <View style={{ height: padding.xs / 2 }} />
      )}
      <Text
        color="color-colors-text-text-secondary"
        size={fontSize.sm}
        weight="medium"
        align="center"
      >
        {getMainLineText()}
      </Text>
    </View>
  );
}
