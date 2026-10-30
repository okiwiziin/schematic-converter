// Converts one file. The formats differ in where things are, not in what they hold, so
// each adapter below just walks its file and feeds a shared Job. NBT tags can be in any
// order, so adapters take what they can on each pass and go round again if something
// arrived before the data it depends on. In practice one pass is nearly always enough.
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { access, mkdir, open, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pipeline as pipelineCallback } from "node:stream";
import zlib from "node:zlib";
import type {
  BlockReportRow,
  ConvertOptions,
  ConvertReport,
  FileInfo,
  Progress,
  ProgressPhase,
  SourceFormat,
} from "../shared/types";
import { BlockCanvas } from "./canvas";
import versions from "./data/versions.json";
import { decodePacked, decodeVarints, type RunTarget } from "./decode";
import { translateEntity } from "./mapping/entities";
import { BlockResolver, displayName18, type Resolved } from "./mapping/resolver";
import { isWorthReporting, translateTile, type TileContext } from "./mapping/tileEntities";
import {
  asCompound,
  asList,
  asNumber,
  asString,
  asTriple,
  child,
  ENTER,
  NbtReader,
  SKIP,
  STOP,
  TAG,
  walk,
  type Compound,
  type NbtTag,
  type WalkAction,
} from "./nbt/nbt";
import { planTiles, SchematicOutput, type WorldEditOrigin } from "./output";
import { collectBlockRecords, PaletteTable, SpecialIndex } from "./palette";

const CHUNK_SIZE = 1024 * 1024;
const MAX_PASSES = 4;

export interface ConvertRequest {
  input: string;
  outputDir: string;
  tempDir: string;
  options: ConvertOptions;
  threads: number;
  onProgress?: (progress: Progress) => void;
}

interface Source {
  reader: NbtReader;
  bytesRead: () => number;
  close: () => void;
}

async function isGzip(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const magic = Buffer.alloc(2);
    await file.read(magic, 0, 2, 0);
    return magic[0] === 0x1f && magic[1] === 0x8b;
  } finally {
    await file.close();
  }
}

async function openSource(path: string): Promise<Source> {
  const gzipped = await isGzip(path);
  const file: ReadStream = createReadStream(path, { highWaterMark: CHUNK_SIZE });
  if (!gzipped) {
    return {
      reader: new NbtReader(file[Symbol.asyncIterator]() as AsyncIterator<Buffer>),
      bytesRead: () => file.bytesRead,
      close: () => file.destroy(),
    };
  }
  const gunzip = zlib.createGunzip({ chunkSize: CHUNK_SIZE });
  pipelineCallback(file, gunzip, () => {});
  return {
    reader: new NbtReader(gunzip[Symbol.asyncIterator]() as AsyncIterator<Buffer>),
    bytesRead: () => file.bytesRead,
    close: () => {
      file.destroy();
      gunzip.destroy();
    },
  };
}

function versionLabel(dataVersion: number | null): string | null {
  if (dataVersion === null) return null;
  const table = versions as [number, string][];
  let label: string | null = null;
  for (const [version, name] of table) {
    if (version > dataVersion) break;
    label = name;
  }
  return label;
}

const FORMAT_LABELS: Record<SourceFormat, string> = {
  sponge: "Sponge schematic",
  litematic: "Litematica",
  structure: "Structure block",
  legacy: "Legacy schematic",
};

// Reads just enough of a file to identify it, stopping as soon as it can.
export async function inspectFile(path: string): Promise<FileInfo> {
  try {
    return await readFileInfo(path);
  } catch (error) {
    throw friendlyError(error);
  }
}

async function readFileInfo(path: string): Promise<FileInfo> {
  const fileSize = (await stat(path)).size;
  const source = await openSource(path);

  let format: SourceFormat | null = null;
  let width: number | undefined;
  let height: number | undefined;
  let length: number | undefined;
  let dataVersion: number | null = null;
  let regionCount: number | null = null;

  const known = (): boolean =>
    format !== null &&
    width !== undefined &&
    height !== undefined &&
    length !== undefined &&
    (format !== "litematic" || regionCount !== null);
  const number = (use: (value: number) => void): WalkAction => ({
    kind: "value",
    use: (tag) => {
      const value = asNumber(tag);
      if (value !== undefined) use(value);
    },
  });

  try {
    await walk(source.reader, (rawPath, type) => {
      if (known()) return STOP;
      const path = rawPath.startsWith("/Schematic") ? rawPath.slice(10) : rawPath;
      switch (path) {
        case "":
          return type === TAG.Compound ? ENTER : SKIP;
        case "/Width":
          return number((value) => (width = value & 0xffff));
        case "/Height":
          return number((value) => (height = value & 0xffff));
        case "/Length":
          return number((value) => (length = value & 0xffff));
        case "/DataVersion":
        case "/MinecraftDataVersion":
          return number((value) => (dataVersion = value));
        case "/Materials":
          format ??= "legacy";
          return SKIP;
        case "/Palette":
        case "/BlockData":
          format ??= "sponge";
          return SKIP;
        case "/Blocks":
          format ??= type === TAG.Compound ? "sponge" : "legacy";
          return SKIP;
        case "/Regions":
          format = "litematic";
          // The metadata normally comes first; don't read gigabytes looking for it.
          return width !== undefined ? STOP : SKIP;
        case "/Metadata":
          return ENTER;
        case "/Metadata/RegionCount":
          format = "litematic";
          return number((value) => (regionCount = value));
        case "/Metadata/EnclosingSize":
          format = "litematic";
          return {
            kind: "value",
            use: (tag) => {
              const size = asCompound(tag);
              width = Math.abs(asNumber(child(size, "x")) ?? 0);
              height = Math.abs(asNumber(child(size, "y")) ?? 0);
              length = Math.abs(asNumber(child(size, "z")) ?? 0);
            },
          };
        case "/size":
          format = "structure";
          return {
            kind: "value",
            use: (tag) => {
              const size = asTriple(tag);
              if (size) [width, height, length] = size;
            },
          };
        case "/palette":
        case "/palettes":
        case "/blocks":
          format = "structure";
          return SKIP;
        default:
          return SKIP;
      }
    });
  } finally {
    source.close();
  }

  if (!format || width === undefined || height === undefined || length === undefined) {
    throw new Error("This doesn't look like a schematic: it has no recognisable block data or size");
  }
  return {
    format,
    formatLabel: FORMAT_LABELS[format],
    width,
    height,
    length,
    volume: width * height * length,
    fileSize,
    dataVersion,
    versionLabel: versionLabel(dataVersion),
    regionCount,
  };
}

