import HttpClient from "../client/http-client.ts";
import { APIError } from "../client/types/types.ts";
import { APIRequestHeaders } from "../client/http-client.ts";
import {
  ConversationResponse,
  TextConversation,
  TextMessages,
  ProvisionedNumbers,
  EditorMessage,
  MediaUploadResponse,
  SendMessageResponse
} from "./types.ts";
import { Logger } from "shared/utils/Logger.ts";
import { Platform } from "react-native";

const logger = new Logger("Messaging API: ");

const headers: APIRequestHeaders = {
  Accept: "application/json",
  Authorization: "",
  "Content-Type": "application/json"
};

// List all SMS/MMS conversations
export const listConversations = async (
  accessToken: string
): Promise<ConversationResponse> => {
  logger.debug("listConversations() called");
  const apiClient = new HttpClient();

  try {
    headers.Authorization = `Bearer ${accessToken}`;

    await apiClient.get("/v2/messaging/conversations", headers);

    if (apiClient.success) {
      const response = apiClient.response as unknown as ConversationResponse;
      // logger.debug("listConversations() success - Retrieved conversations:", {
      //   count: response.records?.length || 0,
      //   totalRecords: response.totalRecords
      // });
      return response;
    }
  } catch (error) {
    logger.error("listConversations() error:", error);
    throw error as unknown as APIError;
  }

  logger.error(
    "listConversations() failed - API response:",
    apiClient.response
  );
  throw apiClient.response as unknown as APIError;
};

// Get a specific conversation by ID
export const getConversationById = async (
  accessToken: string,
  conversationId: number
): Promise<TextConversation> => {
  logger.debug(
    "getConversationById() called with conversationId:",
    conversationId
  );
  const apiClient = new HttpClient();

  try {
    headers.Authorization = `Bearer ${accessToken}`;

    await apiClient.get(
      `/v2/messaging/conversations/${conversationId}`,
      headers
    );

    if (apiClient.success) {
      const response = apiClient.response as unknown as TextConversation;
      logger.debug("getConversationById() success - Retrieved conversation:", {
        id: response.id,
        participantCount: response.participants?.length || 0
      });
      return response;
    }
  } catch (error) {
    logger.error(
      "getConversationById() error - conversationId:",
      conversationId,
      "error:",
      error
    );
    throw error as unknown as APIError;
  }

  logger.error(
    "getConversationById() failed - conversationId:",
    conversationId,
    "API response:",
    apiClient.response
  );
  throw apiClient.response as unknown as APIError;
};

// Get conversation by participants
export const getConversationsByParticipants = async (
  accessToken: string,
  from: string,
  to: string
): Promise<TextConversation> => {
  logger.debug(
    "getConversationsByParticipants() called with from:",
    from,
    "to:",
    to
  );
  const apiClient = new HttpClient();

  try {
    headers.Authorization = `Bearer ${accessToken}`;

    await apiClient.get(
      `/v2/messaging/conversations/conversation-by-participants?from=${from}&to=${to}`,
      headers
    );

    if (apiClient.success) {
      const response = apiClient.response as unknown as TextConversation;
      logger.debug(
        "getConversationsByParticipants() success - Retrieved conversation:",
        {
          id: response.id,
          from,
          to
        }
      );
      return response;
    }
  } catch (error) {
    // 404 is expected when no conversation exists yet - don't log as error
    const apiError = error as any;
    if (apiError?.code === 404 || apiError?.message?.includes("not found")) {
      logger.debug(
        "getConversationsByParticipants() - No conversation found (404 - this is normal for new numbers)"
      );
    } else {
      logger.error(
        "getConversationsByParticipants() error - from:",
        from,
        "to:",
        to,
        "error:",
        error
      );
    }
    throw error as unknown as APIError;
  }

  // Check if response is 404 (conversation not found)
  const response = apiClient.response as any;
  if (response?.code === 404 || response?.message?.includes("not found")) {
    logger.debug(
      "getConversationsByParticipants() - No conversation found (404 - this is normal for new numbers)"
    );
    throw apiClient.response as unknown as APIError;
  }

  logger.error(
    "getConversationsByParticipants() failed - from:",
    from,
    "to:",
    to,
    "API response:",
    apiClient.response
  );
  throw apiClient.response as unknown as APIError;
};

