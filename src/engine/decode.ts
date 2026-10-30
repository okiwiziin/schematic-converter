// The hot loops. These are the only code touched per block, so they use local variables,
// typed arrays and early returns rather than anything tidier.
import type { NbtReader } from "./nbt/nbt";
import type { PaletteTable } from "./palette";

export const RUN_SIZE = 1 << 20;

export interface RunTarget {
  // Receives blocks in file order. The buffers are reused after the promise resolves.
  write(ids: Uint8Array, data: Uint8Array, count: number): Promise<void>;
}

export interface SpecialSink {
  push(position: number, block: number): void;
}

export interface DecodeState {
  palette: PaletteTable;
  specials: SpecialSink;
  target: RunTarget;
  onProgress: (blocksDone: number) => void;
  invalid: number;
  // Added to every palette index, for files where each region has its own palette.
  paletteBase?: number;
  // How many of those entries belong to this region. Indices at or past it are invalid.
  paletteCount?: number;
}

// Writes `length` varint palette indices (the .schem format) to the target.
export async function decodeVarints(
  reader: NbtReader,
  byteLength: number,
  expected: number,
  state: DecodeState,
  positionBase = 0,
): Promise<number> {
  const ids = new Uint8Array(RUN_SIZE);
  const data = new Uint8Array(RUN_SIZE);
  const { palette, specials } = state;
  const lutIds = palette.ids;
  const lutData = palette.data;
  const lutSpecial = palette.special;
  const counts = palette.counts;
  const paletteSize = lutIds.length;

  let produced = 0;
  let remaining = byteLength;
  let out = 0;
  let invalid = 0;

  while (remaining > 0) {
    if (reader.end - reader.pos < Math.min(5, remaining)) await reader.ensure(Math.min(5, remaining));
    const buffer = reader.buf;
    let at = reader.pos;
    const available = Math.min(reader.end - at, remaining);
    const stop = at + available;
    // Anywhere before here a whole varint is guaranteed to be readable.
    const safeStop = available === remaining ? stop : stop - 4;
    const before = at;

    // Never produce more than the schematic's size, even from a malformed file.
    const want = Math.min(RUN_SIZE, expected - produced);

    while (at < safeStop && out < want) {
      let value = buffer[at++]!;
      if (value <= 127) {
        // Maps are mostly long runs of air and stone, so take a whole run at a time.
        const scanStop = Math.min(safeStop, at + want - out - 1);
        let scan = at;
        while (scan < scanStop && buffer[scan] === value) scan++;
        const run = scan - at + 1;
        at = scan;
        if (value >= paletteSize) {
          invalid += run;
          ids.fill(0, out, out + run);
          data.fill(0, out, out + run);
          out += run;
          continue;
        }
        const id = lutIds[value]!;
        const dataValue = lutData[value]!;
        if (run > 32) {
          ids.fill(id, out, out + run);
          data.fill(dataValue, out, out + run);
        } else {
          for (let i = out; i < out + run; i++) {
            ids[i] = id;
            data[i] = dataValue;
          }
        }
        counts[value]! += run;
        if (lutSpecial[value] === 1) {
          for (let i = 0; i < run; i++) specials.push(positionBase + produced + out + i, value);
        }
        out += run;
        continue;
      }
      {
        value &= 127;
        let byte = at < stop ? buffer[at++]! : 0;
        value |= (byte & 127) << 7;
        if (byte > 127) {
          byte = at < stop ? buffer[at++]! : 0;
          value |= (byte & 127) << 14;
          if (byte > 127) {
            byte = at < stop ? buffer[at++]! : 0;
            value |= (byte & 127) << 21;
            if (byte > 127) {
              byte = at < stop ? buffer[at++]! : 0;
              value |= (byte & 127) << 28;
            }
          }
        }
      }
      if (value >= paletteSize || value < 0) {
        invalid += 1;
        ids[out] = 0;
        data[out] = 0;
        out += 1;
        continue;
      }
      ids[out] = lutIds[value]!;
      data[out] = lutData[value]!;
      counts[value]! += 1;
      if (lutSpecial[value] === 1) specials.push(positionBase + produced + out, value);
      out += 1;
    }

    reader.pos = at;
    remaining -= at - before;
    if (out === want && want > 0) {
      await state.target.write(ids, data, out);
      produced += out;
      out = 0;
      state.onProgress(produced);
    } else if (want === 0) {
      throw new Error(`Block data has more blocks than the schematic's size of ${expected}`);
    } else if (at === before) {
      // Fewer than 5 bytes in the buffer but more in the array: pull in the next chunk.
      await reader.ensure(Math.min(reader.end - reader.pos + 1, remaining));
    }
  }

  if (out > 0) {
    await state.target.write(ids, data, out);
    produced += out;
    state.onProgress(produced);
  }
  state.invalid += invalid;
  return produced;
}