class Job {
  readonly resolver: BlockResolver;
  readonly palette = new PaletteTable();
  readonly specials = new SpecialIndex();
  readonly warnings: string[] = [];
  readonly tileCtx: TileContext;
  readonly droppedEntities = new Map<string, number>();
  output: SchematicOutput | null = null;
  width = 0;
  height = 0;
  length = 0;
  volume = 0;
  origin: WorldEditOrigin = { originX: 0, originY: 0, originZ: 0, offsetX: 0, offsetY: 0, offsetZ: 0 };
  tilesWritten = 0;
  entitiesWritten = 0;
  split = false;
  invalid = 0;
  private lastProgress = 0;
  private lastBlocks = 0;
  private lastTime = Date.now();
  private rate = 0;
  private baseName = "";
  private source: Source | null = null;
  private fileSize = 0;

  constructor(readonly request: ConvertRequest) {
    const [id, data] = request.options.fallback.split(":").map(Number);
    this.resolver = new BlockResolver([id ?? 0, data ?? 0], request.options.overrides);
    this.tileCtx = { resolver: this.resolver, dropped: new Map(), orphans: new Map() };
  }

  async prepare(fileSize: number): Promise<void> {
    this.fileSize = fileSize;
    await mkdir(this.request.outputDir, { recursive: true });
    this.baseName = await this.pickBaseName();
  }

  private async pickBaseName(): Promise<string> {
    const stem = basename(this.request.input, extname(this.request.input));
    if (this.request.options.overwrite) return stem;
    const taken = async (name: string): Promise<boolean> => {
      for (const file of [`${name}.schematic`, `${name}_x0_z0.schematic`]) {
        try {
          await access(join(this.request.outputDir, file));
          return true;
        } catch {
          // Not there, keep checking.
        }
      }
      return false;
    };
    if (!(await taken(stem))) return stem;
    for (let n = 2; n < 10000; n++) {
      const candidate = `${stem} (${n})`;
      if (!(await taken(candidate))) return candidate;
    }
    throw new Error("Couldn't find a free output file name");
  }

  async open(): Promise<Source> {
    this.source = await openSource(this.request.input);
    return this.source;
  }

  setDimensions(width: number, height: number, length: number): void {
    if (width <= 0 || height <= 0 || length <= 0) throw new Error(`Invalid schematic size ${width}×${height}×${length}`);
    this.width = width;
    this.height = height;
    this.length = length;
    this.volume = width * height * length;
  }

  async ensureOutput(): Promise<SchematicOutput> {
    if (this.output) return this.output;
    const { options, outputDir, tempDir, threads } = this.request;
    const { layout, forced } = planTiles(this.width, this.height, this.length, options.tileSize);
    this.split = layout.columns * layout.rows > 1;
    if (forced) {
      this.warnings.push(
        `Split into ${layout.columns * layout.rows} files of ${layout.tileWidth}×${layout.tileLength} blocks because a single 1.8 schematic can't hold ${Math.round(this.volume / 1e6).toLocaleString("en-US")} million blocks.`,
      );
    }
    this.output = new SchematicOutput(
      this.width,
      this.height,
      this.length,
      layout,
      tempDir,
      outputDir,
      this.baseName,
      options.compression,
      threads,
    );
    await this.output.begin();
    return this.output;
  }

  progress(phase: ProgressPhase, blocksDone: number, fraction?: number): void {
    const now = Date.now();
    if (now - this.lastProgress < 100) return;
    const elapsed = (now - this.lastTime) / 1000;
    if (elapsed > 0.05) {
      const instant = (blocksDone - this.lastBlocks) / elapsed;
      if (instant >= 0) this.rate = this.rate === 0 ? instant : this.rate * 0.7 + instant * 0.3;
      this.lastBlocks = blocksDone;
      this.lastTime = now;
    }
    this.lastProgress = now;
    this.request.onProgress?.({
      phase,
      fraction: Math.min(1, fraction ?? (this.volume > 0 ? blocksDone / this.volume : 0)),
      blocksDone,
      volume: this.volume,
      blocksPerSecond: this.rate,
    });
  }

  readingProgress(): void {
    const bytes = this.source?.bytesRead() ?? 0;
    this.progress("reading", 0, this.fileSize > 0 ? bytes / this.fileSize : 0);
  }

  target(): RunTarget {
    const output = this.output!;
    return { write: (ids, data, count) => output.writeRun(ids, data, count) };
  }

  decodeState(target: RunTarget) {
    return {
      palette: this.palette,
      specials: this.specials,
      target,
      invalid: 0,
      onProgress: (done: number) => this.progress("converting", done),
    };
  }

  positionOf(index: number): [number, number, number] {
    const y = Math.floor(index / (this.width * this.length));
    const rest = index - y * this.width * this.length;
    const z = Math.floor(rest / this.width);
    const x = rest - z * this.width;
    return [x, y, z];
  }

