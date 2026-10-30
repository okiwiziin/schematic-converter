// Parallel gzip, in the style of pigz. Input is cut into chunks that are deflated
// independently on libuv's thread pool and written in order. Each chunk ends on a
// byte boundary (Z_SYNC_FLUSH), so compressed sections can be stored in separate
// files and spliced together afterwards into one ordinary gzip stream.
import { open, type FileHandle } from "node:fs/promises";
import zlib from "node:zlib";

const DICTIONARY_SIZE = 32 * 1024;

export type CompressionLevel = "fast" | "balanced" | "small";

const LEVELS: Record<CompressionLevel, number> = { fast: 1, balanced: 6, small: 9 };

export class DeflatePool {
  private inFlight = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly options: zlib.ZlibOptions;

  constructor(
    private readonly limit: number,
    level: CompressionLevel,
  ) {
    this.options = {
      level: LEVELS[level],
      memLevel: 9,
      finishFlush: zlib.constants.Z_SYNC_FLUSH,
    };
  }

  // Resolves when another chunk may be started, which is what bounds memory use.
  async slot(): Promise<void> {
    while (this.inFlight >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  deflate(chunk: Uint8Array, dictionary: Buffer | undefined): Promise<Buffer> {
    this.inFlight += 1;
    return new Promise((resolve, reject) => {
      zlib.deflateRaw(chunk, dictionary ? { ...this.options, dictionary } : this.options, (error, out) => {
        this.inFlight -= 1;
        this.waiters.shift()?.();
        if (error) reject(error);
        else resolve(out);
      });
    });
  }
}

// One ordered, compressed run of bytes appended to a file.
export class DeflateSection {
  crc = 0;
  rawLength = 0;
  compressedLength = 0;

  private current: Buffer | null = null;
  private currentLength = 0;
  private tail: Buffer | undefined;
  private writing: Promise<void> = Promise.resolve();
  private failure: unknown;
  private file: FileHandle | null = null;
  private opening: Promise<FileHandle> | null = null;

  constructor(
    private readonly pool: DeflatePool,
    private readonly chunkSize: number,
    private readonly fileFactory: () => Promise<FileHandle>,
  ) {}

  private handle(): Promise<FileHandle> {
    this.opening ??= this.fileFactory().then((file) => (this.file = file));
    return this.opening;
  }

  async write(source: Uint8Array, start = 0, end = source.length): Promise<void> {
    let at = start;
    while (at < end) {
      const current = (this.current ??= Buffer.allocUnsafeSlow(this.chunkSize));
      const take = Math.min(end - at, this.chunkSize - this.currentLength);
      current.set(source.subarray(at, at + take), this.currentLength);
      this.currentLength += take;
      at += take;
      if (this.currentLength === this.chunkSize) await this.submit();
    }
  }

  private async submit(): Promise<void> {
    if (this.failure) throw this.failure;
    const length = this.currentLength;
    if (length === 0) return;
    const chunk = this.current!.subarray(0, length);
    this.current = null;
    this.currentLength = 0;
    await this.pool.slot();

    this.crc = zlib.crc32(chunk, this.crc);
    this.rawLength += length;
    const dictionary = this.tail;
    this.tail = Buffer.from(chunk.subarray(Math.max(0, length - DICTIONARY_SIZE)));
    const compressed = this.pool.deflate(chunk, dictionary);
    const file = this.handle();
    this.writing = this.writing.then(async () => {
      if (this.failure) return;
      try {
        const data = await compressed;
        await (await file).write(data);
        this.compressedLength += data.length;
      } catch (error) {
        this.failure ??= error;
      }
    });
    // Compression failures have to reach the caller even if nobody is awaiting them yet.
    compressed.catch((error) => {
      this.failure ??= error;
    });
  }

  async finish(): Promise<void> {
    await this.submit();
    await this.writing;
    if (this.failure) throw this.failure;
    if (this.file) await this.file.close();
    this.file = null;
    this.opening = null;
  }

  // Opens the backing file now, for sections that must exist on disk even if empty.
  async touch(): Promise<void> {
    await this.handle();
  }
}

export const createFile = (path: string): Promise<FileHandle> => open(path, "w");

// GF(2) matrix CRC combination from zlib. The Node API exposes crc32 but not this,
// and it is what lets sections be compressed before their final order is known.
const GF2_DIM = 32;

function gf2Times(matrix: Uint32Array, vector: number): number {
  let sum = 0;
  let index = 0;
  let value = vector >>> 0;
  while (value !== 0) {
    if (value & 1) sum ^= matrix[index]!;
    value >>>= 1;
    index += 1;
  }
  return sum >>> 0;
}

function gf2Square(square: Uint32Array, matrix: Uint32Array): void {
  for (let n = 0; n < GF2_DIM; n++) square[n] = gf2Times(matrix, matrix[n]!);
}

export function crc32Combine(crc1: number, crc2: number, length2: number): number {
  if (length2 <= 0) return crc1 >>> 0;
  const even = new Uint32Array(GF2_DIM);
  const odd = new Uint32Array(GF2_DIM);
  odd[0] = 0xedb88320;
  let row = 1;
  for (let n = 1; n < GF2_DIM; n++) {
    odd[n] = row;
    row = (row << 1) >>> 0;
  }
  gf2Square(even, odd);
  gf2Square(odd, even);

  let crc = crc1 >>> 0;
  let remaining = length2;
  do {
    gf2Square(even, odd);
    if (remaining % 2 === 1) crc = gf2Times(even, crc);
    remaining = Math.floor(remaining / 2);
    if (remaining === 0) break;
    gf2Square(odd, even);
    if (remaining % 2 === 1) crc = gf2Times(odd, crc);
    remaining = Math.floor(remaining / 2);
  } while (remaining !== 0);
  return (crc ^ crc2) >>> 0;
}

export const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);

// A complete deflate "stored" block: uncompressed and byte aligned. The file header is
// written as one of these so it can be patched in place once all of its values are known.
export function storedBlock(data: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(5 + data.length);
  out[0] = 0;
  out.writeUInt16LE(data.length, 1);
  out.writeUInt16LE(~data.length & 0xffff, 3);
  out.set(data, 5);
  return out;
}

// A final, empty deflate block followed by the gzip trailer.
export function gzipTrailer(crc: number, totalLength: number): Buffer {
  const out = Buffer.allocUnsafe(10);
  out[0] = 0x03;
  out[1] = 0x00;
  out.writeUInt32LE(crc >>> 0, 2);
  out.writeUInt32LE(totalLength % 0x100000000, 6);
  return out;
}

export function deflateSmall(data: Uint8Array): Buffer {
  return zlib.deflateRawSync(data, { level: 6, finishFlush: zlib.constants.Z_SYNC_FLUSH });
}
