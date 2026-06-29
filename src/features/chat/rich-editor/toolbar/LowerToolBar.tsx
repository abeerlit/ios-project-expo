import React, { useEffect, useMemo, useState } from "react";
import {
  Image,
  Platform,
  StyleSheet,
  TouchableOpacity,
  View
} from "react-native";
import { type EditorBridge, useEditorContent } from "@10play/tentap-editor";
import {
  GiphyDialog,
  GiphySDK,
  GiphyThemePreset
} from "@giphy/react-native-sdk";
import {
  Asset,
  ImageLibraryOptions,
  launchImageLibrary
} from "react-native-image-picker";
import Video from "react-native-video";
import { toast } from "@backpackapp-io/react-native-toast";
import { GIPHY_ANDROID_KEY, GIPHY_IOS_KEY } from "@env";

import { Text } from "shared/components/Text.tsx";
import Icon from "shared/components/Icon.tsx";
import { useRichEditor } from "features/chat/rich-editor/context/RichEditorContext.ts";
import { useTheme } from "hooks/use-theme.ts";
import {
  padding,
  borderRadius,
  fontSize,
  componentSize
} from "core/theme/theme.ts";
import { Button } from "shared/components/Button.tsx";
import { Logger } from "shared/utils/Logger.ts";
import { exportBlobFromWebView } from "features/chat/rich-editor/pasteBlobBridge.ts";
import {
  MAX_CHAT_IMAGE_BYTES,
  dataUriToImageAsset,
  describeDataUriForLog,
  estimateDataUriPayloadBytes
} from "features/chat/rich-editor/pasteImageUtils.ts";

/**
 * True when the TipTap document contains embedded media. Plain `getText()` is empty for
 * pasted images — HTML still has `<img>` (often `blob:` or `data:image` in the WebView).
 */
function htmlIndicatesEmbeddedMedia(html: string): boolean {
  if (!html?.trim()) return false;
  const lower = html.toLowerCase();
  return (
    /<img\b/i.test(html) ||
    /<video\b/i.test(html) ||
    /<figure\b/i.test(html) ||
    /blob:/i.test(html) ||
    /data:image\//i.test(html) ||
    lower.includes('data-type="resizableimage"')
  );
}

/** Visible text after removing tags (mentions, formatting wrappers, etc.). */
function hasNonTagTextContent(html: string): boolean {
  return (
    html
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim().length > 0
  );
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Collect `data:image/...;base64,...` URIs from `<img src=...>`. */
function extractDataImageSrcsFromHtml(html: string): string[] {
  const out: string[] = [];
  const imgTagRe = /<img\b[^>]*?>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgTagRe.exec(html)) !== null) {
    const tag = m[0];
    const quoted = tag.match(/\bsrc\s*=\s*["'](data:image\/[^"']+)["']/i);
    const unquoted = tag.match(/\bsrc\s*=\s*(data:image\/[^\s>]+)/i);
    const uri = quoted?.[1] || unquoted?.[1];
    if (uri?.startsWith("data:image/")) {
      out.push(uri);
    }
  }
  return out;
}

/** Collect `blob:...` URIs from `<img src=...>` (WebView paste). */
function extractBlobSrcsFromHtml(html: string): string[] {
  const out: string[] = [];
  const imgTagRe = /<img\b[^>]*?>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgTagRe.exec(html)) !== null) {
    const tag = m[0];
    const quoted = tag.match(/\bsrc\s*=\s*["'](blob:[^"']+)["']/i);
    const unquoted = tag.match(/\bsrc\s*=\s*(blob:[^\s>]+)/i);
    const uri = quoted?.[1] || unquoted?.[1];
    if (uri?.startsWith("blob:")) {
      out.push(uri);
    }
  }
  return out;
}

/** Remove inline `<img>` whose `src` is `data:image/...` or `blob:...` (pasted / WebView). */
function stripDataAndBlobImgTags(html: string): string {
  return html.replace(
    /<img\b[^>]*\bsrc\s*=\s*["'](?:data:image\/[^"']+|blob:[^"']+)["'][^>]*\/?>/gi,
    ""
  );
}

