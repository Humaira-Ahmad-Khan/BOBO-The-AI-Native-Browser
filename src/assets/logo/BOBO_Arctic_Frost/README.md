# BOBO Browser — Arctic Frost asset pack

The colours follow the selected No. 15 Arctic Frost scheme. The circular 3D B mark, glossy ring and wordmark are taken from the approved reference image. No logo redesign was intended.

## Included

- `BOBO_Arctic_Frost_Full_Logo.png`: original cropped light full logo with wordmark.
- `BOBO_Arctic_Frost_Emblem_Transparent_1024.png`: isolated circular emblem with a softly feathered edge. Transparency is approximated from the raster artwork, not an original vector mask.
- `BOBO_Arctic_Frost_App_Icon_Light_1024.png`: square icon with pale background.
- `BOBO_Arctic_Frost_App_Icon_Dark_1024.png`: same emblem on a dark blue background.
- `BOBO_Arctic_Frost_512.png` etc.: square PNGs at 512, 256, 128, 64, 48, 32 and 16 px.
- `bobo.ico`: Windows multi-resolution ICO (16–256 px).
- `favicon-16.png` and `favicon-32.png`: small favicon versions.
- `BOBO_Arctic_Frost_Colours.css`: theme palette.
- `BOBO_Arctic_Frost_Preview.png`: overview.

## Electron usage

Put `bobo.ico` under your project's `assets` folder. In an Electron Forge packaging configuration, use the ICO path **without the .ico extension** for `packagerConfig.icon` on Windows where required, e.g. `assets/bobo`. Your agent should confirm the current Forge configuration. For BrowserWindow icons, use a PNG resource.

## Colour palette

- Snow White — `#FFFFFF`
- Ice Blue — `#B8E9FF`
- Steel Blue — `#5C8AA6`
- Deep Navy — `#192734`

## Quality notes

These files are derived from generated raster artwork, not editable vector masters. The larger 1024 px assets are resampled from the available source and should be inspected at small icon sizes before distribution. This pack contains no proprietary font files.
