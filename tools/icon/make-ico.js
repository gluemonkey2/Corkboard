// Make the Windows icon (electron/icon/Corkboard.ico) from electron/icon/icon.png.
// Run it with Electron, on any system:   npx electron tools/icon/make-ico.js
// The .ico file holds the picture at six sizes, each one as a PNG.
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', '..', 'electron', 'icon');
app.whenReady().then(() => {
  const src = nativeImage.createFromPath(path.join(dir, 'icon.png'));
  const pngs = [16, 32, 48, 64, 128, 256].map((s) => [s, src.resize({ width: s, height: s, quality: 'best' }).toPNG()]);
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(1, 2);            // type: icon
  head.writeUInt16LE(pngs.length, 4);  // how many pictures
  let at = head.length;
  pngs.forEach(([s, png], i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(s === 256 ? 0 : s, e);     // width (0 is 256)
    head.writeUInt8(s === 256 ? 0 : s, e + 1); // height
    head.writeUInt16LE(1, e + 4);              // colour planes
    head.writeUInt16LE(32, e + 6);             // bits for each pixel
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(at, e + 12);
    at += png.length;
  });
  fs.writeFileSync(path.join(dir, 'Corkboard.ico'), Buffer.concat([head, ...pngs.map(([, png]) => png)]));
  console.log('Made electron/icon/Corkboard.ico');
  app.quit();
});
