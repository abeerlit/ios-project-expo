import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View, Platform, Pressable } from "react-native";
import {
  RichText,
  useEditorContent,
  EditorBridge
} from "@10play/tentap-editor";
import type { WebViewMessageEvent } from "react-native-webview";
import { Asset } from "react-native-image-picker";
import { toast } from "@backpackapp-io/react-native-toast";

import { handleVoxoBlobWebMessage } from "features/chat/rich-editor/pasteBlobBridge.ts";
import {
  buildIosClipboardImagePasteInterceptorJs,
  handleVoxoClipWebMessage,
  subscribeClipboardImageDataUrl
} from "features/chat/rich-editor/pasteClipboardBridge.ts";
import {
  MAX_CHAT_IMAGE_BYTES,
  dataUriToImageAsset
} from "features/chat/rich-editor/pasteImageUtils.ts";
import { useTheme } from "hooks/use-theme.ts";
import { padding, borderRadius, Theme } from "core/theme/theme.ts";
import { useRichEditor } from "features/chat/rich-editor/context/RichEditorContext.ts";
import { CustomToolbar } from "features/chat/rich-editor/toolbar/CustomToolbar.tsx";
import { LowerToolBar } from "features/chat/rich-editor/toolbar/LowerToolBar.tsx";

interface AdvancedRichTextProps {
  editor: EditorBridge;
  handleGifUpload: (gif: {
    title: string;
    url: string;
    height: number;
    width: number;
  }) => void;
  handleFile: (files: Asset[]) => void;
  sendMessage: (params: { message: string; mentionedUsers: string[] }) => void;
}

