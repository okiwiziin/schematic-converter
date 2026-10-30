// Writes large test maps for benchmarking and stress tests.
//   node scripts/make-big-schem.mjs out.schem 2000 256 2000
//   node scripts/make-big-schem.mjs out.schem 500 256 500 --noise      Worst case: random blocks
//   node scripts/make-big-schem.mjs out.litematic 3000 256 3000        Bit-packed, can exceed 2^31
import { createWriteStream } from "node:fs";
import zlib from "node:zlib";

const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
const [out, widthArg, heightArg, lengthArg] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const width = Number(widthArg ?? 1000);
const height = Number(heightArg ?? 256);
const length = Number(lengthArg ?? 1000);
const noise = flags.includes("--noise");
const litematic = out.endsWith(".litematic");

const STATES = [
  "minecraft:air",
  "minecraft:stone",
  "minecraft:grass_block[snowy=false]",
  "minecraft:dirt",
  "minecraft:deepslate[axis=y]",
  "minecraft:water[level=0]",
  "minecraft:sand",
  "minecraft:gravel",
  "minecraft:granite",
  "minecraft:andesite",
  "minecraft:diorite",
  "minecraft:coal_ore",
  "minecraft:iron_ore",
  "minecraft:copper_ore",
  "minecraft:deepslate_diamond_ore",
  "minecraft:oak_log[axis=y]",
  "minecraft:oak_leaves[distance=1,persistent=true,waterlogged=false]",
  "minecraft:chest[facing=north,type=single,waterlogged=false]",
  "minecraft:oak_sign[rotation=0,waterlogged=false]",
  "minecraft:stone_bricks",
  "minecraft:cobblestone",
];
// Enough extra states that plenty of indices take two varint bytes, like a real map.
const WOODS = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "cherry", "mangrove", "bamboo", "crimson", "warped", "pale_oak"];
stairs: for (const wood of WOODS) {
  for (const facing of ["north", "south", "east", "west"]) {
    for (const half of ["top", "bottom"]) {
      for (const shape of ["straight", "inner_left", "inner_right", "outer_left", "outer_right"]) {
        if (STATES.length === 421) break stairs;
        STATES.push(`minecraft:${wood}_stairs[facing=${facing},half=${half},shape=${shape},waterlogged=false]`);
      }
    }
  }
}

const str = (text) => {
  const bytes = Buffer.from(text);
  const head = Buffer.alloc(2);
  head.writeUInt16BE(bytes.length);
  return Buffer.concat([head, bytes]);
};
const tag = (type, name) => Buffer.concat([Buffer.from([type]), str(name)]);
const short = (name, value) => {
  const body = Buffer.alloc(2);
  body.writeUInt16BE(value & 0xffff);
  return Buffer.concat([tag(2, name), body]);
};
const int = (name, value) => {
  const body = Buffer.alloc(4);
  body.writeInt32BE(value);
  return Buffer.concat([tag(3, name), body]);
};
const string = (name, value) => Buffer.concat([tag(8, name), str(value)]);
const END = Buffer.from([0]);

const terrain = (x, z) =>
  70 + 14 * Math.sin(x / 47) * Math.cos(z / 53) + 6 * Math.sin((x + z) / 19) + 2 * Math.cos((x * 3 - z) / 7);

const heights = new Uint16Array(width * length);
for (let z = 0; z < length; z++) {
  for (let x = 0; x < width; x++) heights[z * width + x] = Math.round(terrain(x, z));
}

const isTree = (x, z) => x % 31 === 5 && z % 29 === 7;
const isChest = (x, z) => x % 197 === 3 && z % 211 === 3;
const isSign = (x, z) => x % 211 === 11 && z % 197 === 11;
const isBuild = (x, z) => x % 64 < 8 && z % 64 < 8;

