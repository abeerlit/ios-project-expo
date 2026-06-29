import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import {
  ChatParams,
  Routes,
  ThreadsChatParams,
  TwoFactorSetupParams,
  TwoFactorVerifyParams
} from "core/navigation/types/types.ts";
import { BottomTabNavigator } from "core/navigation/navigators/BottomTabNavigator.tsx";
import PreferencesScreen from "features/preferences/PreferencesScreen.tsx";
import { AuthenticationTwoFactorSetup } from "features/authentication/pages/AuthenticationTwoFactorSetup.tsx";
import { AuthenticationTwoFactorVerify } from "features/authentication/pages/AuthenticationTwoFactorVerify.tsx";
import { Chat } from "features/chat/pages/Chat.tsx";
import { Threads } from "features/chat/pages/Threads.tsx";
import { InCallScreen } from "features/calling/components/InCallScreen.tsx";
import { TextConversations } from "features/text/pages/TextConversations.tsx";
import { Meetings } from "features/meeting/pages/Meetings.tsx";

export type AuthParams = {
  BottomTabNavigator: undefined;
  Inbox: undefined;
  Contacts: undefined;
  Keypad: undefined;
  PermissionsNotifications: undefined;
  PermissionsMicrophone: undefined;
  PermissionsContacts: undefined;
  MissingPolicyConsent: undefined;
  Preferences: undefined;
  TwoFactorSetup: TwoFactorSetupParams;
  TwoFactorVerify: TwoFactorVerifyParams;
  Chat: ChatParams;
  Threads: ThreadsChatParams;
  InCallScreen: {
    callId?: string;
    /** For immediate "Dialing..." shell before SIP session exists. */
    destination?: string;
    displayName?: string;
    avatarPath?: string | null;
  };
  NewMessage: ChatParams | undefined;
  Meetings: {
    meetURL: string;
    roomId?: string;
    meetingToken?: string;
    enableTranscription?: number;
  };
  TextConversations: undefined;
  TextThread: ChatParams;
  NewTextMessage: undefined;
};

const AuthNavigator = createNativeStackNavigator<AuthParams>();

export const AuthenticatedStackNavigator = () => {
  const initialRoute = Routes.BottomTabNavigator;

  return (
    <AuthNavigator.Navigator
      screenOptions={{ headerShown: false }}
      initialRouteName={initialRoute}
    >
      <AuthNavigator.Screen
        name="BottomTabNavigator"
        component={BottomTabNavigator}
      />
      <AuthNavigator.Screen
        name={Routes.Preferences}
        component={PreferencesScreen}
      />
      <AuthNavigator.Screen
        name={Routes.TwoFactorSetup}
        component={AuthenticationTwoFactorSetup}
      />
      <AuthNavigator.Screen
        name={Routes.TwoFactorVerify}
        component={AuthenticationTwoFactorVerify}
      />
      <AuthNavigator.Screen name={Routes.Chat} component={Chat} />
      <AuthNavigator.Screen name={Routes.Threads} component={Threads} />
      <AuthNavigator.Screen
        name="InCallScreen"
        component={InCallScreen}
        options={{
          headerShown: false,
          // presentation: "modal",
          gestureEnabled: false
        }}
      />
      <AuthNavigator.Screen name={Routes.NewMessage} component={Chat} />
      <AuthNavigator.Screen
        name={Routes.TextConversations}
        component={TextConversations}
      />
      <AuthNavigator.Screen name={Routes.Meetings} component={Meetings} />
      <AuthNavigator.Screen name={Routes.TextThread} component={Chat} />
      <AuthNavigator.Screen name={Routes.NewTextMessage} component={Chat} />
    </AuthNavigator.Navigator>
  );
};
