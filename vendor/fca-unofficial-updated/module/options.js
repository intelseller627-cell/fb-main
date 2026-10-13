const { getType } = require("../src/utils/format");
const { setProxy } = require("../src/utils/request");
const { getRandomUserAgent } = require("../src/utils/userAgent");
const logger = require("../func/logger");
const Boolean_Option = [
  "online",
  "selfListen",
  "listenEvents",
  "updatePresence",
  "forceLogin",
  "autoMarkRead",
  "listenTyping",
  "autoReconnect",
  "emitReady",
  "selfListenEvent",
  "autoMarkDelivery"
];
function setOptions(globalOptions, options) {
  for (const key of Object.keys(options || {})) {
    if (Boolean_Option.includes(key)) {
      globalOptions[key] = Boolean(options[key]);
      continue;
    }
    switch (key) {
      case "userAgent": {
        globalOptions.userAgent = options.userAgent || getRandomUserAgent();
        break;
      }
      case "logLevel":
      case "notes":
      case "proxy": {
        if (typeof options.proxy !== "string") {
          delete globalOptions.proxy;
          setProxy();
        } else {
          globalOptions.proxy = options.proxy;
          setProxy(globalOptions.proxy);
        }
        break;
      }
      default: {
        logger("setOptions Unrecognized option given to setOptions: " + key, "warn");
        break;
      }
    }
  }
}
module.exports = { setOptions, Boolean_Option };
