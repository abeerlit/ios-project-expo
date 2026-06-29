import React, { useState, useEffect } from "react";
import {
  View,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert
} from "react-native";
import { useTheme } from "hooks/use-theme.ts";
import { padding, borderRadius, fontSize } from "core/theme/theme.ts";
import { Text } from "shared/components/Text.tsx";
import { WhiteSpace } from "shared/components/utils/Whitespace.tsx";
import { Button } from "shared/components/Button.tsx";
import { Avatar } from "shared/components/Avatar.tsx";
import { LoadingSpinner } from "shared/components/LoadingSpinner.tsx";
import Icon from "shared/components/Icon.tsx";
import { Logger } from "shared/utils/Logger.ts";
import { toast } from "@backpackapp-io/react-native-toast";
import { useSelector } from "react-redux";
import { State } from "store/types.ts";
import {
  listConferenceParticipants,
  toggleMuteConferenceParticipant,
  bootConferenceParticipant
} from "shared/api/conferencing/methods.ts";
import { ConferenceParticipant } from "shared/api/conferencing/types.ts";
import { formatPhoneNumber } from "shared/utils/formatters.ts";
import { useSoftphone } from "core/softphone/useSoftphone.ts";
import { findContactByPhoneNumber } from "features/calling/utils/contact-lookup.ts";

const logger = new Logger("ConferenceParticipantsDrawer");

interface ConferenceParticipantsDrawerProps {
  callId: string;
  conferenceId: string;
  onClose: () => void;
}