  // A block entity from the source, at a position within the output.
  async sourceTile(x: number, y: number, z: number, source: Compound): Promise<void> {
    if (!this.request.options.keepTileEntities) return;
    const index = (y * this.length + z) * this.width + x;
    if (x < 0 || y < 0 || z < 0 || x >= this.width || y >= this.height || z >= this.length) return;
    const block = this.specials.take(index);
    const resolved = block === undefined ? undefined : this.palette.resolved[block];
    if (!resolved) {
      this.recordOrphan(source);
      return;
    }
    await this.writeTile(x, y, z, source, resolved);
  }

  // A source block entity with nowhere to go, because of what its block turned into.
  recordOrphan(source: Compound | undefined): void {
    const name = asString(child(source, "id")) ?? asString(child(source, "Id")) ?? "block entity";
    if (isWorthReporting(name)) this.tileCtx.orphans.set(name, (this.tileCtx.orphans.get(name) ?? 0) + 1);
  }

  async writeTile(x: number, y: number, z: number, source: Compound | null, block: Resolved): Promise<void> {
    const output = await this.ensureOutput();
    const [originX, originZ] = output.tileOrigin(x, z);
    const tag = translateTile(source, block, x - originX, y, z - originZ, this.tileCtx);
    if (!tag) return;
    await output.writeTile(x, z, tag);
    this.tilesWritten += 1;
  }

  // Tile-bearing blocks the source had no data for, such as flower pots and note blocks
  // whose contents are part of the block state in modern versions.
  async writeRemainingTiles(): Promise<void> {
    if (!this.request.options.keepTileEntities) return;
    for (const [index, block] of this.specials.remaining()) {
      const resolved = this.palette.resolved[block];
      if (!resolved) continue;
      const [x, y, z] = this.positionOf(index);
      await this.writeTile(x, y, z, null, resolved);
    }
  }

  // WorldEdit stores entities in world coordinates while the Sponge spec and others use
  // coordinates relative to the schematic. Whichever puts it inside the box must be right.
  relativePosition(position: number[], min: readonly number[]): [number, number, number] {
    const [x, y, z] = position as [number, number, number];
    const inside = (a: number, b: number, c: number): boolean =>
      a >= 0 && b >= 0 && c >= 0 && a <= this.width && b <= this.height && c <= this.length;
    const shifted: [number, number, number] = [x - min[0]!, y - min[1]!, z - min[2]!];
    return inside(...shifted) || !inside(x, y, z) ? shifted : [x, y, z];
  }

  // An entity at `relative`, a position within the output. Absolute coordinates are what
  // WorldEdit expects next to a WEOrigin, so that's what gets stored.
  async writeEntity(source: Compound, relative: [number, number, number]): Promise<void> {
    if (!this.request.options.keepEntities) return;
    const output = await this.ensureOutput();
    const absolute: [number, number, number] = [
      relative[0] + this.origin.originX,
      relative[1] + this.origin.originY,
      relative[2] + this.origin.originZ,
    ];
    const tag = translateEntity(source, absolute, {
      resolver: this.resolver,
      dropped: this.tileCtx.dropped,
      droppedEntities: this.droppedEntities,
    });
    if (!tag) return;
    await output.writeEntity(relative[0], relative[2], tag);
    this.entitiesWritten += 1;
  }

  async finish(info: FileInfo, startedAt: number): Promise<ConvertReport> {
    const output = await this.ensureOutput();
    if (output.written !== this.volume) {
      throw new Error(`The file ended early: found ${output.written} of ${this.volume} blocks`);
    }
    this.request.onProgress?.({
      phase: "finishing",
      fraction: 0,
      blocksDone: this.volume,
      volume: this.volume,
      blocksPerSecond: 0,
    });
    const outputs = await output.finish(this.origin, (index, total) => {
      this.request.onProgress?.({
        phase: "finishing",
        fraction: index / total,
        blocksDone: this.volume,
        volume: this.volume,
        blocksPerSecond: 0,
      });
    });

    // Indices that had no palette entry were written as air, which is worth owning up to.
    for (let index = 0; index < this.palette.counts.length; index++) {
      const count = this.palette.counts[index]!;
      if (count > 0 && !this.palette.resolved[index]) this.invalid += count;
    }

    const records = collectBlockRecords(this.palette);
    const blocks: BlockReportRow[] = records.map((record) => ({
      ...record,
      target: displayName18(record.id, record.data),
    }));

    const warn = (message: string, entries: Map<string, number>, limit = 6): void => {
      if (entries.size === 0) return;
      const total = [...entries.values()].reduce((sum, value) => sum + value, 0);
      const top = [...entries.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([name, count]) => `${name.replace("minecraft:", "")} ×${count}`)
        .join(", ");
      const more = entries.size > limit ? `, and ${entries.size - limit} more` : "";
      this.warnings.push(`${message} (${total.toLocaleString("en-US")}): ${top}${more}.`);
    };
    warn("Block entities with no 1.8 equivalent were dropped", this.tileCtx.orphans);
    warn("Items with no 1.8 equivalent were removed", this.tileCtx.dropped);
    warn("Entities with no 1.8 equivalent were dropped", this.droppedEntities);
    if (this.invalid > 0) {
      this.warnings.push(
        `${this.invalid.toLocaleString("en-US")} blocks pointed outside the palette and were written as air. The source file may be damaged.`,
      );
    }
    const unmapped = blocks.filter((row) => row.kind === "unmapped");
    if (unmapped.length > 0) {
      const names = unmapped.slice(0, 6).map((row) => row.name).join(", ");
      const more = unmapped.length > 6 ? `, and ${unmapped.length - 6} more` : "";
      const types = unmapped.length === 1 ? "1 unknown block type" : `${unmapped.length} unknown block types`;
      this.warnings.push(`${types} used the fallback block: ${names}${more}.`);
    }

    return {
      info,
      outputs,
      blocks,
      warnings: this.warnings,
      durationMs: Date.now() - startedAt,
      nonAirBlocks: blocks.reduce((sum, row) => (row.id === 0 ? sum : sum + row.count), 0),
      tileEntitiesWritten: this.tilesWritten,
      entitiesWritten: this.entitiesWritten,
      split: outputs.length > 1,
    };
  }
}

