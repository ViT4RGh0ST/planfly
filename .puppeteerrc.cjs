/**
 * Puppeteer is only used by the design-scan and screenshot scripts, which are
 * development tools.
 *
 * Without this, `npm ci` downloads Chrome — some 150 MB — for anyone who only
 * wants to start the application, and if the download fails — a half-filled
 * cache, a restrictive network — the whole install comes down over something
 * with nothing to do with the project.
 *
 * To use those scripts:  npx puppeteer browsers install chrome
 */
module.exports = { skipDownload: true };
