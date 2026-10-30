// Streaming NBT. Block arrays can be gigabytes, so nothing here ever needs a whole
// file in memory: the walker hands big arrays to the caller a chunk at a time and
// only materialises the small values it is explicitly asked for.

export const TAG = {
  Byte: 1,
  ByteArray: 7,
  Compound: 10,
  Double: 6,
  End: 0,
  Float: 5,
  Int: 3,
  IntArray: 11,
  List: 9,
  Long: 4,
  LongArray: 12,
  Short: 2,
  String: 8,
} as const;

export type Compound = Map<string, NbtTag>;

export type NbtTag =
  | { t: 1 | 2 | 3 | 5 | 6; v: number }
  | { t: 4; v: bigint }
  | { t: 7; v: Int8Array }
  | { t: 8; v: string }
  | { t: 9; et: number; v: NbtTag[] }
  | { t: 10; v: Compound }
  | { t: 11; v: Int32Array }
  | { t: 12; v: BigInt64Array };

export const nbt = {
  byte: (v: number): NbtTag => ({ t: 1, v }),
  compound: (v: Compound = new Map()): NbtTag => ({ t: 10, v }),
  double: (v: number): NbtTag => ({ t: 6, v }),
  float: (v: number): NbtTag => ({ t: 5, v }),
  int: (v: number): NbtTag => ({ t: 3, v }),
  list: (et: number, v: NbtTag[]): NbtTag => ({ et, t: 9, v }),
  long: (v: bigint): NbtTag => ({ t: 4, v }),
  short: (v: number): NbtTag => ({ t: 2, v }),
  string: (v: string): NbtTag => ({ t: 8, v }),
};

export const child = (
  c: Compound | undefined,
  key: string
): NbtTag | undefined => c?.get(key);

export function asNumber(tag: NbtTag | undefined): number | undefined {
  if (!tag) {
    return undefined;
  }
  if (tag.t === 1 || tag.t === 2 || tag.t === 3 || tag.t === 5 || tag.t === 6) {
    return tag.v;
  }
  if (tag.t === 4) {
    return Number(tag.v);
  }
  return undefined;
}

export const asString = (tag: NbtTag | undefined): string | undefined =>
  tag?.t === 8 ? tag.v : undefined;

export const asCompound = (tag: NbtTag | undefined): Compound | undefined =>
  tag?.t === 10 ? tag.v : undefined;

export const asList = (tag: NbtTag | undefined): NbtTag[] | undefined =>
  tag?.t === 9 ? tag.v : undefined;

// [x, y, z] from an int array or a list of numbers, the two shapes positions come in.
export function asTriple(
  tag: NbtTag | undefined
): [number, number, number] | undefined {
  if (tag?.t === 11 && tag.v.length >= 3) {
    return [tag.v[0]!, tag.v[1]!, tag.v[2]!];
  }
  if (tag?.t === 9 && tag.v.length >= 3) {
    const [x, y, z] = tag.v.map((item) => asNumber(item));
    if (x !== undefined && y !== undefined && z !== undefined) {
      return [x, y, z];
    }
  }
  return undefined;
}

// Thrown (as a singleton, so it stays cheap) when a sync decode runs off the buffer.
const UNDERFLOW = new Error("nbt underflow");
const MAX_DEPTH = 512;
const MAX_BUFFERED = 512 * 1024 * 1024;
const FIXED_SIZE: Record<number, number> = {
  1: 1,
  2: 2,
  3: 4,
  4: 8,
  5: 4,
  6: 8,
};
const textDecoder = new TextDecoder("utf-8");

// Bytes per element of the three array tags.
const ARRAY_UNIT: Record<number, number> = { 7: 1, 11: 4, 12: 8 };

export class NbtError extends Error {}

export class NbtReader {
  buf: Buffer = Buffer.alloc(0);
  pos = 0;
  end = 0;
  private done = false;

  constructor(private readonly source: AsyncIterator<Buffer>) {}

