import React, { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "shared/components/Text.tsx";
import { useSoftphone } from "core/softphone/useSoftphone.ts";
import { CallState } from "core/softphone/types.ts";
import { navigate } from "core/navigation/utils/Ref.ts";
import { Routes } from "core/navigation/types/types.ts";
import { borderRadius, padding } from "core/theme/theme.ts";

interface ActiveCallBannerProps {
  currentRouteName?: string;
}

const LIVE_CALL_STATES = new Set<CallState>([
  CallState.INCOMING,
  CallState.OUTGOING,
  CallState.CONNECTING,
  CallState.CONNECTED,
  CallState.HOLDING,
  CallState.HELD
]);

export function ActiveCallBanner({ currentRouteName }: ActiveCallBannerProps) {
  const { calls, activeCallId, setInCallScreenMinimized } = useSoftphone();
  const [, setNow] = useState(() => Date.now());

  const activeCall = useMemo(() => {
    const activeFromId = activeCallId ? calls[activeCallId] : undefined;
    if (activeFromId && LIVE_CALL_STATES.has(activeFromId.state)) {
      return activeFromId;
    }

    return Object.values(calls).find((call) => LIVE_CALL_STATES.has(call.state));
  }, [activeCallId, calls]);

  const showTimer =
    activeCall?.state === CallState.CONNECTED ||
    activeCall?.state === CallState.HOLDING ||
    activeCall?.state === CallState.HELD;

  useEffect(() => {
    if (!showTimer) {
      return;
    }

    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => clearInterval(interval);
  }, [showTimer, activeCall?.sessionId]);

  if (!activeCall) {
    return null;
  }

  if (currentRouteName === Routes.InCallScreen || currentRouteName === Routes.Keypad) {
    return null;
  }

  const stateLabel = activeCall.isOnHold
    ? "On hold"
    : activeCall.state === CallState.INCOMING
    ? "Incoming call"
    : activeCall.state === CallState.CONNECTING ||
      activeCall.state === CallState.OUTGOING
    ? "Connecting..."
    : "Ongoing call";

  const peerLabel =
    activeCall.contactDisplayName || activeCall.remoteDisplayName || "Current call";

  const formatDuration = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hrs > 0) {
      return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(
        2,
        "0"
      )}:${String(secs).padStart(2, "0")}`;
    }

    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  };

  const timerStart = activeCall.answerTime || activeCall.startTime;
  const elapsedSeconds = timerStart
    ? Math.max(
        0,
        Math.floor((Date.now() - new Date(timerStart).getTime()) / 1000)
      )
    : 0;

  return (
    <Pressable
      style={styles.container}
      onPress={() => {
        setInCallScreenMinimized(false);
        navigate(Routes.InCallScreen, { callId: activeCall.sessionId });
      }}
    >
      <View>
        <Text
          color="white"
          size={13}
          weight="semiBold"
          align="left"
        >
          {stateLabel}
        </Text>
        <Text
          color="white"
          size={12}
          weight="medium"
          align="left"
        >
          {peerLabel}
        </Text>
      </View>
      {showTimer ? (
        <Text color="white" size={13} weight="semiBold" align="right">
          {formatDuration(elapsedSeconds)}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: 'rgba(0, 0, 0, 1)',
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  }
});
