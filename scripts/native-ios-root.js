const path = require("path");

function getNativeIosRoot() {
  return path.join(__dirname, "..", "native-ios");
}

module.exports = { getNativeIosRoot };
