import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";
import prismarine from "prismarine-nbt";
import { convertFile } from "../src/engine/convert";
import { NbtEncoder, type NbtTag, nbt, TAG } from "../src/engine/nbt/nbt";
import {
  type ConvertOptions,
  type ConvertReport,
  DEFAULT_OPTIONS,
} from "../src/shared/types";

export const compound = (entries: Record<string, NbtTag> = {}): NbtTag =>
  nbt.compound(new Map(Object.entries(entries)));
export const ints = (...values: number[]): NbtTag => ({
  t: 11,
  v: Int32Array.from(values),
});
export const list = (et: number, ...values: NbtTag[]): NbtTag =>
  nbt.list(et, values);
export const doubles = (...values: number[]): NbtTag =>
  nbt.list(TAG.Double, values.map(nbt.double));
export const bytes = (values: ArrayLike<number>): NbtTag => ({
  t: 7,
  v: Int8Array.from(values as number[]),
});
export const longs = (values: bigint[]): NbtTag => ({
  t: 12,
  v: BigInt64Array.from(values),
});

export function encodeFile(root: NbtTag, rootName = "", gzip = true): Buffer {
  const encoder = new NbtEncoder();
  encoder.named(rootName, root);
  const raw = Buffer.from(encoder.bytes());
  return gzip ? zlib.gzipSync(raw) : raw;
}

export function varints(values: number[]): NbtTag {
  const out: number[] = [];
  for (let value of values) {
    while (value > 127) {
      out.push((value & 127) | 128);
      value >>>= 7;
    }
    out.push(value);
  }
  return bytes(out.map((byte) => (byte > 127 ? byte - 256 : byte)));
}

// Litematica's packing, written the slow and obvious way so it can check the fast decoder.
export function packLitematic(values: number[], bits: number): bigint[] {
  const total = Math.ceil((values.length * bits) / 64);
  const out = new Array<bigint>(total).fill(0n);
  const mask = (1n << BigInt(bits)) - 1n;
  values.forEach((value, index) => {
    const start = index * bits;
    const word = start >> 6;
    const shift = BigInt(start & 63);
    out[word]! |= (BigInt(value) & mask) << shift;
    const overflow = Number(shift) + bits - 64;
    if (overflow > 0) {
      out[word + 1]! |=
        (BigInt(value) & mask) >> (BigInt(bits) - BigInt(overflow));
    }
  });
  return out.map((value) => BigInt.asIntN(64, value));
}

export interface Workspace {
  cleanup(): void;
  dir: string;
  outDir: string;
  write(name: string, data: Buffer): string;
}

export function workspace(): Workspace {
  const root = join(process.cwd(), "test/.tmp");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "t-"));
  const outDir = join(dir, "out");
  mkdirSync(outDir);
  return {
    dir,
    outDir,
    write(name, data) {
      const path = join(dir, name);
      writeFileSync(path, data);
      return path;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function convert(
  ws: Workspace,
  input: string,
  options: Partial<ConvertOptions> = {}
): Promise<ConvertReport> {
  return convertFile({
    input,
    outputDir: ws.outDir,
    tempDir: join(ws.dir, "tmp"),
    threads: 4,
    options: { ...DEFAULT_OPTIONS, overwrite: true, ...options },
  });
}

export interface Schematic {
  at(x: number, y: number, z: number): [number, number];
  entities: Record<string, unknown>[];
  height: number;
  length: number;
  raw: Record<string, unknown>;
  tiles: Record<string, unknown>[];
  width: number;
}

// Reads a converted file with an independent gzip and NBT implementation, so a bug in the
// engine's own NBT code can't hide itself.
export async function readSchematic(path: string): Promise<Schematic> {
  const inflated = zlib.gunzipSync(readFileSync(path));
  const parsed = await prismarine.parseAs(inflated, "big");
  // The typings describe parse(); parseAs actually returns the tree under `data`.
  const tree = (parsed as unknown as { data: prismarine.NBT }).data;
  const raw = prismarine.simplify(tree) as unknown as Record<string, unknown>;
  const width = raw.Width as number;
  const height = raw.Height as number;
  const length = raw.Length as number;
  const blocks = raw.Blocks as number[];
  const data = raw.Data as number[];
  return {
    raw,
    width,
    height,
    length,
    at(x, y, z) {
      const index = (y * length + z) * width + x;
      return [blocks[index]! & 0xff, data[index]! & 0xff];
    },
    tiles: raw.TileEntities as Record<string, unknown>[],
    entities: raw.Entities as Record<string, unknown>[],
  };
}

export const outputs = (ws: Workspace): string[] =>
  readdirSync(ws.outDir).sort();
