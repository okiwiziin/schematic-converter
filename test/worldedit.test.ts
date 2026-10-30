// Checks real output against the real WorldEdit 6.1 reader, the one 1.8.8 servers run. Needs a
// JDK and the jars, so it only runs when WORLDEDIT_JARS points at a folder of
// worldedit-core-6.1.jar, guava, gson and jsr305. See the README.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nbt, TAG, type NbtTag } from "../src/engine/nbt/nbt";
import {
  compound,
  convert,
  doubles,
  encodeFile,
  ints,
  list,
  longs,
  packLitematic,
  readSchematic,
  varints,
  workspace,
  type Workspace,
} from "./helpers";

const jarDir = process.env.WORLDEDIT_JARS;
const enabled = Boolean(jarDir && existsSync(jarDir));

interface Loaded {
  file: string;
  size: [number, number, number];
  min: [number, number, number];
  origin: [number, number, number];
  hash: number;
  nonAir: number;
  tiles: { type: number; data: number; nbt: Record<string, unknown> }[];
  entities: { id: string; pos: [number, number, number]; nbt: Record<string, unknown> }[];
}

describe.skipIf(!enabled)("the real WorldEdit 6.1 reader", () => {
  let ws: Workspace;
  let classDir: string;
  let classpath: string;

  beforeAll(() => {
    ws = workspace();
    classDir = join(ws.dir, "classes");
    mkdirSync(classDir);
    const jars = readdirSync(jarDir!).filter((name) => name.endsWith(".jar")).map((name) => join(jarDir!, name));
    classpath = jars.join(delimiter);
    execFileSync("javac", ["-nowarn", "-cp", classpath, "-d", classDir, join(process.cwd(), "test/worldedit/Harness.java")], {
      stdio: "pipe",
    });
  });
  afterAll(() => ws?.cleanup());

  const load = (path: string): Loaded => {
    const output = execFileSync("java", ["-Xmx4g", "-cp", `${classDir}${delimiter}${classpath}`, "Harness", path], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    return JSON.parse(output.trim()) as Loaded;
  };

  const hashOf = async (path: string): Promise<number> => {
    const schematic = await readSchematic(path);
    let hash = 0;
    for (let y = 0; y < schematic.height; y++) {
      for (let z = 0; z < schematic.length; z++) {
        for (let x = 0; x < schematic.width; x++) {
          const [id, data] = schematic.at(x, y, z);
          hash = (Math.imul(hash, 31) + ((id << 4) | data)) | 0;
        }
      }
    }
    return hash;
  };

  // A little of everything, in one .schem.
  const SHOWCASE: Record<string, number> = {
    "minecraft:air": 0,
    "minecraft:stone": 1,
    "minecraft:oak_wall_sign[facing=north,waterlogged=false]": 2,
    "minecraft:chest[facing=east,type=single,waterlogged=false]": 3,
    "minecraft:potted_poppy": 4,
    "minecraft:player_head[rotation=9]": 5,
    "minecraft:red_banner[rotation=4]": 6,
    "minecraft:note_block[instrument=harp,note=12,powered=false]": 7,
    "minecraft:deepslate[axis=y]": 8,
    "minecraft:red_concrete": 9,
    "minecraft:spawner": 10,
    "minecraft:oak_door[facing=north,half=upper,hinge=left,open=true,powered=false]": 11,
    "minecraft:dark_oak_stairs[facing=south,half=top,shape=outer_left,waterlogged=false]": 12,
    "minecraft:barrel[facing=north,open=false]": 13,
  };
  const SHOWCASE_DATA = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 0, 1];

  const showcase = (): NbtTag =>
    compound({
      Version: nbt.int(2),
      DataVersion: nbt.int(3465),
      Width: nbt.short(4),
      Height: nbt.short(2),
      Length: nbt.short(2),
      Offset: ints(100, 64, 200),
      Metadata: compound({ WEOffsetX: nbt.int(-2), WEOffsetY: nbt.int(0), WEOffsetZ: nbt.int(-3) }),
      Palette: compound(Object.fromEntries(Object.entries(SHOWCASE).map(([state, index]) => [state, nbt.int(index)]))),
      BlockData: varints(SHOWCASE_DATA),
      BlockEntities: list(
        TAG.Compound,
        compound({
          Id: nbt.string("minecraft:sign"),
          Pos: ints(2, 0, 0),
          front_text: compound({ messages: list(TAG.String, nbt.string('{"text":"Hello 1.8"}'), nbt.string('""'), nbt.string('""'), nbt.string('""')) }),
        }),
        compound({
          Id: nbt.string("minecraft:chest"),
          Pos: ints(3, 0, 0),
          Items: list(TAG.Compound, compound({ Slot: nbt.byte(1), id: nbt.string("minecraft:red_wool"), count: nbt.int(7) })),
        }),
        compound({
          Id: nbt.string("minecraft:skull"),
          Pos: ints(1, 0, 1),
          profile: compound({ name: nbt.string("Notch"), id: ints(1, 2, 3, 4) }),
        }),
        compound({
          Id: nbt.string("minecraft:banner"),
          Pos: ints(2, 0, 1),
          patterns: list(TAG.Compound, compound({ pattern: nbt.string("minecraft:creeper"), color: nbt.string("white") })),
        }),
      ),
      Entities: list(TAG.Compound, compound({ Id: nbt.string("minecraft:armor_stand"), Pos: doubles(101.5, 64, 200.5) })),
    });

  it("loads a converted .schem with every block in the right place", async () => {
    const path = ws.write("show.schem", encodeFile(showcase(), "Schematic"));
    const report = await convert(ws, path);
    const out = join(ws.outDir, "show.schematic");
    const loaded = load(out);

    expect(loaded.size).toEqual([4, 2, 2]);
    expect(loaded.min).toEqual([100, 64, 200]);
    // Origin = where the player stood, which //paste offsets from.
    expect(loaded.origin).toEqual([102, 64, 203]);
    expect(loaded.hash).toBe(await hashOf(out));
    expect(loaded.nonAir).toBe(report.nonAirBlocks);
  });

  it("sees every tile entity attached to its block", async () => {
    const path = ws.write("show.schem", encodeFile(showcase(), "Schematic"));
    await convert(ws, path);
    const { tiles } = load(join(ws.outDir, "show.schematic"));
    const of = (id: string) => tiles.find((tile) => tile.nbt.id === id);

    expect(of("Sign")).toMatchObject({ type: 68, data: 2, nbt: { Text1: '{"text":"Hello 1.8"}', x: 2, y: 0, z: 0 } });
    expect(of("Chest")).toMatchObject({
      type: 54,
      data: 5,
      nbt: { Items: [{ Slot: 1, id: "minecraft:wool", Damage: 14, Count: 7 }] },
    });
    expect(of("FlowerPot")).toMatchObject({ type: 140, nbt: { Item: "minecraft:red_flower", Data: 0 } });
    expect(of("Skull")).toMatchObject({ type: 144, data: 1, nbt: { SkullType: 3, Rot: 9, Owner: { Name: "Notch" } } });
    expect(of("Banner")).toMatchObject({ type: 176, data: 4, nbt: { Base: 1, Patterns: [{ Pattern: "cre", Color: 15 }] } });
    expect(of("Music")).toMatchObject({ type: 25, nbt: { note: 12 } });
    expect(of("MobSpawner")).toMatchObject({ type: 52, nbt: { EntityId: "Pig" } });
  });

  it("sees entities at their world position", async () => {
    const path = ws.write("show.schem", encodeFile(showcase(), "Schematic"));
    await convert(ws, path);
    const { entities } = load(join(ws.outDir, "show.schematic"));
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ id: "ArmorStand", pos: [101.5, 64, 200.5] });
  });

  it("loads litematic and structure conversions too", async () => {
    const lit = compound({
      MinecraftDataVersion: nbt.int(3700),
      Metadata: compound({
        RegionCount: nbt.int(1),
        EnclosingSize: compound({ x: nbt.int(2), y: nbt.int(1), z: nbt.int(2) }),
      }),
      Regions: compound({
        main: compound({
          Position: compound({ x: nbt.int(0), y: nbt.int(0), z: nbt.int(0) }),
          Size: compound({ x: nbt.int(2), y: nbt.int(1), z: nbt.int(2) }),
          BlockStatePalette: list(
            TAG.Compound,
            compound({ Name: nbt.string("minecraft:air") }),
            compound({ Name: nbt.string("minecraft:gold_block") }),
            compound({ Name: nbt.string("minecraft:red_concrete") }),
          ),
          BlockStates: longs(packLitematic([1, 0, 2, 1], 2)),
          TileEntities: list(TAG.Compound),
          Entities: list(TAG.Compound),
        }),
      }),
    });
    await convert(ws, ws.write("lit.litematic", encodeFile(lit)));
    const fromLit = load(join(ws.outDir, "lit.schematic"));
    expect(fromLit.size).toEqual([2, 1, 2]);
    expect(fromLit.nonAir).toBe(3);

    const structure = compound({
      size: list(TAG.Int, nbt.int(2), nbt.int(1), nbt.int(1)),
      blocks: list(TAG.Compound, compound({ state: nbt.int(0), pos: list(TAG.Int, nbt.int(1), nbt.int(0), nbt.int(0)) })),
      palette: list(TAG.Compound, compound({ Name: nbt.string("minecraft:gold_block") })),
      entities: list(TAG.Compound),
    });
    await convert(ws, ws.write("str.nbt", encodeFile(structure)));
    const fromStructure = load(join(ws.outDir, "str.schematic"));
    expect(fromStructure.nonAir).toBe(1);
  });

  it("lines split files up the way //paste would place them", async () => {
    const width = 25;
    const length = 13;
    const data: number[] = [];
    for (let z = 0; z < length; z++) for (let x = 0; x < width; x++) data.push((x + z) % 3 === 0 ? 1 : 0);
    const root = compound({
      Version: nbt.int(2),
      Width: nbt.short(width),
      Height: nbt.short(1),
      Length: nbt.short(length),
      Offset: ints(1000, 64, 2000),
      Metadata: compound({ WEOffsetX: nbt.int(5), WEOffsetY: nbt.int(1), WEOffsetZ: nbt.int(7) }),
      Palette: compound({ "minecraft:air": nbt.int(0), "minecraft:stone": nbt.int(1) }),
      BlockData: varints(data),
    });
    const report = await convert(ws, ws.write("big.schem", encodeFile(root, "Schematic")), { tileSize: 10 });
    expect(report.outputs.length).toBe(6);

    // Every piece must agree on where the player stood, so pasting from one spot rebuilds the map.
    const origins = new Set<string>();
    const covered = new Set<string>();
    for (const output of report.outputs) {
      const loaded = load(output.path);
      origins.add(loaded.origin.join(","));
      for (let z = 0; z < loaded.size[2]; z++) {
        for (let x = 0; x < loaded.size[0]; x++) covered.add(`${loaded.min[0] + x},${loaded.min[2] + z}`);
      }
    }
    expect([...origins]).toEqual(["995,63,1993"]);
    expect(covered.size).toBe(width * length);
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) expect(covered.has(`${1000 + x},${2000 + z}`)).toBe(true);
    }
  });

  it.skipIf(!process.env.SAMPLE_SCHEMATIC)("reads a real-world 1.8 file unchanged", async () => {
    const path = ws.write("real.schematic", readFileSync(process.env.SAMPLE_SCHEMATIC!));
    await convert(ws, path);
    const before = load(path);
    const after = load(join(ws.outDir, "real.schematic"));
    expect(after.size).toEqual(before.size);
    expect(after.hash).toBe(before.hash);
    expect(after.tiles.length).toBe(before.tiles.length);
  });
});
