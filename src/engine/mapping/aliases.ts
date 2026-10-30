// Hand-picked 1.8 stand-ins for everything added after 1.8. A value is either another
// flattened block name, which keeps the state's properties (stairs stay stairs facing
// the same way), or a fixed "id:meta". Functions can look at the state's properties.

export type Props = Record<string, string>;
export type AliasTarget = string | ((props: Props) => string);

export const COLORS = [
  "white",
  "orange",
  "magenta",
  "light_blue",
  "yellow",
  "lime",
  "pink",
  "gray",
  "light_gray",
  "cyan",
  "purple",
  "blue",
  "brown",
  "green",
  "red",
  "black",
] as const;

const OLD_WOODS = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak"];

// Closest 1.8 wood by colour.
const NEW_WOODS: Record<string, string> = {
  bamboo: "birch",
  cherry: "birch",
  crimson: "dark_oak",
  mangrove: "acacia",
  pale_oak: "birch",
  warped: "spruce",
};

const AIR = "0:0";
const WATER = "9:0";
const TORCH = "50:5";
const GLOWSTONE = "89:0";
const STONE = "1:0";
const COBBLE = "4:0";
const ANDESITE = "1:5";
const POLISHED_ANDESITE = "1:6";
const DIORITE = "1:3";
const STONE_BRICKS = "98:0";
const CRACKED_BRICKS = "98:2";
const CHISELED_BRICKS = "98:3";
const BRICKS = "45:0";
const NETHER_BRICKS = "112:0";
const NETHERRACK = "87:0";
const COARSE_DIRT = "3:1";
const clay = (color: number): string => `159:${color}`;
const wool = (color: number): string => `35:${color}`;
const BLACK_CLAY = clay(15);
const ORANGE_CLAY = clay(1);
const CYAN_CLAY = clay(9);

export const ALIASES = new Map<string, AliasTarget>();

const add = (entries: Record<string, AliasTarget>): void => {
  for (const [name, target] of Object.entries(entries)) {
    ALIASES.set(name, target);
  }
};

// Names that only changed spelling, or that lose nothing in 1.8. These still count as an
// exact match in the conversion report, unlike real substitutions.
export const LOSSLESS = new Set<string>([
  "cave_air",
  "void_air",
  "short_grass",
  "smooth_stone_slab",
]);

const addLossless = (name: string, target: AliasTarget): void => {
  ALIASES.set(name, target);
  LOSSLESS.add(name);
};

// ---- Wood

for (const [wood, target] of Object.entries(NEW_WOODS)) {
  for (const part of [
    "planks",
    "stairs",
    "slab",
    "fence",
    "fence_gate",
    "door",
    "leaves",
    "sapling",
    "log",
    "wood",
  ]) {
    ALIASES.set(`${wood}_${part}`, `${target}_${part}`);
  }
}

for (const wood of [...OLD_WOODS, ...Object.keys(NEW_WOODS)]) {
  // 1.8 has a single wooden trapdoor, button and pressure plate.
  if (wood !== "oak") {
    ALIASES.set(`${wood}_trapdoor`, "oak_trapdoor");
    ALIASES.set(`${wood}_button`, "oak_button");
    ALIASES.set(`${wood}_pressure_plate`, "oak_pressure_plate");
  }
  ALIASES.set(`${wood}_sign`, "sign");
  ALIASES.set(`${wood}_wall_sign`, "wall_sign");
  ALIASES.set(`${wood}_hanging_sign`, "sign");
  ALIASES.set(`${wood}_wall_hanging_sign`, "wall_sign");
  ALIASES.set(`${wood}_shelf`, "47:0");
  const log = NEW_WOODS[wood] ?? wood;
  ALIASES.set(`stripped_${wood}_log`, `${log}_log`);
  ALIASES.set(`stripped_${wood}_wood`, `${log}_wood`);
}
addLossless("oak_sign", "sign");
addLossless("oak_wall_sign", "wall_sign");