function htmlHeadForLog(html: string, maxLen = 280): string {
  const collapsed = html.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen)}…`;
}

interface LowerToolBarProps {
  editor: EditorBridge;
  toggleToolbar: () => void;
  handleGifUpload: (media: {
    title: string;
    url: string;
    height: number;
    width: number;
  }) => void;
  handleFile: (file: Asset[]) => void | Promise<void>;
  sendMessage: ({
    message,
    mentionedUsers
  }: {
    message: string;
    mentionedUsers: string[];
  }) => void;
  /** When set with `onSelectedFilesChange`, attachment list is controlled by parent (e.g. iOS clipboard paste). */
  selectedFiles?: Asset[];
  onSelectedFilesChange?: React.Dispatch<React.SetStateAction<Asset[]>>;
}

export const LowerToolBar: React.FC<LowerToolBarProps> = ({
  editor,
  toggleToolbar,
  handleGifUpload,
  handleFile,
  sendMessage,
  selectedFiles: selectedFilesProp,
  onSelectedFilesChange
}) => {
  const logger = new Logger("LowerToolBar: ");

  const theme = useTheme();
  const { mentions } = useRichEditor();

  const [loader, setLoader] = useState(false);
  const [internalSelectedFiles, setInternalSelectedFiles] = useState<Asset[]>(
    []
  );
  const isFilesControlled =
    selectedFilesProp !== undefined && onSelectedFilesChange !== undefined;
  const selectedFiles = isFilesControlled
    ? selectedFilesProp!
    : internalSelectedFiles;
  const setSelectedFiles = isFilesControlled
    ? onSelectedFilesChange!
    : setInternalSelectedFiles;

  const { isEditing, setEditing } = useRichEditor();

  const textContent = useEditorContent(editor, { type: "text" });
  const htmlContent = useEditorContent(editor, { type: "html" });

  const canSendFromEditor = useMemo(() => {
    const hasPlainText = (textContent || "").trim().length > 0;
    if (hasPlainText) return true;
    if (selectedFiles.length > 0) return true;
    if (Platform.OS === "ios") {
      return htmlIndicatesEmbeddedMedia(htmlContent || "");
    }
    return false;
  }, [textContent, htmlContent, selectedFiles.length]);

  // Configure Giphy SDK
  useEffect(() => {
    GiphySDK.configure({
      apiKey: Platform.OS === "ios" ? GIPHY_IOS_KEY : GIPHY_ANDROID_KEY
    });
  }, []);

  const uploadFile = () => {
    const options: ImageLibraryOptions = {
      mediaType: "mixed",
      selectionLimit: 0
    };

    launchImageLibrary(options, (response) => {
      if (response.didCancel) {
        logger.debug("cancelled image upload");
      } else if (response.errorMessage) {
        toast.error("Error uploading file");
      } else if (response.assets) {
        const maxFileSize = 20 * 1024 * 1024;
        if (
          response.assets[0].fileSize &&
          response.assets[0].fileSize > maxFileSize
        ) {
          toast.error("File should be less than 20 MB");
          return;
        }
        if (response.assets) {
          setSelectedFiles((prev) => [...response.assets!, ...prev]);
        }
      }
    }).catch((e) => {
      toast.error("Error uploading file");
      logger.error(e);
    });
  };

  const handleMediaSelect = (param: {
    media: {
      data: {
        title?: string;
        images?: {
          original?: { height?: number; width?: number; url?: string };
        };
      };
    };
  }) => {
    const gifObject = {
      title: param?.media?.data?.title || "",
      height: param?.media?.data?.images?.original?.height || 0,
      width: param?.media?.data?.images?.original?.width || 0,
      url: param?.media?.data?.images?.original?.url || ""
    };
    handleGifUpload(gifObject);
    GiphyDialog.hide();
    GiphyDialog.removeAllListeners("onMediaSelect");
  };

  const removeFile = (fileName: string) => {
    setSelectedFiles((prev) =>
      prev.filter((item) => item?.fileName !== fileName)
    );
  };

  useEffect(() => {
    GiphyDialog.configure({
      mediaTypeConfig: ["gif"],
      theme: theme.dark ? GiphyThemePreset.Dark : GiphyThemePreset.Light
    });
  }, []);

  useEffect(() => {
    GiphyDialog.addListener("onDismiss", () => {
      GiphyDialog.removeAllListeners("onMediaSelect");
    });
    return () => {
      GiphyDialog.removeAllListeners("onDismiss");
    };
  }, []);

  const handleSubmit = async () => {
    setLoader(true);
    const log = (step: string, meta?: Record<string, unknown>) => {
      if (meta !== undefined) {
        logger.debug(`[pasteSend] ${step} ${JSON.stringify(meta)}`);
      } else {
        logger.debug(`[pasteSend] ${step}`);
      }
    };

    try {
      log("1_submit_tap");
      const messageHtml = await editor.getHTML();
      const text = await editor.getText();
      const hasText = (text || "").trim().length > 0;
      const hasMedia = htmlIndicatesEmbeddedMedia(messageHtml);
      const pickerFiles = [...(selectedFiles || [])];

      log("2_editor_snapshot", {
        platform: Platform.OS,
        htmlLen: messageHtml?.length ?? 0,
        textLen: (text || "").length,
        textTrimLen: (text || "").trim().length,
        hasText,
        hasMedia,
        pickerFileCount: pickerFiles.length,
        htmlHead: htmlHeadForLog(messageHtml || "")
      });

      if (!hasText && !hasMedia && pickerFiles.length === 0) {
        log("3_abort_nothing_to_send");
        return;
      }

      const dataUrisRaw = extractDataImageSrcsFromHtml(messageHtml);
      const dataUris = dedupeStrings(dataUrisRaw);
      log("4_data_uri_extract", {
        rawImgSrcCount: dataUrisRaw.length,
        dedupedCount: dataUris.length,
        previews: dataUris.map((u) => describeDataUriForLog(u))
      });

      const pastedAssets: Asset[] = [];
      let uriIndex = 0;
      for (const uri of dataUris) {
        uriIndex += 1;
        log("5_convert_paste_start", {
          index: uriIndex,
          total: dataUris.length,
          ...describeDataUriForLog(uri)
        });
        try {
          if (estimateDataUriPayloadBytes(uri) > MAX_CHAT_IMAGE_BYTES) {
            log("5a_convert_skip_too_large", describeDataUriForLog(uri));
            toast.error("Image is too large (max 20 MB)");
            continue;
          }
          const asset = await dataUriToImageAsset(uri);
          pastedAssets.push(asset);
          log("5b_convert_ok", {
            fileName: asset.fileName,
            fileSize: asset.fileSize,
            type: asset.type,
            uriPrefix: (asset.uri || "").slice(0, 32)
          });
        } catch (e) {
          logger.error("[pasteSend] 5c_convert_error", e);
          toast.error("Could not send pasted image");
        }
      }

      const blobUrlsRaw = extractBlobSrcsFromHtml(messageHtml);
      const blobUrls = dedupeStrings(blobUrlsRaw);
      log("4b_blob_src_extract", {
        rawBlobSrcCount: blobUrlsRaw.length,
        dedupedBlobCount: blobUrls.length,
        prefixes: blobUrls.map((b) => b.slice(0, 48))
      });

      const injectJS = (editor as { injectJS?: (js: string) => void }).injectJS;
      let blobIndex = 0;
      for (const blobUrl of blobUrls) {
        blobIndex += 1;
        log("5d_blob_export_start", {
          index: blobIndex,
          total: blobUrls.length,
          prefix: blobUrl.slice(0, 48)
        });
        if (typeof injectJS !== "function") {
          log("5d_blob_export_skip_no_injectJS");
          toast.error("Editor is not ready to send pasted images");
          break;
        }
        try {
          const dataUrl = await exportBlobFromWebView(injectJS, blobUrl);
          log("5e_blob_export_ok", describeDataUriForLog(dataUrl));
          if (estimateDataUriPayloadBytes(dataUrl) > MAX_CHAT_IMAGE_BYTES) {
            log("5f_blob_export_skip_too_large", describeDataUriForLog(dataUrl));
            toast.error("Image is too large (max 20 MB)");
            continue;
          }
          const asset = await dataUriToImageAsset(dataUrl);
          pastedAssets.push(asset);
          log("5g_blob_to_file_ok", {
            fileName: asset.fileName,
            fileSize: asset.fileSize,
            type: asset.type
          });
        } catch (e) {
          logger.error("[pasteSend] 5h_blob_export_error", e);
          toast.error("Could not read pasted image from editor");
        }
      }

      log("6_pasted_assets_summary", {
        pastedCount: pastedAssets.length,
        pickerCount: pickerFiles.length
      });

      const hadInlineDataImages = dataUris.length > 0;
      const hadInlineBlobImages = blobUrls.length > 0;
      if (
        (hadInlineDataImages || hadInlineBlobImages) &&
        pastedAssets.length === 0 &&
        pickerFiles.length === 0
      ) {
        log("7_abort_no_inline_image_materialized");
        toast.error("Could not send pasted image");
        return;
      }

      setSelectedFiles([]);

      const allFiles = [...pickerFiles, ...pastedAssets];
      log("8_file_upload_batch", {
        totalFiles: allFiles.length,
        names: allFiles.map((f) => f.fileName ?? "(no name)")
      });
      if (allFiles.length > 0) {
        log("8a_await_handleFile_start");
        await Promise.resolve(handleFile(allFiles));
        log("8b_await_handleFile_done");
      } else {
        log("8_skip_no_files_to_upload");
      }

      const htmlStripped = stripDataAndBlobImgTags(messageHtml);
      const stillMedia = htmlIndicatesEmbeddedMedia(htmlStripped);
      const stillText = hasNonTagTextContent(htmlStripped);
      const shouldSendUserMessage =
        hasText || stillMedia || stillText;

      log("9_strip_and_send_decision", {
        strippedHtmlLen: htmlStripped.length,
        strippedTrimLen: htmlStripped.trim().length,
        shouldSendUserMessage,
        flags: { hasText, stillMedia, stillText },
        strippedHead: htmlHeadForLog(htmlStripped)
      });

      let sentUserMessage = false;
      if (Platform.OS === "ios") {
        if (shouldSendUserMessage && htmlStripped.trim().length > 0) {
          log("10_sendUserMessage_ios", {
            messageLen: htmlStripped.length,
            mentionCount: mentions.length
          });
          sendMessage({
            message: htmlStripped,
            mentionedUsers: mentions.map((i) => i.userId)
          });
          sentUserMessage = true;
        } else {
          log("10_skip_sendUserMessage_ios", {
            reason: !shouldSendUserMessage
              ? "shouldSendUserMessage_false"
              : "stripped_html_empty"
          });
        }
      } else if (shouldSendUserMessage && htmlStripped.trim().length > 0) {
        log("10_sendUserMessage_android", {
          messageLen: htmlStripped.length,
          mentionCount: mentions.length
        });
        sendMessage({
          message: htmlStripped,
          mentionedUsers: mentions.map((i) => i.userId)
        });
        sentUserMessage = true;
      } else {
        log("10_skip_sendUserMessage_android", {
          shouldSendUserMessage,
          strippedTrimLen: htmlStripped.trim().length
        });
      }

      const didUploadFiles = allFiles.length > 0;
      if (didUploadFiles || sentUserMessage) {
        log("11_editor_clear", { didUploadFiles, sentUserMessage });
        editor.setContent("");
      } else {
        log("11_skip_editor_clear_nothing_sent");
      }
      log("12_submit_complete");
    } finally {
      setLoader(false);
    }
  };

  return (
    <View>
      {selectedFiles?.length > 0 && (
        <View style={styles.filesContainer}>
          {selectedFiles.map((file, index) => (
            <View
              key={index}
              style={{ width: 70, height: 70, position: "relative" }}
            >
              {file?.type?.startsWith("image/") ? (
                <Image source={{ uri: file?.uri }} style={styles.filePreview} />
              ) : (
                <Video
                  source={{ uri: file?.uri }}
                  style={styles.filePreview}
                  resizeMode="cover"
                  muted={true}
                  repeat={true}
                />
              )}
              {!loader && (
                <Icon
                  onPress={() => removeFile(file?.fileName || "")}
                  name="x-circle"
                  color="white"
                  size={componentSize.sm}
                  style={styles.removeIcon}
                />
              )}
            </View>
          ))}
        </View>
      )}
      <View style={styles.toolbarContainer}>
        <View style={styles.actionButtons}>
          <TouchableOpacity
            onPress={() => editor.insertMentionChar()}
            style={styles.actionButton}
          >
            <Icon name="at-sign" size={20} />
          </TouchableOpacity>

          <TouchableOpacity onPress={toggleToolbar} style={styles.actionButton}>
            <Icon name="type-square" size={20} />
          </TouchableOpacity>

          <TouchableOpacity onPress={uploadFile} style={styles.actionButton}>
            <Icon name="file-attachment-01" size={20} />
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => {
              GiphyDialog.addListener("onMediaSelect", handleMediaSelect);
              GiphyDialog.show();
            }}
            style={styles.actionButton}
          >
            <Text size={fontSize.md} weight={"semiBold"}>
              GIF
            </Text>
          </TouchableOpacity>
        </View>
        {isEditing && (
          <Button
            onPress={() => setEditing(null)}
            type={"outline"}
            size={componentSize.sm}
            weight={"semiBold"}
          >
            Cancel
          </Button>
        )}
        <Button
          onPress={handleSubmit}
          size={componentSize.sm}
          weight={"semiBold"}
          disabled={!canSendFromEditor && !selectedFiles.length}
        >
          {loader ? "Sending..." : "Send"}
        </Button>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  filesContainer: {
    flexDirection: "row",
    marginVertical: padding.xs,
    flexWrap: "wrap"
  },
  filePreview: {
    position: "absolute",
    marginLeft: padding.md,
    marginTop: padding.xs,
    width: 60,
    height: 60,
    borderRadius: borderRadius.md
  },
  removeIcon: {
    zIndex: 10,
    position: "absolute",
    right: padding.sm,
    top: padding.sm
  },
  toolbarContainer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center"
  },
  actionButtons: {
    flexDirection: "row"
  },
  actionButton: {
    paddingHorizontal: padding.sm,
    paddingVertical: padding.xs,
    borderRadius: borderRadius.sm,
    marginLeft: padding.xs,
    marginRight: padding.xs / 2
  },
  sendButton: {
    paddingHorizontal: padding.md,
    paddingVertical: padding.md,
    borderRadius: borderRadius.md,
    alignItems: "center",
    justifyContent: "center"
  }
});
