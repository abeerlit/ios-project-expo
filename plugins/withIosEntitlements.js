const { withEntitlementsPlist } = require("@expo/config-plugins");

function withIosEntitlements(config, options = {}) {
  const appGroup = options.appGroup ?? "group.co.voxo.voxo-ios";
  const domain = options.associatedDomain ?? "applinks:meet.voxo.co";
  const aps = options.apsEnvironment ?? "production";

  return withEntitlementsPlist(config, (mod) => {
    mod.modResults["aps-environment"] = aps;
    mod.modResults["com.apple.developer.associated-domains"] = [domain];
    mod.modResults["com.apple.security.application-groups"] = [appGroup];
    return mod;
  });
}

module.exports = { withIosEntitlements };
