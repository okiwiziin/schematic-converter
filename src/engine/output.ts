// Writes 1.8 .schematic files. Blocks and Data arrive together but must be stored one
// after the other, so each goes to its own compressed section and they are spliced
// together at the end, without decompressing anything. Peak disk use stays around twice
// the final file size and memory use is constant, whatever the size of the map.
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import {
  crc32Combine,
  createFile,
  deflateSmall,
  DeflatePool,
  DeflateSection,
  GZIP_HEADER,
  gzipTrailer,
  storedBlock,
  type CompressionLevel,
} from "./gzip";
import { nbt, NbtEncoder, TAG, type Compound } from "./nbt/nbt";

// The format stores sizes as signed shorts and arrays with signed int lengths.
export const MAX_SIDE = 32767;
export const MAX_ARRAY = 2147483647;
const MAX_TILES = 1024;

export interface WorldEditOrigin {
  // Lowest corner of the region, which is what the WEOrigin fields really hold.
  originX: number;
  originY: number;
  originZ: number;
  // Corner minus the point it was copied from, so //paste lands where the player expects.
  offsetX: number;
  offsetY: number;
  offsetZ: number;
}

export interface OutputSummary {
  path: string;
  size: number;
  width: number;
  height: number;
  length: number;
  tileX: number;
  tileZ: number;
}

function encodeHeader(width: number, height: number, length: number, origin: WorldEditOrigin): Buffer {
  const encoder = new NbtEncoder(256);
  encoder.head(TAG.Compound, "Schematic");
  encoder.named("Height", nbt.short(height));
  encoder.named("Length", nbt.short(length));
  encoder.named("Width", nbt.short(width));
  encoder.named("WEOriginX", nbt.int(origin.originX));
  encoder.named("WEOriginY", nbt.int(origin.originY));
  encoder.named("WEOriginZ", nbt.int(origin.originZ));
  encoder.named("WEOffsetX", nbt.int(origin.offsetX));
  encoder.named("WEOffsetY", nbt.int(origin.offsetY));
  encoder.named("WEOffsetZ", nbt.int(origin.offsetZ));
  encoder.named("Materials", nbt.string("Alpha"));
  encoder.named("Platform", nbt.string("bukkit"));
  return Buffer.from(encoder.bytes());
}

function arrayHead(name: string, length: number): Buffer {
  const encoder = new NbtEncoder(32);
  encoder.head(TAG.ByteArray, name);
  encoder.i32(length);
  return Buffer.from(encoder.bytes());
}

function listHead(name: string, count: number): Buffer {
  const encoder = new NbtEncoder(32);
  encoder.head(TAG.List, name);
  encoder.u8(TAG.Compound);
  encoder.i32(count);
  return Buffer.from(encoder.bytes());
}

const PLACEHOLDER_ORIGIN: WorldEditOrigin = {
  originX: 0,
  originY: 0,
  originZ: 0,
  offsetX: 0,
  offsetY: 0,
  offsetZ: 0,
};

// A single .schematic file being written.
class SchematicFile {
  readonly volume: number;
  hasContent = false;
  private readonly blocks: DeflateSection;
  private readonly data: DeflateSection;
  private readonly tiles: DeflateSection;
  private readonly entities: DeflateSection;
  private tileCount = 0;
  private entityCount = 0;
  private readonly mainPath: string;
  private readonly dataPath: string;
  private readonly tilePath: string;
  private readonly entityPath: string;
  private readonly encoder = new NbtEncoder(8192);
  private readonly headerLength: number;

