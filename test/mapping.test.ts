import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BlockResolver } from "../src/engine/mapping/resolver";

const dataDir = join(
  process.cwd(),
  "node_modules/minecraft-data/minecraft-data/data/pc"
);

interface BlockState {
  name: string;
  type: string;
  values?: string[];
}

const blocksFor = (version: string): { name: string; states: BlockState[] }[] =>
  JSON.parse(readFileSync(join(dataDir, version, "blocks.json"), "utf8"));

const modernVersions = readdirSync(dataDir).filter(
  (version) =>
    /^(?:1\.(?:1[3-9]|2\d)|2\d)/u.test(version) &&
    existsSync(join(dataDir, version, "blocks.json"))
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
        if (
          resolver.resolveParts(`minecraft:${block.name}`, {}).kind ===
          "unmapped"
        ) {
          unmapped.add(`${block.name} (${version})`);
        }
      }
    }
    expect([...unmapped]).toEqual([]);
  });

  it("gives every state of every latest block a valid 1.8 id and data value", () => {
    const blocks = blocksFor(
      modernVersions.includes("26.1") ? "26.1" : modernVersions.at(-1)!
    );
    let checked = 0;
    for (const block of blocks) {
      // Walk the property combinations. Capped per block, since fence-like blocks have
      // thousands of states that all differ only in properties 1.8 doesn't store.
      const stateLists = block.states.map((property) =>
        (
          property.values ??
          (property.type === "bool" ? ["true", "false"] : ["0"])
        ).map((value) => [property.name, value] as const)
      );
      let combos: (readonly [string, string])[][] = [[]];
      for (const options of stateLists) {
        const next: (readonly [string, string])[][] = [];
        for (const combo of combos) {
          for (const option of options) {
            next.push([...combo, option]);
          }
        }
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
    expect(checked).toBeGreaterThan(10_000);
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
    [
      "minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]",
      [53, 0],
    ],
    [
      "minecraft:oak_stairs[facing=west,half=bottom,shape=inner_left,waterlogged=false]",
      [53, 1],
    ],
    [
      "minecraft:oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]",
      [53, 2],
    ],
    [
      "minecraft:oak_stairs[facing=north,half=top,shape=straight,waterlogged=false]",
      [53, 7],
    ],
    [
      "minecraft:oak_door[facing=east,half=lower,hinge=right,open=false,powered=false]",
      [64, 0],
    ],
    [
      "minecraft:oak_door[facing=north,half=lower,hinge=right,open=true,powered=false]",
      [64, 7],
    ],
    [
      "minecraft:oak_door[facing=north,half=upper,hinge=left,open=true,powered=false]",
      [64, 8],
    ],
    [
      "minecraft:oak_door[facing=south,half=upper,hinge=right,open=false,powered=true]",
      [64, 11],
    ],
    ["minecraft:red_bed[facing=south,occupied=false,part=foot]", [26, 0]],
    ["minecraft:red_bed[facing=north,occupied=false,part=head]", [26, 10]],
    ["minecraft:oak_sign[rotation=4,waterlogged=false]", [63, 4]],
    ["minecraft:oak_wall_sign[facing=north,waterlogged=false]", [68, 2]],
    [
      "minecraft:redstone_wire[east=none,north=side,power=5,south=up,west=none]",
      [55, 5],
    ],
    [
      "minecraft:repeater[delay=3,facing=west,locked=false,powered=true]",
      [94, 9],
    ],
    ["minecraft:furnace[facing=north,lit=true]", [62, 2]],
    ["minecraft:furnace[facing=north,lit=false]", [61, 2]],
    [
      "minecraft:oak_leaves[distance=7,persistent=true,waterlogged=false]",
      [18, 4],
    ],
    [
      "minecraft:oak_leaves[distance=1,persistent=false,waterlogged=false]",
      [18, 0],
    ],
    [
      "minecraft:oak_fence[east=true,north=true,south=false,waterlogged=false,west=false]",
      [85, 0],
    ],
    [
      "minecraft:vine[east=false,north=true,south=true,up=false,west=false]",
      [106, 5],
    ],
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
    for (const name of [
      "cave_air",
      "short_grass",
      "oak_sign",
      "player_head",
      "blue_banner",
      "potted_poppy",
      "smooth_stone_slab",
    ]) {
      expect(resolver.resolveParts(`minecraft:${name}`, {}).kind, name).toBe(
        "exact"
      );
    }
  });
});

