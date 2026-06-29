import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  Dimensions,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View
} from "react-native";
import {
  Gesture,
  GestureDetector
} from "react-native-gesture-handler";
import Reanimated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming
} from "react-native-reanimated";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "shared/components/Text.tsx";
import Icon from "shared/components/Icon.tsx";
import { fontSize, padding } from "core/theme/theme.ts";
import type { MeetingChatMessage } from "features/meeting/meetingChatProtocol.ts";

const WIN_H = Dimensions.get("window").height;
const SHEET_FRACTION_CLOSED = 0.72;
const SHEET_FRACTION_KEYBOARD_OPEN = 0.8;
const SHEET_MAX_CLOSED = Math.min(WIN_H * SHEET_FRACTION_CLOSED, 580);
const MAX_MESSAGE_CHARS = 4000;
/** Keep some space below the status bar/notch when expanded. */
const SHEET_TOP_GAP = 44;
/** Match DrawerProvider swipe-to-dismiss thresholds. */
const SWIPE_CLOSE_TRANSLATION_Y = 100;
const SWIPE_CLOSE_VELOCITY_Y = 800;

export type MeetingChatSheetProps = {
  visible: boolean;
  onClose: () => void;
  messages: MeetingChatMessage[];
  onSend: (text: string) => void;
  /** Shown in input placeholder, e.g. display name */
  composerHint?: string;
  canSend: boolean;
  /** Daily local participant `session_id` — aligns bubbles left/right like web DM. */
  localSessionId: string;
};

type SheetBodyProps = Omit<MeetingChatSheetProps, "visible"> & {
  hardwareBackRef: React.MutableRefObject<() => void>;
};