add({
  azalea: "18:4",
  azalea_leaves: "oak_leaves",
  bamboo_block: "birch_log",
  bamboo_mosaic: "5:2",
  bamboo_mosaic_slab: "birch_slab",
  bamboo_mosaic_stairs: "birch_stairs",
  barrel: (props) =>
    props.facing === "up" || props.facing === "down" ? "54:2" : "chest",
  cherry_leaves: wool(6),
  chiseled_bookshelf: "47:0",
  creaking_heart: "17:12",
  crimson_hyphae: "dark_oak_wood",
  crimson_stem: "dark_oak_log",
  decorated_pot: "140:0",
  flowering_azalea: "18:4",
  flowering_azalea_leaves: "oak_leaves",
  mangrove_propagule: "6:3",
  mangrove_roots: "85:0",
  muddy_mangrove_roots: COARSE_DIRT,
  stripped_bamboo_block: "birch_log",
  stripped_crimson_hyphae: "dark_oak_wood",
  stripped_crimson_stem: "dark_oak_log",
  stripped_warped_hyphae: "spruce_wood",
  stripped_warped_stem: "spruce_log",
  warped_hyphae: "spruce_wood",
  warped_stem: "spruce_log",
});

// ---- Colours

for (const [index, color] of COLORS.entries()) {
  add({
    [`${color}_shulker_box`]: clay(index),
    [`${color}_glazed_terracotta`]: clay(index),
    [`${color}_concrete`]: clay(index),
    [`${color}_concrete_powder`]: wool(index),
    [`${color}_candle`]: TORCH,
    [`${color}_candle_cake`]: "92:0",
  });
  if (color !== "red") {
    ALIASES.set(`${color}_bed`, "red_bed");
  }
  if (color !== "white") {
    // The banner's colour lives in its tile entity, so nothing is lost.
    addLossless(`${color}_banner`, "white_banner");
    addLossless(`${color}_wall_banner`, "white_wall_banner");
  }
}

add({
  candle: TORCH,
  candle_cake: "92:0",
  shulker_box: clay(10),
});

// ---- Heads. The kind of head and its rotation live in the tile entity, so every head
// standing on the floor is the same block. (The flattening table has rotations here that
// came from the old data value's unrelated bits.)

addLossless("skeleton_skull", "144:1");

for (const head of [
  ["wither_skeleton_skull", "wither_skeleton_wall_skull"],
  ["zombie_head", "zombie_wall_head"],
  ["player_head", "player_wall_head"],
  ["creeper_head", "creeper_wall_head"],
] as const) {
  addLossless(head[0], "skeleton_skull");
  addLossless(head[1], "skeleton_wall_skull");
}
for (const head of [
  ["dragon_head", "dragon_wall_head"],
  ["piglin_head", "piglin_wall_head"],
] as const) {
  ALIASES.set(head[0], "skeleton_skull");
  ALIASES.set(head[1], "skeleton_wall_skull");
}

// ---- 1.9 to 1.12 blocks that appear in the legacy table with ids above 197.

add({
  beetroots: (props) =>
    `141:${Math.min(7, Number(props.age ?? 0) * 2 + (Number(props.age ?? 0) === 3 ? 1 : 0))}`,
  bone_block: "quartz_pillar",
  chain_command_block: "137:0",
  chorus_flower: clay(10),
  chorus_plant: clay(10),
  dirt_path: COARSE_DIRT,
  end_gateway: "119:0",
  end_rod: TORCH,
  end_stone_bricks: "121:0",
  frosted_ice: "79:0",
  grass_path: COARSE_DIRT,
  magma_block: NETHERRACK,
  nether_wart_block: wool(14),
  observer: COBBLE,
  purpur_block: clay(2),
  purpur_pillar: clay(2),
  purpur_slab: "quartz_slab",
  purpur_stairs: "quartz_stairs",
  red_nether_bricks: NETHER_BRICKS,
  repeating_command_block: "137:0",
  structure_block: AIR,
  structure_void: AIR,
});

// ---- Stone and masonry

const stairs = (names: string[], target: string): void => {
  for (const name of names) {
    ALIASES.set(`${name}_stairs`, target);
  }
};
const slabs = (names: string[], target: string): void => {
  for (const name of names) {
    ALIASES.set(`${name}_slab`, target);
  }
};
const walls = (names: string[], target: string): void => {
  for (const name of names) {
    ALIASES.set(`${name}_wall`, target);
  }
};

