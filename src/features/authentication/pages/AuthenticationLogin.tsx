// React Imports
import {
  ENABLE_GOOGLE_SSO,
  ENABLE_MICROSOFT_SSO,
  GOOGLE_CLIENT_ID
} from "@env";
import {
  authenticate,
  azureSignIn,
  googleSignIn
} from "shared/api/authentication/methods.ts";
import { useDispatch } from "react-redux";
import { useMutation } from "@tanstack/react-query";
import { useTheme } from "hooks/use-theme.ts";
import { useCallback, useEffect, useState } from "react";
import { isValidEmail } from "shared/utils/utils.ts";
import { useNavigation } from "@react-navigation/core";
import { LOGIN_SUCCESS } from "store/authentication/actions.ts";
import { GoogleSignin } from "@react-native-google-signin/google-signin";
import { authorize } from "react-native-app-auth";

// Type Imports
import React from "react";
import { APIError } from "shared/api/client/types/types.ts";
import { FieldInputProps } from "formik";
import {
  MFAMode,
  AuthResponse,
  BasicAuthRequestBody
} from "shared/api/authentication/types.ts";
import { LoginScreenNavigationProp } from "features/authentication/types/authentication.types.ts";

// Component Imports
import { Logger } from "shared/utils/Logger.ts";
import { Text } from "shared/components/Text.tsx";
import LoginBG from "assets/bg/bg_grid.svg";
import { Routes } from "core/navigation/types/types.ts";
import { Button } from "shared/components/Button.tsx";
import { TextInput } from "shared/components/TextInput.tsx";
import { Screen } from "shared/components/utils/Screen.tsx";
import { BrandingLogo } from "shared/branding/BrandingLogo.tsx";
import {
  getLegalPrivacyUrl,
  getLegalTermsUrl
} from "shared/branding/appBrand.ts";
import { Field, FormikProvider, useFormik } from "formik";
import { toast } from "@backpackapp-io/react-native-toast";
import GoogleIcon from "assets/brand/google_icon.svg";
import MicrosoftIcon from "assets/brand/microsoft_icon.svg";
import { WhiteSpace } from "shared/components/utils/Whitespace.tsx";
import { microsoftConfig } from "features/authentication/config/sso-config.ts";
import { GOOGLE_IOS_CLIENT_ID } from "features/authentication/config/google-signin-config.ts";
import {
  Dimensions,
  Keyboard,
  Linking,
  TouchableOpacity,
  View
} from "react-native";
import { AuthenticationEnums } from "features/authentication/enums/authentication.enums.ts";
import { authenticationStyles } from "features/authentication/styles/authentication.styles.ts";
import { fontSize } from "core/theme/theme.ts";

interface FormValues {
  email: string;
  password: string;
}

