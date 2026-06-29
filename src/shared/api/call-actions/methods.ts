import HttpClient from "../client/http-client.ts";
import { APIError } from "../client/types/types.ts";

const headers = {
  Accept: "application/json",
  Authorization: "",
  "Content-Type": "application/json"
};

export const toggleCallRecording = async (
  accessToken: string,
  callId: string,
  recording: boolean
) => {
  const apiClient = new HttpClient();
  try {
    headers.Authorization = `Bearer ${accessToken}`;

    await apiClient.post(
      "/v2/calling/recording/toggle",
      { callId, recording },
      headers
    );

    if (apiClient.success) {
      return apiClient.response as unknown as {
        callId: string;
        recording: boolean;
      };
    }
  } catch (error) {
    throw error as unknown as APIError;
  }

  throw apiClient.response as unknown as APIError;
};

export const mergeCalls = async (
  accessToken: string,
  callId: string,
  mergeCallId: string
): Promise<{ conferenceId: string }> => {
  const apiClient = new HttpClient();
  try {
    headers.Authorization = `Bearer ${accessToken}`;
    console.log("[CallActions] mergeCalls request", {
      endpoint: "/v2/calling/conference/merge",
      callId,
      mergeCallId,
      hasAccessToken: !!accessToken
    });

    await apiClient.post(
      "/v2/calling/conference/merge",
      { callId, mergeCallId },
      headers
    );
    console.log("[CallActions] mergeCalls response", {
      success: apiClient.success,
      statusCode: apiClient.code,
      response: apiClient.response
    });

    if (apiClient.success) {
      return apiClient.response as unknown as {
        conferenceId: string;
      };
    }
  } catch (error) {
    throw error as unknown as APIError;
  }

  throw apiClient.response as unknown as APIError;
};

export const addParticipantToCall = async (
  accessToken: string,
  conferenceId: string,
  mergeCallId: string
) => {
  const apiClient = new HttpClient();
  try {
    headers.Authorization = `Bearer ${accessToken}`;
    console.log("[CallActions] addParticipantToCall request", {
      endpoint: "/v2/calling/conference/add-participant",
      conferenceId,
      mergeCallId,
      hasAccessToken: !!accessToken
    });

    await apiClient.post(
      "/v2/calling/conference/add-participant",
      { conferenceId, mergeCallId },
      headers
    );
    console.log("[CallActions] addParticipantToCall response", {
      success: apiClient.success,
      statusCode: apiClient.code,
      response: apiClient.response
    });

    if (apiClient.success) {
      return apiClient.response as unknown as {
        conferenceId: string;
      };
    }
  } catch (error) {
    throw error as unknown as APIError;
  }

  throw apiClient.response as unknown as APIError;
};