stairs(
  [
    "stone",
    "mossy_cobblestone",
    "granite",
    "polished_granite",
    "diorite",
    "polished_diorite",
    "andesite",
    "polished_andesite",
    "cobbled_deepslate",
    "polished_deepslate",
    "tuff",
    "polished_tuff",
  ],
  "cobblestone_stairs"
);
stairs(
  [
    "mossy_stone_brick",
    "deepslate_brick",
    "deepslate_tile",
    "tuff_brick",
    "prismarine",
    "prismarine_brick",
    "dark_prismarine",
  ],
  "stone_brick_stairs"
);
stairs(
  [
    "red_nether_brick",
    "blackstone",
    "polished_blackstone",
    "polished_blackstone_brick",
  ],
  "nether_brick_stairs"
);
stairs(["mud_brick", "resin_brick"], "brick_stairs");
stairs(["smooth_quartz"], "quartz_stairs");
stairs(["smooth_sandstone", "end_stone_brick"], "sandstone_stairs");
stairs(["smooth_red_sandstone"], "red_sandstone_stairs");
stairs(
  [
    "cut_copper",
    "exposed_cut_copper",
    "weathered_cut_copper",
    "oxidized_cut_copper",
    "waxed_cut_copper",
    "waxed_exposed_cut_copper",
    "waxed_weathered_cut_copper",
    "waxed_oxidized_cut_copper",
  ],
  "brick_stairs"
);

slabs(
  [
    "mossy_cobblestone",
    "granite",
    "polished_granite",
    "diorite",
    "polished_diorite",
    "andesite",
    "polished_andesite",
    "cobbled_deepslate",
    "polished_deepslate",
    "tuff",
    "polished_tuff",
  ],
  "cobblestone_slab"
);
slabs(
  [
    "mossy_stone_brick",
    "deepslate_brick",
    "deepslate_tile",
    "tuff_brick",
    "prismarine",
    "prismarine_brick",
    "dark_prismarine",
  ],
  "stone_brick_slab"
);
slabs(
  [
    "red_nether_brick",
    "blackstone",
    "polished_blackstone",
    "polished_blackstone_brick",
  ],
  "nether_brick_slab"
);
slabs(["mud_brick", "resin_brick"], "brick_slab");
slabs(["smooth_quartz"], "quartz_slab");
slabs(
  ["smooth_sandstone", "cut_sandstone", "end_stone_brick"],
  "sandstone_slab"
);
slabs(["smooth_red_sandstone", "cut_red_sandstone"], "red_sandstone_slab");
slabs(
  [
    "cut_copper",
    "exposed_cut_copper",
    "weathered_cut_copper",
    "oxidized_cut_copper",
    "waxed_cut_copper",
    "waxed_exposed_cut_copper",
    "waxed_weathered_cut_copper",
    "waxed_oxidized_cut_copper",
  ],
  "brick_slab"
);
addLossless("smooth_stone_slab", "stone_slab");

walls(
  [
    "brick",
    "stone_brick",
    "mud_brick",
    "andesite",
    "granite",
    "diorite",
    "sandstone",
    "red_sandstone",
    "end_stone_brick",
    "cobbled_deepslate",
    "polished_deepslate",
    "deepslate_brick",
    "deepslate_tile",
    "tuff",
    "polished_tuff",
    "tuff_brick",
    "resin_brick",
    "blackstone",
    "polished_blackstone",
    "polished_blackstone_brick",
  ],
  "cobblestone_wall"
);
walls(["mossy_stone_brick", "prismarine"], "mossy_cobblestone_wall");
walls(["nether_brick", "red_nether_brick"], "113:0");