// Get messages for a specific conversation
export const getMessagesForConversation = async (
  accessToken: string,
  userId: number,
  conversationId: number,
  pageNumber: number = 1,
  recordsPerPage: number = 100,
  forceRefresh: boolean = false
): Promise<TextMessages> => {
  logger.debug("getMessagesForConversation() called with params:", {
    userId,
    conversationId,
    pageNumber,
    recordsPerPage
  });
  const apiClient = new HttpClient();

  try {
    headers.Authorization = `Bearer ${accessToken}`;

    const timestamp = forceRefresh ? `&_t=${Date.now()}` : "";
    await apiClient.get(
      `/v2/messaging/messages?conversationId=${conversationId}&page=${pageNumber}&recordsPerPage=${recordsPerPage}`,
      headers
    );

    if (apiClient.success) {
      const response = apiClient.response as unknown as TextMessages;
      logger.debug(
        "getMessagesForConversation() success - Retrieved messages:",
        {
          conversationId,
          messageCount: response.records?.length || 0,
          totalRecords: response.totalRecords,
          currentPage: pageNumber
        }
      );
      return response;
    }
  } catch (error) {
    logger.error(
      "getMessagesForConversation() error - conversationId:",
      conversationId,
      "userId:",
      userId,
      "error:",
      error
    );
    throw error as unknown as APIError;
  }

  logger.error(
    "getMessagesForConversation() failed - conversationId:",
    conversationId,
    "API response:",
    apiClient.response
  );
  throw apiClient.response as unknown as APIError;
};

// Get provisioned numbers for SMS/MMS (10DLC)
export const getProvisionedNumbers = async (
  accessToken: string
): Promise<ProvisionedNumbers> => {
  logger.debug("getProvisionedNumbers() called");
  const apiClient = new HttpClient();

  try {
    headers.Authorization = `Bearer ${accessToken}`;

    await apiClient.get("/v2/messaging/get-provisioned-numbers", headers);

    if (apiClient.success) {
      const response = apiClient.response as unknown as ProvisionedNumbers;
      logger.debug(
        "getProvisionedNumbers() success - Retrieved provisioned numbers:",
        {
          count: response.provisionedNumbers?.length || 0
        }
      );
      return response;
    }
  } catch (error) {
    logger.error("getProvisionedNumbers() error:", error);
    throw error as unknown as APIError;
  }

  logger.error(
    "getProvisionedNumbers() failed - API response:",
    apiClient.response
  );
  throw apiClient.response as unknown as APIError;
};

// Send SMS or MMS message
export const sendNewTextMessage = async (
  accessToken: string,
  tenantId: number | undefined,
  recipients: string[],
  sender: string,
  message: EditorMessage,
  mediaUrls: string[]
): Promise<SendMessageResponse> => {
  logger.debug("📱 [sendNewTextMessage] Called with:", {
    recipientsCount: recipients.length,
    recipients: recipients,
    sender: sender,
    messageLength: message.text?.length || 0,
    tenantId: tenantId,
    hasMedia: mediaUrls?.length > 0
  });

  if (recipients.length === 0 || sender.length === 0) {
    const error = new Error("Recipients and sender are required");
    logger.error("📱 [sendNewTextMessage] Validation failed:", error);
    throw error;
  }

  const apiClient = new HttpClient();

  const isMMSMessage = recipients.length > 1 || mediaUrls?.length > 0;

  const smsUrl = "/v2/messaging/messages/send-sms";
  const mmsUrl = "/v2/messaging/messages/send-mms";

  try {
    headers.Authorization = `Bearer ${accessToken}`;

    const messageBody: {
      tenantId: number | undefined;
      to: string[];
      from: string;
      text?: string;
      mediaUrls?: string[];
    } = {
      tenantId: tenantId,
      to: recipients,
      from: sender,
      text: message.text
    };

    if (isMMSMessage) {
      if (mediaUrls && mediaUrls.length > 0) messageBody.mediaUrls = mediaUrls;
    }

    if (!messageBody.text) delete messageBody.text;

    const url = isMMSMessage ? mmsUrl : smsUrl;
    logger.debug("📱 [sendNewTextMessage] Sending request to:", url);
    logger.debug(
      "📱 [sendNewTextMessage] Request body:",
      JSON.stringify(messageBody, null, 2)
    );

    await apiClient.post(url, messageBody, headers);

    if (apiClient.success) {
      logger.debug("📱 [sendNewTextMessage] Success:", apiClient.response);
      return apiClient.response as unknown as SendMessageResponse;
    } else {
      logger.error("📱 [sendNewTextMessage] API call failed:", {
        success: apiClient.success,
        response: apiClient.response,
        status: apiClient.status
      });
    }
  } catch (error: any) {
    logger.error("📱 [sendNewTextMessage] Exception caught:", {
      error: error,
      code: error?.code,
      message: error?.message,
      response: error?.response || apiClient.response,
      status: error?.status || apiClient.status
    });
    throw error as unknown as APIError;
  }

  logger.error(
    "📱 [sendNewTextMessage] Request failed - throwing API error:",
    apiClient.response
  );
  throw apiClient.response as unknown as APIError;
};

