// Our worker Saga that log the user in
import { call, delay, fork, put, select, takeEvery } from "redux-saga/effects";
import * as userActions from "store/users/actions.ts";
import * as globalActions from "store/global-actions.ts";
import * as directoryActions from "store/directory/actions.ts";
import { Logger } from "shared/utils/Logger.ts";
import { State } from "store/types.ts";
import * as authActions from "store/authentication/actions.ts";
import type { CompanyContact } from "shared/api/directory/types.ts";
import { getCompanyContacts } from "shared/api/directory/methods.ts";
import {
  deletePushToken,
  setPushToken,
  getCurrentUserProfile
} from "shared/api/users/methods.ts";
import { jwtAuthenticate } from "shared/api/authentication/methods.ts";
import { normalizeUserDnd } from "shared/utils/user-dnd.ts";

const logger = new Logger("User Sagas: ");

const PROFILE_SYNC_INTERVAL_MS = 10000; // 10 seconds

const getToken = (state: State) => state.authReducer.accessToken;

interface StorePushAction {
  type: typeof authActions.LOGIN_SUCCESS;
  payload: {
    pushToken: string;
    tokenType: string;
  };
}

function* storePushId(action: StorePushAction): Generator<any, void, any> {
  try {
    const authReducer = yield select((state: State) => state.authReducer);
    if (
      authReducer.isLoggedIn &&
      action.payload.pushToken &&
      action.payload.pushToken.length > 0
    ) {
      if (action.payload.tokenType === "ios_voip") {
        logger.debug("[storePushId] Saving VoIP push token to backend", {
          tokenType: action.payload.tokenType,
          tokenLength: action.payload.pushToken.length,
          token: action.payload.pushToken
        });
      }
      yield call(setPushToken, {
        tokenType: action.payload.tokenType,
        token: action.payload.pushToken,
        accessToken: authReducer.accessToken
      });
      if (action.payload.tokenType === "ios_voip") {
        logger.debug("[storePushId] VoIP push token save request completed");
      }
    }
  } catch (e) {
    if (action.payload.tokenType === "ios_voip") {
      logger.error("[storePushId] Failed to save VoIP push token", e);
    }
  }
}

function* deletePushId(): Generator<any, void, any> {
  logger.debug("deletePushId() saga: deleting user push token");
  try {
    const authReducer = yield select((state: State) => state.authReducer);
    const accessToken = authReducer?.accessToken;

    if (accessToken) {
      yield call(deletePushToken, accessToken);
    } else {
      logger.warn(
        "deletePushId() called without accessToken - skipping API call"
      );
    }
  } catch (error) {
    logger.error("deletePushId() error:", error);
  }
}

function* refreshUserProfile(): Generator<any, void, any> {
  try {
    const token: string = yield select(getToken);
    if (!token) return;
    const user = (yield select((s: State) => s.userReducer?.user)) as {
      avatarPath?: string;
      coverPhoto?: string;
      dnd?: string;
    } | null;
    const profile = (yield call(
      getCurrentUserProfile,
      token
    )) as Awaited<ReturnType<typeof getCurrentUserProfile>>;

    let dnd: "0" | "1" | undefined = profile?.dnd;
    if (dnd === undefined) {
      try {
        const auth = (yield call(
          jwtAuthenticate,
          token
        )) as Awaited<ReturnType<typeof jwtAuthenticate>>;
        if (auth?.user && auth.user.dnd !== undefined && auth.user.dnd !== null) {
          dnd = normalizeUserDnd(auth.user.dnd);
        }
      } catch (e) {
        logger.debug("refreshUserProfile jwtAuthenticate fallback:", e);
      }
    }

    if (!profile && dnd === undefined) return;

    const updates: Record<string, unknown> = {};
    if (profile) {
      if (profile.avatarPath != null && profile.avatarPath !== user?.avatarPath) {
        updates.avatarPath = profile.avatarPath;
      }
      if (profile.coverPhoto != null && profile.coverPhoto !== user?.coverPhoto) {
        updates.coverPhoto = profile.coverPhoto;
      }
    }
    if (dnd !== undefined) {
      const current = normalizeUserDnd(user?.dnd);
      if (dnd !== current) {
        updates.dnd = dnd;
      }
    }
    if (Object.keys(updates).length === 0) return;
    if (updates.avatarPath != null) {
      updates.avatarMediaVersion = Date.now();
    }
    if (updates.coverPhoto != null) {
      updates.coverMediaVersion = Date.now();
    }
    yield put({ type: userActions.UPDATE_USER, payload: updates });
    logger.debug("refreshUserProfile: updated from server", {
      keys: Object.keys(updates)
    });
  } catch (e) {
    logger.debug("refreshUserProfile error:", e);
  }
}