add({
  amethyst_block: clay(10),
  amethyst_cluster: AIR,
  ancient_debris: NETHER_BRICKS,
  basalt: ANDESITE,
  blackstone: BLACK_CLAY,
  budding_amethyst: clay(10),
  calcite: DIORITE,
  chiseled_deepslate: CHISELED_BRICKS,
  chiseled_nether_bricks: NETHER_BRICKS,
  chiseled_polished_blackstone: BLACK_CLAY,
  chiseled_resin_bricks: BRICKS,
  chiseled_tuff: CHISELED_BRICKS,
  chiseled_tuff_bricks: CHISELED_BRICKS,
  cobbled_deepslate: COBBLE,
  cracked_deepslate_bricks: CRACKED_BRICKS,
  cracked_deepslate_tiles: CRACKED_BRICKS,
  cracked_nether_bricks: NETHER_BRICKS,
  cracked_polished_blackstone_bricks: NETHER_BRICKS,
  crying_obsidian: "49:0",
  deepslate: STONE,
  deepslate_bricks: STONE_BRICKS,
  deepslate_tiles: STONE_BRICKS,
  dripstone_block: "1:1",
  gilded_blackstone: BLACK_CLAY,
  heavy_core: "42:0",
  infested_deepslate: STONE,
  large_amethyst_bud: AIR,
  lodestone: CHISELED_BRICKS,
  medium_amethyst_bud: AIR,
  mud: COARSE_DIRT,
  mud_bricks: BRICKS,
  netherite_block: "173:0",
  packed_mud: COARSE_DIRT,
  pointed_dripstone: AIR,
  polished_basalt: POLISHED_ANDESITE,
  polished_blackstone: BLACK_CLAY,
  polished_blackstone_bricks: NETHER_BRICKS,
  polished_blackstone_button: "stone_button",
  polished_blackstone_pressure_plate: "stone_pressure_plate",
  polished_deepslate: POLISHED_ANDESITE,
  polished_tuff: POLISHED_ANDESITE,
  quartz_bricks: "155:0",
  reinforced_deepslate: "7:0",
  resin_block: ORANGE_CLAY,
  resin_bricks: BRICKS,
  respawn_anchor: "49:0",
  rooted_dirt: COARSE_DIRT,
  small_amethyst_bud: AIR,
  smooth_basalt: ANDESITE,
  trial_spawner: "52:0",
  tuff: ANDESITE,
  tuff_bricks: STONE_BRICKS,
  vault: "49:0",
});

// ---- Ores and raw metals

add({
  copper_ore: "15:0",
  deepslate_coal_ore: "coal_ore",
  deepslate_copper_ore: "15:0",
  deepslate_diamond_ore: "diamond_ore",
  deepslate_emerald_ore: "emerald_ore",
  deepslate_gold_ore: "gold_ore",
  deepslate_iron_ore: "iron_ore",
  deepslate_lapis_ore: "lapis_ore",
  deepslate_redstone_ore: "redstone_ore",
  nether_gold_ore: "153:0",
  raw_copper_block: ORANGE_CLAY,
  raw_gold_block: "41:0",
  raw_iron_block: "42:0",
  suspicious_gravel: "13:0",
  suspicious_sand: "12:0",
});

// ---- Copper. Colour follows oxidation, shape stays as close as 1.8 allows.

const oxidation: [string, string][] = [
  ["", ORANGE_CLAY],
  ["exposed_", clay(8)],
  ["weathered_", CYAN_CLAY],
  ["oxidized_", "168:0"],
];
for (const wax of ["", "waxed_"]) {
  for (const [stage, color] of oxidation) {
    const prefix = `${wax}${stage}`;
    add({
      [`${prefix}cut_copper`]: color,
      [`${prefix}chiseled_copper`]: color,
      [`${prefix}copper_grate`]: "101:0",
      [`${prefix}copper_door`]: "iron_door",
      [`${prefix}copper_trapdoor`]: "iron_trapdoor",
      [`${prefix}copper_bulb`]: (props) =>
        props.lit === "true" ? "124:0" : "123:0",
      [`${prefix}copper_chest`]: "chest",
      [`${prefix}copper_bars`]: "101:0",
      [`${prefix}copper_chain`]: "101:0",
      [`${prefix}copper_lantern`]: GLOWSTONE,
      [`${prefix}lightning_rod`]: "101:0",
      [`${prefix}copper_golem_statue`]: AIR,
    });
    if (stage !== "") {
      ALIASES.set(`${prefix}copper`, color);
    }
  }
  ALIASES.set(`${wax}copper_block`, ORANGE_CLAY);
}
add({ chain: "101:0", iron_chain: "101:0", waxed_copper: ORANGE_CLAY });

// ---- Nether

add({
  copper_torch: "torch",
  copper_wall_torch: "wall_torch",
  crimson_fungus: "40:0",
  crimson_nylium: NETHERRACK,
  crimson_roots: AIR,
  nether_sprouts: AIR,
  shroomlight: GLOWSTONE,
  soul_fire: "51:0",
  soul_soil: "88:0",
  soul_torch: "torch",
  soul_wall_torch: "wall_torch",
  twisting_vines: AIR,
  twisting_vines_plant: AIR,
  warped_fungus: "39:0",
  warped_nylium: CYAN_CLAY,
  warped_roots: AIR,
  warped_wart_block: CYAN_CLAY,
  weeping_vines: AIR,
  weeping_vines_plant: AIR,
});