// Minecraft 26.4 renamed these keys to lowercase, so both spellings are out there. An entry
// that has neither goes through as an unknown block, which gets reported, rather than
// quietly becoming air.
function stateFromCompound(entry: Compound | undefined): string {
  const name = asString(child(entry, "Name")) ?? asString(child(entry, "id"));
  if (!name) return "unknown:malformed_palette_entry";
  const properties = asCompound(child(entry, "Properties")) ?? asCompound(child(entry, "properties"));
  if (!properties || properties.size === 0) return name;
  const parts: string[] = [];
  for (const [key, value] of properties) parts.push(`${key}=${asString(value) ?? asNumber(value) ?? ""}`);
  return `${name}[${parts.join(",")}]`;
}

// ---- Sponge .schem, versions 1 to 3

async function convertSponge(job: Job): Promise<void> {
  let width: number | undefined;
  let height: number | undefined;
  let length: number | undefined;
  let offset: [number, number, number] | undefined;
  let version = 2;
  const weOffset: [number?, number?, number?] = [];
  let weOrigin: [number, number, number] | undefined;
  let paletteLoaded = false;
  let dataDone = false;
  let tilesDone = false;
  let entitiesDone = false;
  let tilesSeen = false;
  let entitiesSeen = false;
  let versionSeen = false;
  let metadataSeen = false;

  const applyOrigin = (): [number, number, number] => {
    const own = offset ?? [0, 0, 0];
    if (version >= 3) {
      const origin = weOrigin ?? [0, 0, 0];
      const min: [number, number, number] = [origin[0] + own[0], origin[1] + own[1], origin[2] + own[2]];
      job.origin = {
        originX: min[0],
        originY: min[1],
        originZ: min[2],
        offsetX: own[0],
        offsetY: own[1],
        offsetZ: own[2],
      };
      return min;
    }
    job.origin = {
      originX: own[0],
      originY: own[1],
      originZ: own[2],
      offsetX: weOffset[0] ?? 0,
      offsetY: weOffset[1] ?? 0,
      offsetZ: weOffset[2] ?? 0,
    };
    return own;
  };

  const number = (use: (value: number) => void): WalkAction => ({
    kind: "value",
    use: (tag) => {
      const value = asNumber(tag);
      if (value !== undefined) use(value);
    },
  });

  const canPlaceEntities = (pass: number): boolean =>
    pass > 0 ||
    (width !== undefined &&
      height !== undefined &&
      length !== undefined &&
      offset !== undefined &&
      versionSeen &&
      (version < 3 || metadataSeen));

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const source = await job.open();
    let tilesThisPass = false;
    let entitiesThisPass = false;
    try {
      await walk(source.reader, (rawPath, type) => {
        const path = rawPath.startsWith("/Schematic") ? rawPath.slice(10) : rawPath;
        switch (path) {
          case "":
            return type === TAG.Compound ? ENTER : SKIP;
          case "/Width":
            return pass === 0 ? number((value) => (width = value & 0xffff)) : SKIP;
          case "/Height":
            return pass === 0 ? number((value) => (height = value & 0xffff)) : SKIP;
          case "/Length":
            return pass === 0 ? number((value) => (length = value & 0xffff)) : SKIP;
          case "/Version":
            return pass === 0
              ? number((value) => {
                  version = value;
                  versionSeen = true;
                })
              : SKIP;
          case "/Offset":
            return pass === 0
              ? { kind: "value", use: (tag) => void (offset = asTriple(tag)) }
              : SKIP;
          case "/Metadata":
            metadataSeen = true;
            return pass === 0 ? ENTER : SKIP;
          case "/Metadata/WorldEdit":
            return pass === 0 ? ENTER : SKIP;
          case "/Metadata/WEOffsetX":
            return number((value) => (weOffset[0] = value));
          case "/Metadata/WEOffsetY":
            return number((value) => (weOffset[1] = value));
          case "/Metadata/WEOffsetZ":
            return number((value) => (weOffset[2] = value));
          case "/Metadata/WorldEdit/Origin":
            return { kind: "value", use: (tag) => void (weOrigin = asTriple(tag)) };
          case "/Blocks":
            return type === TAG.Compound ? ENTER : SKIP;
          case "/Palette":
          case "/Blocks/Palette":
            if (paletteLoaded) return SKIP;
            return {
              kind: "value",
              use: (tag) => {
                const entries = asCompound(tag);
                if (!entries) throw new Error("The schematic's palette is malformed");
                let max = 0;
                for (const value of entries.values()) max = Math.max(max, asNumber(value) ?? 0);
                job.palette.ensure(max + 1);
                for (const [state, value] of entries) {
                  const index = asNumber(value);
                  if (index !== undefined) job.palette.set(index, job.resolver.resolveState(state));
                }
                if (!job.request.options.keepTileEntities) job.palette.special.fill(0);
                paletteLoaded = true;
              },
            };
          case "/BlockData":
          case "/Blocks/Data":
            if (dataDone) return SKIP;
            if (!paletteLoaded || width === undefined || height === undefined || length === undefined) {
              return SKIP;
            }
            return {
              kind: "array",
              use: async (reader, byteLength) => {
                job.setDimensions(width!, height!, length!);
                await job.ensureOutput();
                const state = job.decodeState(job.target());
                await decodeVarints(reader, byteLength, job.volume, state);
                job.invalid += state.invalid;
                job.specials.finalize();
                dataDone = true;
              },
            };
          case "/BlockEntities":
          case "/TileEntities":
          case "/Blocks/BlockEntities":
            if (tilesDone) return SKIP;
            tilesSeen = true;
            if (!dataDone) return SKIP;
            tilesThisPass = true;
            return {
              kind: "each",
              use: async (element) => {
                const entry = asCompound(element);
                const position = asTriple(child(entry, "Pos"));
                if (!entry || !position) return;
                // Version 3 nests the block entity's own tags under Data.
                const data = asCompound(child(entry, "Data"));
                const tile = data ?? entry;
                if (data && !tile.has("id")) {
                  const id = child(entry, "Id");
                  if (id) tile.set("id", id);
                }
                await job.sourceTile(position[0], position[1], position[2], tile);
              },
            };
          case "/Entities":
            if (entitiesDone) return SKIP;
            entitiesSeen = true;
            if (!canPlaceEntities(pass)) return SKIP;
            entitiesThisPass = true;
            return {
              kind: "each",
              use: async (element) => {
                const entry = asCompound(element);
                const data = asCompound(child(entry, "Data")) ?? entry;
                const position = asList(child(entry, "Pos"))?.map((value) => asNumber(value) ?? 0);
                if (!entry || !data || !position || position.length < 3) return;
                job.setDimensions(width!, height!, length!);
                const min = applyOrigin();
                const relative = job.relativePosition(position, min);
                const copy = new Map(data);
                if (!copy.has("id")) {
                  const id = child(entry, "Id");
                  if (id) copy.set("id", id);
                }
                if (!copy.has("Pos")) copy.set("Pos", child(entry, "Pos")!);
                await job.writeEntity(copy, relative);
              },
            };
          case "/DataVersion":
            return SKIP;
          default:
            return SKIP;
        }
      });
    } finally {
      source.close();
    }
    if (tilesThisPass) tilesDone = true;
    if (entitiesThisPass) entitiesDone = true;
    if (dataDone && (tilesDone || !tilesSeen) && (entitiesDone || !entitiesSeen)) break;
    if (!dataDone && pass > 0 && !paletteLoaded) break;
  }

  if (!paletteLoaded) throw new Error("This schematic has no block palette");
  if (!dataDone) throw new Error("This schematic has no block data");
  applyOrigin();
  await job.writeRemainingTiles();
}