export function ConferenceParticipantsDrawer({
  callId,
  conferenceId,
  onClose
}: ConferenceParticipantsDrawerProps) {
  const theme = useTheme();
  const user = useSelector((state: State) => state.userReducer.user);
  const { personalContacts, companyContacts, directory, phoneContacts } =
    useSelector((state: State) => state.directoryReducer);
  const accessToken = useSelector(
    (state: State) => state.authReducer.accessToken
  );
  const { setMutedConferenceParticipant, removeMutedConferenceParticipant } =
    useSoftphone();

  const [participants, setParticipants] = useState<ConferenceParticipant[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Fetch participants on mount
  useEffect(() => {
    fetchParticipants();
  }, []);

  const fetchParticipants = async () => {
    if (!accessToken) return;

    try {
      setLoading(true);
      const fetchedParticipants = await listConferenceParticipants(
        callId,
        accessToken
      );
      setParticipants(fetchedParticipants);
    } catch (error) {
      logger.error("Failed to fetch conference participants:", error);
      toast.error("Failed to load participants");
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    if (!accessToken) return;

    try {
      setRefreshing(true);
      const fetchedParticipants = await listConferenceParticipants(
        callId,
        accessToken
      );
      setParticipants(fetchedParticipants);
    } catch (error) {
      logger.error("Failed to refresh participants:", error);
    } finally {
      setRefreshing(false);
    }
  };

  const handleToggleMute = async (
    participant: ConferenceParticipant,
    shouldMute: boolean
  ) => {
    if (!accessToken) return;

    try {
      await toggleMuteConferenceParticipant(
        callId,
        accessToken,
        participant.name,
        shouldMute
      );

      // Update local state
      setParticipants((prev) =>
        prev.map((p) =>
          p.name === participant.name ? { ...p, muted: shouldMute } : p
        )
      );

      // Update softphone state
      if (shouldMute) {
        setMutedConferenceParticipant(conferenceId, participant.name);
      } else {
        removeMutedConferenceParticipant(conferenceId, participant.name);
      }

      toast.success(shouldMute ? "Participant muted" : "Participant unmuted");
    } catch (error) {
      logger.error("Failed to toggle mute:", error);
      toast.error("Failed to mute participant");
    }
  };

  const handleRemoveParticipant = (participant: ConferenceParticipant) => {
    Alert.alert(
      "Remove Participant",
      `Are you sure you want to remove ${
        participant.cidName || participant.cidNum
      } from the conference?`,
      [
        {
          text: "Cancel",
          style: "cancel"
        },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => confirmRemoveParticipant(participant)
        }
      ]
    );
  };

  const confirmRemoveParticipant = async (
    participant: ConferenceParticipant
  ) => {
    if (!accessToken) return;

    try {
      await bootConferenceParticipant(callId, accessToken, participant.name);

      // Remove from local state
      setParticipants((prev) =>
        prev.filter((p) => p.name !== participant.name)
      );

      toast.success("Participant removed");

      // If only one participant left (just me), close the drawer
      if (participants.length <= 2) {
        onClose();
      }
    } catch (error) {
      logger.error("Failed to remove participant:", error);
      toast.error("Failed to remove participant");
    }
  };

  const isParticipantMe = (participant: ConferenceParticipant): boolean => {
    const extNum = user?.extNum;
    const callerIdNumber = user?.callerIdNumber;

    return (
      participant.cidNum === extNum || participant.cidNum === callerIdNumber
    );
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Text
            color="color-colors-text-text-primary"
            size={fontSize.lg}
            weight="semiBold"
          >
            Conference Participants
          </Text>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Icon name="x-close" size={24} />
          </TouchableOpacity>
        </View>
        <WhiteSpace height={padding.xl} />
        <View style={styles.loadingContainer}>
          <LoadingSpinner size={40} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text
          color="color-colors-text-text-primary"
          size={fontSize.lg}
          weight="semiBold"
        >
          Conference Participants
        </Text>
        <TouchableOpacity onPress={onClose} style={styles.closeButton}>
          <Icon name="x-close" size={24} />
        </TouchableOpacity>
      </View>

      <WhiteSpace height={padding.lg} />

      {/* Divider */}
      <View
        style={[
          styles.divider,
          {
            backgroundColor:
              theme.colors["color-colors-border-border-secondary"]
          }
        ]}
      />

      {/* Participants List */}
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshing={refreshing}
        onRefresh={handleRefresh}
      >
        {participants.map((participant) => {
          const isMe = isParticipantMe(participant);
          const contactMatch = isMe
            ? null
            : findContactByPhoneNumber(
                participant.cidNum,
                personalContacts,
                companyContacts,
                directory,
                phoneContacts
              );
          const cidNameSanitized = (() => {
            const raw = participant.cidName?.toString().trim();
            if (!raw || raw === "undefined" || raw === "null") return undefined;
            return raw;
          })();
          const avatarSource =
            (isMe && user?.avatarPath?.trim()) ||
            contactMatch?.avatarPath?.trim() ||
            undefined;
          const avatarName =
            (isMe && (user?.extName || user?.peerName || "You")) ||
            contactMatch?.name ||
            cidNameSanitized ||
            participant.cidNum;
          const primaryDisplayName = isMe
            ? "You"
            : contactMatch?.name ||
              cidNameSanitized ||
              formatPhoneNumber(participant.cidNum) ||
              (participant.cidNum != null ? String(participant.cidNum) : "");

          const mutedMicColor = participant.muted
            ? theme.colors["color-colors-foreground-fg-error-primary"]
            : theme.colors[
                "color-component-colors-components-buttons-tertiary-button-tertiary-fg"
              ];

          return (
            <View key={participant.id} style={styles.participantRow}>
              <View style={styles.participantInfo}>
                <Avatar
                  source={avatarSource}
                  size={40}
                  borderRadius={borderRadius.md}
                  name={avatarName}
                />
                <View style={styles.participantDetails}>
                  <View style={styles.nameRow}>
                    <Text
                      color="color-colors-text-text-secondary"
                      size={fontSize.sm}
                      weight="semiBold"
                      numberOfLines={1}
                      align="left"
                      style={styles.nameInRow}
                    >
                      {primaryDisplayName}
                    </Text>
                    {!isMe ? (
                      <View style={styles.rowActions}>
                        <TouchableOpacity
                          onPress={() =>
                            handleToggleMute(participant, !participant.muted)
                          }
                          style={styles.iconButton}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          accessibilityRole="button"
                          accessibilityLabel={
                            participant.muted ? "Unmute participant" : "Mute participant"
                          }
                        >
                          <Icon
                            name={
                              participant.muted
                                ? "microphone-off-02"
                                : "microphone-02"
                            }
                            size={20}
                            color={mutedMicColor}
                          />
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleRemoveParticipant(participant)}
                          style={styles.iconButton}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          accessibilityRole="button"
                          accessibilityLabel="Remove participant"
                        >
                          <Icon
                            name="minus-circle"
                            size={20}
                            color={
                              theme.colors[
                                "color-component-colors-components-buttons-tertiary-button-tertiary-fg"
                              ]
                            }
                          />
                        </TouchableOpacity>
                      </View>
                    ) : null}
                  </View>
                  <Text
                    color="color-colors-text-text-tertiary"
                    size={fontSize.sm}
                    weight="regular"
                    align="left"
                    style={styles.phoneLine}
                  >
                    {formatPhoneNumber(participant.cidNum)}
                  </Text>
                </View>
              </View>
            </View>
          );
        })}

        {participants.length === 0 && (
          <View style={styles.emptyState}>
            <Text
              color="color-colors-text-text-tertiary"
              size={fontSize.md}
              weight="regular"
              align="center"
            >
              No participants in conference
            </Text>
          </View>
        )}
      </ScrollView>

      {/* Footer */}
      <View style={styles.footer}>
        <View
          style={[
            styles.divider,
            {
              backgroundColor:
                theme.colors["color-colors-border-border-secondary"]
            }
          ]}
        />
        <WhiteSpace height={padding.xl} />
        <Button type="secondary" onPress={onClose} size={fontSize.md}>
          Done
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: padding["3xl"],
    paddingTop: padding["3xl"]
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center"
  },
  closeButton: {
    padding: padding.sm
  },
  divider: {
    height: 1,
    width: "100%"
  },
  scrollView: {
    flex: 1,
    marginTop: padding.xl
  },
  scrollContent: {
    paddingBottom: padding.xl
  },
  participantRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: padding.md,
    marginBottom: padding.sm
  },
  participantInfo: {
    flexDirection: "row",
    alignItems: "flex-start",
    flex: 1,
    minWidth: 0,
    gap: padding.md
  },
  participantDetails: {
    flex: 1,
    minWidth: 0
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: padding.sm,
    minHeight: 24
  },
  nameInRow: {
    flex: 1,
    minWidth: 0,
    marginLeft: 10
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    gap: padding.xs
  },
  phoneLine: {
    marginLeft: 10,
    marginTop: 4
  },
  iconButton: {
    padding: padding.xs
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center"
  },
  emptyState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: padding["4xl"]
  },
  footer: {
    paddingTop: padding["2xl"],
    paddingBottom: padding.xl
  }
});
