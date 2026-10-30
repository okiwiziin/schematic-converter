import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectFile } from "../src/engine/convert";
import { crc32Combine } from "../src/engine/gzip";
import { nbt, NbtReader, TAG, walk, ENTER, SKIP, type NbtTag } from "../src/engine/nbt/nbt";
import { planTiles } from "../src/engine/output";
import {
  bytes,
  compound,
  convert,
  doubles,
  encodeFile,
  ints,
  list,
  longs,
  outputs,
  packLitematic,
  readSchematic,
  varints,
  workspace,
  type Workspace,
} from "./helpers";

let ws: Workspace;
beforeEach(() => {
  ws = workspace();
});
afterEach(() => {
  ws.cleanup();
});

const PALETTE = {
  "minecraft:air": 0,
  "minecraft:stone": 1,
  "minecraft:red_wool": 2,
  "minecraft:oak_stairs[facing=west,half=bottom,shape=straight,waterlogged=false]": 3,
  "minecraft:deepslate[axis=y]": 4,
};
const paletteTag = compound(Object.fromEntries(Object.entries(PALETTE).map(([state, index]) => [state, nbt.int(index)])));

// A 3x2x4 pattern where every position differs, to catch any axis mix-up.
const W = 3;
const H = 2;
const L = 4;
const pattern = (x: number, y: number, z: number): number => (x * 1 + y * 2 + z * 3) % 5;
const EXPECTED: Record<number, [number, number]> = { 0: [0, 0], 1: [1, 0], 2: [35, 14], 3: [53, 1], 4: [1, 0] };
const values: number[] = [];
for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) values.push(pattern(x, y, z));

async function expectPattern(path: string): Promise<void> {
  const schematic = await readSchematic(path);
  expect([schematic.width, schematic.height, schematic.length]).toEqual([W, H, L]);
  for (let y = 0; y < H; y++) {
    for (let z = 0; z < L; z++) {
      for (let x = 0; x < W; x++) {
        expect(schematic.at(x, y, z), `${x},${y},${z}`).toEqual(EXPECTED[pattern(x, y, z)]);
      }
    }
  }
  expect(schematic.raw.Materials).toBe("Alpha");
}

const spongeV2 = (extra: Record<string, NbtTag> = {}): NbtTag =>
  compound({
    Version: nbt.int(2),
    DataVersion: nbt.int(3465),
    Width: nbt.short(W),
    Height: nbt.short(H),
    Length: nbt.short(L),
    PaletteMax: nbt.int(5),
    Palette: paletteTag,
    BlockData: varints(values),
    ...extra,
  });

