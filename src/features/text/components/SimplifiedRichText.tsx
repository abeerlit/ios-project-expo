import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View, Platform } from "react-native";
import { RichText, EditorBridge } from "@10play/tentap-editor";
import type { WebViewMessageEvent } from "react-native-webview";
import { Asset } from "react-native-image-picker";
import { toast } from "@backpackapp-io/react-native-toast";

import {
  buildIosClipboardImagePasteInterceptorJs,
  handleVoxoClipWebMessage,
  subscribeClipboardImageDataUrl
} from "features/chat/rich-editor/pasteClipboardBridge.ts";
import {
  dataUriToImageAsset,
  estimateDataUriPayloadBytes
} from "features/chat/rich-editor/pasteImageUtils.ts";
import { useTheme } from "hooks/use-theme.ts";
import { padding, borderRadius, Theme } from "core/theme/theme.ts";
import {
  MAX_SMS_MMS_BYTES,
  TextLowerToolBar
} from "./TextLowerToolBar.tsx";

interface SimplifiedRichTextProps {
  editor: EditorBridge;
  handleGifUpload: (gif: {
    title: string;
    url: string;
    height: number;
    width: number;
  }) => Promise<void>;
  handleFile: (files: Asset[]) => Promise<void>;
  sendMessage: (message: string) => void;
}

export const SimplifiedRichText: React.FC<SimplifiedRichTextProps> = ({
  editor,
  handleGifUpload,
  handleFile,
  sendMessage
}) => {
  const theme = useTheme();
  const tapRef = useRef(null);
  /** Picker + iOS clipboard-pasted images; upload only on Send (see `TextLowerToolBar`). */
  const [attachmentFiles, setAttachmentFiles] = useState<Asset[]>([]);

  const dynamicStyles = getStyles(theme.colors);

  const relayEditorWebMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (handleVoxoClipWebMessage(event)) {
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
        buildIosClipboardImagePasteInterceptorJs(MAX_SMS_MMS_BYTES)
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
          if (estimateDataUriPayloadBytes(dataUrl) > MAX_SMS_MMS_BYTES) {
            toast.error("File should be 3 MB or smaller");
            return;
          }
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
      <View style={styles.editorContainer}>
        <RichText
          editor={editor}
          exclusivelyUseCustomOnMessage
          onMessage={relayEditorWebMessage}
          scrollEnabled={Platform.OS === "android"}
          nestedScrollEnabled={Platform.OS === "android"}
        />
      </View>

      <TextLowerToolBar
        editor={editor}
        handleGifUpload={handleGifUpload}
        handleFile={handleFile}
        sendMessage={sendMessage}
        selectedFiles={attachmentFiles}
        onSelectedFilesChange={setAttachmentFiles}
      />
    </View>
  );
};

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
    minHeight: 70,
    maxHeight: 150
  }
});
