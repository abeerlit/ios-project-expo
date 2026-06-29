const fs = require("fs");
const path = require("path");
const {
  withDangerousMod,
  withPodfileProperties,
  withXcodeProject,
  IOSConfig
} = require("@expo/config-plugins");

function withFirebaseIos(config, options = {}) {
  config = withPodfileProperties(config, (mod) => {
    mod.modResults["ios.useFrameworks"] = "static";
    return mod;
  });

  const plistPath =
    options.googleServicesPlist ??
    process.env.GOOGLE_SERVICES_PLIST ??
    path.join(__dirname, "..", "native-resources", "GoogleService-Info.plist");

  config = withDangerousMod(config, [
    "ios",
    async (mod) => {
      const dest = path.join(
        mod.modRequest.platformProjectRoot,
        "VOXOConnect",
        "GoogleService-Info.plist"
      );
      if (fs.existsSync(plistPath)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(plistPath, dest);
      }
      return mod;
    }
  ]);

  return withXcodeProject(config, (mod) => {
    // VOXOConnect lives directly under ios/ (not ios/<name>/); Expo's getProjectName glob fails here.
    const projectName = "VOXOConnect";
    const project = mod.modResults;
    const relativePath = `${projectName}/GoogleService-Info.plist`;

    if (!project.hasFile(relativePath)) {
      IOSConfig.XcodeUtils.addResourceFileToGroup({
        filepath: relativePath,
        groupName: projectName,
        project,
        isBuildFile: true,
        verbose: true
      });
    }
    return mod;
  });
}

module.exports = { withFirebaseIos };