// Written from how 1.8's own block classes read their metadata, not from any table.
describe("orientation follows 1.8's metadata", () => {
  const TRAPDOOR_FACING: Record<string, number> = {
    north: 0,
    south: 1,
    west: 2,
    east: 3,
  };

  it.each([
    ["oak_trapdoor", 96],
    ["spruce_trapdoor", 96],
    ["cherry_trapdoor", 96],
    ["iron_trapdoor", 167],
    ["copper_trapdoor", 167],
  ])("%s keeps its direction, half and open state", (name, id) => {
    for (const facing of ["north", "south", "west", "east"]) {
      for (const half of ["bottom", "top"]) {
        for (const open of ["true", "false"]) {
          for (const powered of ["true", "false"]) {
            const text = `minecraft:${name}[facing=${facing},half=${half},open=${open},powered=${powered},waterlogged=false]`;
            const expected =
              TRAPDOOR_FACING[facing]! |
              (open === "true" ? 4 : 0) |
              (half === "top" ? 8 : 0);
            expect(state(text), text).toEqual([id, expected]);
          }
        }
      }
    }
  });

  it("levers stay on their wall, floor or ceiling, along the right axis", () => {
    const WALL: Record<string, number> = {
      east: 1,
      west: 2,
      south: 3,
      north: 4,
    };
    const FLOOR: Record<string, number> = {
      north: 5,
      south: 5,
      west: 6,
      east: 6,
    };
    const CEILING: Record<string, number> = {
      north: 7,
      south: 7,
      west: 0,
      east: 0,
    };
    for (const facing of ["north", "south", "west", "east"]) {
      for (const powered of [false, true]) {
        const bit = powered ? 8 : 0;
        expect(
          state(
            `minecraft:lever[face=wall,facing=${facing},powered=${powered}]`
          )
        ).toEqual([69, WALL[facing]! | bit]);
        expect(
          state(
            `minecraft:lever[face=floor,facing=${facing},powered=${powered}]`
          )
        ).toEqual([69, FLOOR[facing]! | bit]);
        expect(
          state(
            `minecraft:lever[face=ceiling,facing=${facing},powered=${powered}]`
          )
        ).toEqual([69, CEILING[facing]! | bit]);
      }
    }
  });

  it.each([
    ["stone_button", 77],
    ["oak_button", 143],
    ["birch_button", 143],
    ["polished_blackstone_button", 77],
  ])(
    "%s stays on its wall, floor or ceiling and keeps its pressed state",
    (name, id) => {
      const WALL: Record<string, number> = {
        east: 1,
        west: 2,
        south: 3,
        north: 4,
      };
      for (const facing of ["north", "south", "west", "east"]) {
        for (const powered of [false, true]) {
          const bit = powered ? 8 : 0;
          expect(
            state(
              `minecraft:${name}[face=wall,facing=${facing},powered=${powered}]`
            )
          ).toEqual([id, WALL[facing]! | bit]);
          expect(
            state(
              `minecraft:${name}[face=floor,facing=${facing},powered=${powered}]`
            )
          ).toEqual([id, 5 | bit]);
          expect(
            state(
              `minecraft:${name}[face=ceiling,facing=${facing},powered=${powered}]`
            )
          ).toEqual([id, bit]);
        }
      }
    }
  );

  it("comparators are on when bit 8 is set", () => {
    const FACING: Record<string, number> = {
      south: 0,
      west: 1,
      north: 2,
      east: 3,
    };
    for (const facing of Object.keys(FACING)) {
      for (const mode of ["compare", "subtract"]) {
        for (const powered of [false, true]) {
          const text = `minecraft:comparator[facing=${facing},mode=${mode},powered=${powered}]`;
          expect(state(text), text).toEqual([
            149,
            FACING[facing]! | (mode === "subtract" ? 4 : 0) | (powered ? 8 : 0),
          ]);
        }
      }
    }
  });
});