  private async pull(): Promise<boolean> {
    if (this.done) {
      return false;
    }
    const next = await this.source.next();
    if (next.done) {
      this.done = true;
      return false;
    }
    const chunk = next.value;
    const left = this.end - this.pos;
    if (left === 0) {
      this.buf = chunk;
      this.pos = 0;
      this.end = chunk.length;
    } else {
      if (left + chunk.length > MAX_BUFFERED) {
        throw new NbtError("NBT value is too large to read");
      }
      const merged = Buffer.allocUnsafe(left + chunk.length);
      this.buf.copy(merged, 0, this.pos, this.end);
      chunk.copy(merged, left);
      this.buf = merged;
      this.pos = 0;
      this.end = merged.length;
    }
    return true;
  }

  async ensure(n: number): Promise<void> {
    while (this.end - this.pos < n) {
      if (!(await this.pull())) {
        throw new NbtError("Unexpected end of file (is it truncated?)");
      }
    }
  }

  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.end === this.pos) {
        await this.ensure(1);
      }
      const take = Math.min(left, this.end - this.pos);
      this.pos += take;
      left -= take;
    }
  }

  async u8(): Promise<number> {
    if (this.end === this.pos) {
      await this.ensure(1);
    }
    return this.buf[this.pos++]!;
  }

  async i32(): Promise<number> {
    if (this.end - this.pos < 4) {
      await this.ensure(4);
    }
    const value = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return value;
  }

  async name(): Promise<string> {
    if (this.end - this.pos < 2) {
      await this.ensure(2);
    }
    const length = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    await this.ensure(length);
    const text = textDecoder.decode(
      this.buf.subarray(this.pos, this.pos + length)
    );
    this.pos += length;
    return text;
  }

  // Decode one value, however large, into memory. Only for values known to be small.
  async value(type: number): Promise<NbtTag> {
    for (;;) {
      const start = this.pos;
      try {
        return this.decode(type, 0);
      } catch (error) {
        if (error !== UNDERFLOW) {
          throw error;
        }
        this.pos = start;
        // Double what's buffered before retrying so very large values stay linear.
        const target = (this.end - this.pos) * 2;
        if (!(await this.pull())) {
          throw new NbtError("Unexpected end of file (is it truncated?)", {
            cause: error,
          });
        }
        while (this.end - this.pos < target && (await this.pull())) {
          // Pulling is all there is to do until enough has arrived.
        }
      }
    }
  }

  private need(n: number): void {
    if (this.end - this.pos < n) {
      throw UNDERFLOW;
    }
  }

  private decode(type: number, depth: number): NbtTag {
    if (depth > MAX_DEPTH) {
      throw new NbtError("NBT is nested too deeply");
    }
    const buf = this.buf;
    switch (type) {
      case 1: {
        this.need(1);
        return { t: 1, v: buf.readInt8(this.pos++) };
      }
      case 2: {
        this.need(2);
        const v = buf.readInt16BE(this.pos);
        this.pos += 2;
        return { t: 2, v };
      }
      case 3: {
        this.need(4);
        const v = buf.readInt32BE(this.pos);
        this.pos += 4;
        return { t: 3, v };
      }
      case 4: {
        this.need(8);
        const v = buf.readBigInt64BE(this.pos);
        this.pos += 8;
        return { t: 4, v };
      }
      case 5: {
        this.need(4);
        const v = buf.readFloatBE(this.pos);
        this.pos += 4;
        return { t: 5, v };
      }
      case 6: {
        this.need(8);
        const v = buf.readDoubleBE(this.pos);
        this.pos += 8;
        return { t: 6, v };
      }
      case 7: {
        const n = this.arrayLength(1);
        const v = new Int8Array(n);
        v.set(buf.subarray(this.pos, this.pos + n));
        this.pos += n;
        return { t: 7, v };
      }
      case 8:
        return { t: 8, v: this.decodeString() };
      case 9: {
        this.need(5);
        const et = buf[this.pos]!;
        const n = buf.readInt32BE(this.pos + 1);
        this.pos += 5;
        if (n < 0) {
          return { et, t: 9, v: [] };
        }
        const v: NbtTag[] = [];
        for (let i = 0; i < n; i++) {
          v.push(this.decode(et, depth + 1));
        }
        return { et, t: 9, v };
      }
      case 10: {
        const v: Compound = new Map();
        for (;;) {
          this.need(1);
          const inner = buf[this.pos++]!;
          if (inner === 0) {
            return { t: 10, v };
          }
          const key = this.decodeString();
          v.set(key, this.decode(inner, depth + 1));
        }
      }
      case 11: {
        const n = this.arrayLength(4);
        const v = new Int32Array(n);
        for (let i = 0; i < n; i++) {
          v[i] = buf.readInt32BE(this.pos + i * 4);
        }
        this.pos += n * 4;
        return { t: 11, v };
      }
      case 12: {
        const n = this.arrayLength(8);
        const v = new BigInt64Array(n);
        for (let i = 0; i < n; i++) {
          v[i] = buf.readBigInt64BE(this.pos + i * 8);
        }
        this.pos += n * 8;
        return { t: 12, v };
      }
      default:
        throw new NbtError(`Corrupt NBT: unknown tag type ${type}`);
    }
  }

  private arrayLength(unit: number): number {
    this.need(4);
    const n = this.buf.readInt32BE(this.pos);
    if (n < 0) {
      throw new NbtError("Corrupt NBT: negative array length");
    }
    this.need(4 + n * unit);
    this.pos += 4;
    return n;
  }

  private decodeString(): string {
    this.need(2);
    const n = this.buf.readUInt16BE(this.pos);
    this.need(2 + n);
    this.pos += 2;
    const text = textDecoder.decode(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return text;
  }

  // Skips within the current buffer. Returns false (rewound) if the value runs past it.
  private skipBuffered(type: number, depth: number): boolean {
    const start = this.pos;
    try {
      this.skipSync(type, depth);
      return true;
    } catch (error) {
      if (error !== UNDERFLOW) {
        throw error;
      }
      this.pos = start;
      return false;
    }
  }

  private skipSync(type: number, depth: number): void {
    if (depth > MAX_DEPTH) {
      throw new NbtError("NBT is nested too deeply");
    }
    const fixed = FIXED_SIZE[type];
    if (fixed !== undefined) {
      this.need(fixed);
      this.pos += fixed;
      return;
    }
    const buf = this.buf;
    switch (type) {
      case 7:
      case 11:
      case 12: {
        const unit = ARRAY_UNIT[type]!;
        this.need(4);
        const n = buf.readInt32BE(this.pos);
        if (n < 0) {
          throw new NbtError("Corrupt NBT: negative array length");
        }
        this.need(4 + n * unit);
        this.pos += 4 + n * unit;
        return;
      }
      case 8: {
        this.need(2);
        const n = buf.readUInt16BE(this.pos);
        this.need(2 + n);
        this.pos += 2 + n;
        return;
      }
      case 9: {
        this.need(5);
        const et = buf[this.pos]!;
        const n = buf.readInt32BE(this.pos + 1);
        this.pos += 5;
        const size = FIXED_SIZE[et];
        if (size !== undefined) {
          if (n > 0) {
            this.need(n * size);
            this.pos += n * size;
          }
          return;
        }
        for (let i = 0; i < n; i++) {
          this.skipSync(et, depth + 1);
        }
        return;
      }
      case 10: {
        for (;;) {
          this.need(1);
          const inner = buf[this.pos++]!;
          if (inner === 0) {
            return;
          }
          this.need(2);
          const n = buf.readUInt16BE(this.pos);
          this.need(2 + n);
          this.pos += 2 + n;
          this.skipSync(inner, depth + 1);
        }
      }
      default:
        throw new NbtError(`Corrupt NBT: unknown tag type ${type}`);
    }
  }

  // Skips any value in constant memory, even a multi-gigabyte array.
  async skipValue(type: number, depth = 0): Promise<void> {
    if (this.skipBuffered(type, depth)) {
      return;
    }
    if (depth > MAX_DEPTH) {
      throw new NbtError("NBT is nested too deeply");
    }
    const fixed = FIXED_SIZE[type];
    if (fixed !== undefined) {
      return this.skip(fixed);
    }
    switch (type) {
      case 7:
      case 11:
      case 12: {
        const n = await this.i32();
        if (n < 0) {
          throw new NbtError("Corrupt NBT: negative array length");
        }
        return this.skip(n * ARRAY_UNIT[type]!);
      }
      case 8: {
        await this.ensure(2);
        const n = this.buf.readUInt16BE(this.pos);
        this.pos += 2;
        return this.skip(n);
      }
      case 9: {
        const et = await this.u8();
        const n = await this.i32();
        const size = FIXED_SIZE[et];
        if (size !== undefined) {
          return this.skip(Math.max(n, 0) * size);
        }
        for (let i = 0; i < n; i++) {
          await this.skipValue(et, depth + 1);
        }
        return;
      }
      case 10: {
        for (;;) {
          const inner = await this.u8();
          if (inner === 0) {
            return;
          }
          await this.ensure(2);
          const n = this.buf.readUInt16BE(this.pos);
          this.pos += 2;
          await this.skip(n);
          await this.skipValue(inner, depth + 1);
        }
      }
      default:
        throw new NbtError(`Corrupt NBT: unknown tag type ${type}`);
    }
  }
}