const MeetingChatSheetBody = ({
  onClose,
  messages,
  onSend,
  composerHint,
  canSend,
  localSessionId,
  hardwareBackRef
}: SheetBodyProps) => {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const listRef = useRef<FlatList<MeetingChatMessage>>(null);
  const [draft, setDraft] = useState("");
  /** RN KeyboardAvoidingView is unreliable inside transparent Modal + fixed-height sheet; lift whole sheet. */
  const [keyboardBottomInset, setKeyboardBottomInset] = useState(0);
  /** Height of the safe content area (window minus safe-area insets). */
  const safeContentHeight = useMemo(
    () => Math.max(1, windowHeight - insets.top - insets.bottom),
    [insets.bottom, insets.top, windowHeight]
  );

  /**
   * Keyboard closed: ~72% of safe area (capped).
   * Keyboard open: up to 80% of safe area, capped so the sheet + composer stay above the keyboard
   * (`modalRoot` uses `paddingBottom: keyboard` so the input row sits on the keyboard top).
   */
  const sheetHeight = useMemo(() => {
    const gap = 10;
    // Guard the sheet top so it stays below the status bar / notch.
    const topGuard = Math.max(SHEET_TOP_GAP, padding.lg);
    const kb = keyboardBottomInset;
    const spaceAboveKeyboard = Math.max(0, safeContentHeight - kb - gap);
    const maxAboveStatusBar = Math.max(0, safeContentHeight - topGuard - gap);
    if (kb > 0) {
      const target = safeContentHeight * SHEET_FRACTION_KEYBOARD_OPEN;
      return Math.max(280, Math.min(target, spaceAboveKeyboard, maxAboveStatusBar));
    }
    return Math.max(
      260,
      Math.min(SHEET_MAX_CLOSED, Math.max(0, safeContentHeight - gap), maxAboveStatusBar)
    );
  }, [keyboardBottomInset, safeContentHeight]);

  const sheetHeightRef = useRef(sheetHeight);
  sheetHeightRef.current = sheetHeight;

  const translateY = useSharedValue(sheetHeight);
  const dragStartY = useSharedValue(0);
  const sheetMaxY = useSharedValue(sheetHeight);

  useEffect(() => {
    sheetMaxY.value = sheetHeight;
  }, [sheetHeight, sheetMaxY]);

  useEffect(() => {
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const onShow = (e: { endCoordinates: { height: number } }) => {
      const h = e.endCoordinates.height;
      setKeyboardBottomInset(h);
      if (h > 0) {
        requestAnimationFrame(() => {
          listRef.current?.scrollToEnd({ animated: true });
        });
      }
    };
    const onHide = () => {
      setKeyboardBottomInset(0);
    };
    const subShow = Keyboard.addListener(showEvent, onShow);
    const subHide = Keyboard.addListener(hideEvent, onHide);
    return () => {
      subShow.remove();
      subHide.remove();
    };
  }, []);

  useLayoutEffect(() => {
    const h = sheetHeightRef.current;
    translateY.value = h;
    translateY.value = withTiming(0, { duration: 240 });
  }, [translateY]);

  const finishClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const closeAnimated = useCallback(() => {
    const h = sheetHeightRef.current;
    translateY.value = withTiming(h, { duration: 220 }, (finished) => {
      if (finished) {
        runOnJS(finishClose)();
      }
    });
  }, [finishClose, translateY]);

  useLayoutEffect(() => {
    hardwareBackRef.current = closeAnimated;
  }, [closeAnimated, hardwareBackRef]);

  const sheetPanGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(keyboardBottomInset === 0)
        .activeOffsetY(6)
        .failOffsetX([-24, 24])
        .onBegin(() => {
          dragStartY.value = translateY.value;
        })
        .onUpdate((event) => {
          const newY = dragStartY.value + Math.max(0, event.translationY);
          translateY.value = Math.min(newY, sheetMaxY.value);
        })
        .onEnd((event) => {
          const shouldClose =
            event.translationY > SWIPE_CLOSE_TRANSLATION_Y ||
            event.velocityY > SWIPE_CLOSE_VELOCITY_Y;
          if (shouldClose) {
            translateY.value = withTiming(
              sheetMaxY.value,
              { duration: 220 },
              (finished) => {
                if (finished) {
                  runOnJS(finishClose)();
                }
              }
            );
            return;
          }
          translateY.value = withSpring(0, {
            damping: 20,
            stiffness: 300
          });
        }),
    [finishClose, keyboardBottomInset, dragStartY, sheetMaxY, translateY]
  );

  const sheetAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }]
  }));

  const lastMessageId = messages[messages.length - 1]?.id;

  useEffect(() => {
    if (messages.length === 0) return;
    const t = requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
    return () => cancelAnimationFrame(t);
  }, [lastMessageId, messages.length]);

  const placeholder = useMemo(
    () =>
      composerHint?.trim()
        ? `Message as ${composerHint.trim()}…`
        : "Message everyone…",
    [composerHint]
  );

  const submit = useCallback(() => {
    const t = draft.trim();
    if (!t || !canSend) return;
    onSend(t);
    setDraft("");
  }, [canSend, draft, onSend]);

  /** When keyboard is open, sheet is already lifted — only small inner padding under the composer. */
  const composerBottomPad =
    keyboardBottomInset > 0 ? padding.sm : Math.max(insets.bottom, padding.md);

  const sheetBody = (
    <Reanimated.View
      style={[
        styles.sheet,
        { height: sheetHeight },
        sheetAnimatedStyle
      ]}
    >
      <GestureDetector gesture={sheetPanGesture}>
        <View style={styles.sheetDragHeader}>
          <View style={styles.handleStrip}>
            <View style={styles.grab} />
          </View>
          <View style={styles.panelHeader}>
            <Text size={fontSize.md} weight="semiBold" color="white">
              Chat
            </Text>
            <Pressable
              onPress={closeAnimated}
              hitSlop={12}
              style={styles.closeHit}
              accessibilityRole="button"
              accessibilityLabel="Close chat"
            >
              <Icon name="x-close" size={22} color="white" />
            </Pressable>
          </View>
        </View>
      </GestureDetector>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        style={styles.list}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: padding.sm }
        ]}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item, index }) => {
          const mine =
            !!localSessionId && item.fromSessionId === localSessionId;
          const prev = index > 0 ? messages[index - 1] : null;
          const sameSender =
            !!prev && prev.fromSessionId === item.fromSessionId;
          /** Start of a new sender group — show label above bubble (standard chat pattern). */
          const groupStarts = !sameSender;
          const showTheirName = !mine && groupStarts;
          /** Subtle “You” only when your message starts a new run (not repeated on every line). */
          const showYouLabel = mine && groupStarts;

          return (
            <View
              style={[
                styles.messageCluster,
                mine ? styles.messageClusterMine : styles.messageClusterTheirs,
                sameSender ? styles.messageClusterTight : styles.messageClusterGap
              ]}
            >
              {showTheirName ? (
                <Text
                  size={fontSize.xs}
                  weight="medium"
                  color="white"
                  style={styles.senderLabelTheirs}
                  numberOfLines={1}
                >
                  {item.senderName}
                </Text>
              ) : null}
              {showYouLabel ? (
                <Text
                  size={fontSize.xs}
                  weight="medium"
                  color="white"
                  style={styles.senderLabelMine}
                  numberOfLines={1}
                >
                  You
                </Text>
              ) : null}
              <View
                style={[
                  styles.bubble,
                  mine ? styles.bubbleMine : styles.bubbleTheirs
                ]}
              >
                <Text size={fontSize.sm} color="white" align="left" style={styles.bubbleText}>
                  {item.text} 
                </Text>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          <Text
            size={fontSize.sm}
            weight="medium"
            color="white"
            style={styles.emptyHint}
          >
            No messages yet. Say hi to the room.
          </Text>
        }
      />

      <View
        style={[
          styles.composerRow,
          {
            paddingBottom: composerBottomPad,
            alignItems: keyboardBottomInset > 0 ? "center" : "flex-end",
            borderTopWidth: keyboardBottomInset > 0 ? 1 : 0,
            paddingHorizontal: 14
          }
        ]}
      >
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={placeholder}
          placeholderTextColor="rgba(255,255,255,0.45)"
          multiline
          maxLength={MAX_MESSAGE_CHARS}
          editable={canSend}
          returnKeyType="default"
          blurOnSubmit={false}
          keyboardAppearance="dark"
        />
        <TouchableOpacity
          style={[
            styles.sendButton,
            (!draft.trim() || !canSend) && styles.sendButtonDisabled
          ]}
          onPress={submit}
          disabled={!draft.trim() || !canSend}
          accessibilityRole="button"
          accessibilityLabel="Send message"
        >
          <Icon name="send-03" size={22} color="white" />
        </TouchableOpacity>
      </View>
    </Reanimated.View>
  );

  return (
    <View
      style={[
        styles.modalRoot,
        keyboardBottomInset > 0 && { paddingBottom: keyboardBottomInset }
      ]}
    >
      <Pressable style={styles.backdrop} onPress={closeAnimated} />
      {Platform.OS === "android" ? (
        <KeyboardAvoidingView
          behavior="height"
          style={styles.keyboardAvoid}
          keyboardVerticalOffset={0}
        >
          {sheetBody}
        </KeyboardAvoidingView>
      ) : (
        sheetBody
      )}
    </View>
  );
};

