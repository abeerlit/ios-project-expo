// Sendbird Chat Content Component - Pure content, no header logic
import React, {
  useCallback,
  useMemo,
  useRef,
  useEffect,
  useState
} from "react";
import {
  View,
  StyleSheet,
  AppState,
  Platform,
  KeyboardAvoidingView,
  InteractionManager
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSelector } from "react-redux";
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
  useEditorBridge
} from "@10play/tentap-editor";
import { Mention } from "@tiptap/extension-mention";

// Type Imports
import { MentionType, MessageMetaArray } from "@sendbird/chat/message";
import { State } from "store/types.ts";
import { ChatMessage } from "features/chat/types.ts";
import { EditorMention } from "features/chat/rich-editor/types.ts";

// Component Imports
import { Logger } from "shared/utils/Logger.ts";
import { FlatList } from "shared/components/utils/Flatlist.tsx";
import { Message } from "features/chat/components/Message.tsx";
import { Editor } from "features/chat/rich-editor/AdvancedRichText.tsx";
import { MentionActionType } from "features/chat/rich-editor/mentions/MentionBridge.ts";
import { LinkBridge } from "features/chat/rich-editor/bridges/LinkBridge.ts";
import { editorHtml } from "features/chat/editor/build/editorHtml.ts";
import { fontSize, padding } from "core/theme/theme.ts";
import { useRichEditor } from "features/chat/rich-editor/context/RichEditorContext.ts";
import { useSendbirdContext } from "features/chat/utils/SendbirdContext.ts";
import { useDrawer } from "core/drawer/DrawerContext.tsx";
import { useTheme } from "hooks/use-theme.ts";
import { Text } from "shared/components/Text.tsx";
import { ChannelInfoHeader } from "features/chat/components/ChannelInfoHeader.tsx";
import { useSoftphone } from "core/softphone/useSoftphone.ts";
import { Routes } from "core/navigation/types/types.ts";
import { getCurrentRoute } from "core/navigation/utils/Ref.ts";
import { CallState } from "core/softphone/types.ts";
import { useMeetingActive } from "features/meeting/MeetingActiveContext.tsx";

const INITIAL_BATCH_SIZE = 20;
const MENTION_CHAR = "@";
const MAX_VALUE_LENGTH = 128;

const logger = new Logger("SendbirdChatContent");

const LIVE_CALL_STATES = new Set<CallState>([
  CallState.INCOMING,
  CallState.OUTGOING,
  CallState.CONNECTING,
  CallState.CONNECTED,
  CallState.HOLDING,
  CallState.HELD
]);

interface SendbirdChatContentProps {
  channelUrl?: string;
  recipientNames: string;
  onSendMessage: () => void;
  scrollToMessageId?: string;
  /** Extra offset for keyboard (e.g. header height) so input is not hidden */
  keyboardOffsetExtra?: number;
  /** When user sends with no channel, parent can store this and pass back as initialPendingMessage after remount */
  onStorePendingMessage?: (payload: { message: string; mentionedUsers: string[] }) => void;
  /** Pending message from parent (survives remount when key changes from compose to channelUrl) */
  initialPendingMessage?: { message: string; mentionedUsers: string[] } | null;
  onPendingMessageConsumed?: () => void;
}
/** Fallback header height before parent onLayout fires. */
const IOS_HEADER_HEIGHT_FALLBACK = 52;
/** Rich editor (formatting + lower toolbar) needs slightly more clearance than SMS. */
const IOS_SENDBIRD_KEYBOARD_EXTRA = 0;
/** Extra `keyboardVerticalOffset` per top banner row (active call / minimized meeting). */
const IOS_ACTIVE_CALL_BANNER_ROW_HEIGHT = 95;