// What a walker should do with a tag it just reached.
export type WalkAction =
  | { kind: "skip" }
  | { kind: "enter" } // Compound: visit children.
  | { kind: "stop" } // Abandon the walk entirely.
  | { kind: "value"; use: (tag: NbtTag) => void | Promise<void> }
  | {
      kind: "each";
      use: (element: NbtTag, count: number) => void | Promise<void>;
    } // List
  // Arrays: the callback must consume exactly `length` elements from the reader.
  | {
      kind: "array";
      use: (reader: NbtReader, length: number) => Promise<void>;
    };

export const SKIP: WalkAction = { kind: "skip" };
export const ENTER: WalkAction = { kind: "enter" };
export const STOP: WalkAction = { kind: "stop" };

export type WalkHandler = (path: string, type: number) => WalkAction;

class WalkStopped extends Error {}

// Walks a named root tag. Paths look like "/Blocks/Palette"; the root name is dropped.
export async function walk(
  reader: NbtReader,
  handler: WalkHandler
): Promise<void> {
  const rootType = await reader.u8();
  if (rootType !== TAG.Compound) {
    throw new NbtError(
      "This isn't a Minecraft schematic: it doesn't contain NBT data."
    );
  }
  await reader.name();
  try {
    await walkCompound(reader, "", handler, 0);
  } catch (error) {
    if (!(error instanceof WalkStopped)) {
      throw error;
    }
  }
}