// ---- Litematica

interface Region {
  name: string;
  position?: [number, number, number];
  size?: [number, number, number];
  paletteBase: number;
  paletteSize: number;
  paletteLoaded: boolean;
  dataDone: boolean;
  tilesDone: boolean;
  entitiesDone: boolean;
  hasTiles: boolean;
  hasEntities: boolean;
}

const xyz = (tag: NbtTag | undefined): [number, number, number] | undefined => {
  const compound = asCompound(tag);
  const x = asNumber(child(compound, "x"));
  const y = asNumber(child(compound, "y"));
  const z = asNumber(child(compound, "z"));
  return x === undefined || y === undefined || z === undefined ? undefined : [x, y, z];
};

const regionMin = (region: Region, axis: 0 | 1 | 2): number => {
  const size = region.size![axis];
  const position = region.position![axis];
  return size < 0 ? position + size + 1 : position;
};

async function convertLitematic(job: Job, info: FileInfo): Promise<void> {
  const regions = new Map<string, Region>();
  let paletteEnd = 0;
  let directRegion: Region | null = null;
  let boundsReady = false;
  let minX = 0;
  let minY = 0;
  let minZ = 0;
  let canvas: BlockCanvas | null = null;
  const singleRegion = info.regionCount === 1;

  const regionOf = (name: string): Region => {
    let region = regions.get(name);
    if (!region) {
      if (singleRegion && regions.size > 0) throw new Error("This litematic has more regions than its metadata says");
      region = {
        name,
        paletteBase: 0,
        paletteSize: 0,
        paletteLoaded: false,
        dataDone: false,
        tilesDone: false,
        entitiesDone: false,
        hasTiles: false,
        hasEntities: false,
      };
      regions.set(name, region);
    }
    return region;
  };

  const computeBounds = (): void => {
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    minX = Infinity;
    minY = Infinity;
    minZ = Infinity;
    for (const region of regions.values()) {
      if (!region.position || !region.size) throw new Error(`Region "${region.name}" has no size`);
      const [sx, sy, sz] = region.size;
      const x = regionMin(region, 0);
      const y = regionMin(region, 1);
      const z = regionMin(region, 2);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x + Math.abs(sx));
      maxY = Math.max(maxY, y + Math.abs(sy));
      maxZ = Math.max(maxZ, z + Math.abs(sz));
    }
    job.setDimensions(maxX - minX, maxY - minY, maxZ - minZ);
    boundsReady = true;
  };

  const allData = (): boolean => [...regions.values()].every((region) => region.dataDone);

  const decodeRegion = async (region: Region, reader: NbtReader, longs: number): Promise<void> => {
    const [sx, sy, sz] = region.size!.map(Math.abs) as [number, number, number];
    const entries = sx * sy * sz;
    const bits = Math.max(2, Math.ceil(Math.log2(Math.max(2, region.paletteSize))));
    await job.ensureOutput();
    const base = region.paletteBase;

    let target: RunTarget;
    let specials = job.specials as Pick<SpecialIndex, "push">;
    if (directRegion === region) {
      target = job.target();
    } else {
      if (!canvas) {
        canvas = new BlockCanvas(job.volume, join(job.request.tempDir, "canvas.bin"));
      }
      const active = canvas;
      const dx = regionMin(region, 0) - minX;
      const dy = regionMin(region, 1) - minY;
      const dz = regionMin(region, 2) - minZ;
      let x = 0;
      let y = 0;
      let z = 0;
      target = {
        write: async (ids, data, count) => {
          for (let i = 0; i < count; i++) {
            if (ids[i] !== 0) {
              active.set(((y + dy) * job.length + (z + dz)) * job.width + x + dx, ids[i]!, data[i]!);
            }
            x += 1;
            if (x === sx) {
              x = 0;
              z += 1;
              if (z === sz) {
                z = 0;
                y += 1;
              }
            }
          }
        },
      };
      specials = {
        push: (position, block) => {
          const ry = Math.floor(position / (sx * sz));
          const rest = position - ry * sx * sz;
          const rz = Math.floor(rest / sx);
          const rx = rest - rz * sx;
          job.specials.push(((ry + dy) * job.length + (rz + dz)) * job.width + rx + dx, block);
        },
      };
    }

    const state = {
      ...job.decodeState(target),
      specials,
      paletteBase: base,
      paletteCount: region.paletteSize,
    };
    await decodePacked(reader, longs, bits, entries, state);
    job.invalid += state.invalid;
    region.dataDone = true;
    if (allData()) job.specials.finalize();
  };

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const source = await job.open();
    try {
      await walk(source.reader, (path) => {
        if (pass === 0) job.readingProgress();
        if (path === "/Regions") return ENTER;
        if (!path.startsWith("/Regions/")) return SKIP;
        const parts = path.slice(9).split("/");
        const region = regionOf(parts[0]!);
        if (parts.length === 1) return ENTER;
        switch (parts[1]) {
          case "Position":
            return { kind: "value", use: (tag) => void (region.position = xyz(tag)) };
          case "Size":
            return { kind: "value", use: (tag) => void (region.size = xyz(tag)) };
          case "BlockStatePalette":
            if (region.paletteLoaded) return SKIP;
            return {
              kind: "value",
              use: (tag) => {
                const entries = asList(tag) ?? [];
                region.paletteBase = paletteEnd;
                region.paletteSize = entries.length;
                job.palette.ensure(paletteEnd + entries.length);
                for (const [index, entry] of entries.entries()) {
                  const state = stateFromCompound(asCompound(entry));
                  job.palette.set(region.paletteBase + index, job.resolver.resolveState(state));
                }
                if (!job.request.options.keepTileEntities) job.palette.special.fill(0);
                paletteEnd += entries.length;
                region.paletteLoaded = true;
              },
            };
          case "BlockStates": {
            if (region.dataDone) return SKIP;
            if (!region.paletteLoaded || !region.size || !region.position) return SKIP;
            if (!boundsReady) {
              if (!singleRegion) return SKIP;
              computeBounds();
              directRegion = region;
            }
            return {
              kind: "array",
              use: (reader, longs) => decodeRegion(region, reader, longs),
            };
          }
          case "TileEntities":
            region.hasTiles = true;
            if (region.tilesDone || !boundsReady || !allData()) return SKIP;
            region.tilesDone = true;
            return {
              kind: "each",
              use: async (element) => {
                const entry = asCompound(element);
                const x = asNumber(child(entry, "x"));
                const y = asNumber(child(entry, "y"));
                const z = asNumber(child(entry, "z"));
                if (!entry || x === undefined || y === undefined || z === undefined) return;
                await job.sourceTile(
                  x + regionMin(region, 0) - minX,
                  y + regionMin(region, 1) - minY,
                  z + regionMin(region, 2) - minZ,
                  entry,
                );
              },
            };
          case "Entities":
            region.hasEntities = true;
            if (region.entitiesDone || !boundsReady) return SKIP;
            region.entitiesDone = true;
            return {
              kind: "each",
              use: async (element) => {
                const entry = asCompound(element);
                const position = asList(child(entry, "Pos"))?.map((value) => asNumber(value) ?? 0);
                if (!entry || !position || position.length < 3) return;
                await job.writeEntity(entry, [
                  position[0]! + region.position![0] - minX,
                  position[1]! + region.position![1] - minY,
                  position[2]! + region.position![2] - minZ,
                ]);
              },
            };
          default:
            return SKIP;
        }
      });
    } finally {
      source.close();
    }

    if (regions.size === 0) throw new Error("This litematic has no regions");
    if (!boundsReady) computeBounds();
    const pendingLists = [...regions.values()].some(
      (region) => (region.hasTiles && !region.tilesDone) || (region.hasEntities && !region.entitiesDone),
    );
    if (allData() && !pendingLists) break;
  }

  if (!allData()) throw new Error("This litematic is missing block data for a region");

  if (canvas) {
    const active = canvas as BlockCanvas;
    await active.drain(async (ids, data, count) => {
      await job.output!.writeRun(ids, data, count);
      job.progress("writing", job.output!.written);
    });
  }
  await job.writeRemainingTiles();
}

