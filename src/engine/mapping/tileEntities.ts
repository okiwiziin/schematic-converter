// Rebuilds block entities in 1.8's format. The output id comes from the block actually
// being placed, not the source id, so a barrel turned into a chest gets a working chest.
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
import { COLORS, POTTED } from "./aliases";
import { entityId18 } from "./entities";
import { profileToOwner, translateItems, type ItemContext } from "./items";
import type { Resolved } from "./resolver";
import { flattenText, readSignMessages, signLine } from "./text";

const TILE_BY_BLOCK: Record<number, string> = {
  23: "Trap",
  25: "Music",
  52: "MobSpawner",
  54: "Chest",
  61: "Furnace",
  62: "Furnace",
  63: "Sign",
  68: "Sign",
  84: "RecordPlayer",
  116: "EnchantTable",
  117: "Cauldron",
  119: "Airportal",
  130: "EnderChest",
  137: "Control",
  138: "Beacon",
  140: "FlowerPot",
  144: "Skull",
  146: "Chest",
  149: "Comparator",
  150: "Comparator",
  151: "DLDetector",
  154: "Hopper",
  158: "Dropper",
  176: "Banner",
  177: "Banner",
  178: "DLDetector",
};

export const needsTileEntity = (blockId: number): boolean => TILE_BY_BLOCK[blockId] !== undefined;

// Source block entities that hold nothing worth mentioning when they go: 1.8 beds and pistons
// keep everything in the block itself, and the others are building tools that become air.
const UNREMARKABLE = /(^|:)(bed|piston|moving_piston|jigsaw|structure_block|end_gateway|campfire|bell|conduit)$/i;

export const isWorthReporting = (id: string): boolean => !UNREMARKABLE.test(id);

const SKULL_TYPES: Record<string, number> = {
  skeleton: 0,
  wither_skeleton: 1,
  zombie: 2,
  player: 3,
  creeper: 4,
};

function skullType(name: string): number {
  const short = name.replace("minecraft:", "").replace(/_(wall_)?(skull|head)$/, "");
  return SKULL_TYPES[short] ?? (short === "dragon" ? 1 : 4);
}

const BANNER_PATTERNS: Record<string, string> = {
  base: "b",
  square_bottom_left: "bl",
  square_bottom_right: "br",
  square_top_left: "tl",
  square_top_right: "tr",
  stripe_bottom: "bs",
  stripe_top: "ts",
  stripe_left: "ls",
  stripe_right: "rs",
  stripe_center: "cs",
  stripe_middle: "ms",
  stripe_downright: "drs",
  stripe_downleft: "dls",
  small_stripes: "ss",
  cross: "cr",
  straight_cross: "sc",
  triangle_bottom: "bt",
  triangle_top: "tt",
  triangles_bottom: "bts",
  triangles_top: "tts",
  diagonal_left: "ld",
  diagonal_up_right: "rd",
  diagonal_up_left: "lud",
  diagonal_right: "rud",
  circle: "mc",
  rhombus: "mr",
  half_vertical: "vh",
  half_horizontal: "hh",
  half_vertical_right: "vhr",
  half_horizontal_bottom: "hhb",
  border: "bo",
  curly_border: "cbo",
  gradient: "gra",
  gradient_up: "gru",
  bricks: "bri",
  creeper: "cre",
  skull: "sku",
  flower: "flo",
  mojang: "moj",
};

const BEACON_EFFECTS: Record<string, number> = {
  speed: 1,
  haste: 3,
  strength: 5,
  jump_boost: 8,
  regeneration: 10,
  resistance: 11,
};

function bannerPatterns(source: Compound | undefined): NbtTag | null {
  const patterns: NbtTag[] = [];
  // 1.20.5+: [{pattern:"minecraft:creeper", color:"red"}]
  for (const entry of asList(child(source, "patterns")) ?? []) {
    const pattern = asCompound(entry);
    const name = asString(child(pattern, "pattern"))?.replace("minecraft:", "");
    const color = COLORS.indexOf((asString(child(pattern, "color")) ?? "white") as (typeof COLORS)[number]);
    const code = name ? BANNER_PATTERNS[name] : undefined;
    if (!code) continue;
    patterns.push(
      nbt.compound(
        new Map<string, NbtTag>([
          ["Pattern", nbt.string(code)],
          ["Color", nbt.int(15 - Math.max(color, 0))],
        ]),
      ),
    );
  }
  // 1.13 to 1.20.4: [{Pattern:"cre", Color:14}]. Colour ids run the opposite way to 1.8's.
  for (const entry of asList(child(source, "Patterns")) ?? []) {
    const pattern = asCompound(entry);
    const code = asString(child(pattern, "Pattern"));
    const color = asNumber(child(pattern, "Color"));
    if (!code || color === undefined) continue;
    patterns.push(
      nbt.compound(
        new Map<string, NbtTag>([
          ["Pattern", nbt.string(code)],
          ["Color", nbt.int(source?.has("Base") ? color : 15 - color)],
        ]),
      ),
    );
  }
  return patterns.length > 0 ? nbt.list(TAG.Compound, patterns) : null;
}