  constructor(
    pool: DeflatePool,
    chunkSize: number,
    tempDir: string,
    stem: string,
    readonly width: number,
    readonly height: number,
    readonly length: number,
    readonly finalPath: string,
    readonly tileX: number,
    readonly tileZ: number,
  ) {
    this.volume = width * height * length;
    this.mainPath = join(tempDir, `${stem}.main`);
    this.dataPath = join(tempDir, `${stem}.data`);
    this.tilePath = join(tempDir, `${stem}.tiles`);
    this.entityPath = join(tempDir, `${stem}.entities`);
    this.headerLength = encodeHeader(width, height, length, PLACEHOLDER_ORIGIN).length;

    this.blocks = new DeflateSection(pool, chunkSize, async () => {
      const file = await open(this.mainPath, "w");
      // Reserve room for the gzip header and a stored block holding the NBT header.
      await file.write(Buffer.alloc(GZIP_HEADER.length + 5 + this.headerLength));
      return file;
    });
    const smallChunk = Math.min(chunkSize, 1024 * 1024);
    this.data = new DeflateSection(pool, chunkSize, () => createFile(this.dataPath));
    this.tiles = new DeflateSection(pool, smallChunk, () => createFile(this.tilePath));
    this.entities = new DeflateSection(pool, smallChunk, () => createFile(this.entityPath));
  }

  async begin(): Promise<void> {
    await this.blocks.touch();
    await this.blocks.write(arrayHead("Blocks", this.volume));
    await this.data.touch();
    await this.data.write(arrayHead("Data", this.volume));
  }

  async writeBlocks(ids: Uint8Array, data: Uint8Array, start: number, end: number): Promise<void> {
    await this.blocks.write(ids, start, end);
    await this.data.write(data, start, end);
  }

  async writeTile(tag: Compound): Promise<void> {
    this.encoder.reset();
    this.encoder.payload(nbt.compound(tag));
    await this.tiles.write(this.encoder.bytes());
    this.tileCount += 1;
    this.hasContent = true;
  }

  async writeEntity(tag: Compound): Promise<void> {
    this.encoder.reset();
    this.encoder.payload(nbt.compound(tag));
    await this.entities.write(this.encoder.bytes());
    this.entityCount += 1;
    this.hasContent = true;
  }

  // Splices the sections into the final gzip file. Returns the compressed size.
  async finish(origin: WorldEditOrigin): Promise<number> {
    await this.blocks.finish();
    await this.data.finish();
    await this.tiles.finish();
    await this.entities.finish();

    const header = encodeHeader(this.width, this.height, this.length, origin);
    let crc = zlib.crc32(header);
    let total = header.length;
    const absorb = (sectionCrc: number, length: number): void => {
      crc = crc32Combine(crc, sectionCrc, length);
      total += length;
    };
    const absorbBytes = (bytes: Buffer): void => absorb(zlib.crc32(bytes), bytes.length);

    absorb(this.blocks.crc, this.blocks.rawLength);
    absorb(this.data.crc, this.data.rawLength);

    const entityHead = listHead("Entities", this.entityCount);
    const tileHead = listHead("TileEntities", this.tileCount);
    const end = Buffer.from([0]);

    const mainPath = this.mainPath;
    const appendFile = async (path: string): Promise<void> => {
      await pipeline(createReadStream(path, { highWaterMark: 4 * 1024 * 1024 }), createWriteStream(mainPath, { flags: "a" }));
    };
    const appendBytes = async (bytes: Buffer): Promise<void> => {
      const file = await open(mainPath, "a");
      await file.write(bytes);
      await file.close();
    };

    await appendFile(this.dataPath);
    await appendBytes(deflateSmall(entityHead));
    absorbBytes(entityHead);
    if (this.entities.rawLength > 0) {
      await appendFile(this.entityPath);
      absorb(this.entities.crc, this.entities.rawLength);
    }
    await appendBytes(deflateSmall(tileHead));
    absorbBytes(tileHead);
    if (this.tiles.rawLength > 0) {
      await appendFile(this.tilePath);
      absorb(this.tiles.crc, this.tiles.rawLength);
    }
    await appendBytes(deflateSmall(end));
    absorbBytes(end);
    await appendBytes(gzipTrailer(crc, total));

    // With everything known, patch the reserved space at the start of the file.
    const patch = await open(mainPath, "r+");
    await patch.write(Buffer.concat([GZIP_HEADER, storedBlock(header)]), 0, undefined, 0);
    await patch.close();

    await rm(this.dataPath, { force: true });
    await rm(this.tilePath, { force: true });
    await rm(this.entityPath, { force: true });
    await rename(mainPath, this.finalPath);
    return (await stat(this.finalPath)).size;
  }