export const MeetingChatSheet = ({
  visible,
  onClose,
  messages,
  onSend,
  composerHint,
  canSend,
  localSessionId
}: MeetingChatSheetProps) => {
  const hardwareBackClose = useRef<() => void>(() => {
    onClose();
  });

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={() => hardwareBackClose.current()}
    >
      <SafeAreaView style={styles.safeFill} edges={["top", "bottom", "left", "right"]}>
        <MeetingChatSheetBody
          onClose={onClose}
          messages={messages}
          onSend={onSend}
          composerHint={composerHint}
          canSend={canSend}
          localSessionId={localSessionId}
          hardwareBackRef={hardwareBackClose}
        />
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  safeFill: {
    flex: 1
  },
  modalRoot: {
    flex: 1,
    justifyContent: "flex-end"
  },
  keyboardAvoid: {
    flex: 1,
    width: "100%",
    justifyContent: "flex-end"
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(2, 6, 23, 0.55)"
  },
  sheet: {
    backgroundColor: "#1e1f20",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    overflow: "hidden"
  },
  sheetDragHeader: {
    width: "100%"
  },
  handleStrip: {
    width: "100%",
    minHeight: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 10,
    paddingBottom: 6
  },
  grab: {
    width: 42,
    height: 4,
    borderRadius: 4,
    backgroundColor: "#3a3f44"
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: padding.lg,
    paddingBottom: padding.sm
  },
  closeHit: {
    padding: padding.xs
  },
  list: {
    flex: 1,
    minHeight: 120
  },
  listContent: {
    paddingHorizontal: padding.md,
    flexGrow: 1
  },
  emptyHint: {
    textAlign: "center",
    marginTop: padding.xl,
    opacity: 0.7
  },
  /** One logical message: optional sender row + bubble, aligned L/R like iMessage-style apps. */
  messageCluster: {
    maxWidth: "78%"
  },
  messageClusterMine: {
    alignSelf: "flex-end",
    alignItems: "flex-end"
  },
  messageClusterTheirs: {
    alignSelf: "flex-start",
    alignItems: "flex-start"
  },
  /** Tighter vertical gap when same person sends consecutive messages. */
  messageClusterTight: {
    marginBottom: 4
  },
  messageClusterGap: {
    marginBottom: 14
  },
  senderLabelTheirs: {
    opacity: 0.55,
    marginBottom: 4,
    paddingHorizontal: 2,
    maxWidth: "100%"
  },
  senderLabelMine: {
    opacity: 0.45,
    marginBottom: 4,
    paddingHorizontal: 2,
    textAlign: "right",
    alignSelf: "flex-end"
  },
  /** Asymmetric radius reads as “tail” toward the thread edge (common chat UI). */
  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: "100%"
  },
  bubbleMine: {
    backgroundColor: "#3f9df8",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 5
  },
  bubbleTheirs: {
    backgroundColor: "#2a2f34",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.10)",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomRightRadius: 18,
    borderBottomLeftRadius: 5
  },
  bubbleText: {
    flexShrink: 1
  },
  composerRow: {
    flexDirection: "row",
    paddingHorizontal: padding.md,
    paddingTop: padding.sm,
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.12)",
    height: 80,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#2a2f34",
    color: "#fff",
    fontSize: fontSize.sm
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#3f9df8",
    alignItems: "center",
    justifyContent: "center"
  },
  sendButtonDisabled: {
    opacity: 0.35
  }
});