function bannerColor(name: string): number | undefined {
  const short = name.replace("minecraft:", "").replace(/_(wall_)?banner$/, "");
  const index = COLORS.indexOf(short as (typeof COLORS)[number]);
  return index === -1 ? undefined : index;
}

export interface TileContext extends ItemContext {
  // Source block entities that had to be discarded because of what they turned into.
  orphans: Map<string, number>;
}

// x, y, z are the position within the output schematic.
export function translateTile(
  source: Compound | null,
  block: Resolved,
  x: number,
  y: number,
  z: number,
  ctx: TileContext,
): Compound | null {
  const id = TILE_BY_BLOCK[block.id];
  if (!id) return null;

  const out: Compound = new Map<string, NbtTag>([
    ["id", nbt.string(id)],
    ["x", nbt.int(x)],
    ["y", nbt.int(y)],
    ["z", nbt.int(z)],
  ]);
  const customName = child(source ?? undefined, "CustomName");

  switch (id) {
    case "Chest":
    case "Trap":
    case "Dropper":
    case "Hopper":
    case "Furnace":
    case "Cauldron": {
      out.set("Items", translateItems(asList(child(source ?? undefined, "Items")), ctx));
      if (customName) out.set("CustomName", nbt.string(flattenText(customName)));
      const lock = asString(child(source ?? undefined, "Lock"));
      if (lock) out.set("Lock", nbt.string(lock));
      if (id === "Furnace") {
        const burn = asNumber(child(source ?? undefined, "BurnTime")) ?? asNumber(child(source ?? undefined, "lit_time_remaining")) ?? 0;
        const cook = asNumber(child(source ?? undefined, "CookTime")) ?? asNumber(child(source ?? undefined, "cooking_time_spent")) ?? 0;
        const total = asNumber(child(source ?? undefined, "CookTimeTotal")) ?? asNumber(child(source ?? undefined, "cooking_total_time")) ?? 200;
        out.set("BurnTime", nbt.short(burn));
        out.set("CookTime", nbt.short(cook));
        out.set("CookTimeTotal", nbt.short(total));
      }
      if (id === "Cauldron") {
        out.set("BrewTime", nbt.int(asNumber(child(source ?? undefined, "BrewTime")) ?? 0));
      }
      if (id === "Hopper") {
        out.set("TransferCooldown", nbt.int(asNumber(child(source ?? undefined, "TransferCooldown")) ?? 0));
      }
      break;
    }
    case "Sign": {
      // 1.20+: front_text.messages[], 1.8 to 1.19: Text1..Text4.
      const front = child(source ?? undefined, "front_text");
      const messages = front ? readSignMessages(front) : undefined;
      for (let line = 0; line < 4; line++) {
        const value = messages ? messages[line] : child(source ?? undefined, `Text${line + 1}`);
        out.set(`Text${line + 1}`, nbt.string(signLine(value)));
      }
      break;
    }
    case "Skull": {
      const existingType = asNumber(child(source ?? undefined, "SkullType"));
      out.set("SkullType", nbt.byte(existingType ?? skullType(block.name)));
      const rotation = asNumber(child(source ?? undefined, "Rot")) ?? Number(block.props.rotation ?? 0);
      out.set("Rot", nbt.byte(rotation));
      const profile =
        asCompound(child(source ?? undefined, "profile")) ??
        asCompound(child(source ?? undefined, "SkullOwner")) ??
        asCompound(child(source ?? undefined, "Owner"));
      if (profile) {
        const owner = profileToOwner(profile);
        if (owner) {
          out.set("Owner", owner);
          out.set("SkullType", nbt.byte(3));
        }
      } else {
        const name =
          asString(child(source ?? undefined, "profile")) ??
          asString(child(source ?? undefined, "SkullOwner")) ??
          asString(child(source ?? undefined, "ExtraType"));
        if (name) {
          out.set("ExtraType", nbt.string(name));
          out.set("SkullType", nbt.byte(3));
        }
      }
      break;
    }
    case "Banner": {
      const existingBase = asNumber(child(source ?? undefined, "Base"));
      const color = bannerColor(block.name);
      out.set("Base", nbt.int(existingBase ?? 15 - (color ?? 0)));
      const patterns = bannerPatterns(source ?? undefined);
      if (patterns) out.set("Patterns", patterns);
      break;
    }
    case "FlowerPot": {
      const potted = POTTED[block.name.replace("minecraft:", "")];
      const sourceItem = child(source ?? undefined, "Item");
      if (sourceItem) {
        out.set("Item", sourceItem);
        out.set("Data", nbt.int(asNumber(child(source ?? undefined, "Data")) ?? 0));
      } else if (potted) {
        out.set("Item", nbt.string(potted[0]));
        out.set("Data", nbt.int(potted[1]));
      } else {
        out.set("Item", nbt.string(""));
        out.set("Data", nbt.int(0));
      }
      break;
    }
    case "Music": {
      out.set("note", nbt.byte(asNumber(child(source ?? undefined, "note")) ?? Number(block.props.note ?? 0)));
      break;
    }
    case "MobSpawner": {
      const spawnData = asCompound(child(source ?? undefined, "SpawnData"));
      const entity = asCompound(child(spawnData, "entity")) ?? spawnData;
      const raw =
        asString(child(entity, "id")) ?? asString(child(source ?? undefined, "EntityId")) ?? "minecraft:pig";
      out.set("EntityId", nbt.string(entityId18(raw) ?? "Pig"));
      out.set("Delay", nbt.short(asNumber(child(source ?? undefined, "Delay")) ?? 20));
      out.set("MinSpawnDelay", nbt.short(asNumber(child(source ?? undefined, "MinSpawnDelay")) ?? 200));
      out.set("MaxSpawnDelay", nbt.short(asNumber(child(source ?? undefined, "MaxSpawnDelay")) ?? 800));
      out.set("SpawnCount", nbt.short(asNumber(child(source ?? undefined, "SpawnCount")) ?? 4));
      out.set("SpawnRange", nbt.short(asNumber(child(source ?? undefined, "SpawnRange")) ?? 4));
      out.set("MaxNearbyEntities", nbt.short(asNumber(child(source ?? undefined, "MaxNearbyEntities")) ?? 6));
      out.set("RequiredPlayerRange", nbt.short(asNumber(child(source ?? undefined, "RequiredPlayerRange")) ?? 16));
      break;
    }
    case "Control": {
      out.set("Command", nbt.string(asString(child(source ?? undefined, "Command")) ?? ""));
      out.set("SuccessCount", nbt.int(asNumber(child(source ?? undefined, "SuccessCount")) ?? 0));
      out.set("TrackOutput", nbt.byte(asNumber(child(source ?? undefined, "TrackOutput")) ?? 1));
      if (customName) out.set("CustomName", nbt.string(flattenText(customName)));
      break;
    }
    case "Beacon": {
      const effect = (key: string, modern: string): number => {
        const value = child(source ?? undefined, key);
        const numeric = asNumber(value);
        if (numeric !== undefined) return numeric;
        const name = asString(child(source ?? undefined, modern))?.replace("minecraft:", "");
        return name ? (BEACON_EFFECTS[name] ?? 0) : 0;
      };
      out.set("Levels", nbt.int(asNumber(child(source ?? undefined, "Levels")) ?? 0));
      out.set("Primary", nbt.int(effect("Primary", "primary_effect")));
      out.set("Secondary", nbt.int(effect("Secondary", "secondary_effect")));
      break;
    }
    case "Comparator": {
      out.set("OutputSignal", nbt.int(asNumber(child(source ?? undefined, "OutputSignal")) ?? 0));
      break;
    }
    case "RecordPlayer": {
      const record = asCompound(child(source ?? undefined, "RecordItem"));
      if (record) {
        const list = translateItems([nbt.compound(record)], ctx);
        const translated = asList(list)?.[0];
        if (translated) {
          out.set("RecordItem", translated);
          const name = asString(child(asCompound(translated), "id"));
          if (name) out.set("Record", nbt.int(recordId(name)));
        }
      }
      break;
    }
    case "EnchantTable": {
      if (customName) out.set("CustomName", nbt.string(flattenText(customName)));
      break;
    }
    default:
      break;
  }
  return out;
}

const RECORDS = ["13", "cat", "blocks", "chirp", "far", "mall", "mellohi", "stal", "strad", "ward", "11", "wait"];

function recordId(name: string): number {
  const index = RECORDS.indexOf(name.replace("minecraft:record_", ""));
  return index === -1 ? 0 : 2256 + index;
}