  async discard(): Promise<void> {
    await this.blocks.finish();
    await this.data.finish();
    await this.tiles.finish();
    await this.entities.finish();
    for (const path of [this.mainPath, this.dataPath, this.tilePath, this.entityPath]) {
      await rm(path, { force: true });
    }
  }
}

export interface TileLayout {
  tileWidth: number;
  tileLength: number;
  columns: number;
  rows: number;
}

// Works out the grid. `requested` is the user's tile size in blocks, or 0 for one file
// where the format allows it.
export function planTiles(
  width: number,
  height: number,
  length: number,
  requested: number,
): { layout: TileLayout; forced: boolean } {
  let side = requested > 0 ? requested : Math.max(width, length);
  let forced = false;

  // Every tile has to fit the format's limits.
  if (height > MAX_SIDE) throw new Error(`This schematic is ${height} blocks tall, more than the format allows`);
  const maxSide = Math.min(MAX_SIDE, Math.floor(Math.sqrt(MAX_ARRAY / height)));
  const tooBig = (w: number, l: number): boolean =>
    w > MAX_SIDE || l > MAX_SIDE || w * height * l > MAX_ARRAY;
  if (tooBig(Math.min(width, side), Math.min(length, side))) {
    side = Math.floor(maxSide / 16) * 16;
    forced = true;
  }

  let columns = Math.ceil(width / side);
  let rows = Math.ceil(length / side);
  if (columns * rows > MAX_TILES) {
    const scale = Math.ceil(Math.sqrt((columns * rows) / MAX_TILES));
    side *= scale;
    if (tooBig(Math.min(width, side), Math.min(length, side))) {
      throw new Error("This map is too large to split into a reasonable number of files");
    }
    columns = Math.ceil(width / side);
    rows = Math.ceil(length / side);
    forced = true;
  }
  // When the split wasn't the user's choice, share the map out evenly rather than leaving slivers.
  const even = forced && requested === 0;
  return {
    layout: {
      tileWidth: even ? Math.ceil(width / columns) : Math.min(side, width),
      tileLength: even ? Math.ceil(length / rows) : Math.min(side, length),
      columns,
      rows,
    },
    forced,
  };
}

function isAllZero(bytes: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (bytes[i] !== 0) return false;
  return true;
}