async function walkCompound(
  reader: NbtReader,
  path: string,
  handler: WalkHandler,
  depth: number
): Promise<void> {
  if (depth > MAX_DEPTH) {
    throw new NbtError("NBT is nested too deeply");
  }
  for (;;) {
    const type = await reader.u8();
    if (type === 0) {
      return;
    }
    if (type > 12) {
      throw new NbtError(`Corrupt NBT: unknown tag type ${type}`);
    }
    const childPath = `${path}/${await reader.name()}`;
    const action = handler(childPath, type);
    switch (action.kind) {
      case "skip":
        await reader.skipValue(type);
        break;
      case "enter":
        if (type === TAG.Compound) {
          await walkCompound(reader, childPath, handler, depth + 1);
        } else {
          await reader.skipValue(type);
        }
        break;
      case "stop":
        throw new WalkStopped();
      case "value":
        await action.use(await reader.value(type));
        break;
      case "each": {
        if (type !== TAG.List) {
          await reader.skipValue(type);
          break;
        }
        const et = await reader.u8();
        const count = await reader.i32();
        for (let i = 0; i < count; i++) {
          const element = await reader.value(et);
          await action.use(element, count);
        }
        break;
      }
      case "array": {
        if (
          type !== TAG.ByteArray &&
          type !== TAG.IntArray &&
          type !== TAG.LongArray
        ) {
          await reader.skipValue(type);
          break;
        }
        const length = await reader.i32();
        if (length < 0) {
          throw new NbtError("Corrupt NBT: negative array length");
        }
        await action.use(reader, length);
        break;
      }
    }
  }
}

