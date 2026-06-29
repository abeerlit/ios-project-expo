const { withInfoPlist } = require("@expo/config-plugins");

function buildUsageStrings(displayName, organizationName) {
  const app = displayName?.trim() || "This app";
  const org = organizationName?.trim() || app;
  return {
    NSCameraUsageDescription: "This enables you to upload photos and videos",
    NSContactsUsageDescription: `${app} uses your phone contacts so you can call and message them. If you create a personal contact in the app, that contact's details will be saved to ${org} servers.`,
    NSMicrophoneUsageDescription: `${app} needs microphone access for phone calls and meetings.`,
    NSPhotoLibraryUsageDescription: "This enables you to upload photos and videos",
    NSLocationAlwaysAndWhenInUseUsageDescription:
      "Your location will only be accessed when you make a 911 call for better service. If location access is not provided, the default location of your extension will be used.",
    NSLocationAlwaysUsageDescription:
      "Your location will only be accessed when you make a 911 call for better service. If location access is not provided, the default location of your extension will be used.",
    NSLocationWhenInUseUsageDescription:
      "Your location will only be accessed when you make a 911 call for better service. If location access is not provided, the default location of your extension will be used."
  };
}

function withIosPermissions(config, options = {}) {
  const displayName =
    options.displayName?.trim() || config.name?.trim() || "This app";
  const organizationName =
    options.organizationName?.trim() || displayName;
  const usageStrings = buildUsageStrings(displayName, organizationName);

  return withInfoPlist(config, (mod) => {
    for (const [key, value] of Object.entries(usageStrings)) {
      mod.modResults[key] = value;
    }
    mod.modResults.UIBackgroundModes = [
      ...new Set([
        ...(mod.modResults.UIBackgroundModes ?? []),
        "audio",
        "voip",
        "fetch",
        "remote-notification"
      ])
    ];
    return mod;
  });
}

module.exports = { withIosPermissions };
