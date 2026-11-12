'use strict';

/**
 * Electron Forge packaging configuration (Windows).
 *
 * Makers are kept to the two that matter on Windows: Squirrel (installer .exe)
 * and zip (portable). No extra plugins/dependencies until one is actually needed.
 *
 * `packagerConfig.icon` points at the official BOBO Arctic Frost ICO. On Windows
 * electron-packager appends `.ico`, so the path is given without the extension.
 */

const ICON = 'src/assets/logo/BOBO_Arctic_Frost/bobo';

module.exports = {
  packagerConfig: {
    name: 'BOBO',
    asar: true,
    appCopyright: 'BOBO',
    icon: ICON,
    ignore: [/^\/(?!src(?:\/|$)|package\.json$|node_modules(?:\/|$))/],
    ...(process.env.BOBO_ELECTRON_ZIP_DIR && { electronZipDir: process.env.BOBO_ELECTRON_ZIP_DIR }),
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'bobo',
        authors: 'BOBO',
        setupExe: 'BOBO-Setup.exe',
        setupIcon: `${ICON}.ico`,
        loadingGif: 'src/assets/logo/BOBO_Arctic_Frost/installing.gif',
        skipUpdateIcon: true,
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32'],
    },
  ],
};