// Upload media files for MMS
export const uploadMediaFiles = async (
  accessToken: string,
  files: Array<{ uri: string; name?: string; type?: string; fileName?: string }>
): Promise<MediaUploadResponse | undefined> => {
  if (files && files.length === 0) {
    return;
  }

  const apiClient = new HttpClient();

  try {
    headers.Authorization = `Bearer ${accessToken}`;
    const headersCopy = { ...headers };
    delete headersCopy["Content-Type"];

    const formData = new FormData();

    for (const file of files) {
      const fileName = file.fileName || file.name || `media_${Date.now()}`;

      // On iOS, strip "file://" prefix from URI (required for FormData)
      let fileUri = file.uri;
      if (!fileUri) {
        logger.error("📱 [uploadMediaFiles] File URI is missing");
        throw new Error("File URI is required for upload");
      }

      if (Platform.OS === "ios" && fileUri.startsWith("file://")) {
        fileUri = fileUri.replace("file://", "");
      }

      // Use the type from file, or default to image/jpeg
      const mimeType = file.type || "image/jpeg";

      logger.debug("📱 [uploadMediaFiles] Adding file:", {
        fileName,
        mimeType,
        platform: Platform.OS
      });

      formData.append(fileName, {
        uri: fileUri,
        name: fileName,
        type: mimeType
      });
    }

    logger.debug("📱 [uploadMediaFiles] Uploading files:", {
      fileCount: files.length,
      platform: Platform.OS
    });

    await apiClient.post(
      "/v2/messaging/messages/upload-media",
      formData,
      headersCopy
    );

    if (apiClient.success) {
      logger.debug(
        "📱 [uploadMediaFiles] Upload successful:",
        apiClient.response
      );
      return apiClient.response as unknown as MediaUploadResponse;
    } else {
      logger.error("📱 [uploadMediaFiles] Upload failed:", {
        success: apiClient.success,
        response: apiClient.response,
        status: apiClient.code
      });
    }
  } catch (error: any) {
    logger.error("📱 [uploadMediaFiles] Exception caught:", {
      error: error,
      code: error?.code,
      message: error?.message,
      response: error?.response || apiClient.response,
      status: error?.status || apiClient.code
    });
    throw error as unknown as APIError;
  }

  throw apiClient.response as unknown as APIError;
};

// Hide/archive a conversation
export const hideConversation = async (
  accessToken: string,
  conversationId: number
): Promise<void> => {
  const apiClient = new HttpClient();

  try {
    headers.Authorization = `Bearer ${accessToken}`;
    const headersCopy = { ...headers };
    delete headersCopy["Content-Type"];

    await apiClient.delete(
      `/v2/messaging/conversations/${conversationId}`,
      headersCopy
    );

    if (apiClient.success) {
      return apiClient.response as unknown as any;
    }
  } catch (error) {
    logger.error("hideConversation(): ", error);
    throw error as unknown as APIError;
  }

  throw apiClient.response as unknown as APIError;
};

// Mark conversation as read
export const markConversationAsRead = async (
  accessToken: string,
  conversationId: number
): Promise<void> => {
  const apiClient = new HttpClient();

  try {
    headers.Authorization = `Bearer ${accessToken}`;
    const headersCopy = { ...headers };
    delete headersCopy["Content-Type"];

    await apiClient.patch(
      `/v2/messaging/conversations/mark-read/${conversationId}`,
      {},
      headersCopy
    );

    if (apiClient.success) {
      return apiClient.response as unknown as any;
    }
  } catch (error) {
    logger.error("markConversationAsRead(): ", error);
    throw error as unknown as APIError;
  }

  throw apiClient.response as unknown as APIError;
};

// Update conversation name
export const patchConversationName = async (
  accessToken: string,
  conversationId: number,
  name: string
): Promise<void> => {
  const apiClient = new HttpClient();

  try {
    headers.Authorization = `Bearer ${accessToken}`;

    await apiClient.patch(
      `/v2/messaging/conversations/name/${conversationId}`,
      {
        conversationName: name
      },
      headers
    );

    if (apiClient.success) {
      return apiClient.response as unknown as any;
    }
  } catch (error) {
    logger.error("patchConversationName(): ", error);
    throw error as unknown as APIError;
  }

  throw apiClient.response as unknown as APIError;
};

// Retry failed message
export const retryFailedMessage = async (
  accessToken: string,
  messageId: number
): Promise<void> => {
  const apiClient = new HttpClient();

  try {
    headers.Authorization = `Bearer ${accessToken}`;

    await apiClient.patch(
      `/v2/messaging/messages/retry-message/${messageId}`,
      { messageId },
      headers
    );

    if (apiClient.success) {
      return apiClient.response as unknown as any;
    }
  } catch (error) {
    logger.error("retryFailedMessage(): ", error);
    throw error as unknown as APIError;
  }

  throw apiClient.response as unknown as APIError;
};

// Search messages
export const searchAllMessages = async (
  accessToken: string,
  userId: number,
  query: string
): Promise<any> => {
  const apiClient = new HttpClient();

  try {
    headers.Authorization = `Bearer ${accessToken}`;

    let searchQuery = query;
    if (query.startsWith("#")) {
      searchQuery = encodeURIComponent(query);
    }

    await apiClient.get(
      `/v2/messaging/messages/search?userId=${userId}&query=${searchQuery}`,
      headers
    );

    if (apiClient.success) {
      return apiClient.response as unknown as any;
    }
  } catch (error) {
    logger.error("searchAllMessages(): ", error);
    throw error as unknown as APIError;
  }

  throw apiClient.response as unknown as APIError;
};