// ---- Plants

add({
  attached_melon_stem: "105:7",
  attached_pumpkin_stem: "104:7",
  bamboo: "83:0",
  bamboo_sapling: AIR,
  big_dripleaf: "111:0",
  big_dripleaf_stem: AIR,
  bush: "31:1",
  cactus_flower: AIR,
  cave_vines: AIR,
  cave_vines_plant: AIR,
  closed_eyeblossom: "red_tulip",
  cornflower: "blue_orchid",
  dried_ghast: AIR,
  firefly_bush: "32:0",
  frogspawn: "111:0",
  glow_lichen: AIR,
  golden_dandelion: "dandelion",
  hanging_roots: AIR,
  leaf_litter: AIR,
  lily_of_the_valley: "oxeye_daisy",
  moss_block: "2:0",
  moss_carpet: "171:13",
  open_eyeblossom: "oxeye_daisy",
  pale_hanging_moss: AIR,
  pale_moss_block: POLISHED_ANDESITE,
  pale_moss_carpet: "171:8",
  pink_petals: AIR,
  pitcher_crop: AIR,
  pitcher_plant: "rose_bush",
  pumpkin: "86:0",
  resin_clump: AIR,
  sculk_vein: AIR,
  short_dry_grass: "32:0",
  small_dripleaf: "31:2",
  sniffer_egg: AIR,
  spore_blossom: AIR,
  sweet_berry_bush: "31:2",
  tall_dry_grass: "32:0",
  torchflower: "red_tulip",
  torchflower_crop: AIR,
  turtle_egg: AIR,
  wildflowers: AIR,
  wither_rose: "32:0",
});

// ---- Underwater. Plants that only exist in water become the water around them.

add({
  blue_ice: "174:0",
  bubble_column: WATER,
  conduit: WATER,
  dried_kelp_block: BLACK_CLAY,
  kelp: WATER,
  kelp_plant: WATER,
  sea_pickle: (props) => (props.waterlogged === "false" ? AIR : WATER),
  seagrass: WATER,
  tall_seagrass: WATER,
});

const coralColor: Record<string, number> = {
  brain: 6,
  bubble: 10,
  fire: 14,
  horn: 4,
  tube: 11,
};
for (const [coral, color] of Object.entries(coralColor)) {
  const wetOrAir = (props: Props): string =>
    props.waterlogged === "false" ? AIR : WATER;
  add({
    [`${coral}_coral_block`]: wool(color),
    [`dead_${coral}_coral_block`]: COBBLE,
    [`${coral}_coral`]: wetOrAir,
    [`dead_${coral}_coral`]: wetOrAir,
    [`${coral}_coral_fan`]: wetOrAir,
    [`dead_${coral}_coral_fan`]: wetOrAir,
    [`${coral}_coral_wall_fan`]: wetOrAir,
    [`dead_${coral}_coral_wall_fan`]: wetOrAir,
  });
}

// ---- Functional blocks and decoration

add({
  bee_nest: "170:0",
  beehive: "170:0",
  bell: "41:0",
  blast_furnace: "furnace",
  calibrated_sculk_sensor: AIR,
  campfire: "17:12",
  cartography_table: "58:0",
  composter: "5:0",
  crafter: "58:0",
  fletching_table: "58:0",
  grindstone: "145:0",
  honey_block: ORANGE_CLAY,
  honeycomb_block: clay(4),
  jigsaw: AIR,
  lantern: GLOWSTONE,
  lava_cauldron: "118:0",
  lectern: "47:0",
  light: AIR,
  loom: "58:0",
  ochre_froglight: GLOWSTONE,
  pearlescent_froglight: "169:0",
  powder_snow: "80:0",
  powder_snow_cauldron: (props) =>
    `118:${Math.min(3, Number(props.level ?? 0))}`,
  scaffolding: "85:0",
  sculk: BLACK_CLAY,
  sculk_catalyst: BLACK_CLAY,
  sculk_sensor: AIR,
  sculk_shrieker: AIR,
  smithing_table: "58:0",
  smoker: "furnace",
  soul_campfire: "17:12",
  soul_lantern: GLOWSTONE,
  stonecutter: "stone_slab",
  target: "170:0",
  test_block: AIR,
  test_instance_block: AIR,
  tinted_glass: "95:15",
  verdant_froglight: "169:0",
  water_cauldron: (props) => `118:${Math.min(3, Number(props.level ?? 0))}`,
});
addLossless("cave_air", AIR);
addLossless("void_air", AIR);
addLossless("short_grass", "grass");

