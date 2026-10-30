// Entities in 1.8's format. Types that didn't exist in 1.8 are dropped and reported.
import {
  asCompound,
  asList,
  asNumber,
  asString,
  child,
  nbt,
  TAG,
  type Compound,
  type NbtTag,
} from "../nbt/nbt";
import { translateItem, translateItems, type ItemContext } from "./items";
import { flattenText } from "./text";

const ENTITY_IDS: Record<string, string> = {
  item: "Item",
  experience_orb: "XPOrb",
  leash_knot: "LeashKnot",
  painting: "Painting",
  item_frame: "ItemFrame",
  glow_item_frame: "ItemFrame",
  armor_stand: "ArmorStand",
  end_crystal: "EnderCrystal",
  tnt: "PrimedTnt",
  firework_rocket: "FireworksRocketEntity",
  minecart: "MinecartRideable",
  chest_minecart: "MinecartChest",
  furnace_minecart: "MinecartFurnace",
  tnt_minecart: "MinecartTNT",
  hopper_minecart: "MinecartHopper",
  spawner_minecart: "MinecartSpawner",
  command_block_minecart: "MinecartCommandBlock",
  creeper: "Creeper",
  skeleton: "Skeleton",
  stray: "Skeleton",
  wither_skeleton: "Skeleton",
  bogged: "Skeleton",
  spider: "Spider",
  cave_spider: "CaveSpider",
  giant: "Giant",
  zombie: "Zombie",
  husk: "Zombie",
  drowned: "Zombie",
  zombie_villager: "Zombie",
  slime: "Slime",
  ghast: "Ghast",
  zombified_piglin: "PigZombie",
  zombie_pigman: "PigZombie",
  piglin: "PigZombie",
  piglin_brute: "PigZombie",
  enderman: "Enderman",
  silverfish: "Silverfish",
  blaze: "Blaze",
  magma_cube: "LavaSlime",
  ender_dragon: "EnderDragon",
  wither: "WitherBoss",
  bat: "Bat",
  witch: "Witch",
  endermite: "Endermite",
  guardian: "Guardian",
  elder_guardian: "Guardian",
  pig: "Pig",
  sheep: "Sheep",
  cow: "Cow",
  chicken: "Chicken",
  squid: "Squid",
  glow_squid: "Squid",
  wolf: "Wolf",
  mooshroom: "MushroomCow",
  snow_golem: "SnowMan",
  ocelot: "Ozelot",
  cat: "Ozelot",
  iron_golem: "VillagerGolem",
  horse: "EntityHorse",
  donkey: "EntityHorse",
  mule: "EntityHorse",
  skeleton_horse: "EntityHorse",
  zombie_horse: "EntityHorse",
  rabbit: "Rabbit",
  villager: "Villager",
  wandering_trader: "Villager",
};

const OLD_NAMES = new Set(Object.values(ENTITY_IDS));

export function entityId18(raw: string): string | null {
  if (OLD_NAMES.has(raw)) return raw;
  const short = raw.replace("minecraft:", "").toLowerCase();
  if (short.endsWith("_boat") || short.endsWith("_raft") || short === "boat") return "Boat";
  return ENTITY_IDS[short] ?? null;
}

// Modern painting names are the old ones in snake_case. Newer paintings have no 1.8 version.
const PAINTINGS: Record<string, string> = {
  kebab: "Kebab",
  aztec: "Aztec",
  alban: "Alban",
  aztec2: "Aztec2",
  bomb: "Bomb",
  plant: "Plant",
  wasteland: "Wasteland",
  pool: "Pool",
  courbet: "Courbet",
  sea: "Sea",
  sunset: "Sunset",
  creebet: "Creebet",
  wanderer: "Wanderer",
  graham: "Graham",
  match: "Match",
  bust: "Bust",
  stage: "Stage",
  void: "Void",
  skull_and_roses: "SkullAndRoses",
  wither: "Wither",
  fighters: "Fighters",
  pointer: "Pointer",
  pigscene: "Pigscene",
  burning_skull: "BurningSkull",
  skeleton: "Skeleton",
  donkey_kong: "DonkeyKong",
};