const Login = () => {
  // Constants
  const logger = new Logger("LoginScreen: ");
  const { width } = Dimensions.get("window");

  // Configs — webClientId required when offlineAccess is true
  useEffect(() => {
    if (ENABLE_GOOGLE_SSO !== "true" || !GOOGLE_CLIENT_ID?.trim()) return;
    GoogleSignin.configure({
      iosClientId: GOOGLE_IOS_CLIENT_ID,
      webClientId: GOOGLE_CLIENT_ID,
      offlineAccess: true
    });
  }, []);

  // Hooks
  const theme = useTheme();
  const navigation = useNavigation<LoginScreenNavigationProp>();
  const dispatch = useDispatch();

  // Local State
  const [emailSubmitted, setEmailSubmitted] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [googleSignInLoading, setGoogleSignInLoading] = useState(false);
  const [microsoftSignInLoading, setMicrosoftSignInLoading] = useState(false);

  const authInProgress =
    loading || googleSignInLoading || microsoftSignInLoading;

  const processAuthResponse = useCallback(
    (response: AuthResponse, emailForMfa?: string): boolean => {
      const email =
        emailForMfa?.trim() ||
        response.user?.email?.trim() ||
        emailSubmitted.trim();

      if ("mfaSetupToken" in response && response.mfaSetupToken) {
        navigation.navigate(Routes.ForceTwoFactor, {
          token: String(response.mfaSetupToken),
          email
        });
        return true;
      }

      if ("mfaVerifyToken" in response && response.mfaVerifyToken) {
        navigation.navigate(Routes.TwoFactorVerify, {
          token: String(response.mfaVerifyToken),
          mode: response.mode as MFAMode,
          message: String(response.message ?? ""),
          phoneNumber: String(response.phoneNumber ?? ""),
          email
        });
        return true;
      }

      if ("accessToken" in response && response.accessToken) {
        dispatch({
          type: LOGIN_SUCCESS,
          payload: response
        });
        return true;
      }

      toast.error("Sign in failed. Please try again.");
      return false;
    },
    [dispatch, navigation, emailSubmitted]
  );

  const loginMutation = useMutation<
    AuthResponse,
    APIError,
    BasicAuthRequestBody
  >({
    mutationFn: authenticate,
    onSuccess: async (response) => {
      logger.debug("Login successful", response);

      if (__DEV__) {
        console.warn("[AUTH][Login] authenticate() response", {
          keys: Object.keys(response ?? {}),
          hasAccessToken: "accessToken" in response && !!response.accessToken,
          hasMfaVerifyToken:
            "mfaVerifyToken" in response && response.mfaVerifyToken != null,
          hasMfaSetupToken:
            "mfaSetupToken" in response && response.mfaSetupToken != null,
          mode: (response as { mode?: string }).mode,
          message: (response as { message?: string }).message,
          phoneNumber: (response as { phoneNumber?: string }).phoneNumber,
          hasSecretField:
            "secret" in response &&
            (response as { secret?: string }).secret != null &&
            String((response as { secret?: string }).secret).length > 0,
          userId: (response as { user?: { id?: number } }).user?.id,
          mfaVerifyTokenPreview:
            "mfaVerifyToken" in response && response.mfaVerifyToken != null
              ? `${String(response.mfaVerifyToken).slice(0, 8)}…(len=${String(response.mfaVerifyToken).length})`
              : undefined,
          mfaSetupTokenPreview:
            "mfaSetupToken" in response && response.mfaSetupToken != null
              ? `${String(response.mfaSetupToken).slice(0, 8)}…(len=${String(response.mfaSetupToken).length})`
              : undefined
        });

        console.log("🔍 [LOGIN] API Response - Notification Settings:", {
          enableChatNotifications: response.user?.enableChatNotifications,
          enableAllNewMessageNotifications:
            response.user?.enableAllNewMessageNotifications,
          enableDirectMessageNotifications:
            response.user?.enableDirectMessageNotifications,
          enableMobileCallNotifications:
            response.user?.enableMobileCallNotifications,
          enableMobileTextNotifications:
            response.user?.enableMobileTextNotifications
        });
      }

      processAuthResponse(response, emailSubmitted);
    },
    onError: (error: APIError) => {
      toast.error(`Error: ${error.message}`);
    },
    onSettled: () => {
      setLoading(false);
    }
  });

  // Handling Google Login
  const handleGoogleLogin = useCallback(async () => {
    if (authInProgress) {
      return;
    }
    setGoogleSignInLoading(true);

    try {
      Keyboard.dismiss();
      await GoogleSignin.hasPlayServices({
        showPlayServicesUpdateDialog: true
      });

      const { type, data } = await GoogleSignin.signIn();
      if (type === "cancelled" || !data?.idToken) {
        toast.error("Google sign in cancelled");
        logger.error("User Cancelled Google Sign In");
        return;
      }

      const response = await googleSignIn(data.idToken);
      processAuthResponse(response, data.user?.email);
    } catch (error) {
      toast.error("Error with Google Sign In");
      logger.error("Error with Google Sign In", error);
    } finally {
      setGoogleSignInLoading(false);
    }
  }, [authInProgress, processAuthResponse]);

  // Handling Microsoft Login
  const handleMicrosoftLogin = useCallback(async () => {
    if (authInProgress) {
      return;
    }
    setMicrosoftSignInLoading(true);

    try {
      Keyboard.dismiss();
      const data = await authorize(microsoftConfig);

      if (!data?.accessToken) {
        toast.error("Microsoft sign in failed");
        logger.error("User Cancelled Microsoft Sign In");
        return;
      }

      const response = await azureSignIn(data.accessToken);
      processAuthResponse(
        response,
        response.user?.email ?? emailSubmitted
      );
    } catch (error) {
      toast.error("Error with Microsoft Sign in");
      logger.error("Error with Azure Sign In", error);
    } finally {
      setMicrosoftSignInLoading(false);
    }
  }, [authInProgress, emailSubmitted, processAuthResponse]);

  const formik = useFormik<FormValues>({
    initialValues: { email: __DEV__ ? "abeerahmad204@hotmail.com" : "", password: __DEV__ ? "asad1234" : "" },

    validate: ({ email, password }) => {
      const validationErrors: Partial<FormValues> = {};

      if (!isValidEmail(email)) {
        validationErrors.email = "Email is invalid";
      }

      if (!password) {
        validationErrors.password = "Password is required";
      }

      return validationErrors;
    },

    onSubmit: ({ email, password }) => {
      logger.debug("Logging in user", email, password);
      Keyboard.dismiss();
      setLoading(true);
      setEmailSubmitted(email.trim());
      loginMutation.mutate({ email: email.trim(), password });
    }
  });

  const submit = useCallback(() => {
    if (authInProgress) {
      return;
    }
    formik.handleSubmit();
  }, [authInProgress, formik.handleSubmit]);

  return (
    <Screen paddingHorizontal scroll>
      <View
        style={[
          authenticationStyles.loginBackgroundIconContainer,
          { right: -width / 2 }
        ]}
      >
        <LoginBG
          width={width * 2}
          height={350}
          fill={theme.colors.backgroundSvg}
          stroke={theme.colors.backgroundSvg}
        />
      </View>
      <View style={authenticationStyles.loginHeaderContainer}>
        <BrandingLogo size={40} />
        <WhiteSpace height={15} />
        <Text size={fontSize.xl} weight={"medium"}>
          {AuthenticationEnums.LOGIN_TO_ACCOUNT}
        </Text>
        <WhiteSpace height={10} />
        <Text size={fontSize.md}>{AuthenticationEnums.ENTER_DETAILS}</Text>
        <WhiteSpace height={30} />
        <Text
          color={"colors-text-text-secondary"}
          size={14}
          weight={"regular"}
          align={"left"}
        >
          {AuthenticationEnums.EMAIL}
        </Text>
        <WhiteSpace height={5} />
        <FormikProvider value={formik}>
          <Field name="email">
            {({ field }: { field: FieldInputProps<string> }) => (
              <View>
                <TextInput
                  accessibilityLabel="Text input field"
                  placeholder={AuthenticationEnums.EMAIL_PLACEHOLDER}
                  placeholderColor={"colors-text-text-placeholder"}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={field.value}
                  onChangeText={field.onChange("email")}
                  onBlur={field.onBlur("email")}
                  textContentType="emailAddress"
                  autoComplete="email"
                  returnKeyType="done"
                  returnKeyLabel="Login"
                  enablesReturnKeyAutomatically={true}
                />
                {formik.touched.email && formik.errors.email && (
                  <View>
                    <WhiteSpace height={4} />
                    <Text color={"secondary"} size={fontSize.xs} align={"left"}>
                      {formik.errors.email}
                    </Text>
                  </View>
                )}
              </View>
            )}
          </Field>
          <WhiteSpace height={17} />
          <Text size={fontSize.sm} weight={"regular"} align={"left"}>
            {AuthenticationEnums.PASSWORD}
          </Text>
          <WhiteSpace height={5} />
          <Field name="password">
            {({ field }: { field: FieldInputProps<string> }) => (
              <View>
                <TextInput
                  accessibilityLabel="Text input field"
                  placeholder={AuthenticationEnums.PASSWORD_PLACEHOLDER}
                  placeholderColor={"colors-text-text-placeholder"}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry={true}
                  value={field.value}
                  style={{ alignItems: "center" }}
                  onChangeText={field.onChange("password")}
                  onBlur={field.onBlur("password")}
                  textContentType="password"
                  autoComplete="password"
                  returnKeyType="done"
                  returnKeyLabel="Login"
                  enablesReturnKeyAutomatically={true}
                />
                {formik.touched.password && formik.errors.password && (
                  <View>
                    <WhiteSpace height={4} />
                    <Text color={"secondary"} size={fontSize.xs} align={"left"}>
                      {formik.errors.password}
                    </Text>
                  </View>
                )}
              </View>
            )}
          </Field>
          <WhiteSpace height={20} />
          <View style={authenticationStyles.forgotRow}>
            <TouchableOpacity
              onPress={() => navigation.navigate(Routes.ForgotPassword)}
            >
              <Text
                align={"left"}
                weight={"semiBold"}
                color={
                  "color-component-colors-components-buttons-tertiary-color-button-tertiary-color-fg"
                }
                size={fontSize.sm}
              >
                {AuthenticationEnums.FORGOT_PASSWORD}
              </Text>
            </TouchableOpacity>
          </View>
          <WhiteSpace height={30} />
          <Button
            loading={loading}
            disabled={authInProgress && !loading}
            onPress={submit}
          >
            {AuthenticationEnums.SIGN_IN}
          </Button>
        </FormikProvider>
        {(ENABLE_GOOGLE_SSO === "true" || ENABLE_MICROSOFT_SSO === "true") && (
          <View>
            <WhiteSpace height={20} />
            <View style={authenticationStyles.rememberRow}>
              <View
                style={[
                  authenticationStyles.line,
                  {
                    borderTopColor:
                      theme.colors["color-colors-border-border-secondary"]
                  }
                ]}
              />
              <WhiteSpace width={10} />
              <Text size={fontSize.md}>OR</Text>
              <WhiteSpace width={10} />
              <View
                style={[
                  authenticationStyles.line,
                  {
                    borderTopColor:
                      theme.colors["color-colors-border-border-secondary"]
                  }
                ]}
              />
            </View>
            <WhiteSpace height={20} />
          </View>
        )}
        {ENABLE_GOOGLE_SSO === "true" && (
          <View>
            <Button
              type={"outline"}
              icon={<GoogleIcon />}
              loading={googleSignInLoading}
              disabled={authInProgress && !googleSignInLoading}
              onPress={handleGoogleLogin}
            >
              {AuthenticationEnums.SIGN_IN_WITH_GOOGLE}
            </Button>
            <WhiteSpace height={10} />
          </View>
        )}
        {ENABLE_MICROSOFT_SSO === "true" && (
          <View>
            <Button
              onPress={handleMicrosoftLogin}
              loading={microsoftSignInLoading}
              disabled={authInProgress && !microsoftSignInLoading}
              icon={<MicrosoftIcon />}
              type={"outline"}
            >
              {AuthenticationEnums.SIGN_IN_WITH_MICROSOFT}
            </Button>
          </View>
        )}
        <WhiteSpace height={10} />
        <Text size={fontSize.xs} align={"center"}>
          By signing in, you agree to our{" "}
          <Text
            color={
              "color-component-colors-components-buttons-tertiary-color-button-tertiary-color-fg"
            }
            size={fontSize.xs}
            onPress={async () => {
              await Linking.openURL(getLegalTermsUrl());
            }}
          >
            Terms of Service
          </Text>{" "}
          and{" "}
          <Text
            color={
              "color-component-colors-components-buttons-tertiary-color-button-tertiary-color-fg"
            }
            size={fontSize.xs}
            onPress={async () => {
              await Linking.openURL(getLegalPrivacyUrl());
            }}
          >
            Privacy Policy
          </Text>
        </Text>
      </View>
    </Screen>
  );
};

export default Login;
