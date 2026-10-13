const logger = require("./logger");

async function _checkAndUpdateVersionImpl() {
  logger("Auto-update is disabled for fca-unofficial-updated to maintain custom fixes.", "info");
  return;
}

function checkAndUpdateVersion(callback) {
  if (typeof callback === "function") {
    _checkAndUpdateVersionImpl().then(() => callback(null)).catch(err => callback(err));
    return;
  }
  return _checkAndUpdateVersionImpl();
}

module.exports = { checkAndUpdateVersion };