function terrainBlock(x, y, z, top) {
  if (y > top) {
    if (y <= 62) return 5;
    if (isTree(x, z) && y <= top + 5) return 15;
    if (isTree(x, z) && y === top + 6) return 16;
    if (isChest(x, z) && y === top + 1) return 17;
    if (isSign(x, z) && y === top + 1) return 18;
    if (isBuild(x, z) && y === top + 1) return 21 + ((x * 7 + z) % 400);
    return 0;
  }
  if (y === top) return top <= 63 ? 6 : 2;
  if (y > top - 4) return 3;
  if (Math.sin(x / 11) + Math.cos(z / 13) + Math.sin(y / 7) > 2.2) return 0;
  const hash = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  const roll = (hash >>> 0) % 1000;
  if (roll < 2) return 12;
  if (roll < 6) return 11;
  if (roll < 40) return 8 + (roll % 3);
  return y < 16 ? 4 : 1;
}

// A fixed seed, so the same arguments always make the same map.
let seed = 0x9e3779b9;
const randomBlock = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) % STATES.length;
};

const volume = width * height * length;
const started = Date.now();

const gzip = zlib.createGzip({ level: 1, chunkSize: 1 << 20 });
const file = createWriteStream(out, { highWaterMark: 1 << 22 });
gzip.pipe(file);
const put = async (buffer) => {
  if (!gzip.write(buffer)) await new Promise((resolve) => gzip.once("drain", resolve));
};

const eachBlock = async (visit) => {
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const value = noise ? randomBlock() : terrainBlock(x, y, z, heights[z * width + x]);
        visit(value);
      }
    }
    await flush();
    if (y % 16 === 0) process.stderr.write(`${Math.round((y / height) * 100)}%\r`);
  }
};

let chunk = Buffer.allocUnsafe(1 << 24);
let at = 0;
const flush = async () => {
  if (at === 0) return;
  await put(chunk.subarray(0, at));
  chunk = Buffer.allocUnsafe(1 << 24);
  at = 0;
};
// A layer can be larger than the buffer, so drain it from inside the loop when needed.
const pending = [];
const room = (needed) => {
  if (at + needed > chunk.length) {
    pending.push(chunk.subarray(0, at));
    chunk = Buffer.allocUnsafe(1 << 24);
    at = 0;
    if (pending.length > 32) drainPendingSync();
  }
};
const drainPendingSync = () => {
  while (pending.length > 0) gzip.write(pending.shift());
};

async function writeSchem() {
  await put(tag(10, "Schematic"));
  await put(int("Version", 2));
  await put(int("DataVersion", 3465));
  await put(short("Width", width));
  await put(short("Height", height));
  await put(short("Length", length));
  await put(int("PaletteMax", STATES.length));
  await put(tag(10, "Palette"));
  for (const [index, state] of STATES.entries()) await put(int(state, index));
  await put(END);

  // The array's length comes first, so count how many indices need a second byte.
  let wide = 0;
  if (noise) {
    const saved = seed;
    for (let i = 0; i < volume; i++) if (randomBlock() > 127) wide += 1;
    seed = saved;
  } else {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const top = heights[z * width + x];
        if (top + 1 < height && top >= 62 && !isTree(x, z) && !isChest(x, z) && !isSign(x, z) && isBuild(x, z)) {
          if (21 + ((x * 7 + z) % 400) > 127) wide += 1;
        }
      }
    }
  }
  const byteLength = volume + wide;
  if (byteLength > 2147483647) throw new Error("Too large for a byte array; use a .litematic");
  await put(tag(7, "BlockData"));
  const head = Buffer.alloc(4);
  head.writeInt32BE(byteLength);
  await put(head);

  await eachBlock((value) => {
    room(2);
    if (value > 127) {
      chunk[at++] = (value & 127) | 128;
      chunk[at++] = value >>> 7;
    } else {
      chunk[at++] = value;
    }
  });
  drainPendingSync();
  await flush();

  const entries = [];
  if (!noise) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const y = heights[z * width + x] + 1;
        if (y >= height || y <= 62 || isTree(x, z)) continue;
        if (isChest(x, z)) entries.push([x, y, z, "chest"]);
        else if (isSign(x, z)) entries.push([x, y, z, "sign"]);
      }
    }
  }
  await put(tag(9, "BlockEntities"));
  const listHead = Buffer.alloc(5);
  listHead[0] = 10;
  listHead.writeInt32BE(entries.length, 1);
  await put(listHead);
  for (const [x, y, z, kind] of entries) {
    const pos = Buffer.alloc(16);
    pos.writeInt32BE(3, 0);
    pos.writeInt32BE(x, 4);
    pos.writeInt32BE(y, 8);
    pos.writeInt32BE(z, 12);
    const parts = [tag(11, "Pos"), pos, string("Id", kind === "chest" ? "minecraft:chest" : "minecraft:sign")];
    if (kind === "sign") parts.push(string("Text1", '{"text":"Spawn"}'));
    parts.push(END);
    await put(Buffer.concat(parts));
  }
  await put(END);
  await put(END);
}

