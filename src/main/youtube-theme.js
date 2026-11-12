'use strict';
const { isYouTube, setYouTubeAppearance } = require('../preload/youtube');
async function applyYouTubeTheme(contents, mode) {
  if (!contents || contents.isDestroyed() || !isYouTube(contents.getURL())) return false;
  return contents.executeJavaScriptInIsolatedWorld(1101, [{
    code: `(${isYouTube.toString()})(location.href) && (${setYouTubeAppearance.toString()})(${JSON.stringify(mode)})`,
  }]);
}
module.exports = { applyYouTubeTheme, isYouTube };
