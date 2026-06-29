const { withIosPermissions } = require("./withIosPermissions.js");
const { withIosEntitlements } = require("./withIosEntitlements.js");
const { withFirebaseIos } = require("./withFirebaseIos.js");
const { withAppDelegateBase } = require("./withAppDelegateBase.js");
const { withDebugPackagerHost } = require("./withDebugPackagerHost.js");
const { withVoxoCallKitVoip } = require("./withVoxoCallKitVoip.js");
const { withVoxoNotificationExtension } = require("./withVoxoNotificationExtension.js");
const { withDailyScreenShareExtension } = require("./withDailyScreenShareExtension.js");
const { withDailyScreenShareInfoPlist } = require("./withDailyScreenShareInfoPlist.js");
const { withVoxoSplash } = require("./withVoxoSplash.js");

function withVoxoIos(config, options = {}) {
  config = withVoxoSplash(config);
  config = withIosPermissions(config, {
    displayName: options.displayName,
    organizationName: options.organizationName
  });
  config = withIosEntitlements(config, options);
  config = withFirebaseIos(config, options);
  config = withAppDelegateBase(config);
  config = withDebugPackagerHost(config);

  if (options.enableDailyExtension !== false) {
    config = withDailyScreenShareInfoPlist(config, options);
    config = withDailyScreenShareExtension(config, options);
  }
  if (options.enableNotificationsExtension !== false) {
    config = withVoxoNotificationExtension(config);
  }
  if (options.enableTelephony) {
    config = withVoxoCallKitVoip(config);
  }

  return config;
}

module.exports = withVoxoIos;