// ---- Vanilla structure files

async function convertStructure(job: Job): Promise<void> {
  let size: [number, number, number] | undefined;
  let paletteLoaded = false;
  let blocksDone = false;
  let entitiesDone = false;
  let hasEntities = false;
  let canvas: BlockCanvas | null = null;

  const setup = async (): Promise<BlockCanvas> => {
    if (canvas) return canvas;
    job.setDimensions(size![0], size![1], size![2]);
    await job.ensureOutput();
    canvas = new BlockCanvas(job.volume, join(job.request.tempDir, "canvas.bin"));
    return canvas;
  };

  const loadPalette = (entries: NbtTag[] | undefined): void => {
    job.palette.ensure(entries?.length ?? 0);
    for (const [index, entry] of (entries ?? []).entries()) {
      const state = stateFromCompound(asCompound(entry));
      job.palette.set(index, job.resolver.resolveState(state));
    }
    paletteLoaded = true;
  };

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const source = await job.open();
    let blocksThisPass = false;
    let entitiesThisPass = false;
    try {
      await walk(source.reader, (path) => {
        job.readingProgress();
        switch (path) {
          case "/size":
            return { kind: "value", use: (tag) => void (size = asTriple(tag)) };
          case "/palette":
            if (paletteLoaded) return SKIP;
            return { kind: "value", use: (tag) => loadPalette(asList(tag)) };
          case "/palettes":
            if (paletteLoaded) return SKIP;
            return { kind: "value", use: (tag) => loadPalette(asList(asList(tag)?.[0])) };
          case "/blocks":
            if (blocksDone || !paletteLoaded || !size) return SKIP;
            blocksThisPass = true;
            return {
              kind: "each",
              use: async (element) => {
                const target = await setup();
                job.readingProgress();
                const entry = asCompound(element);
                const state = asNumber(child(entry, "state"));
                const position = asTriple(child(entry, "pos"));
                if (state === undefined || !position) return;
                const [x, y, z] = position;
                if (x < 0 || y < 0 || z < 0 || x >= job.width || y >= job.height || z >= job.length) return;
                const block = job.palette.resolved[state];
                if (!block) {
                  job.invalid += 1;
                  return;
                }
                job.palette.counts[state]! += 1;
                target.set((y * job.length + z) * job.width + x, block.id, block.data);
                if (job.palette.special[state] === 1 && job.request.options.keepTileEntities) {
                  await job.writeTile(x, y, z, asCompound(child(entry, "nbt")) ?? null, block);
                } else if (entry?.has("nbt") && job.request.options.keepTileEntities) {
                  job.recordOrphan(asCompound(child(entry, "nbt")));
                }
              },
            };
          case "/entities":
            hasEntities = true;
            if (entitiesDone || !size) return SKIP;
            entitiesThisPass = true;
            return {
              kind: "each",
              use: async (element) => {
                await setup();
                const entry = asCompound(element);
                const position = asList(child(entry, "pos"))?.map((value) => asNumber(value) ?? 0);
                const data = asCompound(child(entry, "nbt"));
                if (!data || !position || position.length < 3) return;
                await job.writeEntity(data, [position[0]!, position[1]!, position[2]!]);
              },
            };
          default:
            return SKIP;
        }
      });
    } finally {
      source.close();
    }
    if (!size) throw new Error("This structure file has no size");
    if (blocksThisPass) blocksDone = true;
    if (entitiesThisPass) entitiesDone = true;
    if (blocksDone && (entitiesDone || !hasEntities)) break;
  }

  if (!blocksDone) throw new Error("This structure file has no blocks or palette");
  const finished = await setup();
  await finished.drain(async (ids, data, count) => {
    await job.output!.writeRun(ids, data, count);
    job.progress("writing", job.output!.written);
  });
}

