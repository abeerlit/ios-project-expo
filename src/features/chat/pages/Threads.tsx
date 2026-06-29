// React Imports
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import {
  View,
  StyleSheet,
  ListRenderItemInfo,
  Platform,
  KeyboardAvoidingView
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSelector } from "react-redux";
import { useParams } from "hooks/use-params.ts";
import { Asset } from "react-native-image-picker";
import { toast } from "@backpackapp-io/react-native-toast";

// Editor Imports
import {
  BlockquoteBridge,
  BoldBridge,
  BridgeExtension,
  BulletListBridge,
  CodeBridge,
  CoreBridge,
  HistoryBridge,
  ImageBridge,
  ItalicBridge,
  OrderedListBridge,
  PlaceholderBridge,
  StrikeBridge,
  useEditorBridge,
  type EditorBridge
} from "@10play/tentap-editor";
import { Mention } from "@tiptap/extension-mention";

// Type Imports
import { MentionType, MessageMetaArray } from "@sendbird/chat/message";
import { Routes } from "core/navigation/types/types.ts";
import { AuthParams } from "core/navigation/navigators/AuthenticatedStack.tsx";
import { State } from "store/types.ts";
import { ChatMessage } from "features/chat/types.ts";
import { EditorMention } from "features/chat/rich-editor/types.ts";
import { useSoftphone } from "core/softphone/useSoftphone.ts";
import { CallState } from "core/softphone/types.ts";
import { getCurrentRoute } from "core/navigation/utils/Ref.ts";
import { useMeetingActive } from "features/meeting/MeetingActiveContext.tsx";

// Component Imports
import { Logger } from "shared/utils/Logger.ts";
import { Screen } from "shared/components/utils/Screen.tsx";
import { FlatList } from "shared/components/utils/Flatlist.tsx";
import { ChannelHeader } from "features/chat/components/ChannelHeader.tsx";
import { Message } from "features/chat/components/Message.tsx";
import { RichEditorProvider } from "features/chat/rich-editor/context/RichEditorProvider.tsx";
import { Editor } from "features/chat/rich-editor/AdvancedRichText.tsx";
import { MentionActionType } from "features/chat/rich-editor/mentions/MentionBridge.ts";
import { LinkBridge } from "features/chat/rich-editor/bridges/LinkBridge.ts";
import { editorHtml } from "features/chat/editor/build/editorHtml.ts";
import { fontSize, padding } from "core/theme/theme.ts";
import { useRichEditor } from "features/chat/rich-editor/context/RichEditorContext.ts";
import { useSendbirdContext } from "features/chat/utils/SendbirdContext.ts";
import { useTheme } from "hooks/use-theme.ts";
import { useDispatch } from "react-redux";
import * as sendbirdActions from "store/sendbird/actions.ts";
import { UnreadCountCache } from "features/chat/utils/unreadCountCache.ts";
import { ChatSkeletonLoader } from "features/chat/components/ChatSkeletonLoader.tsx";
import { Text } from "shared/components/Text.tsx";

const INITIAL_BATCH_SIZE = 20;
const MENTION_CHAR = "@";
const MAX_VALUE_LENGTH = 128;
const IOS_KEYBOARD_EXTRA_OFFSET = 52;
/** Extra `keyboardVerticalOffset` per top banner row (active call / minimized meeting). */
const IOS_ACTIVE_CALL_BANNER_ROW_HEIGHT = 95;

const LIVE_CALL_STATES = new Set<CallState>([
  CallState.INCOMING,
  CallState.OUTGOING,
  CallState.CONNECTING,
  CallState.CONNECTED,
  CallState.HOLDING,
  CallState.HELD
]);

const logger = new Logger("Threads");

const isGenericThreadSenderLabel = (
  label: string | undefined,
  channelName: string
): boolean => {
  if (!label?.trim()) return true;
  const n = label.trim();
  if (channelName && n === channelName) return true;
  if (/^group\s*channel$/i.test(n)) return true;
  return false;
};