// Litematica's bit-packed longs: fixed width entries that may straddle two longs.
export async function decodePacked(
  reader: NbtReader,
  longCount: number,
  bits: number,
  entryCount: number,
  state: DecodeState,
  positionBase = 0,
): Promise<void> {
  const ids = new Uint8Array(RUN_SIZE);
  const data = new Uint8Array(RUN_SIZE);
  const { palette, specials } = state;
  const lutIds = palette.ids;
  const lutData = palette.data;
  const lutSpecial = palette.special;
  const counts = palette.counts;
  const valueMask = bits >= 32 ? 0xffffffff : ((1 << bits) >>> 0) - 1;
  const base = state.paletteBase ?? 0;
  const zeroId = lutIds[base]!;
  const zeroData = lutData[base]!;
  const zeroIsSpecial = lutSpecial[base] === 1;
  const paletteCount = state.paletteCount ?? lutIds.length;

  let accumulator = 0;
  let available = 0; // Valid low bits held in the accumulator.
  let produced = 0;
  let out = 0;
  let longsLeft = longCount;
  let hasPendingHigh = false;
  let pendingHigh = 0;

  while (produced + out < entryCount) {
    if (out === RUN_SIZE) {
      await state.target.write(ids, data, out);
      produced += out;
      out = 0;
      state.onProgress(produced);
    }
    // Pull whole longs through one 32-bit word at a time, low word first.
    if (!hasPendingHigh && longsLeft > 0 && reader.end - reader.pos < 8) await reader.ensure(8);

    const buffer = reader.buf;
    let at = reader.pos;
    const longsBuffered = Math.min(longsLeft, Math.floor((reader.end - at) / 8));
    const stopAt = at + longsBuffered * 8;
    const limit = Math.min(RUN_SIZE, entryCount - produced);

    while (out < limit) {
      let value: number;
      if (available >= bits) {
        value = accumulator & valueMask;
        accumulator = bits >= 32 ? 0 : accumulator >>> bits;
        available -= bits;
      } else {
        // A whole long of zeros while nothing is held back means a run of palette entry 0,
        // which is air in anything Litematica writes. Skip through those in one go.
        if (accumulator === 0 && !hasPendingHigh && !zeroIsSpecial) {
          let scan = at;
          while (
            scan < stopAt &&
            (buffer[scan]! | buffer[scan + 1]! | buffer[scan + 2]! | buffer[scan + 3]! | buffer[scan + 4]! | buffer[scan + 5]! | buffer[scan + 6]! | buffer[scan + 7]!) === 0
          ) {
            scan += 8;
          }
          if (scan > at) {
            // Whole entries only; any partial one stays in `available` as zero bits.
            const entries = Math.min(Math.floor((available + (scan - at) * 8) / bits), limit - out);
            const bitsWanted = entries * bits - available;
            const longsUsed = bitsWanted <= 0 ? 0 : Math.ceil(bitsWanted / 64);
            if (entries > 0 && longsUsed * 8 <= scan - at) {
              ids.fill(zeroId, out, out + entries);
              data.fill(zeroData, out, out + entries);
              counts[base]! += entries;
              out += entries;
              at += longsUsed * 8;
              longsLeft -= longsUsed;
              available += longsUsed * 64 - entries * bits;
              continue;
            }
          }
        }
        let word: number;
        if (hasPendingHigh) {
          word = pendingHigh;
          hasPendingHigh = false;
        } else if (at < stopAt) {
          pendingHigh = (buffer[at]! << 24) | (buffer[at + 1]! << 16) | (buffer[at + 2]! << 8) | buffer[at + 3]!;
          word = (buffer[at + 4]! << 24) | (buffer[at + 5]! << 16) | (buffer[at + 6]! << 8) | buffer[at + 7]!;
          hasPendingHigh = true;
          at += 8;
          longsLeft -= 1;
        } else {
          break;
        }
        value = (accumulator | (word << available)) & valueMask;
        accumulator = word >>> (bits - available);
        available += 32 - bits;
      }
      if (value >= paletteCount) {
        state.invalid += 1;
        ids[out] = 0;
        data[out] = 0;
        out += 1;
        continue;
      }
      value += base;
      ids[out] = lutIds[value]!;
      data[out] = lutData[value]!;
      counts[value]! += 1;
      if (lutSpecial[value] === 1) specials.push(positionBase + produced + out, value);
      out += 1;
    }
    reader.pos = at;

    if (out < limit && longsLeft === 0 && !hasPendingHigh && available < bits) {
      throw new Error("Litematic block data ended early");
    }
  }

  if (out > 0) {
    await state.target.write(ids, data, out);
    produced += out;
    state.onProgress(produced);
  }
  if (longsLeft > 0) await reader.skip(longsLeft * 8);
}