// Fans a linear (y, z, x) run of blocks out across a grid of files. With a single tile
// it collapses to a direct write.
export class SchematicOutput {
  readonly layout: TileLayout;
  private readonly files: SchematicFile[] = [];
  private readonly pool: DeflatePool;
  private x = 0;
  private z = 0;
  private y = 0;
  written = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly length: number,
    layout: TileLayout,
    private readonly tempDir: string,
    outputDir: string,
    baseName: string,
    level: CompressionLevel,
    threads: number,
  ) {
    this.layout = layout;
    const fileCount = layout.columns * layout.rows;
    // Scale chunks down with the number of files so memory stays bounded.
    const chunkSize = Math.max(64 * 1024, Math.min(4 * 1024 * 1024, Math.floor((256 * 1024 * 1024) / (fileCount * 2))));
    this.pool = new DeflatePool(Math.max(2, threads + 2), level);
    for (let row = 0; row < layout.rows; row++) {
      for (let column = 0; column < layout.columns; column++) {
        const w = Math.min(layout.tileWidth, width - column * layout.tileWidth);
        const l = Math.min(layout.tileLength, length - row * layout.tileLength);
        const suffix = fileCount === 1 ? "" : `_x${column}_z${row}`;
        this.files.push(
          new SchematicFile(
            this.pool,
            chunkSize,
            tempDir,
            `tile-${column}-${row}`,
            w,
            height,
            l,
            join(outputDir, `${baseName}${suffix}.schematic`),
            column,
            row,
          ),
        );
      }
    }
  }

  async begin(): Promise<void> {
    await mkdir(this.tempDir, { recursive: true });
    for (const file of this.files) await file.begin();
  }

  // ids and data hold `count` blocks continuing on from the last call.
  async writeRun(ids: Uint8Array, data: Uint8Array, count: number): Promise<void> {
    this.written += count;
    const { columns, rows, tileWidth, tileLength } = this.layout;
    if (columns === 1 && rows === 1) {
      const file = this.files[0]!;
      if (!file.hasContent && !isAllZero(ids, 0, count)) file.hasContent = true;
      await file.writeBlocks(ids, data, 0, count);
      return;
    }
    let at = 0;
    while (at < count) {
      const column = Math.floor(this.x / tileWidth);
      const row = Math.floor(this.z / tileLength);
      const segmentEnd = Math.min((column + 1) * tileWidth, this.width);
      const take = Math.min(count - at, segmentEnd - this.x);
      const file = this.files[row * columns + column]!;
      if (!file.hasContent && !isAllZero(ids, at, at + take)) file.hasContent = true;
      await file.writeBlocks(ids, data, at, at + take);
      at += take;
      this.x += take;
      if (this.x === this.width) {
        this.x = 0;
        this.z += 1;
        if (this.z === this.length) {
          this.z = 0;
          this.y += 1;
        }
      }
    }
  }

  private fileAt(x: number, z: number): SchematicFile {
    const column = Math.floor(x / this.layout.tileWidth);
    const row = Math.floor(z / this.layout.tileLength);
    return this.files[row * this.layout.columns + column]!;
  }

  // Tile entity positions are relative to the file they land in, so this hands back the
  // tile's origin for the caller to subtract before building the tag.
  tileOrigin(x: number, z: number): [number, number] {
    return [
      Math.floor(x / this.layout.tileWidth) * this.layout.tileWidth,
      Math.floor(z / this.layout.tileLength) * this.layout.tileLength,
    ];
  }

  async writeTile(x: number, z: number, tag: Compound): Promise<void> {
    await this.fileAt(x, z).writeTile(tag);
  }

  async writeEntity(x: number, z: number, tag: Compound): Promise<void> {
    const clampedX = Math.max(0, Math.min(this.width - 1, Math.floor(x)));
    const clampedZ = Math.max(0, Math.min(this.length - 1, Math.floor(z)));
    await this.fileAt(clampedX, clampedZ).writeEntity(tag);
  }

  async finish(origin: WorldEditOrigin, onFile?: (index: number, total: number) => void): Promise<OutputSummary[]> {
    const summaries: OutputSummary[] = [];
    const multi = this.files.length > 1;
    let index = 0;
    for (const file of this.files) {
      onFile?.(index++, this.files.length);
      // Empty parts of a split map would only be clutter, but always keep at least one file.
      if (multi && !file.hasContent) {
        await file.discard();
        continue;
      }
      const xShift = file.tileX * this.layout.tileWidth;
      const zShift = file.tileZ * this.layout.tileLength;
      const size = await file.finish({
        originX: origin.originX + xShift,
        originY: origin.originY,
        originZ: origin.originZ + zShift,
        offsetX: origin.offsetX + xShift,
        offsetY: origin.offsetY,
        offsetZ: origin.offsetZ + zShift,
      });
      summaries.push({
        path: file.finalPath,
        size,
        width: file.width,
        height: file.height,
        length: file.length,
        tileX: file.tileX,
        tileZ: file.tileZ,
      });
    }
    return summaries;
  }
}
