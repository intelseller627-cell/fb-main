const fs = require("fs");
const path = require("path");
const logger = require("../func/logger");
const defaultConfig = {
  autoUpdate: false,
  mqtt: { enabled: true, reconnectInterval: 3600 },
  autoLogin: false, // SECURITY: never re-login with email/password (that path posts credentials to a third-party apiServer)
  apiServer: "", // SECURITY: removed third-party login server; this service uses AppState/cookie login only
  apiKey: "",
  credentials: { email: "", password: "", twofactor: "" },
  antiGetInfo: {
    AntiGetThreadInfo: false,
    AntiGetUserInfo: false
  },
  remoteControl: {
    enabled: false,
    url: "",
    token: "",
    autoReconnect: true
  }
};

function loadConfig() {
  const configPath = path.join(process.cwd(), "fca-config.json");
  let config;
  if (!fs.existsSync(configPath)) {
    config = defaultConfig;
  } else {
    try {
      const fileContent = fs.readFileSync(configPath, "utf8");
      config = Object.assign({}, defaultConfig, JSON.parse(fileContent));
    } catch (err) {
      logger(`Error reading config file: ${err.message}`, "error");
      config = defaultConfig;
    }
  }
  return { config, configPath };
}

module.exports = { loadConfig, defaultConfig };