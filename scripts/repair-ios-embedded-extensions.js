#!/usr/bin/env node
/**
 * Repairs pbxproj after ScreenCapture + VoxoNotificationExtension patches run in any order.
 * - Single "Embed Foundation Extensions" phase (ScreenCapture UUID is canonical)
 * - VOXOConnect must reference the real embed phase, not a phantom VNE0E011*
 * - Both .appex products listed in embed phase
 * - PBXContainerItemProxy entries for extension target dependencies
 */
const fs = require("fs");
const path = require("path");

const PBX = path.join(__dirname, "..", "ios", "VOXOConnect.xcodeproj", "project.pbxproj");

const SCE = {
  embedPhase: "SCE0E0111A68108700A75B9A",
  embedBuild: "SCE0E0121A68108700A75B9A",
  target: "SCE0E0011A68108700A75B9A",
  proxy: "SCE0E0131A68108700A75B9A",
  dependency: "SCE0E0141A68108700A75B9A"
};

const VNE = {
  embedPhase: "VNE0E0111A68108700A75B9A",
  embedBuild: "VNE0E0121A68108700A75B9A",
  target: "VNE0E0011A68108700A75B9A",
  proxy: "VNE0E0131A68108700A75B9A",
  dependency: "VNE0E0141A68108700A75B9A"
};

function hasContainerProxyObject(pbx, proxyId) {
  return new RegExp(
    `${proxyId} \\/\\* PBXContainerItemProxy \\*\\/ = \\{`
  ).test(pbx);
}

function ensureContainerProxy(pbx, { proxy, target, remoteInfo }) {
  if (hasContainerProxyObject(pbx, proxy)) {
    return pbx;
  }
  const block = `\t\t${proxy} /* PBXContainerItemProxy */ = {
\t\t\tisa = PBXContainerItemProxy;
\t\t\tcontainerPortal = 83CBB9F71A601CBA00E9B192 /* Project object */;
\t\t\tproxyType = 1;
\t\t\tremoteGlobalIDString = ${target};
\t\t\tremoteInfo = ${remoteInfo};
\t\t};
`;
  if (pbx.includes("/* Begin PBXContainerItemProxy section */")) {
    return pbx.replace(
      "/* End PBXContainerItemProxy section */",
      `${block}/* End PBXContainerItemProxy section */`
    );
  }
  return pbx.replace(
    "/* Begin PBXCopyFilesBuildPhase section */",
    `/* Begin PBXContainerItemProxy section */\n${block}/* End PBXContainerItemProxy section */\n\n/* Begin PBXCopyFilesBuildPhase section */`
  );
}

function hasTargetDependencyObject(pbx, dependencyId) {
  return new RegExp(
    `${dependencyId} \\/\\* PBXTargetDependency \\*\\/ = \\{`
  ).test(pbx);
}

function ensureTargetDependency(pbx, { dependency, target, proxy, remoteInfo }) {
  if (hasTargetDependencyObject(pbx, dependency)) {
    return pbx;
  }
  const block = `\t\t${dependency} /* PBXTargetDependency */ = {
\t\t\tisa = PBXTargetDependency;
\t\t\ttarget = ${target} /* ${remoteInfo} */;
\t\t\ttargetProxy = ${proxy} /* PBXContainerItemProxy */;
\t\t};
`;
  if (pbx.includes("/* Begin PBXTargetDependency section */")) {
    return pbx.replace(
      "/* End PBXTargetDependency section */",
      `${block}/* End PBXTargetDependency section */`
    );
  }
  return pbx.replace(
    "/* Begin XCBuildConfiguration section */",
    `/* Begin PBXTargetDependency section */\n${block}/* End PBXTargetDependency section */\n\n/* Begin XCBuildConfiguration section */`
  );
}

