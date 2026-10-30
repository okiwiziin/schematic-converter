import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BlockResolver } from "../src/engine/mapping/resolver";

const dataDir = join(process.cwd(), "node_modules/minecraft-data/minecraft-data/data/pc");

interface BlockState {
  name: string;
  type: string;
  values?: string[];
}

const blocksFor = (version: string): { name: string; states: BlockState[] }[] =>
  JSON.parse(readFileSync(join(dataDir, version, "blocks.json"), "utf8"));

const modernVersions = readdirSync(dataDir).filter(
  (version) => /^(1\.(1[3-9]|2\d)|2\d)/.test(version) && existsSync(join(dataDir, version, "blocks.json")),
);

const resolver = new BlockResolver();
const state = (text: string): [number, number] => {
  const { id, data } = resolver.resolveState(text);
  return [id, data];
};

describe("coverage", () => {
  it("found the data to test against", () => {
    expect(modernVersions.length).toBeGreaterThan(20);
  });

  it("maps every block in every version from 1.13 to the latest", () => {
    const unmapped = new Set<string>();
    for (const version of modernVersions) {
      for (const block of blocksFor(version)) {
        if (resolver.resolveParts(`minecraft:${block.name}`, {}).kind === "unmapped") {
          unmapped.add(`${block.name} (${version})`);
        }
      }
    }
    expect([...unmapped]).toEqual([]);
  });

  it("gives every state of every latest block a valid 1.8 id and data value", () => {
    const blocks = blocksFor(modernVersions.includes("26.1") ? "26.1" : modernVersions.at(-1)!);
    let checked = 0;
    for (const block of blocks) {
      // Walk the property combinations. Capped per block, since fence-like blocks have
      // thousands of states that all differ only in properties 1.8 doesn't store.
      const stateLists = block.states.map((property) =>
        (property.values ?? (property.type === "bool" ? ["true", "false"] : ["0"])).map((value) => [property.name, value] as const),
      );
      let combos: (readonly [string, string])[][] = [[]];
      for (const options of stateLists) {
        const next: (readonly [string, string])[][] = [];
        for (const combo of combos) for (const option of options) next.push([...combo, option]);
        combos = next.length > 400 ? next.slice(0, 400) : next;
      }
      for (const combo of combos) {
        const text = `minecraft:${block.name}[${combo.map(([key, value]) => `${key}=${value}`).join(",")}]`;
        const resolved = resolver.resolveState(text);
        expect(resolved.kind, text).not.toBe("unmapped");
        expect(resolved.id, text).toBeLessThanOrEqual(197);
        expect(resolved.data, text).toBeLessThanOrEqual(15);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10000);
  });
});

describe("exact mappings", () => {
  it.each([
    ["minecraft:air", [0, 0]],
    ["minecraft:cave_air", [0, 0]],
    ["minecraft:stone", [1, 0]],
    ["minecraft:granite", [1, 1]],
    ["minecraft:polished_andesite", [1, 6]],
    ["minecraft:grass_block[snowy=false]", [2, 0]],
    ["minecraft:coarse_dirt", [3, 1]],
    ["minecraft:spruce_planks", [5, 1]],
    ["minecraft:dark_oak_planks", [5, 5]],
    ["minecraft:water[level=0]", [9, 0]],
    ["minecraft:water[level=3]", [8, 3]],
    ["minecraft:lava[level=0]", [11, 0]],
    ["minecraft:oak_log[axis=y]", [17, 0]],
    ["minecraft:oak_log[axis=x]", [17, 4]],
    ["minecraft:birch_log[axis=z]", [17, 10]],
    ["minecraft:acacia_log[axis=y]", [162, 0]],
    ["minecraft:red_wool", [35, 14]],
    ["minecraft:white_wool", [35, 0]],
    ["minecraft:stone_slab[type=bottom,waterlogged=false]", [44, 0]],
    ["minecraft:stone_slab[type=top,waterlogged=false]", [44, 8]],
    ["minecraft:stone_slab[type=double,waterlogged=false]", [43, 0]],
    ["minecraft:smooth_stone_slab[type=bottom,waterlogged=false]", [44, 0]],
    ["minecraft:oak_slab[type=top,waterlogged=false]", [126, 8]],
    ["minecraft:torch", [50, 5]],
    ["minecraft:wall_torch[facing=north]", [50, 4]],
    ["minecraft:wall_torch[facing=east]", [50, 1]],
    ["minecraft:chest[facing=north,type=single,waterlogged=false]", [54, 2]],
    ["minecraft:chest[facing=east,type=left,waterlogged=false]", [54, 5]],
    ["minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]", [53, 0]],
    ["minecraft:oak_stairs[facing=west,half=bottom,shape=inner_left,waterlogged=false]", [53, 1]],
    ["minecraft:oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]", [53, 2]],
    ["minecraft:oak_stairs[facing=north,half=top,shape=straight,waterlogged=false]", [53, 7]],
    ["minecraft:oak_door[facing=east,half=lower,hinge=right,open=false,powered=false]", [64, 0]],
    ["minecraft:oak_door[facing=north,half=lower,hinge=right,open=true,powered=false]", [64, 7]],
    ["minecraft:oak_door[facing=north,half=upper,hinge=left,open=true,powered=false]", [64, 8]],
    ["minecraft:oak_door[facing=south,half=upper,hinge=right,open=false,powered=true]", [64, 11]],
    ["minecraft:red_bed[facing=south,occupied=false,part=foot]", [26, 0]],
    ["minecraft:red_bed[facing=north,occupied=false,part=head]", [26, 10]],
    ["minecraft:oak_sign[rotation=4,waterlogged=false]", [63, 4]],
    ["minecraft:oak_wall_sign[facing=north,waterlogged=false]", [68, 2]],
    ["minecraft:redstone_wire[east=none,north=side,power=5,south=up,west=none]", [55, 5]],
    ["minecraft:repeater[delay=3,facing=west,locked=false,powered=true]", [94, 9]],
    ["minecraft:furnace[facing=north,lit=true]", [62, 2]],
    ["minecraft:furnace[facing=north,lit=false]", [61, 2]],
    ["minecraft:oak_leaves[distance=7,persistent=true,waterlogged=false]", [18, 4]],
    ["minecraft:oak_leaves[distance=1,persistent=false,waterlogged=false]", [18, 0]],
    ["minecraft:oak_fence[east=true,north=true,south=false,waterlogged=false,west=false]", [85, 0]],
    ["minecraft:vine[east=false,north=true,south=true,up=false,west=false]", [106, 5]],
    ["minecraft:tall_grass[half=lower]", [175, 2]],
    ["minecraft:sunflower[half=lower]", [175, 0]],
    ["minecraft:snow[layers=3]", [78, 2]],
    ["minecraft:quartz_pillar[axis=x]", [155, 3]],
    ["minecraft:white_banner[rotation=8]", [176, 8]],
    ["minecraft:blue_banner[rotation=8]", [176, 8]],
    ["minecraft:red_wall_banner[facing=south]", [177, 3]],
    ["minecraft:skeleton_skull[rotation=7]", [144, 1]],
    ["minecraft:player_wall_head[facing=east]", [144, 5]],
    ["minecraft:potted_poppy", [140, 0]],
    ["minecraft:short_grass", [31, 1]],
    ["minecraft:grass", [31, 1]],
  ] as const)("%s", (text, expected) => {
    expect(state(text)).toEqual(expected);
  });

  it("does not flag renamed blocks as substitutions", () => {
    for (const name of ["cave_air", "short_grass", "oak_sign", "player_head", "blue_banner", "potted_poppy", "smooth_stone_slab"]) {
      expect(resolver.resolveParts(`minecraft:${name}`, {}).kind, name).toBe("exact");
    }
  });
});

describe("substitutions", () => {
  it.each([
    ["minecraft:red_concrete", [159, 14]],
    ["minecraft:lime_concrete_powder", [35, 5]],
    ["minecraft:blue_glazed_terracotta[facing=north]", [159, 11]],
    ["minecraft:deepslate[axis=y]", [1, 0]],
    ["minecraft:stripped_oak_log[axis=x]", [17, 4]],
    ["minecraft:stripped_spruce_wood[axis=y]", [17, 13]],
    ["minecraft:cherry_planks", [5, 2]],
    ["minecraft:crimson_stairs[facing=east,half=top,shape=straight,waterlogged=false]", [164, 4]],
    ["minecraft:mangrove_door[facing=east,half=lower,hinge=right,open=false,powered=false]", [196, 0]],
    ["minecraft:warped_fence_gate[facing=south,in_wall=false,open=false,powered=false]", [183, 0]],
    ["minecraft:spruce_trapdoor[facing=north,half=bottom,open=false,powered=false,waterlogged=false]", [96, 0]],
    ["minecraft:birch_button[face=wall,facing=north,powered=false]", [143, 4]],
    ["minecraft:cherry_hanging_sign[attached=false,rotation=8,waterlogged=false]", [63, 8]],
    ["minecraft:water_cauldron[level=2]", [118, 2]],
    ["minecraft:kelp[age=4]", [9, 0]],
    ["minecraft:barrel[facing=north,open=false]", [54, 2]],
    ["minecraft:blast_furnace[facing=east,lit=false]", [61, 5]],
    ["minecraft:bone_block[axis=z]", [155, 4]],
    ["minecraft:tube_coral_block", [35, 11]],
    ["minecraft:tube_coral_fan[waterlogged=true]", [9, 0]],
    ["minecraft:tube_coral_fan[waterlogged=false]", [0, 0]],
    ["minecraft:beetroots[age=3]", [141, 7]],
    ["minecraft:copper_block", [159, 1]],
    ["minecraft:waxed_oxidized_cut_copper", [168, 0]],
    ["minecraft:netherite_block", [173, 0]],
    ["minecraft:mossy_stone_brick_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]", [109, 0]],
    ["minecraft:deepslate_brick_slab[type=top,waterlogged=false]", [44, 13]],
    ["minecraft:deepslate_diamond_ore", [56, 0]],
  ] as const)("%s", (text, expected) => {
    const resolved = resolver.resolveState(text);
    expect([resolved.id, resolved.data]).toEqual(expected);
    expect(resolved.kind).toBe("substitute");
  });

  it("uses the fallback for blocks from mods and reports them", () => {
    const withFallback = new BlockResolver([1, 0]);
    const resolved = withFallback.resolveState("create:brass_block");
    expect([resolved.id, resolved.data, resolved.kind]).toEqual([1, 0, "unmapped"]);
  });

  it("lets overrides win over the built-in mapping", () => {
    const custom = new BlockResolver([0, 0], { "minecraft:deepslate": "98:1", "create:brass_block": "41:0" });
    expect(custom.resolveState("minecraft:deepslate[axis=y]")).toMatchObject({ id: 98, data: 1, overridden: true });
    expect(custom.resolveState("create:brass_block")).toMatchObject({ id: 41, data: 0, overridden: true });
  });
});

describe("pre-1.13 ids", () => {
  it("passes through anything 1.8 already understands", () => {
    expect(resolver.resolveLegacy(35, 14)).toMatchObject({ id: 35, data: 14, kind: "exact" });
    expect(resolver.resolveLegacy(197, 3)).toMatchObject({ id: 197, data: 3, kind: "exact" });
  });

  it("maps 1.9 to 1.12 blocks down", () => {
    expect(resolver.resolveLegacy(251, 14)).toMatchObject({ id: 159, data: 14, kind: "substitute" });
    expect(resolver.resolveLegacy(252, 5)).toMatchObject({ id: 35, data: 5, kind: "substitute" });
    expect(resolver.resolveLegacy(216, 0)).toMatchObject({ id: 155, kind: "substitute" });
  });

  it("uses the fallback for modded ids", () => {
    expect(new BlockResolver([1, 0]).resolveLegacy(2000, 0)).toMatchObject({ id: 1, kind: "unmapped" });
  });
});
