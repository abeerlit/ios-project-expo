import HttpClient from "shared/api/client/http-client.ts";
import { FaxDownloadResponse, FaxParams } from "./types.ts";
import { APIError } from "shared/api/client/types/types.ts";
import { Logger } from "shared/utils/Logger.ts";
import { Platform } from "react-native";

const headers = {
  Accept: "application/json",
  "Content-Type": "application/json",
  Authorization: ""
};

const logger = new Logger("Faxes API");

// Not using API Client on this one because of faxing
export async function sendFax(passedBody: FaxParams, accessToken: string) {
  try {
    let { uri } = passedBody;
    logger.debug("sendFax - URI:", uri);
    logger.debug("sendFax - Input context:", {
      hasFrom: !!passedBody.from,
      from: passedBody.from || null,
      destinationNum: passedBody.destinationNum,
      destinationLength: passedBody.destinationNum?.length ?? 0,
      platform: Platform.OS
    });
    if (!uri) {
      throw { type: "no_fax", message: "No fax was selected" };
    }
    const formData = new FormData();

    if (Platform.OS === "ios" && !uri.startsWith("file://")) {
      uri = `file://${uri}`;
    }
    const fileName = uri.split("/").pop() || `attachment.pdf`;
    const filePart = {
      uri,
      name: fileName,
      type: "application/pdf"
    };

    // Match web payload shape: from + attachment1.
    if (passedBody.from) {
      formData.append("from", passedBody.from);
    }
    formData.append("attachment1", filePart as any);
    // Compatibility fields for backends expecting different keys.
    formData.append("attachment", filePart as any);
    formData.append("file", filePart as any);
    logger.debug("sendFax - FormData prepared:", {
      formFields: [
        ...(passedBody.from ? ["from"] : []),
        "attachment1",
        "attachment",
        "file"
      ],
      fileName,
      fileType: filePart.type,
      uriPrefix: uri.slice(0, 40)
    });

    logger.debug(
      "sendFax - Sending request to:",
      `https://api.voxo.co/v2/faxes/send-fax?destNums=${passedBody.destinationNum}`
    );

    const response = await fetch(
      `https://api.voxo.co/v2/faxes/send-fax?destNums=${passedBody.destinationNum}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        body: formData
      }
    );

    logger.debug("sendFax - Response status:", response.status);
    logger.debug("sendFax - Response OK:", response.ok);

    // Check if response is OK
    if (!response.ok) {
      const errorText = await response.text();
      logger.error("sendFax - API error response:", errorText);
      throw {
        type: "api_error",
        message: `API returned status ${response.status}: ${errorText}`,
        status: response.status
      };
    }

    // Parse the response
    const responseData = await response.json();
    logger.debug("sendFax - Response data:", responseData);

    // Check if the fax was successfully queued
    if (responseData.status === "Failed" || responseData.status === "failed") {
      logger.error("sendFax - Fax failed to queue:", responseData.message);
      throw {
        type: "fax_failed",
        message: responseData.message || "Fax failed to queue",
        status: "Failed"
      };
    }

    if (
      responseData.status !== "success" &&
      responseData.status !== "Success"
    ) {
      logger.warn("sendFax - Unexpected status:", responseData.status);
    }

    return responseData;
  } catch (e: any) {
    logger.error("sendFax() error: ", e);
    throw e as unknown as APIError;
  }
}

export const downloadFax = async (accessToken: string, id: number) => {
  const apiClient = new HttpClient();

  try {
    headers.Authorization = `Bearer ${accessToken}`;

    await apiClient.get(`/v2/faxes/download/${id}`, headers);

    if (apiClient.success) {
      return apiClient.response as unknown as FaxDownloadResponse;
    }
  } catch (e) {
    logger.error("downloadFax() error: ", e);
    throw e as unknown as APIError;
  }

  throw apiClient.response as unknown as APIError;
};

export const retryFax = async (id: number) => {
  const apiClient = new HttpClient();

  try {
    await apiClient.get(`/v2/faxes/retry/${id}`, headers);

    if (apiClient.success) {
      return apiClient.response as unknown as any;
    }
  } catch (e) {
    logger.error("retryFax() error: ", e);
    throw e as unknown as APIError;
  }

  throw apiClient.response as unknown as APIError;
};
