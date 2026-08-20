function parsedOrigin(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function parsedSafireAppOrigin(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function allowsSafireDesktopPermission({
  appOrigin,
  mainWebContents,
  webContents,
  permission,
  requestingUrl,
  isMainFrame,
}) {
  const trustedOrigin = parsedSafireAppOrigin(appOrigin);
  return permission === 'fullscreen'
    && mainWebContents != null
    && webContents === mainWebContents
    && isMainFrame === true
    && trustedOrigin !== null
    && parsedOrigin(requestingUrl) === trustedOrigin;
}

module.exports = { allowsSafireDesktopPermission };