describe("Sponge .schem", () => {
  it("converts version 2 and identifies the Minecraft version", async () => {
    const path = ws.write("house.schem", encodeFile(spongeV2(), "Schematic"));
    const info = await inspectFile(path);
    expect(info).toMatchObject({ format: "sponge", width: W, height: H, length: L, versionLabel: "1.20.1" });
    const report = await convert(ws, path);
    await expectPattern(join(ws.outDir, "house.schematic"));
    expect(report.outputs).toHaveLength(1);
    expect(report.blocks.find((row) => row.name === "minecraft:deepslate")).toMatchObject({ kind: "substitute", id: 1 });
    expect(report.blocks.find((row) => row.name === "minecraft:stone")).toMatchObject({ kind: "exact" });
    expect(report.blocks.reduce((sum, row) => sum + row.count, 0)).toBe(W * H * L);
  });

  it("converts version 3, which nests everything under Schematic and Blocks", async () => {
    const root = compound({
      Schematic: compound({
        Version: nbt.int(3),
        DataVersion: nbt.int(3700),
        Width: nbt.short(W),
        Height: nbt.short(H),
        Length: nbt.short(L),
        Offset: ints(5, 6, 7),
        Metadata: compound({ WorldEdit: compound({ Origin: ints(100, 64, 200) }) }),
        Blocks: compound({
          Palette: paletteTag,
          Data: varints(values),
          BlockEntities: list(TAG.Compound),
        }),
      }),
    });
    const path = ws.write("v3.schem", encodeFile(root));
    await convert(ws, path);
    const out = join(ws.outDir, "v3.schematic");
    await expectPattern(out);
    const { raw } = await readSchematic(out);
    expect(raw).toMatchObject({ WEOriginX: 105, WEOriginY: 70, WEOriginZ: 207, WEOffsetX: 5, WEOffsetY: 6, WEOffsetZ: 7 });
  });

  it("keeps the paste position from version 2 WorldEdit metadata", async () => {
    const path = ws.write(
      "origin.schem",
      encodeFile(
        spongeV2({
          Offset: ints(10, 20, 30),
          Metadata: compound({ WEOffsetX: nbt.int(-1), WEOffsetY: nbt.int(-2), WEOffsetZ: nbt.int(-3) }),
        }),
        "Schematic",
      ),
    );
    await convert(ws, path);
    const { raw } = await readSchematic(join(ws.outDir, "origin.schematic"));
    expect(raw).toMatchObject({ WEOriginX: 10, WEOriginY: 20, WEOriginZ: 30, WEOffsetX: -1, WEOffsetY: -2, WEOffsetZ: -3 });
  });

  it("handles tags in any order, including block data before the palette", async () => {
    const root = compound({
      BlockEntities: list(
        TAG.Compound,
        compound({ Id: nbt.string("minecraft:chest"), Pos: ints(0, 0, 0), Items: list(TAG.Compound) }),
      ),
      BlockData: varints([9]),
      Palette: compound({ "minecraft:chest[facing=north,type=single,waterlogged=false]": nbt.int(9) }),
      Length: nbt.short(1),
      Height: nbt.short(1),
      Width: nbt.short(1),
      Version: nbt.int(2),
    });
    const path = ws.write("shuffled.schem", encodeFile(root, "Schematic"));
    await convert(ws, path);
    const schematic = await readSchematic(join(ws.outDir, "shuffled.schematic"));
    expect(schematic.at(0, 0, 0)).toEqual([54, 2]);
    expect(schematic.tiles).toHaveLength(1);
    expect(schematic.tiles[0]).toMatchObject({ id: "Chest", x: 0, y: 0, z: 0 });
  });

  it("decodes multi-byte palette indices", async () => {
    const paletteEntries: Record<string, NbtTag> = { "minecraft:air": nbt.int(0) };
    for (let i = 1; i < 600; i++) paletteEntries[`mod:block_${i}`] = nbt.int(i);
    paletteEntries["minecraft:gold_block"] = nbt.int(70000);
    const root = compound({
      Version: nbt.int(2),
      Width: nbt.short(3),
      Height: nbt.short(1),
      Length: nbt.short(1),
      Palette: compound(paletteEntries),
      BlockData: varints([70000, 0, 300]),
    });
    const path = ws.write("wide.schem", encodeFile(root, "Schematic"));
    const report = await convert(ws, path, { fallback: "1:0" });
    const schematic = await readSchematic(join(ws.outDir, "wide.schematic"));
    expect(schematic.at(0, 0, 0)).toEqual([41, 0]);
    expect(schematic.at(1, 0, 0)).toEqual([0, 0]);
    expect(schematic.at(2, 0, 0)).toEqual([1, 0]);
    expect(report.blocks.find((row) => row.name === "mod:block_300")).toMatchObject({ kind: "unmapped" });
    expect(report.warnings.join(" ")).toContain("mod:block_300");
  });

  it("reports blocks that point at no palette entry", async () => {
    const root = compound({
      Version: nbt.int(2),
      Width: nbt.short(4),
      Height: nbt.short(1),
      Length: nbt.short(1),
      // Index 1 is a hole in the palette, and 500 is past the end of it.
      Palette: compound({ "minecraft:stone": nbt.int(0), "minecraft:dirt": nbt.int(2) }),
      BlockData: varints([0, 1, 2, 500]),
    });
    const report = await convert(ws, ws.write("holes.schem", encodeFile(root, "Schematic")));
    const schematic = await readSchematic(join(ws.outDir, "holes.schematic"));
    expect(schematic.at(0, 0, 0)).toEqual([1, 0]);
    expect(schematic.at(1, 0, 0)).toEqual([0, 0]);
    expect(schematic.at(2, 0, 0)).toEqual([3, 0]);
    expect(schematic.at(3, 0, 0)).toEqual([0, 0]);
    expect(report.warnings.join(" ")).toContain("2 blocks pointed outside the palette");
  });

  it("accepts uncompressed files", async () => {
    const path = ws.write("plain.schem", encodeFile(spongeV2(), "Schematic", false));
    await convert(ws, path);
    await expectPattern(join(ws.outDir, "plain.schematic"));
  });

  it("rejects files that are too short rather than writing a broken schematic", async () => {
    const root = compound({
      Version: nbt.int(2),
      Width: nbt.short(4),
      Height: nbt.short(4),
      Length: nbt.short(4),
      Palette: paletteTag,
      BlockData: varints([1, 1]),
    });
    const path = ws.write("short.schem", encodeFile(root, "Schematic"));
    await expect(convert(ws, path)).rejects.toThrow(/ended early/);
    expect(outputs(ws)).toEqual([]);
  });

  it("explains what's wrong with files that aren't schematics", async () => {
    await expect(convert(ws, ws.write("junk.schem", Buffer.from("return { yslice_prob = {} }")))).rejects.toThrow(/isn't a Minecraft schematic/);
    const truncatedGzip = encodeFile(spongeV2(), "Schematic").subarray(0, 40);
    await expect(convert(ws, ws.write("cut.schem", truncatedGzip))).rejects.toThrow();
    const damaged = Buffer.from(encodeFile(spongeV2(), "Schematic"));
    damaged.fill(0xff, 20, 60);
    await expect(convert(ws, ws.write("bad.schem", damaged))).rejects.toThrow(/damaged/);
    expect(outputs(ws)).toEqual([]);
  });

  it("doesn't warn about beds, which have no tile entity in 1.8", async () => {
    const root = compound({
      Version: nbt.int(2),
      Width: nbt.short(1),
      Height: nbt.short(1),
      Length: nbt.short(1),
      Palette: compound({ "minecraft:blue_bed[facing=north,occupied=false,part=head]": nbt.int(0) }),
      BlockData: varints([0]),
      BlockEntities: list(TAG.Compound, compound({ Id: nbt.string("minecraft:bed"), Pos: ints(0, 0, 0) })),
    });
    const report = await convert(ws, ws.write("bed.schem", encodeFile(root, "Schematic")));
    expect(report.warnings).toEqual([]);
  });

  it("survives every possible chunk boundary", async () => {
    // Worst case: a one byte source forces varints and tags to straddle reads.
    const encoded = encodeFile(spongeV2(), "Schematic", false);
    let at = 0;
    const reader = new NbtReader({
      next: async () => {
        if (at >= encoded.length) return { done: true, value: undefined };
        return { done: false, value: encoded.subarray(at++, at) };
      },
    });
    const names: string[] = [];
    await walk(reader, (path) => {
      names.push(path);
      return SKIP;
    });
    expect(names).toContain("/BlockData");
  });
});

describe("Litematica", () => {
  const litematic = (regions: Record<string, NbtTag>): NbtTag =>
    compound({
      MinecraftDataVersion: nbt.int(3700),
      Version: nbt.int(6),
      Metadata: compound({
        Name: nbt.string("test"),
        RegionCount: nbt.int(Object.keys(regions).length),
        EnclosingSize: compound({ x: nbt.int(W), y: nbt.int(H), z: nbt.int(L) }),
      }),
      Regions: compound(regions),
    });

  const paletteList = list(
    TAG.Compound,
    compound({ Name: nbt.string("minecraft:air") }),
    compound({ Name: nbt.string("minecraft:stone") }),
    compound({ Name: nbt.string("minecraft:red_wool") }),
    compound({
      Name: nbt.string("minecraft:oak_stairs"),
      Properties: compound({
        facing: nbt.string("west"),
        half: nbt.string("bottom"),
        shape: nbt.string("straight"),
        waterlogged: nbt.string("false"),
      }),
    }),
    compound({ Name: nbt.string("minecraft:deepslate"), Properties: compound({ axis: nbt.string("y") }) }),
  );

  const region = (position: [number, number, number], size: [number, number, number], states: bigint[], palette = paletteList, extra: Record<string, NbtTag> = {}): NbtTag =>
    compound({
      Position: compound({ x: nbt.int(position[0]), y: nbt.int(position[1]), z: nbt.int(position[2]) }),
      Size: compound({ x: nbt.int(size[0]), y: nbt.int(size[1]), z: nbt.int(size[2]) }),
      BlockStatePalette: palette,
      BlockStates: longs(states),
      TileEntities: list(TAG.Compound),
      Entities: list(TAG.Compound),
      ...extra,
    });

  it("unpacks bit-packed blocks that straddle longs", async () => {
    const path = ws.write("a.litematic", encodeFile(litematic({ main: region([0, 0, 0], [W, H, L], packLitematic(values, 3)) })));
    const info = await inspectFile(path);
    expect(info).toMatchObject({ format: "litematic", regionCount: 1, versionLabel: expect.any(String) });
    await convert(ws, path);
    await expectPattern(join(ws.outDir, "a.schematic"));
  });

  it("uses the minimum of 2 bits per entry", async () => {
    const small = list(TAG.Compound, compound({ Name: nbt.string("minecraft:air") }), compound({ Name: nbt.string("minecraft:gold_block") }));
    const data = [0, 1, 1, 0, 1, 0, 0, 1];
    const path = ws.write("two.litematic", encodeFile(litematic({ main: region([0, 0, 0], [2, 2, 2], packLitematic(data, 2), small) })));
    await convert(ws, path);
    const schematic = await readSchematic(join(ws.outDir, "two.schematic"));
    expect(schematic.at(1, 0, 0)).toEqual([41, 0]);
    expect(schematic.at(0, 0, 0)).toEqual([0, 0]);
    expect(schematic.at(1, 1, 1)).toEqual([41, 0]);
  });

  it("takes the air fast path without losing alignment", async () => {
    // Long runs of air with blocks at awkward offsets, at bit widths that don't divide 64.
    for (const bits of [2, 3, 5, 7, 9, 13]) {
      const count = 1 << bits;
      const entries: NbtTag[] = [];
      for (let i = 0; i < count; i++) entries.push(compound({ Name: nbt.string(i === 0 ? "minecraft:air" : i === 1 ? "minecraft:gold_block" : "minecraft:stone") }));
      const data = new Array<number>(4000).fill(0);
      for (const at of [0, 1, 7, 8, 63, 64, 65, 200, 999, 1000, 1001, 2047, 2048, 3998, 3999]) data[at] = 1;
      const path = ws.write(`air${bits}.litematic`, encodeFile(litematic({ main: region([0, 0, 0], [4000, 1, 1], packLitematic(data, bits), list(TAG.Compound, ...entries)) })));
      const report = await convert(ws, path);
      const schematic = await readSchematic(join(ws.outDir, `air${bits}.schematic`));
      for (let i = 0; i < 4000; i++) {
        expect(schematic.at(i, 0, 0)[0], `bits=${bits} block=${i}`).toBe(data[i] === 1 ? 41 : 0);
      }
      expect(report.blocks.find((row) => row.name === "minecraft:air")?.count).toBe(3985);
    }
  });

  it("works with wide palettes where entries span two longs often", async () => {
    const entries: NbtTag[] = [];
    for (let i = 0; i < 300; i++) entries.push(compound({ Name: nbt.string(i === 299 ? "minecraft:gold_block" : `mod:b${i}`) }));
    const data = Array.from({ length: 100 }, (_, i) => (i % 10 === 3 ? 299 : i));
    const path = ws.write("wide.litematic", encodeFile(litematic({ main: region([0, 0, 0], [100, 1, 1], packLitematic(data, 9), list(TAG.Compound, ...entries)) })));
    await convert(ws, path);
    const schematic = await readSchematic(join(ws.outDir, "wide.schematic"));
    for (let i = 0; i < 100; i++) expect(schematic.at(i, 0, 0)[0], String(i)).toBe(i % 10 === 3 ? 41 : 0);
  });

  it("merges several regions, including negative sizes, into one box", async () => {
    const gold = list(TAG.Compound, compound({ Name: nbt.string("minecraft:air") }), compound({ Name: nbt.string("minecraft:gold_block") }));
    const iron = list(TAG.Compound, compound({ Name: nbt.string("minecraft:air") }), compound({ Name: nbt.string("minecraft:iron_block") }));
    const path = ws.write(
      "multi.litematic",
      encodeFile(
        litematic({
          first: region([0, 0, 0], [2, 1, 1], packLitematic([1, 0], 2), gold),
          // Negative size: spans x 4..5 going down from position 5.
          second: region([5, 2, 3], [-2, 1, 1], packLitematic([0, 1], 2), iron),
        }),
      ),
    );
    const report = await convert(ws, path);
    const schematic = await readSchematic(join(ws.outDir, "multi.schematic"));
    expect([schematic.width, schematic.height, schematic.length]).toEqual([6, 3, 4]);
    expect(schematic.at(0, 0, 0)).toEqual([41, 0]);
    expect(schematic.at(1, 0, 0)).toEqual([0, 0]);
    expect(schematic.at(5, 2, 3)).toEqual([42, 0]);
    expect(schematic.at(4, 2, 3)).toEqual([0, 0]);
    expect(report.blocks.find((row) => row.name === "minecraft:gold_block")?.count).toBe(1);
  });

  it("places tile entities and entities relative to their region", async () => {
    const chest = list(
      TAG.Compound,
      compound({ Name: nbt.string("minecraft:air") }),
      compound({ Name: nbt.string("minecraft:chest"), Properties: compound({ facing: nbt.string("north"), type: nbt.string("single"), waterlogged: nbt.string("false") }) }),
    );
    const path = ws.write(
      "tiles.litematic",
      encodeFile(
        litematic({
          main: region([0, 0, 0], [2, 1, 1], packLitematic([0, 1], 2), chest, {
            TileEntities: list(
              TAG.Compound,
              compound({
                x: nbt.int(1),
                y: nbt.int(0),
                z: nbt.int(0),
                Items: list(TAG.Compound, compound({ Slot: nbt.byte(0), id: nbt.string("minecraft:lime_wool"), count: nbt.int(3) })),
              }),
            ),
            Entities: list(TAG.Compound, compound({ id: nbt.string("minecraft:zombie"), Pos: doubles(0.5, 0, 0.5) })),
          }),
        }),
      ),
    );
    const report = await convert(ws, path);
    const schematic = await readSchematic(join(ws.outDir, "tiles.schematic"));
    expect(schematic.tiles).toHaveLength(1);
    expect(schematic.tiles[0]).toMatchObject({
      id: "Chest",
      x: 1,
      Items: [{ id: "minecraft:wool", Damage: 5, Count: 3, Slot: 0 }],
    });
    expect(schematic.entities).toHaveLength(1);
    expect(schematic.entities[0]).toMatchObject({ id: "Zombie", Pos: [0.5, 0, 0.5] });
    expect(report).toMatchObject({ tileEntitiesWritten: 1, entitiesWritten: 1 });
  });
});

describe("structure .nbt", () => {
  it("fills unlisted blocks with air, with the palette after the blocks like vanilla writes it", async () => {
    const root = compound({
      size: list(TAG.Int, nbt.int(2), nbt.int(2), nbt.int(2)),
      entities: list(TAG.Compound),
      blocks: list(
        TAG.Compound,
        compound({ state: nbt.int(0), pos: list(TAG.Int, nbt.int(1), nbt.int(1), nbt.int(0)) }),
        compound({ state: nbt.int(1), pos: list(TAG.Int, nbt.int(0), nbt.int(0), nbt.int(1)) }),
      ),
      palette: list(
        TAG.Compound,
        compound({ Name: nbt.string("minecraft:gold_block") }),
        compound({ Name: nbt.string("minecraft:oak_log"), Properties: compound({ axis: nbt.string("x") }) }),
      ),
      DataVersion: nbt.int(3465),
    });
    const path = ws.write("house.nbt", encodeFile(root));
    expect((await inspectFile(path)).format).toBe("structure");
    await convert(ws, path);
    const schematic = await readSchematic(join(ws.outDir, "house.schematic"));
    expect(schematic.at(1, 1, 0)).toEqual([41, 0]);
    expect(schematic.at(0, 0, 1)).toEqual([17, 4]);
    expect(schematic.at(0, 0, 0)).toEqual([0, 0]);
  });

  it("reads the lowercase keys Minecraft 26.4 switched to", async () => {
    const root = compound({
      size: list(TAG.Int, nbt.int(2), nbt.int(1), nbt.int(1)),
      entities: list(TAG.End),
      blocks: list(
        TAG.Compound,
        compound({ state: nbt.int(0), pos: list(TAG.Int, nbt.int(0), nbt.int(0), nbt.int(0)) }),
        compound({ state: nbt.int(1), pos: list(TAG.Int, nbt.int(1), nbt.int(0), nbt.int(0)) }),
      ),
      palette: list(
        TAG.Compound,
        compound({ id: nbt.string("minecraft:gold_block") }),
        compound({ id: nbt.string("minecraft:oak_log"), properties: compound({ axis: nbt.string("x") }) }),
      ),
      DataVersion: nbt.int(5126),
    });
    const path = ws.write("new.nbt", encodeFile(root));
    await convert(ws, path);
    const schematic = await readSchematic(join(ws.outDir, "new.schematic"));
    expect(schematic.at(0, 0, 0)).toEqual([41, 0]);
    expect(schematic.at(1, 0, 0)).toEqual([17, 4]);
  });

  it("reports palette entries it can't read instead of turning them into air", async () => {
    const root = compound({
      size: list(TAG.Int, nbt.int(1), nbt.int(1), nbt.int(1)),
      blocks: list(TAG.Compound, compound({ state: nbt.int(0), pos: list(TAG.Int, nbt.int(0), nbt.int(0), nbt.int(0)) })),
      palette: list(TAG.Compound, compound({ future_key: nbt.string("minecraft:stone") })),
    });
    const path = ws.write("odd.nbt", encodeFile(root));
    const report = await convert(ws, path, { fallback: "19:0" });
    expect(report.blocks[0]).toMatchObject({ kind: "unmapped", id: 19 });
    expect(report.warnings.join(" ")).toContain("malformed_palette_entry");
  });

  it("keeps block entity data", async () => {
    const root = compound({
      size: list(TAG.Int, nbt.int(1), nbt.int(1), nbt.int(1)),
      palette: list(TAG.Compound, compound({ Name: nbt.string("minecraft:oak_sign"), Properties: compound({ rotation: nbt.string("4"), waterlogged: nbt.string("false") }) })),
      blocks: list(
        TAG.Compound,
        compound({
          state: nbt.int(0),
          pos: list(TAG.Int, nbt.int(0), nbt.int(0), nbt.int(0)),
          nbt: compound({
            id: nbt.string("minecraft:sign"),
            front_text: compound({ messages: list(TAG.String, nbt.string('{"text":"hello"}'), nbt.string('""'), nbt.string('""'), nbt.string('""')) }),
          }),
        }),
      ),
    });
    const path = ws.write("sign.nbt", encodeFile(root));
    await convert(ws, path);
    const schematic = await readSchematic(join(ws.outDir, "sign.schematic"));
    expect(schematic.tiles[0]).toMatchObject({ id: "Sign", Text1: '{"text":"hello"}', Text2: '{"text":""}' });
  });
});

describe("legacy .schematic", () => {
  const legacy = (ids: number[], data: number[], extra: Record<string, NbtTag> = {}): NbtTag =>
    compound({
      Width: nbt.short(ids.length),
      Height: nbt.short(1),
      Length: nbt.short(1),
      Materials: nbt.string("Alpha"),
      Blocks: bytes(ids.map((value) => (value > 127 ? value - 256 : value))),
      Data: bytes(data),
      Entities: list(TAG.Compound),
      TileEntities: list(TAG.Compound),
      ...extra,
    });

  it("maps 1.12 blocks down and keeps 1.8 blocks untouched", async () => {
    const path = ws.write("old.schematic", encodeFile(legacy([1, 251, 35, 216], [2, 14, 5, 0]), "Schematic"));
    const report = await convert(ws, path);
    const schematic = await readSchematic(join(ws.outDir, "old.schematic"));
    expect(schematic.at(0, 0, 0)).toEqual([1, 2]);
    expect(schematic.at(1, 0, 0)).toEqual([159, 14]);
    expect(schematic.at(2, 0, 0)).toEqual([35, 5]);
    expect(schematic.at(3, 0, 0)[0]).toBe(155);
    expect(report.blocks.find((row) => row.name === "minecraft:red_concrete")).toMatchObject({ kind: "substitute" });
  });

  it("reads AddBlocks for ids above 255", async () => {
    // Block 0 gets +0x0100 from the low nibble, block 1 gets nothing.
    const path = ws.write("add.schematic", encodeFile(legacy([0xf4, 1], [0, 0], { AddBlocks: bytes([0x01]) }), "Schematic"));
    const report = await convert(ws, path, { fallback: "19:0" });
    const schematic = await readSchematic(join(ws.outDir, "add.schematic"));
    expect(schematic.at(0, 0, 0)).toEqual([19, 0]);
    expect(schematic.at(1, 0, 0)).toEqual([1, 0]);
    expect(report.blocks.some((row) => row.kind === "unmapped")).toBe(true);
  });

  // Set SAMPLE_SCHEMATIC to any real 1.8 .schematic with signs in it.
  it.skipIf(!process.env.SAMPLE_SCHEMATIC)("carries tile entities through from a real-world 1.8 file", async () => {
    const path = ws.write("real.schematic", readFileSync(process.env.SAMPLE_SCHEMATIC!));
    const before = await readSchematic(path);
    await convert(ws, path);
    const after = await readSchematic(join(ws.outDir, "real.schematic"));
    expect([after.width, after.height, after.length]).toEqual([before.width, before.height, before.length]);
    expect(after.raw.Blocks).toEqual(before.raw.Blocks);
    expect(after.raw.Data).toEqual(before.raw.Data);
    expect(after.tiles.length).toBe(before.tiles.length);
    expect(after.tiles[0]).toMatchObject({ id: "Sign", Text1: '{"text":""}' });
  });
});

describe("block entities", () => {
  const single = (state: string, tile?: Record<string, NbtTag>): NbtTag =>
    compound({
      Version: nbt.int(2),
      Width: nbt.short(1),
      Height: nbt.short(1),
      Length: nbt.short(1),
      Palette: compound({ [state]: nbt.int(0) }),
      BlockData: varints([0]),
      BlockEntities: tile ? list(TAG.Compound, compound({ Pos: ints(0, 0, 0), ...tile })) : list(TAG.Compound),
    });

  const tileOf = async (state: string, tile?: Record<string, NbtTag>) => {
    const path = ws.write("x.schem", encodeFile(single(state, tile), "Schematic"));
    await convert(ws, path);
    const schematic = await readSchematic(join(ws.outDir, "x.schematic"));
    return { schematic, tile: schematic.tiles[0] };
  };

  it("creates flower pot contents from the block state", async () => {
    const { schematic, tile } = await tileOf("minecraft:potted_blue_orchid");
    expect(schematic.at(0, 0, 0)).toEqual([140, 0]);
    expect(tile).toMatchObject({ id: "FlowerPot", Item: "minecraft:red_flower", Data: 1 });
  });

  it("creates note block pitch from the block state", async () => {
    const { tile } = await tileOf("minecraft:note_block[instrument=harp,note=12,powered=false]");
    expect(tile).toMatchObject({ id: "Music", note: 12 });
  });

  it("converts modern signs, including ones with SNBT text", async () => {
    const { tile } = await tileOf("minecraft:oak_wall_sign[facing=north,waterlogged=false]", {
      Id: nbt.string("minecraft:sign"),
      front_text: compound({
        messages: list(
          TAG.Compound,
          compound({ text: nbt.string("Line one"), color: nbt.string("red") }),
          compound({ text: nbt.string("") }),
          compound({ text: nbt.string("") }),
          compound({ text: nbt.string("") }),
        ),
      }),
    });
    expect(tile).toMatchObject({ id: "Sign", Text1: '{"text":"Line one","color":"red"}', Text2: '{"text":""}' });
  });

  it("converts plain string sign text to JSON", async () => {
    const { tile } = await tileOf("minecraft:oak_sign[rotation=0,waterlogged=false]", {
      front_text: compound({ messages: list(TAG.String, nbt.string("plain"), nbt.string(""), nbt.string(""), nbt.string("")) }),
    });
    expect(tile).toMatchObject({ Text1: '{"text":"plain"}', Text2: '{"text":""}' });
  });

  it("keeps old style sign text", async () => {
    const { tile } = await tileOf("minecraft:oak_sign[rotation=0,waterlogged=false]", {
      Text1: nbt.string('{"text":"old"}'),
    });
    expect(tile).toMatchObject({ Text1: '{"text":"old"}', Text4: '{"text":""}' });
  });

  it("converts banners with 1.20.5 patterns, flipping colour ids", async () => {
    const { tile, schematic } = await tileOf("minecraft:red_banner[rotation=4]", {
      patterns: list(TAG.Compound, compound({ pattern: nbt.string("minecraft:creeper"), color: nbt.string("white") })),
    });
    expect(schematic.at(0, 0, 0)).toEqual([176, 4]);
    expect(tile).toMatchObject({ id: "Banner", Base: 1, Patterns: [{ Pattern: "cre", Color: 15 }] });
  });

  it("converts player heads and keeps their texture", async () => {
    const { tile, schematic } = await tileOf("minecraft:player_head[rotation=9]", {
      profile: compound({
        name: nbt.string("Steve"),
        id: ints(1, 2, 3, 4),
        properties: list(TAG.Compound, compound({ name: nbt.string("textures"), value: nbt.string("abc"), signature: nbt.string("sig") })),
      }),
    });
    expect(schematic.at(0, 0, 0)).toEqual([144, 1]);
    expect(tile).toMatchObject({
      id: "Skull",
      SkullType: 3,
      Rot: 9,
      Owner: {
        Id: "00000001-0000-0002-0000-000300000004",
        Name: "Steve",
        Properties: { textures: [{ Value: "abc", Signature: "sig" }] },
      },
    });
  });

  it("derives the skull type from the block name", async () => {
    const { tile } = await tileOf("minecraft:creeper_head[rotation=0]");
    expect(tile).toMatchObject({ id: "Skull", SkullType: 4, Rot: 0 });
  });

  it("maps spawners to the 1.8 entity name", async () => {
    const { tile } = await tileOf("minecraft:spawner", {
      SpawnData: compound({ entity: compound({ id: nbt.string("minecraft:zombie") }) }),
    });
    expect(tile).toMatchObject({ id: "MobSpawner", EntityId: "Zombie" });
  });

  it("turns a barrel into a working chest and keeps its items", async () => {
    const { tile, schematic } = await tileOf("minecraft:barrel[facing=north,open=false]", {
      Id: nbt.string("minecraft:barrel"),
      Items: list(
        TAG.Compound,
        compound({ Slot: nbt.byte(4), id: nbt.string("minecraft:diamond_sword"), count: nbt.int(1), components: compound({ "minecraft:enchantments": compound({ levels: compound({ "minecraft:sharpness": nbt.int(5) }) }), "minecraft:custom_name": nbt.string('{"text":"Blade","color":"gold"}') }) }),
        compound({ Slot: nbt.byte(5), id: nbt.string("minecraft:netherite_sword"), count: nbt.int(1) }),
        compound({ Slot: nbt.byte(6), id: nbt.string("minecraft:echo_shard"), count: nbt.int(1) }),
      ),
    });
    expect(schematic.at(0, 0, 0)).toEqual([54, 2]);
    expect(tile).toMatchObject({
      id: "Chest",
      Items: [
        { Slot: 4, id: "minecraft:diamond_sword", Count: 1, tag: { display: { Name: "\u00a76Blade" }, ench: [{ id: 16, lvl: 5 }] } },
        { Slot: 5, id: "minecraft:diamond_sword" },
      ],
    });
  });

  it("converts potions to their 1.8 damage values", async () => {
    const { tile } = await tileOf("minecraft:chest[facing=north,type=single,waterlogged=false]", {
      Items: list(
        TAG.Compound,
        compound({ Slot: nbt.byte(0), id: nbt.string("minecraft:potion"), count: nbt.int(1), components: compound({ "minecraft:potion_contents": compound({ potion: nbt.string("minecraft:strong_healing") }) }) }),
        compound({ Slot: nbt.byte(1), id: nbt.string("minecraft:splash_potion"), Count: nbt.byte(1), tag: compound({ Potion: nbt.string("minecraft:long_swiftness") }) }),
      ),
    });
    expect(tile).toMatchObject({
      Items: [
        { id: "minecraft:potion", Damage: 8229 },
        { id: "minecraft:potion", Damage: 16386 + 64 },
      ],
    });
  });

  it("reports block entities it can't keep", async () => {
    const path = ws.write("x.schem", encodeFile(single("minecraft:lime_shulker_box[facing=up]", { Id: nbt.string("minecraft:shulker_box") }), "Schematic"));
    const report = await convert(ws, path);
    expect(report.warnings.join(" ")).toContain("shulker_box");
  });

  it("skips all of it when asked to", async () => {
    const path = ws.write("x.schem", encodeFile(single("minecraft:potted_poppy"), "Schematic"));
    const report = await convert(ws, path, { keepTileEntities: false });
    expect(report.tileEntitiesWritten).toBe(0);
    const schematic = await readSchematic(join(ws.outDir, "x.schematic"));
    expect(schematic.tiles).toEqual([]);
  });
});

describe("entities", () => {
  const withEntities = (entities: NbtTag[], extra: Record<string, NbtTag> = {}): NbtTag =>
    compound({
      Version: nbt.int(2),
      Width: nbt.short(10),
      Height: nbt.short(1),
      Length: nbt.short(10),
      Offset: ints(100, 60, 200),
      Palette: compound({ "minecraft:air": nbt.int(0) }),
      BlockData: varints(new Array<number>(100).fill(0)),
      Entities: list(TAG.Compound, ...entities),
      ...extra,
    });

  it("stores world coordinates next to WEOrigin, from either source convention", async () => {
    const path = ws.write(
      "e.schem",
      encodeFile(
        withEntities([
          compound({ Id: nbt.string("minecraft:armor_stand"), Pos: doubles(103.5, 60, 205.5) }),
          compound({ Id: nbt.string("minecraft:armor_stand"), Pos: doubles(3.5, 0, 5.5) }),
        ]),
        "Schematic",
      ),
    );
    await convert(ws, path);
    const schematic = await readSchematic(join(ws.outDir, "e.schematic"));
    expect(schematic.entities[0]).toMatchObject({ id: "ArmorStand", Pos: [103.5, 60, 205.5] });
    expect(schematic.entities[1]).toMatchObject({ id: "ArmorStand", Pos: [103.5, 60, 205.5] });
  });

  it("converts armor stand equipment and paintings, and drops what 1.8 doesn't have", async () => {
    const path = ws.write(
      "e.schem",
      encodeFile(
        withEntities([
          compound({
            Id: nbt.string("minecraft:armor_stand"),
            Pos: doubles(101, 60, 201),
            ArmorItems: list(
              TAG.Compound,
              compound({ id: nbt.string("minecraft:iron_boots"), count: nbt.int(1) }),
              compound(),
              compound(),
              compound({ id: nbt.string("minecraft:golden_helmet"), Count: nbt.byte(1) }),
            ),
            HandItems: list(TAG.Compound, compound({ id: nbt.string("minecraft:stick"), count: nbt.int(1) }), compound()),
            ShowArms: nbt.byte(1),
          }),
          compound({
            Id: nbt.string("minecraft:painting"),
            Pos: doubles(102.5, 60.5, 202),
            variant: nbt.string("minecraft:kebab"),
            facing: nbt.byte(3),
            TileX: nbt.int(102),
            TileY: nbt.int(60),
            TileZ: nbt.int(202),
          }),
          compound({ Id: nbt.string("minecraft:axolotl"), Pos: doubles(101, 60, 201) }),
        ]),
        "Schematic",
      ),
    );
    const report = await convert(ws, path);
    const schematic = await readSchematic(join(ws.outDir, "e.schematic"));
    expect(schematic.entities).toHaveLength(2);
    expect(schematic.entities[0]).toMatchObject({
      id: "ArmorStand",
      ShowArms: 1,
      Equipment: [
        { id: "minecraft:stick" },
        { id: "minecraft:iron_boots" },
        {},
        {},
        { id: "minecraft:golden_helmet" },
      ],
    });
    expect(schematic.entities[1]).toMatchObject({ id: "Painting", Motive: "Kebab", Facing: 0, TileX: 102, TileZ: 202 });
    expect(report.warnings.join(" ")).toContain("axolotl");
  });
});

describe("splitting big maps", () => {
  const big = (width: number, length: number): { root: NbtTag; at: (x: number, z: number) => number } => {
    const at = (x: number, z: number): number => ((x + z * 3) % 7 === 0 ? 1 : 0);
    const data: number[] = [];
    for (let z = 0; z < length; z++) for (let x = 0; x < width; x++) data.push(at(x, z));
    return {
      at,
      root: compound({
        Version: nbt.int(2),
        Width: nbt.short(width),
        Height: nbt.short(1),
        Length: nbt.short(length),
        Offset: ints(1000, 64, 2000),
        Metadata: compound({ WEOffsetX: nbt.int(5), WEOffsetY: nbt.int(0), WEOffsetZ: nbt.int(7) }),
        Palette: compound({ "minecraft:air": nbt.int(0), "minecraft:stone": nbt.int(1) }),
        BlockData: varints(data),
      }),
    };
  };

  it("splits into a grid and every block lands in the right file", async () => {
    const { root, at } = big(25, 13);
    const path = ws.write("map.schem", encodeFile(root, "Schematic"));
    const report = await convert(ws, path, { tileSize: 10 });
    expect(outputs(ws).filter((name) => name.endsWith(".schematic"))).toEqual([
      "map_x0_z0.schematic",
      "map_x0_z1.schematic",
      "map_x1_z0.schematic",
      "map_x1_z1.schematic",
      "map_x2_z0.schematic",
      "map_x2_z1.schematic",
    ]);
    expect(report.split).toBe(true);
    for (const output of report.outputs) {
      const schematic = await readSchematic(output.path);
      expect(schematic.width).toBe(output.tileX === 2 ? 5 : 10);
      expect(schematic.length).toBe(output.tileZ === 1 ? 3 : 10);
      for (let z = 0; z < schematic.length; z++) {
        for (let x = 0; x < schematic.width; x++) {
          expect(schematic.at(x, 0, z)[0]).toBe(at(x + output.tileX * 10, z + output.tileZ * 10));
        }
      }
    }
  });

  it("keeps tiles aligned: pasting them all from one spot rebuilds the map", async () => {
    const { root } = big(25, 13);
    const path = ws.write("map.schem", encodeFile(root, "Schematic"));
    const report = await convert(ws, path, { tileSize: 10 });
    const tile = report.outputs.find((output) => output.tileX === 2 && output.tileZ === 1)!;
    const { raw } = await readSchematic(tile.path);
    expect(raw).toMatchObject({ WEOriginX: 1020, WEOriginZ: 2010, WEOffsetX: 25, WEOffsetZ: 17 });
  });

  it("makes tile entity positions relative to their own file", async () => {
    const root = compound({
      Version: nbt.int(2),
      Width: nbt.short(4),
      Height: nbt.short(1),
      Length: nbt.short(1),
      Palette: compound({ "minecraft:air": nbt.int(0), "minecraft:chest[facing=north,type=single,waterlogged=false]": nbt.int(1) }),
      BlockData: varints([0, 0, 0, 1]),
      BlockEntities: list(TAG.Compound, compound({ Pos: ints(3, 0, 0), Items: list(TAG.Compound) })),
    });
    const path = ws.write("m.schem", encodeFile(root, "Schematic"));
    const report = await convert(ws, path, { tileSize: 2 });
    expect(report.outputs).toHaveLength(1); // The first tile is all air and is dropped.
    const schematic = await readSchematic(report.outputs[0]!.path);
    expect(schematic.tiles[0]).toMatchObject({ id: "Chest", x: 1, y: 0, z: 0 });
    expect(report.outputs[0]).toMatchObject({ tileX: 1 });
  });

  it("forces a split when the format can't hold the map", () => {
    const fits = planTiles(1000, 256, 1000, 0);
    expect(fits.layout.columns * fits.layout.rows).toBe(1);
    expect(fits.forced).toBe(false);

    const tooManyBlocks = planTiles(4096, 256, 4096, 0);
    expect(tooManyBlocks.forced).toBe(true);
    expect(tooManyBlocks.layout).toMatchObject({ columns: 2, rows: 2, tileWidth: 2048, tileLength: 2048 });
    expect(tooManyBlocks.layout.tileWidth * 256 * tooManyBlocks.layout.tileLength).toBeLessThanOrEqual(2147483647);

    // Requested sizes are kept, even with a smaller last column.
    expect(planTiles(1000, 256, 1000, 512).layout).toMatchObject({ columns: 2, tileWidth: 512 });

    const tooWide = planTiles(40000, 1, 10, 0);
    expect(tooWide.forced).toBe(true);
    expect(tooWide.layout.tileWidth).toBeLessThanOrEqual(32767);
  });
});

describe("output", () => {
  it("writes one valid gzip member with a correct checksum at every compression level", async () => {
    const data = Array.from({ length: 200000 }, (_, i) => (i % 97 === 0 ? 1 : i % 5 === 0 ? 2 : 0));
    const root = compound({
      Version: nbt.int(2),
      Width: nbt.short(500),
      Height: nbt.short(4),
      Length: nbt.short(100),
      Palette: compound({ "minecraft:air": nbt.int(0), "minecraft:stone": nbt.int(1), "minecraft:dirt": nbt.int(2) }),
      BlockData: varints(data),
    });
    const path = ws.write("g.schem", encodeFile(root, "Schematic"));
    const sizes: number[] = [];
    for (const compression of ["fast", "balanced", "small"] as const) {
      const report = await convert(ws, path, { compression });
      const file = readFileSync(report.outputs[0]!.path);
      sizes.push(file.length);
      // zlib verifies the CRC and length; a bad splice throws here.
      const inflated = zlib.gunzipSync(file);
      // A second member would mean we aren't producing one continuous stream.
      expect(file[0]).toBe(0x1f);
      expect(inflated.length).toBeGreaterThan(400000);
      const schematic = await readSchematic(report.outputs[0]!.path);
      expect(schematic.at(0, 0, 0)).toEqual([1, 0]);
      expect(schematic.at(5, 0, 0)).toEqual([3, 0]);
    }
    expect(sizes[2]!).toBeLessThanOrEqual(sizes[0]!);
  });

  it("doesn't overwrite an existing file unless told to", async () => {
    const root = compound({
      Version: nbt.int(2),
      Width: nbt.short(1),
      Height: nbt.short(1),
      Length: nbt.short(1),
      Palette: compound({ "minecraft:stone": nbt.int(0) }),
      BlockData: varints([0]),
    });
    const path = ws.write("same.schem", encodeFile(root, "Schematic"));
    await convert(ws, path, { overwrite: false });
    const second = await convert(ws, path, { overwrite: false });
    expect(second.outputs[0]!.path).toMatch(/same \(2\)\.schematic$/);
    expect(outputs(ws)).toEqual(["same (2).schematic", "same.schematic"]);
  });

  it("combines CRCs like zlib", () => {
    const a = randomBytes(100000);
    const b = randomBytes(54321);
    const whole = zlib.crc32(Buffer.concat([a, b]));
    expect(crc32Combine(zlib.crc32(a), zlib.crc32(b), b.length)).toBe(whole);
    expect(crc32Combine(zlib.crc32(a), zlib.crc32(Buffer.alloc(0)), 0)).toBe(zlib.crc32(a));
  });
});

describe("NBT walker", () => {
  it("skips deeply mixed values without reading them", async () => {
    const root = compound({
      skipMe: compound({
        a: list(TAG.Compound, compound({ b: longs([1n, 2n]) }), compound({ c: ints(1, 2, 3) })),
        s: nbt.string("hello"),
        d: doubles(1, 2),
      }),
      wanted: nbt.int(42),
    });
    const encoded = encodeFile(root, "", false);
    let at = 0;
    const reader = new NbtReader({
      next: async () => {
        if (at >= encoded.length) return { done: true, value: undefined };
        const chunk = encoded.subarray(at, at + 3);
        at += 3;
        return { done: false, value: chunk };
      },
    });
    let wanted: number | undefined;
    await walk(reader, (path) =>
      path === "/wanted" ? { kind: "value", use: (tag) => void (wanted = tag.t === 3 ? tag.v : undefined) } : SKIP,
    );
    expect(wanted).toBe(42);
  });

  it("refuses absurd nesting instead of overflowing the stack", async () => {
    const encoded: number[] = [10, 0, 0];
    for (let i = 0; i < 20000; i++) encoded.push(10, 0, 1, 0x61);
    let sent = false;
    const reader = new NbtReader({
      next: async () => {
        if (sent) return { done: true, value: undefined };
        sent = true;
        return { done: false, value: Buffer.from(encoded) };
      },
    });
    await expect(walk(reader, () => ENTER)).rejects.toThrow(/nested too deeply/);
  });
});