/** Resolve parent author for "Reply to …" — avoid channel name / Sendbird generic labels. */
const resolveThreadParentSenderDisplayName = (params: {
  displayMessage: ChatMessage | null | undefined;
  user: { id: number } | null | undefined;
  directory: Array<{ userId?: string | number; name?: string }>;
  currentChannel: {
    name?: string;
    members?: Array<{ userId: string; nickname?: string }>;
  } | null;
}): { name: string; debug: Record<string, unknown> } => {
  const { displayMessage, user, directory, currentChannel } = params;
  const channelName = currentChannel?.name?.trim() ?? "";

  if (!displayMessage) {
    return { name: "thread", debug: { source: "no-display-message" } };
  }

  if (displayMessage.messageType === "admin") {
    return {
      name: "Channel Admin",
      debug: {
        source: "admin",
        messageId: displayMessage.messageId
      }
    };
  }

  const senderUserId = displayMessage.sender?.userId;

  // Parent author is the logged-in user — use "yourself" before directory (custom contact names).
  if (user && senderUserId && String(senderUserId) === String(user.id)) {
    return {
      name: "yourself",
      debug: {
        source: "local-user",
        messageId: displayMessage.messageId,
        senderUserId
      }
    };
  }

  const contact = directory.find((c) => c.userId?.toString() === senderUserId);
  const member = currentChannel?.members?.find((m) => m.userId === senderUserId);

  const candidates: Array<{ source: string; value?: string }> = [
    { source: "directory", value: contact?.name?.trim() },
    { source: "channelMember", value: member?.nickname?.trim() },
    { source: "sendbirdSender", value: displayMessage.sender?.nickname?.trim() }
  ];

  const rejected: string[] = [];
  for (const c of candidates) {
    if (c.value && isGenericThreadSenderLabel(c.value, channelName)) {
      rejected.push(`${c.source}:"${c.value}"`);
    }
  }

  const picked = candidates.find(
    (c) => c.value && !isGenericThreadSenderLabel(c.value, channelName)
  );
  const name = picked?.value ?? "Unknown";

  return {
    name,
    debug: {
      source: picked?.source ?? "fallback-unknown",
      messageId: displayMessage.messageId,
      senderUserId,
      channelName,
      contactName: contact?.name,
      memberNickname: member?.nickname,
      senderNickname: displayMessage.sender?.nickname,
      rejectedCandidates: rejected.length > 0 ? rejected : undefined,
      candidateValues: Object.fromEntries(
        candidates.map((c) => [c.source, c.value ?? null])
      )
    }
  };
};

type ThreadChatComposerMountProps = {
  threadComposerPlaceholder: string;
  themedEditor: string;
  createMentionBridge: () => BridgeExtension;
  onEditorBridge: (editor: EditorBridge) => void;
  handleGifUpload: (value: {
    title: string;
    url: string;
    height: number;
    width: number;
  }) => void;
  handleFileUpload: (files: Asset[]) => void;
  handleSendMessage: (params: {
    message: string;
    mentionedUsers: string[];
  }) => void;
};