function resolveEmbedPhaseId(pbx) {
  if (pbx.includes(`${SCE.embedPhase} /* Embed Foundation Extensions */ = {`)) {
    return SCE.embedPhase;
  }
  if (pbx.includes(`${VNE.embedPhase} /* Embed Foundation Extensions */ = {`)) {
    return VNE.embedPhase;
  }
  const m = pbx.match(
    /\t\t([A-F0-9]{24}) \/\* Embed Foundation Extensions \*\/ = \{\n\t\t\tisa = PBXCopyFilesBuildPhase;/
  );
  return m ? m[1] : null;
}

function hasEmbedBuildFileObject(pbx, embedBuildId, productName) {
  return new RegExp(
    `${embedBuildId} \\/\\* ${productName}\\.appex in Embed Foundation Extensions \\*\\/ = \\{isa = PBXBuildFile`
  ).test(pbx);
}

function hasEmbedPhaseFileRef(pbx, embedBuildId, productName) {
  return new RegExp(
    `${embedBuildId} \\/\\* ${productName}\\.appex in Embed Foundation Extensions \\*\\/,\n`
  ).test(pbx);
}

function ensureEmbedBuildFile(pbx, embedPhaseId, embedBuildId, productName) {
  const phaseRe = new RegExp(
    `(${embedPhaseId} \\/\\* Embed Foundation Extensions \\*\\/ = \\{[\\s\\S]*?files = \\()([\\s\\S]*?)(\\n\\t\\t\\t\\);)`
  );
  if (!phaseRe.test(pbx)) return pbx;
  if (hasEmbedPhaseFileRef(pbx, embedBuildId, productName)) {
    return pbx;
  }
  return pbx.replace(
    phaseRe,
    `$1$2\n\t\t\t\t${embedBuildId} /* ${productName}.appex in Embed Foundation Extensions */,$3`
  );
}

function ensureEmbedBuildFileEntry(pbx, embedBuildId, productRefId, productName) {
  if (hasEmbedBuildFileObject(pbx, embedBuildId, productName)) {
    return pbx;
  }
  const line = `\t\t${embedBuildId} /* ${productName}.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = ${productRefId} /* ${productName}.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };`;
  return pbx.replace("/* End PBXBuildFile section */", `${line}\n/* End PBXBuildFile section */`);
}

function hostReferencesEmbedPhase(pbx, embedPhaseId) {
  const hostRe = new RegExp(
    `13B07F861A680F5B00A75B9A \\/\\* VOXOConnect \\*\\/ = \\{[\\s\\S]*?buildPhases = \\([\\s\\S]*?${embedPhaseId} \\/\\* Embed Foundation Extensions \\*\\/`
  );
  return hostRe.test(pbx);
}

function ensureHostEmbedBuildPhaseRef(pbx, embedPhaseId) {
  const embedRef = `\t\t\t\t${embedPhaseId} /* Embed Foundation Extensions */,\n`;
  const hostRe =
    /13B07F861A680F5B00A75B9A \/\* VOXOConnect \*\/ = \{\n\t\t\tisa = PBXNativeTarget;[\s\S]*?buildPhases = \(\n/;
  if (!hostRe.test(pbx) || hostReferencesEmbedPhase(pbx, embedPhaseId)) {
    return pbx;
  }
  return pbx.replace(hostRe, (m) => `${m}${embedRef}`);
}

/** Create Embed Foundation Extensions when targets exist but prebuild dropped the copy phase. */
function createEmbedFoundationExtensionsPhaseIfMissing(pbx) {
  if (resolveEmbedPhaseId(pbx)) {
    return pbx;
  }

  const extensions = [];
  if (pbx.includes("SCE0E0021A68108700A75B9A /* ScreenCaptureExtension.appex */")) {
    extensions.push({
      embedBuild: SCE.embedBuild,
      productRef: "SCE0E0021A68108700A75B9A",
      name: "ScreenCaptureExtension"
    });
  }
  if (pbx.includes("VNE0E0021A68108700A75B9A /* VoxoNotificationExtension.appex */")) {
    extensions.push({
      embedBuild: VNE.embedBuild,
      productRef: "VNE0E0021A68108700A75B9A",
      name: "VoxoNotificationExtension"
    });
  }
  if (extensions.length === 0) {
    return pbx;
  }

  for (const ext of extensions) {
    pbx = ensureEmbedBuildFileEntry(pbx, ext.embedBuild, ext.productRef, ext.name);
  }

  const embedPhaseId = SCE.embedPhase;
  const filesList = extensions
    .map(
      (ext) =>
        `\t\t\t\t${ext.embedBuild} /* ${ext.name}.appex in Embed Foundation Extensions */,`
    )
    .join("\n");

  const copyPhase = `\t\t${embedPhaseId} /* Embed Foundation Extensions */ = {
\t\t\tisa = PBXCopyFilesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tdstPath = "";
\t\t\tdstSubfolderSpec = 13;
\t\t\tfiles = (
${filesList}
\t\t\t);
\t\t\tname = "Embed Foundation Extensions";
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
`;

  if (pbx.includes("/* Begin PBXCopyFilesBuildPhase section */")) {
    pbx = pbx.replace(
      "/* End PBXCopyFilesBuildPhase section */",
      `${copyPhase}/* End PBXCopyFilesBuildPhase section */`
    );
  } else {
    pbx = pbx.replace(
      "/* Begin PBXFrameworksBuildPhase section */",
      `/* Begin PBXCopyFilesBuildPhase section */\n${copyPhase}/* End PBXCopyFilesBuildPhase section */\n\n/* Begin PBXFrameworksBuildPhase section */`
    );
  }

  pbx = ensureHostEmbedBuildPhaseRef(pbx, embedPhaseId);
  console.log(
    "[repair-embedded-ext] created Embed Foundation Extensions phase with",
    extensions.map((e) => e.name).join(", ")
  );
  return pbx;
}

function removeDependencyFromBuildPhases(pbx) {
  const depLine =
    /\n\t\t\t\t(SCE0E0141A68108700A75B9A|VNE0E0141A68108700A75B9A) \/\* PBXTargetDependency \*\/,\n/g;
  return pbx.replace(/(buildPhases = \([\s\S]*?\n\t\t\t\);)/g, (block) =>
    block.replace(depLine, "\n")
  );
}

function fixHostEmbedBuildPhaseRef(pbx) {
  const embedPhaseId = resolveEmbedPhaseId(pbx);
  if (!embedPhaseId) return pbx;
  const canonical = `${embedPhaseId} /* Embed Foundation Extensions */`;
  return pbx.replace(
    /\t\t\t\tVNE0E0111A68108700A75B9A \/\* Embed Foundation Extensions \*\/,\n/g,
    `\t\t\t\t${canonical},\n`
  );
}

function ensureHostDependencies(pbx) {
  const hostDepsRe =
    /(13B07F861A680F5B00A75B9A \/\* VOXOConnect \*\/ = \{[\s\S]*?dependencies = \(\n)([\s\S]*?)(\t+\);\n\t+name = VOXOConnect;)/;

  const addDep = (depsInner, depId) => {
    const needle = `${depId} /* PBXTargetDependency */`;
    if (depsInner.includes(needle)) return depsInner;
    const line = `\t\t\t\t${depId} /* PBXTargetDependency */,\n`;
    return depsInner.trim().length > 0 ? `${depsInner}${line}` : line;
  };

  return pbx.replace(hostDepsRe, (full, pre, depsInner, post) => {
    let deps = depsInner;
    if (pbx.includes("ScreenCaptureExtension")) {
      deps = addDep(deps, SCE.dependency);
    }
    if (pbx.includes("VoxoNotificationExtension")) {
      deps = addDep(deps, VNE.dependency);
    }
    if (deps === depsInner) return full;
    return `${pre}${deps}${post}`;
  });
}

function repairEmbeddedExtensionsPbxproj() {
  if (!fs.existsSync(PBX)) {
    console.warn("[repair-embedded-ext] no project.pbxproj — skip");
    return false;
  }

  let pbx = fs.readFileSync(PBX, "utf8");
  const before = pbx;

  pbx = createEmbedFoundationExtensionsPhaseIfMissing(pbx);
  const embedPhaseId = resolveEmbedPhaseId(pbx);
  if (embedPhaseId) {
    pbx = ensureHostEmbedBuildPhaseRef(pbx, embedPhaseId);
  }

  if (embedPhaseId) {
    const canonicalRef = `${embedPhaseId} /* Embed Foundation Extensions */`;
    pbx = pbx.replace(
      /\t\t\t\tVNE0E0111A68108700A75B9A \/\* Embed Foundation Extensions \*\/,\n/g,
      `\t\t\t\t${canonicalRef},\n`
    );
    pbx = pbx.replace(
      /\t\t\t\tSCE0E0111A68108700A75B9A \/\* Embed Foundation Extensions \*\/,\n/g,
      `\t\t\t\t${canonicalRef},\n`
    );

    if (pbx.includes("ScreenCaptureExtension.appex")) {
      pbx = ensureEmbedBuildFileEntry(
        pbx,
        SCE.embedBuild,
        "SCE0E0021A68108700A75B9A",
        "ScreenCaptureExtension"
      );
      pbx = ensureEmbedBuildFile(
        pbx,
        embedPhaseId,
        SCE.embedBuild,
        "ScreenCaptureExtension"
      );
    }
    if (pbx.includes("VoxoNotificationExtension.appex")) {
      pbx = ensureEmbedBuildFileEntry(
        pbx,
        VNE.embedBuild,
        "VNE0E0021A68108700A75B9A",
        "VoxoNotificationExtension"
      );
      pbx = ensureEmbedBuildFile(
        pbx,
        embedPhaseId,
        VNE.embedBuild,
        "VoxoNotificationExtension"
      );
    }
  }

  if (pbx.includes("ScreenCaptureExtension")) {
    pbx = ensureContainerProxy(pbx, {
      proxy: SCE.proxy,
      target: SCE.target,
      remoteInfo: "ScreenCaptureExtension"
    });
    pbx = ensureTargetDependency(pbx, {
      dependency: SCE.dependency,
      target: SCE.target,
      proxy: SCE.proxy,
      remoteInfo: "ScreenCaptureExtension"
    });
  }

  if (pbx.includes("VoxoNotificationExtension")) {
    pbx = ensureContainerProxy(pbx, {
      proxy: VNE.proxy,
      target: VNE.target,
      remoteInfo: "VoxoNotificationExtension"
    });
    pbx = ensureTargetDependency(pbx, {
      dependency: VNE.dependency,
      target: VNE.target,
      proxy: VNE.proxy,
      remoteInfo: "VoxoNotificationExtension"
    });
  }

  pbx = removeDependencyFromBuildPhases(pbx);
  pbx = ensureHostDependencies(pbx);
  pbx = fixHostEmbedBuildPhaseRef(pbx);

  // Orphan resource build file refs (common after prebuild --clean)
  pbx = pbx.replace(
    /\n\t\t\t\tEC49E443DDEE48838C5BB124 \/\* VOXOConnect-Bridging-Header\.h in Resources \*\/,\n/g,
    "\n"
  );
  pbx = pbx.replace(
    /\n\t\t\t\tEC7B20E8E56D47ABAC1C5367 \/\* VOXOConnect-Bridging-Header\.h in Resources \*\/,\n/g,
    "\n"
  );

  const nseTargetPresent = pbx.includes("VNE0E0011A68108700A75B9A /* VoxoNotificationExtension */");
  const nseEmbedded =
    hasEmbedBuildFileObject(pbx, VNE.embedBuild, "VoxoNotificationExtension") &&
    hasEmbedPhaseFileRef(pbx, VNE.embedBuild, "VoxoNotificationExtension");

  if (nseTargetPresent && !nseEmbedded) {
    console.warn(
      "[repair-embedded-ext] VoxoNotificationExtension target exists but is not embedded — run: npm run ios:fix-nse"
    );
  }

  if (pbx !== before) {
    fs.writeFileSync(PBX, pbx);
    console.log("[repair-embedded-ext] repaired extension embed phases / proxies in pbxproj");
    return true;
  }
  console.log("[repair-embedded-ext] pbxproj OK");
  return false;
}

module.exports = { repairEmbeddedExtensionsPbxproj };

if (require.main === module) {
  repairEmbeddedExtensionsPbxproj();
}