// 1.8 hanging entities store facing as 0 south, 1 west, 2 north, 3 east. Since 1.13 they
// use the general direction ids: 2 north, 3 south, 4 west, 5 east.
const MODERN_FACING: Record<number, number> = { 2: 2, 3: 0, 4: 1, 5: 3 };

export interface EntityContext extends ItemContext {
  droppedEntities: Map<string, number>;
}

function floatList(values: number[]): NbtTag {
  return nbt.list(TAG.Float, values.map((value) => nbt.float(value)));
}

function doubleList(values: number[]): NbtTag {
  return nbt.list(TAG.Double, values.map((value) => nbt.double(value)));
}

function equipment(source: Compound, ctx: EntityContext): NbtTag | null {
  // Equipment order in 1.8 is hand, feet, legs, chest, head.
  const slots: (Compound | undefined)[] = [];
  const hand = asList(child(source, "HandItems"));
  const armor = asList(child(source, "ArmorItems"));
  const modern = asCompound(child(source, "equipment"));
  if (modern) {
    for (const key of ["mainhand", "feet", "legs", "chest", "head"]) slots.push(asCompound(child(modern, key)));
  } else if (hand || armor) {
    slots.push(asCompound(hand?.[0]));
    for (let i = 0; i < 4; i++) slots.push(asCompound(armor?.[i]));
  } else {
    const old = asList(child(source, "Equipment"));
    if (!old) return null;
    return translateItems(old, ctx);
  }
  const items = slots.map((slot) => {
    if (!slot || slot.size === 0) return nbt.compound();
    const item = translateItem(slot, ctx);
    return item ? nbt.compound(item) : nbt.compound();
  });
  return nbt.list(TAG.Compound, items);
}

function copyByte(from: Compound, to: Compound, key: string): void {
  const value = asNumber(child(from, key));
  if (value !== undefined) to.set(key, nbt.byte(value));
}