/** Remount when placeholder changes — `useEditorBridge` only applies PlaceholderBridge on init. */
const ThreadChatComposerMount: React.FC<ThreadChatComposerMountProps> = ({
  threadComposerPlaceholder,
  themedEditor,
  createMentionBridge,
  onEditorBridge,
  handleGifUpload,
  handleFileUpload,
  handleSendMessage
}) => {
  const bridgeExtensions = useMemo(
    () => [
      CoreBridge,
      ImageBridge,
      BoldBridge,
      ItalicBridge,
      StrikeBridge,
      LinkBridge,
      CodeBridge,
      HistoryBridge,
      BlockquoteBridge.configureExtension({
        HTMLAttributes: {
          class: "pl-1 border-l-2 border-colors-border-border-primary text-base"
        }
      }),
      OrderedListBridge.configureExtension({
        HTMLAttributes: {
          class: "pl-5 list-decimal list-outside text-base"
        }
      }),
      BulletListBridge.configureExtension({
        HTMLAttributes: {
          class: "pl-5 list-disc list-outside text-base"
        },
        keepMarks: true,
        keepAttributes: true
      }),
      PlaceholderBridge.configureExtension({
        placeholder: threadComposerPlaceholder
      }),
      createMentionBridge()
    ],
    [createMentionBridge, threadComposerPlaceholder]
  );

  const editor = useEditorBridge({
    customSource: themedEditor,
    bridgeExtensions,
    avoidIosKeyboard: true
  });

  const onEditorBridgeRef = useRef(onEditorBridge);
  onEditorBridgeRef.current = onEditorBridge;

  useEffect(() => {
    onEditorBridgeRef.current(editor);
    logger.debug("[Threads] Editor bridge ready", {
      threadComposerPlaceholder
    });
    // Intentionally once per mount — `editor` identity changes every render from useEditorBridge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Editor
      editor={editor}
      handleGifUpload={handleGifUpload}
      sendMessage={handleSendMessage}
      handleFile={handleFileUpload}
    />
  );
};

const ThreadsChatComponent: React.FC = () => {
  // Navigation
  const { channelUrl, parentMessage, scrollToMessageId } =
    useParams<AuthParams[Routes.Threads]>();

  // Refs
  const flatListRef = useRef<any>(null);
  const hasScrolledToMessage = useRef(false);
  const composerEditorRef = useRef<EditorBridge | null>(null);

  // Hooks
  const insets = useSafeAreaInsets();
  const { calls, activeCallId } = useSoftphone();
  const { meetingActiveGlobally } = useMeetingActive();
  const theme = useTheme();
  const {
    toggleMentionSuggestion,
    isEditing,
    editMessage,
    setEditing,
    setMentionQuery
  } = useRichEditor();

  // Redux State
  const dispatch = useDispatch();
  const { user } = useSelector((state: State) => state.userReducer);
  const { directory } = useSelector((state: State) => state.directoryReducer);

  // Context
  const {
    currentChannel,
    sendUserMessage,
    sendFileMessage,
    sendMultipleFileMessage,
    editUserMessage,
    isConnected,
    activeParentMessage,
    threadMessages,
    setActiveThread,
    clearActiveThread,
    loadThreadFromCache,
    markChannelAsRead,
    fetchThreadMessages,
    isFetchingThread
  } = useSendbirdContext();

  // Thread-specific state (now using context)
  const messages = threadMessages;

  // Scroll to specific message when loaded (e.g., from reaction notification)
  useEffect(() => {
    if (
      !scrollToMessageId ||
      hasScrolledToMessage.current ||
      messages.length === 0
    )
      return;

    const messageIndex = messages.findIndex(
      (msg) => msg.messageId.toString() === scrollToMessageId
    );

    if (messageIndex !== -1 && flatListRef.current) {
      // Small delay to ensure list is rendered
      setTimeout(() => {
        try {
          flatListRef.current?.scrollToIndex({
            index: messageIndex,
            animated: true,
            viewPosition: 0.5 // Center the message
          });
          hasScrolledToMessage.current = true;
          logger.debug("📍 [Threads] Scrolled to message:", scrollToMessageId);
        } catch (error) {
          logger.debug("⚠️ [Threads] Could not scroll to message:", error);
        }
      }, 300);
    }
  }, [messages, scrollToMessageId]);

  // Enter channel effect
  useEffect(() => {
    const enterChannel = async () => {
      if (channelUrl && currentChannel?.url !== channelUrl) {
        // This would typically be handled by the context
        logger.debug("Entering thread channel:", channelUrl);
      }
    };

    if (channelUrl) {
      void enterChannel();
    }
  }, [channelUrl, currentChannel]);

  // Set up active thread and fetch messages
  useEffect(() => {
    if (!parentMessage || !isConnected) return;

    // 1) Show cached replies immediately (sync, uses channelUrl from params)
    if (channelUrl) {
      loadThreadFromCache(channelUrl, parentMessage.messageId);
    }

    // 2) Set this thread as active and store the parent message
    setActiveThread(parentMessage.messageId, parentMessage);

    const setupThread = async () => {
      // 3) Mark channel as read (fire-and-forget, uses channelUrl from params)
      if (channelUrl) {
        void markChannelAsRead(channelUrl).then(() => {
          dispatch(sendbirdActions.resetChannelUnread(channelUrl));
          UnreadCountCache.setUnreadCount(channelUrl, 0);
        });
      }

      // 4) Sync from API (fetchThreadMessages accepts channelUrl - works even when currentChannel not set)
      await fetchThreadMessages(parentMessage, channelUrl);
    };

    void setupThread();

    // Cleanup: clear active thread when component unmounts
    return () => {
      clearActiveThread();
    };
  }, [
    parentMessage,
    isConnected,
    channelUrl,
    dispatch,
    setActiveThread,
    clearActiveThread,
    loadThreadFromCache,
    markChannelAsRead,
    fetchThreadMessages
  ]);

  // Utility Methods
  const splitValue = useCallback((value: string): string[] => {
    if (value.length <= MAX_VALUE_LENGTH) {
      return [value];
    }

    const midpoint = Math.ceil(value.length / 2);
    const firstHalf = value.substring(0, midpoint);
    const secondHalf = value.substring(midpoint);

    return [...splitValue(firstHalf), ...splitValue(secondHalf)];
  }, []);

  const getGifMetaArrays = useCallback(
    (gif: {
      title: string;
      url: string;
      height: number;
      width: number;
    }): MessageMetaArray[] => {
      const metaArrays: MessageMetaArray[] = [];
      const { title, url, height, width } = gif;

      const metaItems = [
        { key: "title", value: title },
        { key: "url", value: url },
        { key: "height", value: String(height) },
        { key: "width", value: String(width) }
      ];

      metaItems.forEach(({ key, value }) => {
        if (value) {
          const splitValues = splitValue(value);
          metaArrays.push(new MessageMetaArray({ key, value: splitValues }));
        }
      });

      return metaArrays;
    },
    [splitValue]
  );

  const parentSenderResolution = useMemo(() => {
    const displayMessage = (activeParentMessage || parentMessage) as
      | ChatMessage
      | undefined;
    return resolveThreadParentSenderDisplayName({
      displayMessage,
      user,
      directory,
      currentChannel
    });
  }, [activeParentMessage, directory, parentMessage, user, currentChannel]);

  const parentSenderDisplayName = parentSenderResolution.name;
  const threadComposerPlaceholder = `Reply to ${parentSenderDisplayName}...`;
  const editorMountKey = `${parentMessage?.messageId ?? 0}:${parentSenderDisplayName}`;

  useEffect(() => {
    logger.debug("[Threads] Thread composer placeholder resolved", {
      editorMountKey,
      threadComposerPlaceholder,
      parentSenderDisplayName,
      parentMessageId: parentMessage?.messageId,
      activeParentMessageId: activeParentMessage?.messageId,
      usesActiveParent: !!activeParentMessage,
      channelUrl,
      currentChannelName: currentChannel?.name,
      resolution: parentSenderResolution.debug,
      routeParentSender: parentMessage
        ? {
            userId: parentMessage.sender?.userId,
            nickname: parentMessage.sender?.nickname
          }
        : null,
      activeParentSender: activeParentMessage
        ? {
            userId: activeParentMessage.sender?.userId,
            nickname: activeParentMessage.sender?.nickname
          }
        : null
    });
  }, [
    activeParentMessage?.messageId,
    activeParentMessage?.sender?.userId,
    activeParentMessage?.sender?.nickname,
    channelUrl,
    currentChannel?.name,
    editorMountKey,
    parentMessage?.messageId,
    parentMessage?.sender?.userId,
    parentMessage?.sender?.nickname,
    parentSenderDisplayName,
    parentSenderResolution.debug.source,
    threadComposerPlaceholder
  ]);

  const handleComposerEditorBridge = useCallback((bridge: EditorBridge) => {
    composerEditorRef.current = bridge;
  }, []);

  // Message Handlers
  const handleLoadMore = useCallback(async () => {
    // For threads, we might implement pagination differently
    // This is a placeholder for now
    if (!isFetchingThread && parentMessage) {
      try {
        // Additional message loading logic could go here
        logger.debug("Loading more thread messages...");
      } catch (error) {
        logger.error("Failed to fetch more thread messages:", error);
      }
    }
  }, [isFetchingThread, parentMessage]);

  const handleGifUpload = useCallback(
    (value: { title: string; url: string; height: number; width: number }) => {
      try {
        const metaArrays = getGifMetaArrays(value);
        sendUserMessage({
          customType: "MESSAGE_GIF",
          message: "",
          metaArrays: metaArrays,
          parentMessageId: parentMessage?.messageId,
          isReplyToChannel: true
        });
      } catch (error) {
        logger.error("Failed to upload GIF:", error);
        toast.error("Error uploading GIF");
      }
    },
    [getGifMetaArrays, sendUserMessage, parentMessage]
  );

  const handleFileUpload = useCallback(
    (files: Asset[]) => {
      try {
        if (files.length === 1) {
          const file = files[0];
          if (!file.uri) {
            logger.debug("File URI not found");
            toast.error("Error sending message");
            return;
          }

          sendFileMessage({
            file: {
              uri: file.uri,
              name: file.fileName || "",
              type: file.type || ""
            },
            fileSize: file.fileSize,
            fileName: file.fileName,
            mimeType: file.type,
            parentMessageId: parentMessage?.messageId,
            isReplyToChannel: true
          });
        } else {
          const adaptedFiles = files.map((item) => ({
            file: {
              uri: item.uri || "",
              name: item.fileName || "",
              type: item.type || ""
            },
            fileSize: item.fileSize,
            fileName: item.fileName,
            mimeType: item.type
          }));
          sendMultipleFileMessage({
            fileInfoList: adaptedFiles,
            parentMessageId: parentMessage?.messageId,
            isReplyToChannel: true
          });
        }
      } catch (error) {
        logger.error("Failed to upload files:", error);
        toast.error("Error uploading files");
      }
    },
    [sendFileMessage, sendMultipleFileMessage, parentMessage]
  );

  const handleSendMessage = useCallback(
    async ({
      message,
      mentionedUsers
    }: {
      message: string;
      mentionedUsers: string[];
    }) => {
      try {
        logger.debug("[Thread Send] editMessage:", editMessage);
        logger.debug(
          "[Thread Send] editMessage?.messageId:",
          editMessage?.messageId
        );
        logger.debug("[Thread Send] isEditing:", isEditing);

        if (isEditing && editMessage?.messageId) {
          logger.debug("[Thread Send] Editing message:", editMessage.messageId);
          await editUserMessage(message, editMessage.messageId);
          setEditing(null);
        } else {
          logger.debug(
            "[Thread Send] Creating new thread message with parentId:",
            parentMessage?.messageId
          );
          sendUserMessage({
            message,
            mentionType: MentionType.USERS,
            mentionedUserIds: mentionedUsers.map((i) => i.toString()),
            parentMessageId: parentMessage?.messageId,
            isReplyToChannel: true
          });
        }
      } catch (error) {
        logger.error("Failed to send message:", error);
        toast.error("Error sending message");
      }
    },
    [
      editMessage,
      isEditing,
      sendUserMessage,
      editUserMessage,
      setEditing,
      parentMessage
    ]
  );

  // Bridge Configuration
  const createMentionBridge = useCallback(() => {
    const handleMentionQuery = (message: { payload: string; type: string }) => {
      toggleMentionSuggestion(true);
      setMentionQuery(message.payload);
    };

    const handleExitMention = () => {
      toggleMentionSuggestion(false);
      setMentionQuery("");
    };

    return new BridgeExtension({
      tiptapExtension: Mention.configure({
        HTMLAttributes: {
          class:
            "bg-component-colors-utility-brand-utility-brand-50 hover:bg-component-colors-utility-brand-utility-brand-100 transition duration-100 border border-component-colors-utility-brand-utility-brand-200 text-component-colors-utility-brand-utility-brand-700 rounded-md p-0.5 cursor-pointer"
        },
        renderText({ options, node }) {
          return `${options.suggestion.char}${
            node.attrs.label ?? node.attrs.id
          }`;
        },
        deleteTriggerWithBackspace: true,
        suggestion: {
          char: MENTION_CHAR,
          allowSpaces: false,
          items: () => []
        }
      }),
      onEditorMessage: (message, editorBridge) => {
        if (message.type === "mention-query") {
          editorBridge.mentionQuery(message);
          return true;
        } else if (message.type === MentionActionType.ExitMention) {
          editorBridge.exitMention();
          return true;
        }
        return false;
      },
      extendEditorInstance: (sendBridgeMessage) => ({
        mentionQuery: handleMentionQuery,
        insertMentionChar: () => {
          sendBridgeMessage({ type: MentionActionType.InsertMentionChar });
        },
        insertMention: (item: EditorMention) => {
          sendBridgeMessage({
            type: MentionActionType.InsertMention,
            payload: item
          });
        },
        exitMention: handleExitMention
      })
    });
  }, [toggleMentionSuggestion, setMentionQuery]);

  const themedEditor = useMemo(
    () =>
      editorHtml
        .replace(
          "{{theme-background}}",
          theme.colors["color-colors-background-bg-primary"]
        )
        .replace(
          "{{theme-color}}",
          theme.colors["color-colors-text-text-primary"]
        ),
    [theme.colors]
  );

  // Render Methods
  const renderMessage = useCallback(
    ({ item, index }: ListRenderItemInfo<ChatMessage>) => {
      const prevMessage =
        index < messages.length - 1 ? messages[index + 1] : null;
      return (
        <Message
          message={item}
          prevMessage={prevMessage}
          editor={composerEditorRef.current ?? undefined}
          isInThread={true}
        />
      );
    },
    [messages]
  );

  const keyExtractor = useCallback(
    (item: ChatMessage) => item.messageId.toString(),
    []
  );

  const renderListHeader = useCallback(() => {
    const displayMessage = activeParentMessage || parentMessage;
    if (displayMessage) {
      return (
        <View>
          <Message
            message={displayMessage as ChatMessage}
            prevMessage={null}
            threadsHeader={true}
            editor={composerEditorRef.current ?? undefined}
            isInThread={true}
          />
          <View style={styles.threadDivider}>
            <Text
              weight={"medium"}
              size={fontSize.sm}
              style={{ paddingHorizontal: padding.sm }}
            >
              {displayMessage.threadInfo?.replyCount}{" "}
              {displayMessage.threadInfo?.replyCount === 1
                ? "reply"
                : "replies"}
            </Text>
            <View style={styles.threadLine} />
          </View>
        </View>
      );
    }
    return null;
  }, [activeParentMessage, parentMessage]);

  if (!currentChannel && !parentMessage) {
    return <ChatSkeletonLoader />;
  }

  const keyboardVerticalOffset = (() => {
    const activeFromId = activeCallId ? calls[activeCallId] : undefined;
    const hasLiveCall =
      (activeFromId && LIVE_CALL_STATES.has(activeFromId.state)) ||
      Object.values(calls).some((call) => LIVE_CALL_STATES.has(call.state));
    const currentRouteName = getCurrentRoute()?.name;
    const callBannerVisible =
      !!hasLiveCall && currentRouteName !== Routes.InCallScreen;
    const meetingBannerVisible =
      meetingActiveGlobally && currentRouteName !== Routes.Meetings;

    if (Platform.OS === "ios") {
      const base = callBannerVisible  || meetingBannerVisible ? insets.top + IOS_KEYBOARD_EXTRA_OFFSET - 80 : insets.top + IOS_KEYBOARD_EXTRA_OFFSET - 40;
      const extraRows =
        (callBannerVisible ? IOS_ACTIVE_CALL_BANNER_ROW_HEIGHT : 0) +
        (meetingBannerVisible ? IOS_ACTIVE_CALL_BANNER_ROW_HEIGHT : 0);
      return base + extraRows;
    }
    return 0;
  })();

  const threadContent = (
    <>
      <FlatList
        ref={flatListRef}
        data={messages}
        inverted={true}
        ListHeaderComponent={renderListHeader}
        renderItem={renderMessage}
        keyExtractor={keyExtractor}
        removeClippedSubviews={true}
        keyboardDismissMode={"on-drag"}
        maxToRenderPerBatch={INITIAL_BATCH_SIZE}
        windowSize={5}
        updateCellsBatchingPeriod={50}
        initialNumToRender={INITIAL_BATCH_SIZE}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.2}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps={"never"}
        onScrollToIndexFailed={(info) => {
          // Handle scroll to index failure - try scrollToOffset as fallback
          logger.debug(
            "⚠️ [Threads] scrollToIndex failed, trying fallback:",
            info
          );
          setTimeout(() => {
            flatListRef.current?.scrollToOffset({
              offset: info.averageItemLength * info.index,
              animated: true
            });
          }, 100);
        }}
      />
      <View
        style={
          isEditing && {
            backgroundColor:
              theme.colors["colors-background-bg-warning-secondary"]
          }
        }
      >
        <ThreadChatComposerMount
          key={editorMountKey}
          threadComposerPlaceholder={threadComposerPlaceholder}
          themedEditor={themedEditor}
          createMentionBridge={createMentionBridge}
          onEditorBridge={handleComposerEditorBridge}
          handleGifUpload={handleGifUpload}
          handleSendMessage={handleSendMessage}
          handleFile={handleFileUpload}
        />
      </View>
    </>
  );

  return (
    <Screen avoidKeyboard={false}>
      {currentChannel && <ChannelHeader channel={currentChannel} />}
      {Platform.OS === "ios" ? (
        <KeyboardAvoidingView
          style={styles.container}
          behavior="padding"
          keyboardVerticalOffset={keyboardVerticalOffset}
        >
          {threadContent}
        </KeyboardAvoidingView>
      ) : (
        <View style={styles.container}>{threadContent}</View>
      )}
    </Screen>
  );
};

export const Threads: React.FC = () => {
  return (
    <RichEditorProvider>
      <ThreadsChatComponent />
    </RichEditorProvider>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1
  },
  listContent: {
    flexGrow: 1,
    paddingVertical: padding.md
  },
  threadDivider: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: padding.sm
  },
  threadLine: {
    flex: 1,
    height: 1,
    backgroundColor: "#e0e0e0"
  },
  threadText: {
    paddingHorizontal: padding.sm
  }
});
