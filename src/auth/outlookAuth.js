const fs = require("fs");
const msal = require("@azure/msal-node");
const config = require("../config/config");
const logger = require("../utils/logger");

const SCOPES = ["Calendars.Read", "User.Read", "OnlineMeetings.Read"];

function buildCachePlugin() {
  return {
    beforeCacheAccess: async (cacheContext) => {
      if (fs.existsSync(config.TOKEN_CACHE_FILE)) {
        cacheContext.tokenCache.deserialize(
          fs.readFileSync(config.TOKEN_CACHE_FILE, "utf-8")
        );
      }
    },
    afterCacheAccess: async (cacheContext) => {
      if (cacheContext.cacheHasChanged) {
        fs.writeFileSync(
          config.TOKEN_CACHE_FILE,
          cacheContext.tokenCache.serialize()
        );
      }
    },
  };
}

function getMsalApp() {
  if (!config.azure.clientId) {
    throw new Error(
      "AZURE_CLIENT_ID belum diisi di file .env. Lihat README bagian 'Setup Kalender - Mode B (graph)'."
    );
  }
  return new msal.PublicClientApplication({
    auth: {
      clientId: config.azure.clientId,
      authority: `https://login.microsoftonline.com/${config.azure.tenantId}`,
    },
    cache: { cachePlugin: buildCachePlugin() },
  });
}

async function login() {
  const app = getMsalApp();
  const deviceCodeRequest = {
    scopes: SCOPES,
    deviceCodeCallback: (response) => {
      logger.title("LOGIN KE MICROSOFT OUTLOOK");
      console.log(response.message);
    },
  };
  const result = await app.acquireTokenByDeviceCode(deviceCodeRequest);
  logger.success(`Berhasil login sebagai ${result.account.username}`);
  return result;
}

async function getAccessToken() {
  const app = getMsalApp();
  const cache = app.getTokenCache();
  const accounts = await cache.getAllAccounts();
  if (accounts.length === 0) {
    throw new Error(
      "Belum login. Jalankan `meetresult login` terlebih dahulu."
    );
  }
  try {
    const result = await app.acquireTokenSilent({
      account: accounts[0],
      scopes: SCOPES,
    });
    return result.accessToken;
  } catch (e) {
    logger.warn("Sesi kadaluarsa, silakan login ulang.");
    const result = await login();
    return result.accessToken;
  }
}

function logout() {
  if (fs.existsSync(config.TOKEN_CACHE_FILE)) {
    fs.unlinkSync(config.TOKEN_CACHE_FILE);
  }
  logger.success("Berhasil logout dari Outlook.");
}

module.exports = { login, logout, getAccessToken };