// Point FLATTENING_TABLE at ViaVersion's mappings/mapping-1.12.json, a dump of Mojang's own
// flattening. Every 1.8 block state in it has to come back to the id and data it started as.
describe.skipIf(!process.env.FLATTENING_TABLE)(
  "Mojang's flattening table",
  () => {
    // Pairs that look different but are the same block in 1.8, or that 1.8 works out by itself.
    const equivalent = (
      id: number,
      meta: number,
      resolved: [number, number]
    ): boolean => {
      const [rId, rMeta] = resolved;
      if (rId === id && rMeta === meta) {
        return true;
      }
      switch (id) {
        case 8:
        case 9:
          return (rId === 8 || rId === 9) && rMeta === meta;
        case 10:
        case 11:
          return (rId === 10 || rId === 11) && rMeta === meta;
        case 6: // Saplings: bit 8 is growth progress.
        case 18: // Leaves: bit 8 is the decay check flag.
        case 161:
          return rId === id && (rMeta & 7) === (meta & 7);
        case 43: // Double slabs: bit 8 selects a smooth texture on only some of them.
        case 125:
          return rId === id && (rMeta & 7) === (meta & 7);
        case 140: // Flower pots: the plant is a tile entity.
          return rId === 140 && rMeta === 0;
        case 144: // Heads: the rotation is a tile entity.
          return rId === 144 && (rMeta === meta || meta === 0 || meta >= 8);
        case 150: // Powered comparators are the same as id 149 with bit 8 set.
          return (
            rId === 149 &&
            (rMeta & 7) === (meta & 7) &&
            (rMeta & 8) === (meta & 8)
          );
        case 155: // Quartz pillars have unused metadata duplicates.
        case 175: // Upper halves of double plants all behave the same.
          return rId === id;
        case 99: // Mushroom blocks and stems share faces across several values.
        case 100:
        case 17:
        case 162:
          return rId === id || (id === 100 && rId === 99);
        case 31:
        case 32:
          return rId === 31 || rId === 32;
        case 46: // TNT: the flattening has no "unstable" for bit 1, so it reads as plain TNT.
          return rId === 46;
        case 132: // Tripwire: bit 2 is the unused "suspended" flag.
          return rId === 132 && (rMeta & ~2) === (meta & ~2);
        default:
          return false;
      }
    };

    it("round trips through the resolver", () => {
      const table = JSON.parse(
        readFileSync(process.env.FLATTENING_TABLE!, "utf8")
      ).blocks as Record<string, string>;
      const wrong: string[] = [];
      for (const [key, text] of Object.entries(table)) {
        const id = Number(key) >> 4;
        const meta = Number(key) & 15;
        if (id > 197) {
          continue;
        }
        const resolved = state(`minecraft:${text}`);
        if (!equivalent(id, meta, resolved)) {
          wrong.push(`${id}:${meta} ${text} -> ${resolved.join(":")}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }
);

describe("substitutions", () => {
  it.each([
    ["minecraft:red_concrete", [159, 14]],
    ["minecraft:lime_concrete_powder", [35, 5]],
    ["minecraft:blue_glazed_terracotta[facing=north]", [159, 11]],
    ["minecraft:deepslate[axis=y]", [1, 0]],
    ["minecraft:stripped_oak_log[axis=x]", [17, 4]],
    ["minecraft:stripped_spruce_wood[axis=y]", [17, 13]],
    ["minecraft:cherry_planks", [5, 2]],
    [
      "minecraft:crimson_stairs[facing=east,half=top,shape=straight,waterlogged=false]",
      [164, 4],
    ],
    [
      "minecraft:mangrove_door[facing=east,half=lower,hinge=right,open=false,powered=false]",
      [196, 0],
    ],
    [
      "minecraft:warped_fence_gate[facing=south,in_wall=false,open=false,powered=false]",
      [183, 0],
    ],
    [
      "minecraft:spruce_trapdoor[facing=north,half=bottom,open=false,powered=false,waterlogged=false]",
      [96, 0],
    ],
    ["minecraft:birch_button[face=wall,facing=north,powered=false]", [143, 4]],
    [
      "minecraft:cherry_hanging_sign[attached=false,rotation=8,waterlogged=false]",
      [63, 8],
    ],
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
    [
      "minecraft:mossy_stone_brick_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]",
      [109, 0],
    ],
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
    expect([resolved.id, resolved.data, resolved.kind]).toEqual([
      1,
      0,
      "unmapped",
    ]);
  });

  it("lets overrides win over the built-in mapping", () => {
    const custom = new BlockResolver([0, 0], {
      "minecraft:deepslate": "98:1",
      "create:brass_block": "41:0",
    });
    expect(custom.resolveState("minecraft:deepslate[axis=y]")).toMatchObject({
      id: 98,
      data: 1,
      overridden: true,
    });
    expect(custom.resolveState("create:brass_block")).toMatchObject({
      id: 41,
      data: 0,
      overridden: true,
    });
  });
});

describe("pre-1.13 ids", () => {
  it("passes through anything 1.8 already understands", () => {
    expect(resolver.resolveLegacy(35, 14)).toMatchObject({
      id: 35,
      data: 14,
      kind: "exact",
    });
    expect(resolver.resolveLegacy(197, 3)).toMatchObject({
      id: 197,
      data: 3,
      kind: "exact",
    });
  });

  it("maps 1.9 to 1.12 blocks down", () => {
    expect(resolver.resolveLegacy(251, 14)).toMatchObject({
      id: 159,
      data: 14,
      kind: "substitute",
    });
    expect(resolver.resolveLegacy(252, 5)).toMatchObject({
      id: 35,
      data: 5,
      kind: "substitute",
    });
    expect(resolver.resolveLegacy(216, 0)).toMatchObject({
      id: 155,
      kind: "substitute",
    });
  });

  it("uses the fallback for modded ids", () => {
    expect(new BlockResolver([1, 0]).resolveLegacy(2000, 0)).toMatchObject({
      id: 1,
      kind: "unmapped",
    });
  });
});
