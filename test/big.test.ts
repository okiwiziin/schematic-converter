// Byte-for-byte check of a large conversion. Set BIG_SCHEM to a .schem file and BIG_OUTPUT to the
// .schematic made from it. A deliberately simple varint decoder works out what every block should
// be, independently of the engine's optimised one.
import { readFileSync } from "node:fs";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { BlockResolver } from "../src/engine/mapping/resolver";
import { asCompound, asNumber, NbtReader, SKIP, walk } from "../src/engine/nbt/nbt";

const source = process.env.BIG_SCHEM;
const output = process.env.BIG_OUTPUT;

function findTag(buffer: Buffer, type: number, name: string): number {
  const needle = Buffer.concat([Buffer.from([type, 0, name.length]), Buffer.from(name)]);
  const at = buffer.indexOf(needle);
  if (at === -1) throw new Error(`No ${name} tag`);
  return at + needle.length;
}

describe.skipIf(!source || !output)("a large conversion", () => {
  it("matches an independent decode of the source, every block", async () => {
    const inflated = zlib.gunzipSync(readFileSync(source!));
    const result = zlib.gunzipSync(readFileSync(output!));

    const luts = { ids: new Uint8Array(0), data: new Uint8Array(0) };
    const resolver = new BlockResolver();
    let sent = false;
    const reader = new NbtReader({
      next: async () => {
        if (sent) return { done: true, value: undefined };
        sent = true;
        return { done: false, value: inflated };
      },
    });
    await walk(reader, (path) => {
      if (path !== "/Palette") return SKIP;
      return {
        kind: "value",
        use: (tag) => {
          const entries = [...(asCompound(tag) ?? new Map()).entries()];
          luts.ids = new Uint8Array(entries.length);
          luts.data = new Uint8Array(entries.length);
          for (const [state, index] of entries) {
            const block = resolver.resolveState(state);
            luts.ids[asNumber(index)!] = block.id;
            luts.data[asNumber(index)!] = block.data;
          }
        },
      };
    });

    const sourceStart = findTag(inflated, 7, "BlockData");
    const byteLength = inflated.readInt32BE(sourceStart);
    const blocksStart = findTag(result, 7, "Blocks");
    const volume = result.readInt32BE(blocksStart);
    const dataStart = findTag(result, 7, "Data");
    expect(result.readInt32BE(dataStart)).toBe(volume);

    let at = sourceStart + 4;
    const end = at + byteLength;
    let mismatches = 0;
    const samples: string[] = [];
    for (let i = 0; i < volume; i++) {
      let value = 0;
      let shift = 0;
      for (;;) {
        const byte = inflated[at++]!;
        value |= (byte & 127) << shift;
        if (byte < 128) break;
        shift += 7;
      }
      if (result[blocksStart + 4 + i] !== luts.ids[value] || result[dataStart + 4 + i] !== luts.data[value]) {
        mismatches += 1;
        if (samples.length < 12) {
          samples.push(`#${i} index=${value} expected=${luts.ids[value]}:${luts.data[value]} actual=${result[blocksStart + 4 + i]}:${result[dataStart + 4 + i]}`);
        }
      }
    }
    expect(at).toBe(end);
    expect(samples).toEqual([]);
    expect(mismatches).toBe(0);
  }, 600000);
});