export const AdvancedRichText: React.FC<AdvancedRichTextProps> = ({
  editor,
  handleGifUpload,
  handleFile,
  sendMessage
}) => {
  const theme = useTheme();
  const tapRef = useRef(null);
  const content = useEditorContent(editor, { type: "json" });

  const [toggleToolbar, setToggleToolbar] = useState(false);
  /** Picker + iOS clipboard-pasted images; upload only on Send (see `LowerToolBar`). */
  const [attachmentFiles, setAttachmentFiles] = useState<Asset[]>([]);

  const { replaceMentions, expanded, editMessage } = useRichEditor();

  // Track previous mentions to prevent unnecessary updates
  const previousMentionsRef = useRef<string>("");

  // Define types for the JSON content
  interface EditorNode {
    type: string;
    attrs?: {
      id?: string;
      label?: string;
      [key: string]: any;
    };
    content?: EditorNode[];

    [key: string]: any;
  }

  const extractMentions = useCallback((json: EditorNode) => {
    const mentions: { userId: string; label: string }[] = [];

    function traverse(node: EditorNode) {
      if (!node) return;

      // If the node is a mention, extract its attributes
      if (node.type === "mention" && node.attrs) {
        mentions.push({
          userId: node.attrs.id || "",
          label: node.attrs.label || ""
        });
      }

      // If the node has children (content), recursively traverse them
      if (node.content && Array.isArray(node.content)) {
        node.content.forEach(traverse);
      }
    }

    traverse(json); // Start traversing from the root
    return mentions;
  }, []);

  // Extract mentions from content and update context
  useEffect(() => {
    if (content) {
      const mentions = extractMentions(content as EditorNode);
      const mentionsString = JSON.stringify(mentions);

      // Only call replaceMentions if mentions actually changed
      if (mentionsString !== previousMentionsRef.current) {
        previousMentionsRef.current = mentionsString;
        replaceMentions(mentions);
      }
    }
  }, [content, extractMentions, replaceMentions]);

  // Set content when editing a message; clear when exiting edit mode (after send or cancel)
  const prevEditMessageRef = useRef(editMessage);
  useEffect(() => {
    if (editMessage) {
      setAttachmentFiles([]);
      // @ts-ignore - Editor type issue with setContent
      editor.setContent(editMessage.message);
    } else if (prevEditMessageRef.current) {
      setAttachmentFiles([]);
      // Just exited edit mode - clear the input bar
      // @ts-ignore - Editor type issue with setContent
      editor.setContent("");
    }
    prevEditMessageRef.current = editMessage;
  }, [editMessage, editor]);

  const dynamicStyles = getStyles(theme.colors);

  /** TenTap default `onMessage` when `exclusivelyUseCustomOnMessage` — forward after blob bridge. */
  const relayEditorWebMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (handleVoxoClipWebMessage(event)) {
        return;
      }
      if (handleVoxoBlobWebMessage(event)) {
        return;
      }
      const { data } = event.nativeEvent;
      if (typeof data !== "string") return;
      try {
        const { type, payload } = JSON.parse(data) as {
          type: string;
          payload: unknown;
        };
        editor.bridgeExtensions?.forEach((e) => {
          e.onEditorMessage && e.onEditorMessage({ type, payload }, editor);
        });
      } catch {
        /* non-JSON dev noise */
      }
    },
    [editor]
  );

  const injectEditorJs = useCallback((js: string) => {
    const inject = (editor as { injectJS?: (s: string) => void }).injectJS;
    if (typeof inject === "function") {
      inject(js);
    }
  }, [editor]);

  /** iOS: intercept clipboard image paste → chunked bridge → local file + attachment strip. */
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const timer = setTimeout(() => {
      injectEditorJs(
        buildIosClipboardImagePasteInterceptorJs(MAX_CHAT_IMAGE_BYTES)
      );
    }, 800);
    return () => clearTimeout(timer);
  }, [editor, injectEditorJs]);

  useEffect(() => {
    if (Platform.OS !== "ios") {
      return () => {};
    }
    return subscribeClipboardImageDataUrl((dataUrl) => {
      void (async () => {
        try {
          const asset = await dataUriToImageAsset(dataUrl);
          setAttachmentFiles((prev) => [...prev, asset]);
          injectEditorJs(
            `document.querySelectorAll('img[src^="blob:"]').forEach(function(n){ n.remove(); });true;`
          );
        } catch (e) {
          console.error(e);
          toast.error("Could not add pasted image as attachment");
        }
      })();
    });
  }, [injectEditorJs]);

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: theme.colors["color-colors-background-bg-primary"] },
        dynamicStyles.container
      ]}
      ref={tapRef}
    >
      {!toggleToolbar && <CustomToolbar editor={editor} />}

      <Pressable
        style={[
          styles.editorContainer,
          {
            minHeight: expanded ? 230 : Platform.OS === "android" ? 70 : 55,
            maxHeight: expanded ? 230 : 150
          }
        ]}
        onPress={() => {
          editor.focus();
        }}
      >
        <RichText
          editor={editor}
          exclusivelyUseCustomOnMessage
          onMessage={relayEditorWebMessage}
          scrollEnabled={Platform.OS === "android"}
          nestedScrollEnabled={Platform.OS === "android"}
        />
      </Pressable>

      <LowerToolBar
        editor={editor}
        toggleToolbar={() => setToggleToolbar(!toggleToolbar)}
        handleGifUpload={handleGifUpload}
        handleFile={handleFile}
        sendMessage={sendMessage}
        selectedFiles={attachmentFiles}
        onSelectedFilesChange={setAttachmentFiles}
      />
    </View>
  );
};

// Alias for backwards compatibility
export const Editor = AdvancedRichText;

const getStyles = (colors: Theme["colors"]) => ({
  container: {
    borderColor: colors["colors-border-border-primary"]
  }
});

const styles = StyleSheet.create({
  container: {
    padding: padding.lg,
    marginVertical: padding.sm,
    borderWidth: 0.25,
    borderRadius: borderRadius.xl,
    marginHorizontal: padding.lg
  },
  editorContainer: {
    marginLeft: padding.lg
  }
});
