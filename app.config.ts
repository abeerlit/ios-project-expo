import type { ExpoConfig, ConfigContext } from "expo/config";
import path from "path";

const bundleId = process.env.IOS_BUNDLE_ID ?? "co.voxo.voxo-ios";
const appGroup = process.env.APP_GROUP ?? "group.co.voxo.voxo-ios";
const displayName = process.env.DISPLAY_NAME ?? "VOXO Connect";

function deriveOrganizationName(name: string): string {
  const trimmed = name.trim();
  const stripped = trimmed.replace(/\s+(Connect|Mobile|App)$/i, "").trim();
  return stripped || trimmed;
}

const organizationName =
  process.env.ORGANIZATION_NAME?.trim() ||
  deriveOrganizationName(displayName);
const legalTermsUrl =
  process.env.LEGAL_TERMS_URL?.trim() ||
  "https://voxo.co/terms-and-conditions";
const legalPrivacyUrl =
  process.env.LEGAL_PRIVACY_URL?.trim() || "https://voxo.co/privacy-policy";
const appVersion = process.env.APP_VERSION ?? "2.1.3";
const iosBuildNumber = process.env.IOS_BUILD_NUMBER ?? "11";

const projectRoot = __dirname;
const defaultIcon = "./branding/voxo/icon.png";
const defaultSplash = "./branding/voxo/splash.png";
const iconPath = process.env.APP_ICON ?? defaultIcon;
const splashImage = process.env.SPLASH_IMAGE ?? defaultSplash;
const splashBackground =
  process.env.SPLASH_BACKGROUND_COLOR ?? "#ffffff";

export default ({ config }: ConfigContext): ExpoConfig => {
  const nativeTelephony =
    process.env.EXPO_PUBLIC_NATIVE_TELEPHONY === "1" ||
    process.env.EXPO_PUBLIC_NATIVE_TELEPHONY === "true";

  const configExtra = config.extra as { eas?: { projectId?: string } } | undefined;
  const easProjectId =
    process.env.EAS_PROJECT_ID ?? configExtra?.eas?.projectId;

  const meetingsNative =
    process.env.EXPO_PUBLIC_MEETINGS_NATIVE === "1" ||
    process.env.EXPO_PUBLIC_MEETINGS_NATIVE === "true";
  const notificationsExtension =
    process.env.EXPO_PUBLIC_NATIVE_NOTIFICATIONS === "1" ||
    nativeTelephony;

  const appExtensions: Array<{
    targetName: string;
    bundleIdentifier: string;
    entitlements: Record<string, string | string[]>;
  }> = [];
  if (meetingsNative) {
    appExtensions.push({
      targetName: "ScreenCaptureExtension",
      bundleIdentifier: `${bundleId}.ScreenCaptureExtension`,
      entitlements: {
        "com.apple.security.application-groups": [appGroup]
      }
    });
  }
  if (notificationsExtension) {
    appExtensions.push({
      targetName: "VoxoNotificationExtension",
      bundleIdentifier: `${bundleId}.VoxoNotificationExtension`,
      entitlements: {
        "com.apple.security.application-groups": [appGroup]
      }
    });
  }

  const existingEas = configExtra?.eas ?? {};
  const easExtra = {
    ...existingEas,
    ...(easProjectId ? { projectId: easProjectId } : {}),
    ...(appExtensions.length > 0
      ? {
          build: {
            ...(typeof existingEas === "object" &&
            existingEas !== null &&
            "build" in existingEas &&
            typeof existingEas.build === "object"
              ? existingEas.build
              : {}),
            experimental: {
              ios: {
                appExtensions
              }
            }
          }
        }
      : {})
  };

  return {
    ...config,
    owner: process.env.EXPO_OWNER ?? config.owner ?? "voxo",
    name: displayName,
    slug: "voxo-connect-ios-expo",
    version: appVersion,
    orientation: "default",
    icon: iconPath,
    scheme: bundleId,
    userInterfaceStyle: "light",
    newArchEnabled: false,
    splash: {
      image: splashImage,
      resizeMode: "contain",
      backgroundColor: splashBackground
    },
    ios: {
      supportsTablet: false,
      bundleIdentifier: bundleId,
      buildNumber: iosBuildNumber,
      icon: iconPath,
      associatedDomains: ["applinks:meet.voxo.co"],
      infoPlist: {
        CFBundleDisplayName: displayName,
        ITSAppUsesNonExemptEncryption: false
      }
    },
    plugins: [
      "expo-dev-client",
      [
        "expo-splash-screen",
        {
          image: splashImage,
          resizeMode: "contain",
          backgroundColor: splashBackground,
          imageWidth: 200
        }
      ],
      "@giphy/react-native-sdk",
      [
        "react-native-permissions",
        {
          iosPermissions: [
            "Camera",
            "Microphone",
            "PhotoLibrary",
            "LocationWhenInUse",
            "Contacts",
            "Notifications"
          ]
        }
      ],
      [
        "expo-build-properties",
        {
          ios: {
            deploymentTarget: "15.1",
            useFrameworks: "static"
          }
        }
      ],
      [
        "./plugins/withVoxoIos.js",
        {
          appGroup,
          associatedDomain: "applinks:meet.voxo.co",
          apsEnvironment:
            process.env.APS_ENVIRONMENT === "development"
              ? "development"
              : "production",
          googleServicesPlist: process.env.GOOGLE_SERVICES_PLIST,
          enableTelephony: nativeTelephony,
          enableNotificationsExtension: true,
          enableDailyExtension: true,
          displayName,
          organizationName
        }
      ]
    ],
    extra: {
      eas: easExtra,
      EXPO_PUBLIC_NATIVE_TELEPHONY: nativeTelephony,
      EXPO_PUBLIC_NATIVE_NOTIFICATIONS:
        process.env.EXPO_PUBLIC_NATIVE_NOTIFICATIONS === "1" || nativeTelephony,
      EXPO_PUBLIC_CHAT_NATIVE: process.env.EXPO_PUBLIC_CHAT_NATIVE !== "0",
      EXPO_PUBLIC_MEETINGS_NATIVE:
        process.env.EXPO_PUBLIC_MEETINGS_NATIVE === "1" ||
        process.env.EXPO_PUBLIC_MEETINGS_NATIVE === "true",
      API_URL: process.env.API_URL,
      SENTRY_DSN: process.env.SENTRY_DSN,
      EXPO_PUBLIC_MINIMAL_BOOT:
        process.env.EXPO_PUBLIC_MINIMAL_BOOT === "1" ||
        process.env.EXPO_PUBLIC_MINIMAL_BOOT === "true",
      DISPLAY_NAME: displayName,
      ORGANIZATION_NAME: organizationName,
      LEGAL_TERMS_URL: legalTermsUrl,
      LEGAL_PRIVACY_URL: legalPrivacyUrl,
      APP_ICON: path.resolve(projectRoot, iconPath),
      SPLASH_IMAGE: path.resolve(projectRoot, splashImage)
    },
    experiments: {
      tsconfigPaths: true
    }
  };
};