function* syncUserProfileFromDirectory(action: {
  type: string;
  payload: CompanyContact[];
}): Generator<any, void, any> {
  try {
    const user = (yield select((s: State) => s.userReducer?.user)) as {
      id?: number;
      extId?: number;
      avatarPath?: string;
      coverPhoto?: string;
    } | null;
    if (!user?.id) return;
    const contacts = action?.payload;
    if (!Array.isArray(contacts)) return;
    const self = contacts.find(
      (c) => c.userId === user.id || c.extId === user.extId
    );
    if (!self) return;
    const updates: Record<string, unknown> = {};
    if (self.avatarPath != null && self.avatarPath !== user.avatarPath) {
      updates.avatarPath = self.avatarPath;
    }
    if (self.coverPhoto != null && self.coverPhoto !== user.coverPhoto) {
      updates.coverPhoto = self.coverPhoto;
    }
    if (Object.keys(updates).length > 0) {
      if (updates.avatarPath != null) {
        updates.avatarMediaVersion = Date.now();
      }
      if (updates.coverPhoto != null) {
        updates.coverMediaVersion = Date.now();
      }
      yield put({ type: userActions.UPDATE_USER, payload: updates });
      logger.debug(
        "syncUserProfileFromDirectory: updated avatar/cover from company contacts"
      );
    }
  } catch (e) {
    logger.debug("syncUserProfileFromDirectory error:", e);
  }
}

/**
 * Runs every 5s while logged in. Fetches profile (company contacts), compares
 * avatar/cover URLs to current user. Updates Redux + force-refresh only when
 * something changed—otherwise no update, so no redundant polling side effects.
 * Ensures other-device profile/banner updates appear even if user stays on the same page.
 */
function* profileSyncLoop(): Generator<any, void, any> {
  while (true) {
    yield delay(PROFILE_SYNC_INTERVAL_MS);

    const token: string = yield select(getToken);
    const user = (yield select((s: State) => s.userReducer?.user)) as {
      id?: number;
      extId?: number;
      avatarPath?: string;
      coverPhoto?: string;
    } | null;
    if (!token || !user?.id) continue;

    try {
      const contacts: CompanyContact[] = yield call(getCompanyContacts, token);
      const self = contacts.find(
        (c) => c.userId === user.id || c.extId === user.extId
      );
      if (!self) continue;

      const updates: Record<string, unknown> = {};
      if (self.avatarPath != null && self.avatarPath !== user.avatarPath) {
        updates.avatarPath = self.avatarPath;
      }
      if (self.coverPhoto != null && self.coverPhoto !== user.coverPhoto) {
        updates.coverPhoto = self.coverPhoto;
      }
      if (Object.keys(updates).length === 0) continue;

      if (updates.avatarPath != null) {
        updates.avatarMediaVersion = Date.now();
      }
      if (updates.coverPhoto != null) {
        updates.coverMediaVersion = Date.now();
      }
      yield put({ type: userActions.UPDATE_USER, payload: updates });
      logger.debug(
        "profileSyncLoop: profile/banner URLs changed → updated and force-refreshed"
      );
    } catch (e) {
      logger.debug("profileSyncLoop error:", e);
    }
  }
}

export const userSagas = [
  takeEvery(userActions.DELETE_PUSH_ID, deletePushId),
  takeEvery(userActions.STORE_PUSH_ID, storePushId),
  takeEvery(userActions.REFRESH_USER_PROFILE, refreshUserProfile),
  takeEvery(globalActions.APP_FOREGROUND, refreshUserProfile),
  takeEvery(
    directoryActions.FETCH_COMPANY_CONTACTS_SUCCESS,
    syncUserProfileFromDirectory
  ),
  fork(profileSyncLoop)
];