// Growable big-endian encoder used for headers, tile entities and entities.
export class NbtEncoder {
  buf: Buffer;
  length = 0;

  constructor(capacity = 4096) {
    this.buf = Buffer.allocUnsafe(capacity);
  }

  private reserve(n: number): void {
    if (this.length + n <= this.buf.length) {
      return;
    }
    let capacity = this.buf.length * 2;
    while (capacity < this.length + n) {
      capacity *= 2;
    }
    const next = Buffer.allocUnsafe(capacity);
    this.buf.copy(next, 0, 0, this.length);
    this.buf = next;
  }

  reset(): void {
    this.length = 0;
  }

  bytes(): Buffer {
    return this.buf.subarray(0, this.length);
  }

  u8(v: number): void {
    this.reserve(1);
    this.buf[this.length++] = v & 0xff;
  }

  i16(v: number): void {
    this.reserve(2);
    this.buf.writeInt16BE(v, this.length);
    this.length += 2;
  }

  i32(v: number): void {
    this.reserve(4);
    this.buf.writeInt32BE(v, this.length);
    this.length += 4;
  }

  str(v: string): void {
    const encoded = Buffer.from(v, "utf8");
    const n = Math.min(encoded.length, 65_535);
    this.reserve(2 + n);
    this.buf.writeUInt16BE(n, this.length);
    this.length += 2;
    encoded.copy(this.buf, this.length, 0, n);
    this.length += n;
  }

  // The tag header on its own, for arrays and lists whose body is written elsewhere.
  head(type: number, name: string): void {
    this.u8(type);
    this.str(name);
  }

  named(name: string, tag: NbtTag): void {
    this.head(tag.t, name);
    this.payload(tag);
  }

  payload(tag: NbtTag): void {
    switch (tag.t) {
      case 1:
        this.u8(tag.v);
        break;
      case 2:
        this.i16(tag.v);
        break;
      case 3:
        this.i32(tag.v);
        break;
      case 4:
        this.reserve(8);
        this.buf.writeBigInt64BE(tag.v, this.length);
        this.length += 8;
        break;
      case 5:
        this.reserve(4);
        this.buf.writeFloatBE(tag.v, this.length);
        this.length += 4;
        break;
      case 6:
        this.reserve(8);
        this.buf.writeDoubleBE(tag.v, this.length);
        this.length += 8;
        break;
      case 7:
        this.i32(tag.v.length);
        this.reserve(tag.v.length);
        this.buf.set(
          new Uint8Array(tag.v.buffer, tag.v.byteOffset, tag.v.length),
          this.length
        );
        this.length += tag.v.length;
        break;
      case 8:
        this.str(tag.v);
        break;
      case 9:
        this.u8(tag.v.length === 0 && tag.et === 0 ? TAG.Compound : tag.et);
        this.i32(tag.v.length);
        for (const item of tag.v) {
          this.payload(item);
        }
        break;
      case 10:
        for (const [key, value] of tag.v) {
          this.named(key, value);
        }
        this.u8(0);
        break;
      case 11:
        this.i32(tag.v.length);
        this.reserve(tag.v.length * 4);
        for (const value of tag.v) {
          this.buf.writeInt32BE(value, this.length);
          this.length += 4;
        }
        break;
      case 12:
        this.i32(tag.v.length);
        this.reserve(tag.v.length * 8);
        for (const value of tag.v) {
          this.buf.writeBigInt64BE(value, this.length);
          this.length += 8;
        }
        break;
    }
  }
}