export const SendbirdChatContent: React.FC<SendbirdChatContentProps> = ({
  channelUrl,
  recipientNames,
  onSendMessage,
  scrollToMessageId,
  keyboardOffsetExtra = 0,
  onStorePendingMessage,
  initialPendingMessage,
  onPendingMessageConsumed
}) => {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { calls, activeCallId } = useSoftphone();
  const { meetingActiveGlobally } = useMeetingActive();
  const {
    toggleMentionSuggestion,
    isEditing,
    editMessage,
    setEditing,
    setMentionQuery
  } = useRichEditor();

  const { user } = useSelector((state: State) => state.userReducer);
  const { directory } = useSelector((state: State) => state.directoryReducer);

  const { closeDrawer, isOpen: isDrawerOpen } = useDrawer();
  const {
    enterChannel,
    leaveChannel,
    currentChannel,
    messageCollection,
    messages,
    fetchMoreMessages,
    isFetchingMessages,
    sendUserMessage,
    sendFileMessage,
    sendMultipleFileMessage,
    editUserMessage,
    typingUsers,
    refreshCurrentChannelMessages
  } = useSendbirdContext();

  // Hide replies in main chat: only show when channel matches and message has no parent
  const listMessages = useMemo(() => {
    const url = channelUrl || currentChannel?.url;
    if (!url) {
      console.warn("[ReplyFilter] listMessages: no url, returning []");
      return [];
    }
    if (currentChannel?.url && url !== currentChannel.url) {
      console.warn("[ReplyFilter] listMessages: channel mismatch, returning []", {
        url,
        currentUrl: currentChannel?.url
      });
      return [];
    }
    const filtered = messages.filter((m) => {
      const msg = m as {
        parentMessageId?: number;
        parent_message_id?: number;
        parentMessage?: unknown;
      };
      if (msg.parentMessage) return false;
      const pid = msg.parentMessageId ?? msg.parent_message_id;
      if (pid == null) return true;
      const n = Number(pid);
      return n === 0 || Number.isNaN(n);
    });
    const replyCount = messages.length - filtered.length;
    if (replyCount > 0) {
      console.warn("[ReplyFilter] SendbirdChatContent listMessages filtered out replies:", {
        fromContext: messages.length,
        afterFilter: filtered.length,
        replyCount,
        replyIds: messages
          .filter((m) => {
            const msg = m as { parentMessageId?: number; parent_message_id?: number; parentMessage?: unknown };
            if (msg.parentMessage) return true;
            const pid = msg.parentMessageId ?? msg.parent_message_id;
            return pid != null && pid !== 0 && !Number.isNaN(Number(pid));
          })
          .map((r) => (r as { messageId: number }).messageId)
      });
    }
    return filtered;
  }, [messages, channelUrl, currentChannel?.url]);

  // Store pending message to send after channel creation
  const pendingMessageRef = useRef<{
    message: string;
    mentionedUsers: string[];
  } | null>(null);

  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isTypingRef = useRef<boolean>(false);
  const flatListRef = useRef<any>(null);
  const hasScrolledToMessage = useRef<boolean>(false);

  const componentMountTime = useRef(Date.now());
  const [listReady, setListReady] = useState(false);
  const editorRef = useRef<any>(null);
  const suppressAutoFocusUntilRef = useRef(0);
  const autoFocusedChannelRef = useRef<string | null>(null);

  React.useEffect(() => {
    componentMountTime.current = Date.now();
    console.warn("⏱️ [SendbirdChatContent] MOUNTED:", {
      channelUrl,
      timestamp: componentMountTime.current
    });
  }, []);

  // Don’t show the message list until channel has settled (avoids reply flash)
  React.useEffect(() => {
    const url = channelUrl || currentChannel?.url;
    if (!url) {
      setListReady(false);
      return;
    }
    if (currentChannel?.url && url !== currentChannel.url) {
      setListReady(false);
      return;
    }
    const t = setTimeout(() => setListReady(true), 80);
    return () => clearTimeout(t);
  }, [channelUrl, currentChannel?.url]);

  React.useEffect(() => {
    if (channelUrl) {
      console.warn("⏱️ [SendbirdChatContent] Calling enterChannel:", {
        channelUrl,
        timeSinceMount: Date.now() - componentMountTime.current
      });
      logger.debug(
        "🚪 [SendbirdChatContent] Channel URL provided, entering channel:",
        channelUrl
      );
      enterChannel(channelUrl);
    }

    return () => {
      leaveChannel();
      closeDrawer();
      logger.debug(
        "🚪 [SendbirdChatContent] Channel URL changing or unmounting"
      );
    };
    // Note: enterChannel and leaveChannel are stable callbacks from context and don't need to be in deps
    // Including them would cause infinite loops if they're recreated
    // eslint-disable-next-line
  }, [channelUrl]);

  // Track when messages become available and whether any are replies (diagnostic)
  useEffect(() => {
    if (messages.length > 0) {
      const replies = messages.filter((m) => {
        const msg = m as { parentMessageId?: number; parent_message_id?: number; parentMessage?: unknown };
        if (msg.parentMessage) return true;
        const pid = msg.parentMessageId ?? msg.parent_message_id;
        return pid != null && pid !== 0 && !Number.isNaN(Number(pid));
      });
      console.warn("[ReplyFilter] Messages from context:", {
        count: messages.length,
        replyCount: replies.length,
        listReady,
        listMessagesCount: listMessages.length,
        replyIds: replies.map((r) => (r as { messageId: number }).messageId),
        timeSinceMount: Date.now() - componentMountTime.current
      });
    }
  }, [messages.length, messages, listReady, listMessages.length]);

  // Sync parent's pending message into ref when we mount with channelUrl (after remount)
  useEffect(() => {
    if (initialPendingMessage && channelUrl) {
      logger.debug("[PendingMessage] READ from parent (survived remount)", {
        messageLength: initialPendingMessage.message?.length,
        mentionedCount: initialPendingMessage.mentionedUsers?.length
      });
      pendingMessageRef.current = initialPendingMessage;
    }
  }, [channelUrl, initialPendingMessage]);

  // Send pending message when channel becomes available (e.g. after creating a group)
  useEffect(() => {
    const toSend =
      pendingMessageRef.current != null
        ? pendingMessageRef.current
        : initialPendingMessage != null
          ? initialPendingMessage
          : null;
    if (!currentChannel || !toSend) return;
    const { message, mentionedUsers } = toSend;
    const source = pendingMessageRef.current ? "ref" : "initialPendingMessage";
    logger.debug("[PendingMessage] SEND: channel available, sending", {
      source,
      messageLength: message?.length,
      mentionedCount: mentionedUsers?.length
    });
    // Consume immediately to avoid double-send if effect re-runs before parent clears
    pendingMessageRef.current = null;
    onPendingMessageConsumed?.();
    try {
      sendUserMessage({
        message,
        mentionType: MentionType.USERS,
        mentionedUserIds: mentionedUsers.map((i) => i.toString())
      });
      onSendMessage();
      // Refresh message list so the sent message appears (onMessageReceived also adds it)
      const t = setTimeout(() => {
        refreshCurrentChannelMessages();
      }, 400);
      return () => clearTimeout(t);
    } catch (error) {
      logger.error("Failed to send pending message:", error);
      toast.error("Error sending message");
      pendingMessageRef.current = null;
      onPendingMessageConsumed?.();
    }
  }, [
    currentChannel,
    initialPendingMessage,
    sendUserMessage,
    onSendMessage,
    onPendingMessageConsumed,
    refreshCurrentChannelMessages
  ]);

  // Scroll to specific message when loaded (e.g., from reaction notification)
  const loadMoreAttemptsRef = useRef(0);
  const maxLoadAttempts = 5;

  useEffect(() => {
    if (
      !scrollToMessageId ||
      hasScrolledToMessage.current ||
      listMessages.length === 0
    )
      return;

    const messageIndex = listMessages.findIndex(
      (msg) => msg.messageId.toString() === scrollToMessageId
    );

    if (messageIndex !== -1 && flatListRef.current) {
      // Message found - scroll to it
      setTimeout(() => {
        try {
          flatListRef.current?.scrollToIndex({
            index: messageIndex,
            animated: true,
            viewPosition: 0.5
          });
          hasScrolledToMessage.current = true;
          loadMoreAttemptsRef.current = 0;
          logger.debug(
            "📍 [SendbirdChatContent] Scrolled to message:",
            scrollToMessageId
          );
        } catch (error) {
          logger.debug(
            "⚠️ [SendbirdChatContent] Could not scroll to message:",
            error
          );
        }
      }, 500);
    } else if (
      loadMoreAttemptsRef.current < maxLoadAttempts &&
      !isFetchingMessages
    ) {
      // Message not found yet - load more messages
      loadMoreAttemptsRef.current += 1;
      logger.debug(
        "📥 [SendbirdChatContent] Message not found, loading more... attempt:",
        loadMoreAttemptsRef.current
      );
      fetchMoreMessages();
    } else if (loadMoreAttemptsRef.current >= maxLoadAttempts) {
      // Give up after max attempts
      logger.debug(
        "⚠️ [SendbirdChatContent] Could not find message after",
        maxLoadAttempts,
        "attempts"
      );
      hasScrolledToMessage.current = true; // Stop trying
    }
  }, [listMessages, scrollToMessageId, isFetchingMessages, fetchMoreMessages]);

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

  // Message Handlers
  const handleLoadMore = useCallback(async () => {
    if (messageCollection?.hasPrevious && !isFetchingMessages) {
      try {
        await fetchMoreMessages();
      } catch (error) {
        logger.error("Failed to fetch more messages:", error);
      }
    }
  }, [fetchMoreMessages, messageCollection, isFetchingMessages]);

  // ✅ FIX: Fetch NEW messages when app comes from background to active mode
  useEffect(() => {
    const subscription = AppState.addEventListener(
      "change",
      async (nextAppState) => {
        if (nextAppState === "active") {
          // App came to foreground
          logger.debug(
            "🔄 [SendbirdChatContent] App came to foreground, refreshing messages",
            {
              channelUrl,
              hasCurrentChannel: !!currentChannel,
              hasMessageCollection: !!messageCollection,
              hasPrevious: messageCollection?.hasPrevious,
              isFetchingMessages
            }
          );

          // If we have a channel, fetch only NEW messages (not old ones)
          if (currentChannel) {
            logger.debug(
              "🔄 [SendbirdChatContent] Calling refreshCurrentChannelMessages on foreground"
            );
            try {
              await refreshCurrentChannelMessages();
            } catch (error) {
              logger.error(
                "❌ [SendbirdChatContent] Error refreshing messages on foreground:",
                error
              );
            }
          }

          // Also fetch older messages if available (original behavior)
          if (
            currentChannel &&
            messageCollection?.hasPrevious &&
            !isFetchingMessages
          ) {
            logger.debug(
              "🔄 [SendbirdChatContent] Calling fetchMoreMessages on foreground"
            );
            try {
              await fetchMoreMessages();
            } catch (error) {
              logger.error(
                "❌ [SendbirdChatContent] Error fetching messages on foreground:",
                error
              );
            }
          }
        }
      }
    );

    return () => {
      subscription.remove();
    };
  }, [
    currentChannel,
    messageCollection,
    isFetchingMessages,
    fetchMoreMessages,
    refreshCurrentChannelMessages,
    channelUrl
  ]);

  const handleGifUpload = useCallback(
    async (value: {
      title: string;
      url: string;
      height: number;
      width: number;
    }) => {
      try {
        // If no channel exists, trigger channel creation first
        if (!currentChannel) {
          logger.debug(
            "No channel exists for GIF upload, triggering channel creation"
          );
          onSendMessage(); // Trigger channel creation
          toast.error("Please wait for chat to load, then try again");
          return;
        }

        const metaArrays = getGifMetaArrays(value);
        sendUserMessage({
          customType: "MESSAGE_GIF",
          message: "",
          metaArrays: metaArrays
        });
        onSendMessage();
      } catch (error) {
        logger.error("Failed to upload GIF:", error);
        toast.error("Error uploading GIF");
      }
    },
    [currentChannel, getGifMetaArrays, sendUserMessage, onSendMessage]
  );

  const handleFileUpload = useCallback(
    async (files: Asset[]) => {
      try {
        // If no channel exists, trigger channel creation first
        if (!currentChannel) {
          logger.debug(
            "No channel exists for file upload, triggering channel creation"
          );
          onSendMessage(); // Trigger channel creation
          toast.error("Please wait for chat to load, then try again");
          return;
        }

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
            mimeType: file.type
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
          sendMultipleFileMessage({ fileInfoList: adaptedFiles });
        }
        onSendMessage();
      } catch (error) {
        logger.error("Failed to upload files:", error);
        toast.error("Error uploading files");
      }
    },
    [currentChannel, sendFileMessage, sendMultipleFileMessage, onSendMessage]
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
        // If no channel exists, store the message and trigger channel creation
        // The message will be sent once the channel is created
        if (!currentChannel) {
          logger.debug(
            "[PendingMessage] STORE: no channel, storing and triggering creation",
            { messageLength: message?.length, mentionedCount: mentionedUsers?.length }
          );
          pendingMessageRef.current = { message, mentionedUsers };
          onStorePendingMessage?.({ message, mentionedUsers });
          onSendMessage(); // This will trigger channel creation in parent
          return;
        }

        logger.debug("[Chat Send] editMessage:", editMessage);
        logger.debug(
          "[Chat Send] editMessage?.messageId:",
          editMessage?.messageId
        );
        logger.debug("[Chat Send] isEditing:", isEditing);

        if (isEditing && editMessage?.messageId) {
          logger.debug("[Chat Send] Editing message:", editMessage.messageId);
          await editUserMessage(message, editMessage.messageId);
          setEditing(null);
        } else {
          logger.debug("[Chat Send] Creating new message");
          sendUserMessage({
            message,
            mentionType: MentionType.USERS,
            mentionedUserIds: mentionedUsers.map((i) => i.toString())
          });
        }
        onSendMessage();
      } catch (error) {
        logger.error("Failed to send message:", error);
        toast.error("Error sending message");
      }
    },
    [
      currentChannel,
      editMessage,
      isEditing,
      sendUserMessage,
      editUserMessage,
      setEditing,
      onSendMessage
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

  const themedEditor = editorHtml
    .replace(
      "{{theme-background}}",
      theme.colors["color-colors-background-bg-primary"]
    )
    .replace("{{theme-color}}", theme.colors["color-colors-text-text-primary"]);

  // Editor Configuration
  const editor = useEditorBridge({
    customSource: themedEditor,
    bridgeExtensions: [
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
        placeholder: `Message ${recipientNames}...`
      }),
      createMentionBridge()
    ],
    avoidIosKeyboard: true,
    onChange: () => {
      // Only send typing indicators if we have an active channel
      if (currentChannel) {
        if (!isTypingRef.current) {
          currentChannel.startTyping();
          isTypingRef.current = true;
        }

        if (typingTimeoutRef.current) {
          clearTimeout(typingTimeoutRef.current);
        }

        typingTimeoutRef.current = setTimeout(() => {
          currentChannel?.endTyping();
          isTypingRef.current = false;
          typingTimeoutRef.current = null;
        }, 300);
      }
    }
  });
  editorRef.current = editor;

  // Blur editor when drawer opens (dismisses WebView keyboard)
  useEffect(() => {
    if (isDrawerOpen && editorRef.current) {
      // Prevent queued focus timers from re-opening keyboard while opening drawer.
      suppressAutoFocusUntilRef.current = Date.now() + 1000;
      editorRef.current.blur();
    }
  }, [isDrawerOpen]);

  // Focus when we first enter this channel (navigate to channel).
  // Depends only on channelUrl so we don't refocus on drawer open, paste, etc.
  useEffect(() => {
    const url = channelUrl || currentChannel?.url;
    const isAutoFocusSuppressed = Date.now() < suppressAutoFocusUntilRef.current;
    if (!url || !listReady || isDrawerOpen || isAutoFocusSuppressed) return;
    if (autoFocusedChannelRef.current === url) return;

    const ed = editorRef.current;
    if (!ed) return;
    autoFocusedChannelRef.current = url;

    if (Platform.OS === "ios") {
      const timer = setTimeout(() => ed.focus(), 400);
      return () => clearTimeout(timer);
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timer2: ReturnType<typeof setTimeout> | null = null;
    const task = InteractionManager.runAfterInteractions(() => {
      if (cancelled) return;
      timer = setTimeout(() => {
        if (cancelled) return;
        ed.focus();
        timer2 = setTimeout(() => {
          if (!cancelled) ed.focus();
        }, 100);
      }, 500);
    });
    return () => {
      cancelled = true;
      task.cancel();
      if (timer) clearTimeout(timer);
      if (timer2) clearTimeout(timer2);
    };
  }, [channelUrl, currentChannel?.url, listReady, isDrawerOpen]);

  // Render Methods - Use messagesRef to avoid re-creating callback on every message update
  const messagesRef = useRef<ChatMessage[]>(listMessages);
  messagesRef.current = listMessages;

  const renderMessage = useCallback(
    ({ item, index }: { item: ChatMessage; index: number }) => {
      // Never show replies in main chat – hide if it has a parent
      const msg = item as { parentMessageId?: number; parent_message_id?: number };
      const pid = msg.parentMessageId ?? msg.parent_message_id;
      if (pid != null && pid !== 0) {
        return <View style={{ height: 0, overflow: "hidden" }} />;
      }
      const prevMessage =
        index < messagesRef.current.length - 1
          ? messagesRef.current[index + 1]
          : null;
      return (
        <Message
          message={item}
          prevMessage={prevMessage}
          editor={editor}
          mainChat
        />
      );
    },
    [editor]
  );

  const keyExtractor = useCallback(
    (item: ChatMessage) => item.messageId.toString(),
    []
  );

  const renderListHeader = useCallback(() => {
    if (!user || !currentChannel) return null;
    const hasFewMessages = listMessages.length <= INITIAL_BATCH_SIZE;
    const reachedBeginning = messageCollection?.hasPrevious === false;

    if (reachedBeginning || hasFewMessages) {
      return <ChannelInfoHeader channel={currentChannel} user={user} />;
    }
    return null;
  }, [messageCollection?.hasPrevious, user, currentChannel, listMessages.length]);

  // Typing Users
  const currentTypingUsers = useMemo(() => {
    if (!currentChannel || !user) return [];

    const channelTypingUsers = typingUsers[currentChannel.url] || [];
    return channelTypingUsers.filter(
      (typingUser) => parseInt(typingUser.userId) !== user.id
    );
  }, [typingUsers, currentChannel, user]);

  const [debouncedTypingText, setDebouncedTypingText] = useState<string | null>(
    null
  );

  const typingText = useMemo(() => {
    if (currentTypingUsers.length === 0) {
      return null;
    } else if (currentTypingUsers.length === 1) {
      const typingUser = currentTypingUsers[0];
      const contact = directory.find(
        (c) => c.userId?.toString() === typingUser.userId
      );
      const name = contact?.name?.trim() || typingUser.nickname || "Someone";
      return `${name} is typing...`;
    } else if (currentTypingUsers.length === 2) {
      const names = currentTypingUsers.map((typingUser) => {
        const contact = directory.find(
          (c) => c.userId?.toString() === typingUser.userId
        );
        return contact?.name?.trim() || typingUser.nickname || "Someone";
      });
      return `${names.join(" and ")} are typing...`;
    } else {
      return `${currentTypingUsers.length} people are typing...`;
    }
  }, [currentTypingUsers, directory]);

  useEffect(() => {
    if (typingText) {
      setDebouncedTypingText(typingText);
    } else {
      const timeout = setTimeout(() => {
        setDebouncedTypingText(null);
      }, 200);
      return () => clearTimeout(timeout);
    }
  }, [typingText]);

  const renderTypingIndicator = useCallback(() => {
    return (
      <View style={styles.typingContainer}>
        {debouncedTypingText && (
          <Text
            align={"left"}
            size={fontSize.xs}
            weight={"medium"}
            style={[
              { color: theme.colors["color-colors-text-text-secondary"] }
            ]}
          >
            {debouncedTypingText}
          </Text>
        )}
      </View>
    );
  }, [debouncedTypingText, directory, theme]);

  const keyboardVerticalOffset = useMemo(() => {
    if (Platform.OS !== "ios") return 0;

    const activeFromId = activeCallId ? calls[activeCallId] : undefined;
    const hasLiveCall =
      (activeFromId && LIVE_CALL_STATES.has(activeFromId.state)) ||
      Object.values(calls).some((call) => LIVE_CALL_STATES.has(call.state));
    const currentRouteName = getCurrentRoute()?.name;
    const callBannerVisible =
      !!hasLiveCall && currentRouteName !== Routes.InCallScreen;
    const meetingBannerVisible =
      meetingActiveGlobally && currentRouteName !== Routes.Meetings;

    const headerHeight =
      keyboardOffsetExtra > 0 ? keyboardOffsetExtra : IOS_HEADER_HEIGHT_FALLBACK;
    const bannerTune =
      callBannerVisible || meetingBannerVisible ? -40 : 0;
    const bannerRows =
      (callBannerVisible ? IOS_ACTIVE_CALL_BANNER_ROW_HEIGHT : 0) +
      (meetingBannerVisible ? IOS_ACTIVE_CALL_BANNER_ROW_HEIGHT : 0);

    return (
      insets.top +
      headerHeight +
      bannerRows +
      bannerTune +
      IOS_SENDBIRD_KEYBOARD_EXTRA
    );
  }, [
    keyboardOffsetExtra,
    insets.top,
    activeCallId,
    calls,
    meetingActiveGlobally
  ]);
  const content = (
    <>
      {channelUrl || currentChannel ? (
        <FlatList
          key={channelUrl || currentChannel?.url}
          ref={flatListRef}
          data={listReady ? listMessages : []}
          ListHeaderComponent={listReady && listMessages.length > 1 ? renderListHeader() : <></>}
          renderItem={renderMessage}
          keyExtractor={keyExtractor}
          inverted
          removeClippedSubviews={true}
          keyboardDismissMode={"on-drag"}
          maxToRenderPerBatch={INITIAL_BATCH_SIZE}
          windowSize={5}
          updateCellsBatchingPeriod={50}
          initialNumToRender={INITIAL_BATCH_SIZE}
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.2}
          contentContainerStyle={styles.listContent}
          maintainVisibleContentPosition={{
            minIndexForVisible: 0,
            autoscrollToTopThreshold: 0
          }}
          onScrollToIndexFailed={(info) => {
            logger.debug(
              "⚠️ [SendbirdChatContent] scrollToIndex failed, trying fallback:",
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
      ) : (
        // Show empty state when no channel exists yet
        <View style={styles.emptyContainer} />
      )}
      <View
        style={[
          styles.editorWrapper,
          isEditing && {
            backgroundColor:
              theme.colors["colors-background-bg-warning-secondary"]
          }
        ]}
      >
        <Editor
          editor={editor}
          handleGifUpload={handleGifUpload}
          sendMessage={handleSendMessage}
          handleFile={handleFileUpload}
        />
        {renderTypingIndicator()}
      </View>
    </>
  );

  return Platform.OS === "ios" ? (
    <KeyboardAvoidingView
      style={styles.container}
      behavior="padding"
      keyboardVerticalOffset={keyboardVerticalOffset}
    >
      {content}
    </KeyboardAvoidingView>
  ) : (
    <View style={styles.container}>{content}</View>
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
  editorWrapper: {
    marginTop: -padding.xs,
    marginBottom: padding.xl
  },
  typingContainer: {
    // marginTop: padding.xs,
    paddingHorizontal: padding.lg,
    height: 30,
    justifyContent: "center"
  },
  emptyContainer: {
    flex: 1
  }
});