// ---- Pre-1.13 .schematic, which may still hold blocks newer than 1.8

async function convertLegacy(job: Job): Promise<void> {
  const { tempDir } = job.request;
  await mkdir(tempDir, { recursive: true });
  let width: number | undefined;
  let height: number | undefined;
  let length: number | undefined;
  const origin: Partial<Record<keyof WorldEditOrigin, number>> = {};
  const spills = new Map<string, string>();
  let hasTiles = false;
  let hasEntities = false;

  const number = (use: (value: number) => void): WalkAction => ({
    kind: "value",
    use: (tag) => {
      const value = asNumber(tag);
      if (value !== undefined) use(value);
    },
  });

  // The arrays can come in any order and depend on each other, so copy them out first.
  const spill = (name: string): WalkAction => ({
    kind: "array",
    use: async (reader, byteLength) => {
      const path = join(tempDir, `${name}.raw`);
      const out = createWriteStream(path, { highWaterMark: CHUNK_SIZE });
      let remaining = byteLength;
      while (remaining > 0) {
        if (reader.end === reader.pos) await reader.ensure(1);
        const take = Math.min(remaining, reader.end - reader.pos);
        const chunk = Buffer.from(reader.buf.subarray(reader.pos, reader.pos + take));
        reader.pos += take;
        remaining -= take;
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
        job.readingProgress();
      }
      await new Promise<void>((resolve, reject) => {
        out.once("error", reject);
        out.end(resolve);
      });
      spills.set(name, path);
    },
  });

  const first = await job.open();
  try {
    await walk(first.reader, (rawPath, type) => {
      const path = rawPath.startsWith("/Schematic") ? rawPath.slice(10) : rawPath;
      switch (path) {
        case "":
          return type === TAG.Compound ? ENTER : SKIP;
        case "/Width":
          return number((value) => (width = value & 0xffff));
        case "/Height":
          return number((value) => (height = value & 0xffff));
        case "/Length":
          return number((value) => (length = value & 0xffff));
        case "/WEOriginX":
          return number((value) => (origin.originX = value));
        case "/WEOriginY":
          return number((value) => (origin.originY = value));
        case "/WEOriginZ":
          return number((value) => (origin.originZ = value));
        case "/WEOffsetX":
          return number((value) => (origin.offsetX = value));
        case "/WEOffsetY":
          return number((value) => (origin.offsetY = value));
        case "/WEOffsetZ":
          return number((value) => (origin.offsetZ = value));
        case "/Blocks":
          return spill("Blocks");
        case "/Data":
          return spill("Data");
        case "/AddBlocks":
          return spill("AddBlocks");
        case "/TileEntities":
          hasTiles = true;
          return SKIP;
        case "/Entities":
          hasEntities = true;
          return SKIP;
        default:
          return SKIP;
      }
    });
  } finally {
    first.close();
  }

  if (width === undefined || height === undefined || length === undefined) {
    throw new Error("This schematic is missing its size");
  }
  const blocksPath = spills.get("Blocks");
  const dataPath = spills.get("Data");
  if (!blocksPath || !dataPath) throw new Error("This schematic has no block data");

  job.setDimensions(width, height, length);
  job.origin = { ...job.origin, ...origin } as WorldEditOrigin;
  const output = await job.ensureOutput();

  const palette = job.palette;
  palette.ensure(65536);
  const known = new Uint8Array(65536);
  const keepTiles = job.request.options.keepTileEntities;

  const inBlocks = await open(blocksPath, "r");
  const inData = await open(dataPath, "r");
  const addPath = spills.get("AddBlocks");
  const inAdd = addPath ? await open(addPath, "r") : null;
  try {
    const blockChunk = Buffer.allocUnsafe(CHUNK_SIZE);
    const dataChunk = Buffer.allocUnsafe(CHUNK_SIZE);
    const addChunk = Buffer.alloc(CHUNK_SIZE / 2 + 1);
    const ids = new Uint8Array(CHUNK_SIZE);
    const data = new Uint8Array(CHUNK_SIZE);
    let index = 0;
    while (index < job.volume) {
      const want = Math.min(CHUNK_SIZE, job.volume - index);
      const { bytesRead } = await inBlocks.read(blockChunk, 0, want, null);
      if (bytesRead === 0) break;
      const dataRead = (await inData.read(dataChunk, 0, bytesRead, index)).bytesRead;
      if (dataRead < bytesRead) dataChunk.fill(0, dataRead, bytesRead);
      if (inAdd) {
        addChunk.fill(0);
        await inAdd.read(addChunk, 0, (bytesRead >> 1) + 1, Math.floor(index / 2));
      }
      const addBase = Math.floor(index / 2);
      for (let i = 0; i < bytesRead; i++) {
        let id = blockChunk[i]!;
        if (inAdd) {
          const absolute = index + i;
          const nibble = addChunk[(absolute >> 1) - addBase]!;
          id |= (absolute & 1) === 0 ? (nibble & 0x0f) << 8 : (nibble & 0xf0) << 4;
        }
        const key = (id << 4) | (dataChunk[i]! & 15);
        if (known[key] === 0) {
          palette.set(key, job.resolver.resolveLegacy(id, key & 15));
          if (!keepTiles) palette.special[key] = 0;
          known[key] = 1;
        }
        ids[i] = palette.ids[key]!;
        data[i] = palette.data[key]!;
        palette.counts[key]! += 1;
        if (palette.special[key] === 1) job.specials.push(index + i, key);
      }
      await output.writeRun(ids, data, bytesRead);
      index += bytesRead;
      job.progress("converting", index);
    }
    if (index !== job.volume) throw new Error(`The file ended early: found ${index} of ${job.volume} blocks`);
  } finally {
    await inBlocks.close();
    await inData.close();
    await inAdd?.close();
  }
  for (const path of spills.values()) await rm(path, { force: true });
  job.specials.finalize();

  if (hasTiles || hasEntities) {
    const second = await job.open();
    const originX = job.origin.originX;
    const originY = job.origin.originY;
    const originZ = job.origin.originZ;
    try {
      await walk(second.reader, (rawPath, type) => {
        const path = rawPath.startsWith("/Schematic") ? rawPath.slice(10) : rawPath;
        if (path === "") return type === TAG.Compound ? ENTER : SKIP;
        if (path === "/TileEntities") {
          return {
            kind: "each",
            use: async (element) => {
              const entry = asCompound(element);
              const x = asNumber(child(entry, "x"));
              const y = asNumber(child(entry, "y"));
              const z = asNumber(child(entry, "z"));
              if (!entry || x === undefined || y === undefined || z === undefined) return;
              await job.sourceTile(x, y, z, entry);
            },
          };
        }
        if (path === "/Entities") {
          return {
            kind: "each",
            use: async (element) => {
              const entry = asCompound(element);
              const position = asList(child(entry, "Pos"))?.map((value) => asNumber(value) ?? 0);
              if (!entry || !position || position.length < 3) return;
              await job.writeEntity(entry, job.relativePosition(position, [originX, originY, originZ]));
            },
          };
        }
        return SKIP;
      });
    } finally {
      second.close();
    }
  }
  await job.writeRemainingTiles();
}