// `position` is where the entity goes in the output's coordinates, in blocks.
export function translateEntity(
  source: Compound,
  position: [number, number, number],
  ctx: EntityContext,
): Compound | null {
  const rawId = asString(child(source, "id")) ?? asString(child(source, "Id")) ?? "unknown";
  const id = entityId18(rawId);
  if (!id) {
    ctx.droppedEntities.set(rawId, (ctx.droppedEntities.get(rawId) ?? 0) + 1);
    return null;
  }

  const out: Compound = new Map<string, NbtTag>([["id", nbt.string(id)]]);
  out.set("Pos", doubleList(position));
  out.set("Motion", doubleList([0, 0, 0]));
  const rotation = asList(child(source, "Rotation"))?.map((value) => asNumber(value) ?? 0);
  out.set("Rotation", floatList([rotation?.[0] ?? 0, rotation?.[1] ?? 0]));
  out.set("OnGround", nbt.byte(asNumber(child(source, "OnGround")) ?? 1));
  out.set("Fire", nbt.short(-1));
  out.set("Air", nbt.short(300));
  out.set("Dimension", nbt.int(0));
  out.set("Invulnerable", nbt.byte(asNumber(child(source, "Invulnerable")) ?? 0));

  const customName = child(source, "CustomName");
  if (customName) out.set("CustomName", nbt.string(flattenText(customName)));
  copyByte(source, out, "CustomNameVisible");
  copyByte(source, out, "NoAI");
  copyByte(source, out, "Silent");
  copyByte(source, out, "PersistenceRequired");

  const sourcePos = asList(child(source, "Pos"))?.map((value) => asNumber(value) ?? 0);
  const shift = sourcePos
    ? [position[0] - sourcePos[0]!, position[1] - sourcePos[1]!, position[2] - sourcePos[2]!]
    : [0, 0, 0];

  switch (id) {
    case "ArmorStand": {
      for (const key of ["Small", "ShowArms", "NoBasePlate", "Invisible", "Marker", "NoGravity"]) {
        copyByte(source, out, key);
      }
      const pose = child(source, "Pose");
      if (pose) out.set("Pose", pose);
      const disabled = asNumber(child(source, "DisabledSlots"));
      if (disabled !== undefined) out.set("DisabledSlots", nbt.int(disabled));
      const items = equipment(source, ctx);
      if (items) out.set("Equipment", items);
      break;
    }
    case "ItemFrame":
    case "Painting": {
      const blockPos = asCompound(child(source, "block_pos"));
      const packed = child(source, "block_pos");
      let tile: number[] | undefined;
      const tx = asNumber(child(source, "TileX"));
      if (tx !== undefined) {
        tile = [tx, asNumber(child(source, "TileY")) ?? 0, asNumber(child(source, "TileZ")) ?? 0];
      } else if (packed?.t === 11) {
        tile = [packed.v[0]!, packed.v[1]!, packed.v[2]!];
      } else if (blockPos) {
        tile = [asNumber(child(blockPos, "x")) ?? 0, asNumber(child(blockPos, "y")) ?? 0, asNumber(child(blockPos, "z")) ?? 0];
      }
      if (!tile) return null;
      out.set("TileX", nbt.int(Math.floor(tile[0]! + shift[0]!)));
      out.set("TileY", nbt.int(Math.floor(tile[1]! + shift[1]!)));
      out.set("TileZ", nbt.int(Math.floor(tile[2]! + shift[2]!)));
      const facing = asNumber(child(source, "Facing")) ?? asNumber(child(source, "facing")) ?? 2;
      const isOldFormat = source.has("Dir") || source.has("Direction");
      out.set("Facing", nbt.byte(isOldFormat ? facing : (MODERN_FACING[facing] ?? 0)));
      if (id === "ItemFrame") {
        const item = asCompound(child(source, "Item"));
        if (item) {
          const translated = translateItem(item, ctx);
          if (translated) out.set("Item", nbt.compound(translated));
        }
        copyByte(source, out, "ItemRotation");
        out.set("ItemDropChance", nbt.float(asNumber(child(source, "ItemDropChance")) ?? 1));
      } else {
        const motive =
          asString(child(source, "Motive")) ?? asString(child(source, "variant")) ?? "minecraft:kebab";
        const short = motive.replace("minecraft:", "");
        const name = PAINTINGS[short] ?? (Object.values(PAINTINGS).includes(short) ? short : undefined);
        if (!name) {
          ctx.droppedEntities.set(`painting:${short}`, (ctx.droppedEntities.get(`painting:${short}`) ?? 0) + 1);
          return null;
        }
        out.set("Motive", nbt.string(name));
      }
      break;
    }
    case "Item": {
      const item = asCompound(child(source, "Item"));
      const translated = item ? translateItem(item, ctx) : null;
      if (!translated) return null;
      out.set("Item", nbt.compound(translated));
      out.set("Age", nbt.short(0));
      out.set("Health", nbt.short(5));
      break;
    }
    case "Skeleton": {
      const short = rawId.replace("minecraft:", "");
      out.set("SkeletonType", nbt.byte(short === "wither_skeleton" ? 1 : (asNumber(child(source, "SkeletonType")) ?? 0)));
      break;
    }
    case "Villager": {
      const data = asCompound(child(source, "VillagerData"));
      const profession = asString(child(data, "profession"))?.replace("minecraft:", "");
      const professions: Record<string, number> = { farmer: 0, librarian: 1, cleric: 2, armorer: 3, butcher: 4 };
      out.set("Profession", nbt.int(asNumber(child(source, "Profession")) ?? professions[profession ?? ""] ?? 0));
      break;
    }
    case "EntityHorse": {
      const short = rawId.replace("minecraft:", "");
      const types: Record<string, number> = { horse: 0, donkey: 1, mule: 2, zombie_horse: 3, skeleton_horse: 4 };
      out.set("Type", nbt.int(asNumber(child(source, "Type")) ?? types[short] ?? 0));
      break;
    }
    case "Sheep": {
      copyByte(source, out, "Color");
      break;
    }
    case "Slime":
    case "LavaSlime": {
      out.set("Size", nbt.int(asNumber(child(source, "Size")) ?? 0));
      break;
    }
    case "Boat":
    case "MinecartRideable":
    case "MinecartChest":
    case "MinecartFurnace":
    case "MinecartTNT":
    case "MinecartHopper":
    case "MinecartSpawner":
    case "MinecartCommandBlock": {
      if (id === "MinecartChest" || id === "MinecartHopper") {
        out.set("Items", translateItems(asList(child(source, "Items")), ctx));
      }
      break;
    }
    default:
      break;
  }
  return out;
}