async function writeLitematic() {
  const bits = Math.max(2, Math.ceil(Math.log2(STATES.length)));
  const longs = Math.ceil((volume * bits) / 64);
  if (longs > 2147483647) throw new Error("Too large for a long array");

  await put(tag(10, ""));
  await put(int("MinecraftDataVersion", 3465));
  await put(int("Version", 6));
  await put(tag(10, "Metadata"));
  await put(string("Name", "big test"));
  await put(int("RegionCount", 1));
  await put(tag(10, "EnclosingSize"));
  await put(int("x", width));
  await put(int("y", height));
  await put(int("z", length));
  await put(END);
  await put(END);
  await put(tag(10, "Regions"));
  await put(tag(10, "main"));
  await put(tag(10, "Position"));
  await put(int("x", 0));
  await put(int("y", 0));
  await put(int("z", 0));
  await put(END);
  await put(tag(10, "Size"));
  await put(int("x", width));
  await put(int("y", height));
  await put(int("z", length));
  await put(END);

  await put(tag(9, "BlockStatePalette"));
  const paletteHead = Buffer.alloc(5);
  paletteHead[0] = 10;
  paletteHead.writeInt32BE(STATES.length, 1);
  await put(paletteHead);
  for (const state of STATES) {
    const open = state.indexOf("[");
    const parts = [string("Name", open === -1 ? state : state.slice(0, open))];
    if (open !== -1) {
      parts.push(tag(10, "Properties"));
      for (const pair of state.slice(open + 1, -1).split(",")) {
        const [key, value] = pair.split("=");
        parts.push(string(key, value));
      }
      parts.push(END);
    }
    parts.push(END);
    await put(Buffer.concat(parts));
  }

  await put(tag(12, "BlockStates"));
  const head = Buffer.alloc(4);
  head.writeInt32BE(longs);
  await put(head);

  // Pack into 32-bit words, low word first, then store each pair as one big-endian long.
  let accumulator = 0;
  let held = 0;
  let low = null;
  const emitWord = (word) => {
    if (low === null) {
      low = word >>> 0;
      return;
    }
    room(8);
    chunk.writeUInt32BE(word >>> 0, at);
    chunk.writeUInt32BE(low, at + 4);
    at += 8;
    low = null;
  };
  await eachBlock((value) => {
    accumulator = (accumulator | (value << held)) >>> 0;
    if (held + bits >= 32) {
      emitWord(accumulator);
      accumulator = held === 0 ? 0 : value >>> (32 - held);
      held = held + bits - 32;
    } else {
      held += bits;
    }
  });
  if (held > 0) emitWord(accumulator);
  if (low !== null) emitWord(0);
  drainPendingSync();
  await flush();

  for (const name of ["TileEntities", "Entities"]) {
    await put(tag(9, name));
    const empty = Buffer.alloc(5);
    empty[0] = 10;
    await put(empty);
  }
  await put(END); // main
  await put(END); // Regions
  await put(END); // root
}

await (litematic ? writeLitematic() : writeSchem());
gzip.end();
await new Promise((resolve) => file.once("finish", resolve));
console.log(`${out}: ${width}x${height}x${length}, ${volume.toLocaleString()} blocks, ${((Date.now() - started) / 1000).toFixed(1)}s`);
