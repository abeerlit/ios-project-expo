#!/usr/bin/env node
/** Add incallmanager ringback/ringtone to VOXOConnect Copy Bundle Resources (idempotent). */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PBX = path.join(ROOT, "ios", "VOXOConnect.xcodeproj", "project.pbxproj");

const PBX_AUDIO_IDS = {
  ringbackFile: "5B881B9C2E2E8FC500922001",
  ringtoneFile: "5B881B9D2E2E8FC500922002",
  ringbackRes: "5B881B9E2E2E8FC500922003",
  ringtoneRes: "5B881B9F2E2E8FC500922004"
};

const GROUP_MARKER =
  /(\t\t\t\t[A-F0-9]+ \/\* GoogleService-Info\.plist \*\/,)\n/;
const RESOURCES_MARKER =
  /(\t\t\t\t[A-F0-9]+ \/\* GoogleService-Info\.plist in Resources \*\/,)\n/;

function ensurePbxprojInCallAudio() {
  if (!fs.existsSync(PBX)) return false;
  let pbx = fs.readFileSync(PBX, "utf8");
  if (pbx.includes("incallmanager_ringback.mp3 in Resources")) {
    return true;
  }

  const buildFiles = `\t\t${PBX_AUDIO_IDS.ringbackRes} /* incallmanager_ringback.mp3 in Resources */ = {isa = PBXBuildFile; fileRef = ${PBX_AUDIO_IDS.ringbackFile} /* incallmanager_ringback.mp3 */; };
\t\t${PBX_AUDIO_IDS.ringtoneRes} /* incallmanager_ringtone.mp3 in Resources */ = {isa = PBXBuildFile; fileRef = ${PBX_AUDIO_IDS.ringtoneFile} /* incallmanager_ringtone.mp3 */; };
`;

  const fileRefs = `\t\t${PBX_AUDIO_IDS.ringbackFile} /* incallmanager_ringback.mp3 */ = {isa = PBXFileReference; lastKnownFileType = audio.mp3; name = incallmanager_ringback.mp3; path = VOXOConnect/incallmanager_ringback.mp3; sourceTree = "<group>"; };
\t\t${PBX_AUDIO_IDS.ringtoneFile} /* incallmanager_ringtone.mp3 */ = {isa = PBXFileReference; lastKnownFileType = audio.mp3; name = incallmanager_ringtone.mp3; path = VOXOConnect/incallmanager_ringtone.mp3; sourceTree = "<group>"; };
`;

  pbx = pbx.replace("/* End PBXBuildFile section */", `${buildFiles}/* End PBXBuildFile section */`);
  pbx = pbx.replace("/* End PBXFileReference section */", `${fileRefs}/* End PBXFileReference section */`);

  const beforeGroup = pbx;
  pbx = pbx.replace(
    GROUP_MARKER,
    `$1\n\t\t\t\t${PBX_AUDIO_IDS.ringbackFile} /* incallmanager_ringback.mp3 */,\n\t\t\t\t${PBX_AUDIO_IDS.ringtoneFile} /* incallmanager_ringtone.mp3 */,\n`
  );
  if (pbx === beforeGroup) {
    console.warn(
      "[ensure-incall-audio-pbx] could not find GoogleService-Info.plist in VOXOConnect group — add incallmanager mp3s to Xcode manually"
    );
    return false;
  }

  const beforeResources = pbx;
  pbx = pbx.replace(
    RESOURCES_MARKER,
    `$1\n\t\t\t\t${PBX_AUDIO_IDS.ringbackRes} /* incallmanager_ringback.mp3 in Resources */,\n\t\t\t\t${PBX_AUDIO_IDS.ringtoneRes} /* incallmanager_ringtone.mp3 in Resources */,\n`
  );
  if (pbx === beforeResources) {
    console.warn(
      "[ensure-incall-audio-pbx] could not find GoogleService-Info.plist in Resources — add incallmanager mp3s to Copy Bundle Resources manually"
    );
    return false;
  }

  fs.writeFileSync(PBX, pbx);
  console.log("[ensure-incall-audio-pbx] ringback/ringtone added to Xcode resources");
  return true;
}

module.exports = { ensurePbxprojInCallAudio };

if (require.main === module) {
  ensurePbxprojInCallAudio();
}