// ---- Flower pots. The block is always 140:0; what's inside goes in the tile entity as
// (1.8 item name, damage). Flowers 1.8 doesn't have use their closest match.

export const POTTED: Record<string, [string, number]> = {
  potted_acacia_sapling: ["minecraft:sapling", 4],
  potted_allium: ["minecraft:red_flower", 2],
  potted_azalea_bush: ["minecraft:tallgrass", 2],
  potted_azure_bluet: ["minecraft:red_flower", 3],
  potted_bamboo: ["minecraft:reeds", 0],
  potted_birch_sapling: ["minecraft:sapling", 2],
  potted_blue_orchid: ["minecraft:red_flower", 1],
  potted_brown_mushroom: ["minecraft:brown_mushroom", 0],
  potted_cactus: ["minecraft:cactus", 0],
  potted_cherry_sapling: ["minecraft:sapling", 2],
  potted_closed_eyeblossom: ["minecraft:red_flower", 4],
  potted_cornflower: ["minecraft:red_flower", 1],
  potted_crimson_fungus: ["minecraft:red_mushroom", 0],
  potted_crimson_roots: ["minecraft:deadbush", 0],
  potted_dandelion: ["minecraft:yellow_flower", 0],
  potted_dark_oak_sapling: ["minecraft:sapling", 5],
  potted_dead_bush: ["minecraft:deadbush", 0],
  potted_fern: ["minecraft:tallgrass", 2],
  potted_flowering_azalea_bush: ["minecraft:tallgrass", 2],
  potted_golden_dandelion: ["minecraft:yellow_flower", 0],
  potted_jungle_sapling: ["minecraft:sapling", 3],
  potted_lily_of_the_valley: ["minecraft:red_flower", 8],
  potted_mangrove_propagule: ["minecraft:sapling", 3],
  potted_oak_sapling: ["minecraft:sapling", 0],
  potted_open_eyeblossom: ["minecraft:red_flower", 8],
  potted_orange_tulip: ["minecraft:red_flower", 5],
  potted_oxeye_daisy: ["minecraft:red_flower", 8],
  potted_pale_oak_sapling: ["minecraft:sapling", 2],
  potted_pink_tulip: ["minecraft:red_flower", 7],
  potted_poppy: ["minecraft:red_flower", 0],
  potted_red_mushroom: ["minecraft:red_mushroom", 0],
  potted_red_tulip: ["minecraft:red_flower", 4],
  potted_spruce_sapling: ["minecraft:sapling", 1],
  potted_torchflower: ["minecraft:red_flower", 4],
  potted_warped_fungus: ["minecraft:brown_mushroom", 0],
  potted_warped_roots: ["minecraft:deadbush", 0],
  potted_white_tulip: ["minecraft:red_flower", 6],
  potted_wither_rose: ["minecraft:deadbush", 0],
};

// Pots whose exact plant exists in 1.8 lose nothing.
for (const name of [
  "potted_dandelion",
  "potted_poppy",
  "potted_blue_orchid",
  "potted_allium",
  "potted_azure_bluet",
  "potted_red_tulip",
  "potted_orange_tulip",
  "potted_white_tulip",
  "potted_pink_tulip",
  "potted_oxeye_daisy",
  "potted_oak_sapling",
  "potted_spruce_sapling",
  "potted_birch_sapling",
  "potted_jungle_sapling",
  "potted_acacia_sapling",
  "potted_dark_oak_sapling",
  "potted_red_mushroom",
  "potted_brown_mushroom",
  "potted_fern",
  "potted_dead_bush",
  "potted_cactus",
]) {
  LOSSLESS.add(name);
}
for (const name of Object.keys(POTTED)) {
  ALIASES.set(name, "140:0");
}
