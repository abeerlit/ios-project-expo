/* User Reducer
 * handles user states in the app
 */
import * as userActions from "./actions.ts";
import { State } from "store/types.ts";
import createReducer from "store/utils/create-reducer.ts";
import { User } from "shared/api/users/types.ts";
import { Logger } from "shared/utils/Logger.ts";

const logger = new Logger("AuthReducer");

export interface UserState {
  user: User | null;
  shouldResetTokenRegistration: boolean;
}

const initialState: UserState = {
  user: null,
  shouldResetTokenRegistration: false
};

// @ts-expect-error Ignoring the type error because making it typesafe involves a lot of work when we already know it will be safe
export const userReducer = createReducer<UserState, unknown>(initialState, {
  [userActions.PROVISION_USER](
    state: State["userReducer"],
    action: { type: string; payload: User }
  ) {
    const u = action.payload;
    logger.debug("PROVISION_USER");
    logger.debug("👤 [Current user] Logged-in user details:", {
      userId: u?.id,
      email: u?.email,
      tenantId: u?.tenantId,
      extensionId: u?.extId,
      extensionName: u?.extName,
      extensionNumber: u?.extNum,
      phoneNumber: u?.phoneNumber,
      provisionedNumbers: u?.provisionedNumbers
    });
    return {
      ...state,
      user: action.payload,
      shouldResetTokenRegistration: false // Reset flag on new login
    };
  },
  [userActions.CLEAR_USER](state: State["userReducer"]) {
    return {
      ...state,
      user: null,
      shouldResetTokenRegistration: false // Clear the flag when user is cleared
    };
  },
  [userActions.RESET_TOKEN_REGISTRATION](state: State["userReducer"]) {
    logger.debug("RESET_TOKEN_REGISTRATION");
    return {
      ...state,
      shouldResetTokenRegistration: true
    };
  },
  [userActions.UPDATE_USER](
    state: State["userReducer"],
    action: { type: string; payload: Partial<User> }
  ) {
    logger.debug("UPDATE_USER", action.payload);
    if (!state.user) {
      return state;
    }
    return {
      ...state,
      user: {
        ...state.user,
        ...action.payload
      }
    };
  }
});