// Turns low-level failures into something a person can act on.
function friendlyError(error: unknown): Error {
  const failure = error as NodeJS.ErrnoException;
  const code = failure?.code ?? "";
  if (code.startsWith("Z_") || code === "ERR_ZLIB_INPUT_ERROR") {
    return new Error("This file is damaged: its compressed data can't be read. Try exporting it again.");
  }
  if (code === "ENOSPC") return new Error("There isn't enough free disk space in the output folder for this map.");
  if (code === "EACCES" || code === "EPERM") {
    return new Error(`Couldn't access ${failure.path ?? "a file"}. Check it isn't open elsewhere and that the output folder is writable.`);
  }
  if (code === "ENOENT") return new Error(`Couldn't find ${failure.path ?? "the file"}.`);
  return error instanceof Error ? error : new Error(String(error));
}

export async function convertFile(request: ConvertRequest): Promise<ConvertReport> {
  try {
    return await runConversion(request);
  } catch (error) {
    throw friendlyError(error);
  }
}

async function runConversion(request: ConvertRequest): Promise<ConvertReport> {
  const startedAt = Date.now();
  const info = await inspectFile(request.input);
  const job = new Job(request);
  await job.prepare(info.fileSize);
  try {
    switch (info.format) {
      case "sponge":
        await convertSponge(job);
        break;
      case "litematic":
        await convertLitematic(job, info);
        break;
      case "structure":
        await convertStructure(job);
        break;
      case "legacy":
        await convertLegacy(job);
        break;
    }
    const actual: FileInfo = { ...info, width: job.width, height: job.height, length: job.length, volume: job.volume };
    return await job.finish(actual, startedAt);
  } finally {
    await rm(request.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

