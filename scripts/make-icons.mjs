// Renders the app icon the installer needs from assets/icon.svg. Run with `npm run icons`.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const assets = join(dirname(fileURLToPath(import.meta.url)), "../assets");
await sharp(join(assets, "icon.svg"), { density: 768 })
  .resize(512, 512)
  .png()
  .toFile(join(assets, "icon.png"));
console.log("assets/icon.png written");
