import React, { useEffect, useRef } from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { connect } from "react-redux";
import { Dispatch } from "redux";
import { StyleSheet, View } from "react-native";
import { Logger } from "shared/utils/Logger.ts";
import { State } from "store/types.ts";
import { UnauthenticatedStackNavigator } from "core/navigation/navigators/UnauthenticatedStack.tsx";
import { AuthenticatedStackNavigator } from "core/navigation/navigators/AuthenticatedStack.tsx";
import * as directoryActions from "store/directory/actions.ts";

const _logger = new Logger("Parent Navigator: ");
console.log(_logger);

interface Props {
  isLoggedIn: boolean;
  fetchInitialData: () => void;
}

export type MainStackParams = {
  Unauthenticated: undefined;
  Authenticated: undefined;
  InCallScreen: undefined;
};

const AppStackNavigator = createNativeStackNavigator<MainStackParams>();

interface MainNavigatorProps extends Props {
  user: State["userReducer"]["user"];
}

const MainNavigator = ({ isLoggedIn, fetchInitialData, user }: MainNavigatorProps) => {
  // logger.debug("User Logged In: ", isLoggedIn);
  
  // Track if initial data has been fetched to prevent duplicate fetches
  const hasFetchedInitialDataRef = useRef(false);

  // Log current logged-in user details (on login or when app opens with existing session)
  useEffect(() => {
    if (user) {
      _logger.debug("👤 [Current user] Logged-in user details:", {
        userId: user.id,
        email: user.email,
        tenantId: user.tenantId,
        extensionId: user.extId,
        extensionName: user.extName,
        extensionNumber: user.extNum,
        phoneNumber: user.phoneNumber,
        provisionedNumbers: user.provisionedNumbers
      });
    }
  }, [user?.id]);

  useEffect(() => {
    const loadInitialData = async () => {
      // OPTIMIZE: Only fetch once on first login, not every time isLoggedIn changes
      if (isLoggedIn && !hasFetchedInitialDataRef.current) {
        hasFetchedInitialDataRef.current = true;
        fetchInitialData();
      }
    };

    loadInitialData();
  }, [isLoggedIn, fetchInitialData]);

  // Reset flag on logout
  useEffect(() => {
    if (!isLoggedIn) {
      hasFetchedInitialDataRef.current = false;
    }
  }, [isLoggedIn]);

  return (
    <View style={styles.full}>
      <AppStackNavigator.Navigator screenOptions={{ headerShown: false }}>
        {!isLoggedIn ? (
          <AppStackNavigator.Screen
            name="Unauthenticated"
            component={UnauthenticatedStackNavigator}
          />
        ) : (
          <AppStackNavigator.Screen
            name="Authenticated"
            component={AuthenticatedStackNavigator}
          />
        )}
      </AppStackNavigator.Navigator>
    </View>
  );
};

const styles = StyleSheet.create({
  full: {
    flex: 1
  }
});

function mapStateToProps(state: State) {
  return {
    isLoggedIn: state.userReducer.user !== null,
    user: state.userReducer.user
  };
}

// dispatch: Dispatch
function mapDispatchToProps(dispatch: Dispatch) {
  return {
    // @ts-ignore
    fetchInitialData: async () => {
      await Promise.all([
        dispatch({ type: directoryActions.FETCH_COMPANY_CONTACTS }),
        dispatch({ type: directoryActions.FETCH_PERSONAL_CONTACTS }),
        dispatch({ type: directoryActions.FETCH_GROUPS })
      ]);
    }
  };
}

export const Navigation = connect(
  mapStateToProps,
  mapDispatchToProps
)(MainNavigator);
