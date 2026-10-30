// Translates item stacks (chest contents, item frames, armor stands) to the 1.8 format.
import legacyData from "../data/legacy.json";
import names18 from "../data/names18.json";
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
import type { BlockResolver } from "./resolver";
import { flattenText, uuidFromInts } from "./text";

const itemNames18 = names18.items as Record<string, string | undefined>;

const byModernName = new Map<string, [number, number]>();
for (const [idMeta, name] of legacyData.items as [string, string][]) {
  const [id, meta] = idMeta.split(":").map(Number) as [number, number];
  if (itemNames18[id] && !byModernName.has(name)) byModernName.set(name, [id, meta]);
}

// Items whose names changed after the flattening table was written, or that were added
// later and have an obvious equivalent.
const RENAMED: Record<string, [number, number]> = {
  "minecraft:red_dye": [351, 1],
  "minecraft:green_dye": [351, 2],
  "minecraft:yellow_dye": [351, 11],
  "minecraft:white_dye": [351, 15],
  "minecraft:blue_dye": [351, 4],
  "minecraft:brown_dye": [351, 3],
  "minecraft:black_dye": [351, 0],
  "minecraft:netherite_ingot": [264, 0],
  "minecraft:netherite_scrap": [265, 0],
  "minecraft:raw_iron": [15, 0],
  "minecraft:raw_gold": [14, 0],
  "minecraft:raw_copper": [265, 0],
  "minecraft:copper_ingot": [265, 0],
  "minecraft:amethyst_shard": [406, 0],
  "minecraft:scute": [265, 0],
  "minecraft:turtle_helmet": [298, 0],
  "minecraft:elytra": [299, 0],
  "minecraft:shield": [268, 0],
  "minecraft:trident": [267, 0],
  "minecraft:crossbow": [261, 0],
  "minecraft:spyglass": [345, 0],
  "minecraft:bundle": [334, 0],
};

// Blocks whose placed id differs from their item id.
const ITEM_FOR_BLOCK: Record<number, number> = {
  26: 355,
  55: 331,
  59: 295,
  63: 323,
  64: 324,
  68: 323,
  71: 330,
  83: 338,
  92: 354,
  93: 356,
  94: 356,
  104: 361,
  105: 362,
  115: 372,
  117: 379,
  118: 380,
  132: 287,
  140: 390,
  141: 391,
  142: 392,
  144: 397,
  149: 404,
  150: 404,
  193: 427,
  194: 428,
  195: 429,
  196: 430,
  197: 431,
};

// Block ids where the item's damage value is the block's sub-type, not a placement detail.
const KEEPS_META = new Set([
  1, 3, 5, 6, 12, 17, 18, 19, 24, 31, 35, 38, 43, 44, 95, 97, 98, 125, 126, 139, 155, 159, 160, 161, 162, 168, 171,
  175, 179,
]);

const ENCHANTMENTS: Record<string, number> = {
  protection: 0,
  fire_protection: 1,
  feather_falling: 2,
  blast_protection: 3,
  projectile_protection: 4,
  respiration: 5,
  aqua_affinity: 6,
  thorns: 7,
  depth_strider: 8,
  sharpness: 16,
  smite: 17,
  bane_of_arthropods: 18,
  knockback: 19,
  fire_aspect: 20,
  looting: 21,
  efficiency: 32,
  silk_touch: 33,
  unbreaking: 34,
  fortune: 35,
  power: 48,
  punch: 49,
  flame: 50,
  infinity: 51,
  luck_of_the_sea: 61,
  lure: 62,
};

const POTION_DAMAGE: Record<string, number> = {
  water: 0,
  mundane: 8192,
  thick: 8192,
  awkward: 8192,
  regeneration: 8193,
  swiftness: 8194,
  fire_resistance: 8195,
  poison: 8196,
  healing: 8197,
  night_vision: 8198,
  weakness: 8200,
  strength: 8201,
  slowness: 8202,
  harming: 8204,
  water_breathing: 8205,
  invisibility: 8206,
};

function potionDamage(potion: string | undefined, splash: boolean): number {
  const name = (potion ?? "minecraft:water").replace("minecraft:", "");
  const strong = name.startsWith("strong_");
  const long = name.startsWith("long_");
  const base = POTION_DAMAGE[name.replace(/^(strong_|long_)/, "")] ?? 0;
  if (base === 0) return 0;
  let damage = base;
  if (strong) damage |= 32;
  if (long) damage |= 64;
  if (splash) damage = (damage & ~8192) | 16384;
  return damage;
}

function resolveItem(name: string, resolver: BlockResolver): [number, number] | null {
  const direct = RENAMED[name] ?? byModernName.get(name);
  if (direct) return direct;

  const short = name.replace("minecraft:", "");
  if (short.startsWith("netherite_")) {
    return byModernName.get(`minecraft:diamond_${short.slice(10)}`) ?? null;
  }
  if (short.endsWith("_chest_boat") || short.endsWith("_boat") || short.endsWith("_raft")) return [333, 0];
  if (short.endsWith("_spawn_egg")) return [383, 0];
  if (short.endsWith("_sign") && !short.includes("wall")) return [323, 0];

  const block = resolver.resolveParts(name, {});
  if (block.kind === "unmapped" || block.id === 0) return null;
  const itemId = ITEM_FOR_BLOCK[block.id] ?? block.id;
  if (!itemNames18[itemId]) return null;
  return [itemId, KEEPS_META.has(block.id) ? block.data : 0];
}

function enchantmentList(entries: [string, number][]): NbtTag | null {
  const tags: NbtTag[] = [];
  for (const [name, level] of entries) {
    const id = ENCHANTMENTS[name.replace("minecraft:", "")];
    if (id === undefined) continue;
    tags.push(
      nbt.compound(
        new Map<string, NbtTag>([
          ["id", nbt.short(id)],
          ["lvl", nbt.short(level)],
        ]),
      ),
    );
  }
  return tags.length > 0 ? nbt.list(TAG.Compound, tags) : null;
}

function oldEnchantments(list: NbtTag[] | undefined): [string, number][] {
  const entries: [string, number][] = [];
  for (const entry of list ?? []) {
    const compound = asCompound(entry);
    const id = child(compound, "id");
    const level = asNumber(child(compound, "lvl")) ?? 1;
    if (id?.t === 8) entries.push([id.v, level]);
    else {
      const numeric = asNumber(id);
      const name = Object.entries(ENCHANTMENTS).find(([, value]) => value === numeric)?.[0];
      if (name) entries.push([name, level]);
    }
  }
  return entries;
}

function componentEnchantments(component: NbtTag | undefined): [string, number][] {
  const compound = asCompound(component);
  if (!compound) return [];
  const levels = asCompound(child(compound, "levels")) ?? compound;
  const entries: [string, number][] = [];
  for (const [name, level] of levels) {
    const value = asNumber(level);
    if (value !== undefined && name !== "show_in_tooltip") entries.push([name, value]);
  }
  return entries;
}

export function profileToOwner(profile: Compound): NbtTag | null {
  const owner: Compound = new Map();
  const name = asString(child(profile, "name")) ?? asString(child(profile, "Name"));
  const idTag = child(profile, "id") ?? child(profile, "Id");
  const id = idTag?.t === 11 ? uuidFromInts(idTag.v) : asString(idTag);
  if (id) owner.set("Id", nbt.string(id));
  if (name) owner.set("Name", nbt.string(name));

  const textures: NbtTag[] = [];
  const properties = child(profile, "properties") ?? child(profile, "Properties");
  if (properties?.t === 9) {
    for (const entry of properties.v) {
      const property = asCompound(entry);
      if (asString(child(property, "name")) !== "textures") continue;
      const texture: Compound = new Map([["Value", nbt.string(asString(child(property, "value")) ?? "")]]);
      const signature = asString(child(property, "signature"));
      if (signature) texture.set("Signature", nbt.string(signature));
      textures.push(nbt.compound(texture));
    }
  } else if (properties?.t === 10) {
    for (const entry of asList(child(properties.v, "textures")) ?? []) {
      const property = asCompound(entry);
      const value = asString(child(property, "Value"));
      if (!value) continue;
      const texture: Compound = new Map([["Value", nbt.string(value)]]);
      const signature = asString(child(property, "Signature"));
      if (signature) texture.set("Signature", nbt.string(signature));
      textures.push(nbt.compound(texture));
    }
  }
  if (textures.length > 0) {
    // 1.8 requires an id whenever textures are present; derive a stable one if absent.
    if (!id) {
      const value = asString(child(asCompound(textures[0]), "Value")) ?? "";
      let hash = 0;
      for (let i = 0; i < value.length; i++) hash = (Math.imul(hash, 31) + value.charCodeAt(i)) | 0;
      owner.set("Id", nbt.string(uuidFromInts([hash, hash ^ 0x5bd1e995, ~hash, hash ^ 0x1b873593])));
    }
    owner.set(
      "Properties",
      nbt.compound(new Map([["textures", nbt.list(TAG.Compound, textures)]])),
    );
  }
  return owner.size > 0 ? nbt.compound(owner) : null;
}

function translateItemTag(source: Compound | undefined, components: Compound | undefined): Compound {
  const tag: Compound = new Map();
  const display: Compound = new Map();

  const sourceDisplay = asCompound(child(source, "display"));
  const name =
    child(components, "minecraft:custom_name") ??
    child(components, "minecraft:item_name") ??
    child(sourceDisplay, "Name");
  if (name) display.set("Name", nbt.string(flattenText(name)));
  const lore = asList(child(components, "minecraft:lore")) ?? asList(child(sourceDisplay, "Lore"));
  if (lore?.length) {
    display.set("Lore", nbt.list(TAG.String, lore.map((line) => nbt.string(flattenText(line)))));
  }
  const color =
    asNumber(child(sourceDisplay, "color")) ??
    asNumber(child(components, "minecraft:dyed_color")) ??
    asNumber(child(asCompound(child(components, "minecraft:dyed_color")), "rgb"));
  if (color !== undefined) display.set("color", nbt.int(color));
  if (display.size > 0) tag.set("display", nbt.compound(display));

  const enchants =
    enchantmentList(componentEnchantments(child(components, "minecraft:enchantments"))) ??
    enchantmentList(oldEnchantments(asList(child(source, "Enchantments")))) ??
    enchantmentList(oldEnchantments(asList(child(source, "ench"))));
  if (enchants) tag.set("ench", enchants);

  const stored =
    enchantmentList(componentEnchantments(child(components, "minecraft:stored_enchantments"))) ??
    enchantmentList(oldEnchantments(asList(child(source, "StoredEnchantments"))));
  if (stored) tag.set("StoredEnchantments", stored);

  if (asNumber(child(source, "Unbreakable")) === 1 || child(components, "minecraft:unbreakable")) {
    tag.set("Unbreakable", nbt.byte(1));
  }

  const profile =
    asCompound(child(components, "minecraft:profile")) ?? asCompound(child(source, "SkullOwner"));
  if (profile) {
    const owner = profileToOwner(profile);
    if (owner) tag.set("SkullOwner", owner);
  } else {
    const ownerName = asString(child(source, "SkullOwner")) ?? asString(child(components, "minecraft:profile"));
    if (ownerName) tag.set("SkullOwner", nbt.string(ownerName));
  }

  // Written books keep their pages when they are already in the old format.
  for (const key of ["pages", "title", "author", "generation"]) {
    const value = child(source, key);
    if (value) tag.set(key, value);
  }
  return tag;
}

export interface ItemContext {
  resolver: BlockResolver;
  dropped: Map<string, number>;
}

// Returns null (and records why) for items with no 1.8 equivalent.
export function translateItem(source: Compound, ctx: ItemContext): Compound | null {
  const idTag = child(source, "id");
  const count = asNumber(child(source, "count")) ?? asNumber(child(source, "Count")) ?? 1;
  const slot = asNumber(child(source, "Slot"));
  const components = asCompound(child(source, "components"));
  const sourceTag = asCompound(child(source, "tag"));

  let id: number;
  let damage: number;
  if (idTag?.t === 8) {
    const name = idTag.v.includes(":") ? idTag.v : `minecraft:${idTag.v}`;
    const potionId =
      asString(child(asCompound(child(components, "minecraft:potion_contents")), "potion")) ??
      asString(child(components, "minecraft:potion_contents")) ??
      asString(child(sourceTag, "Potion"));
    if (name === "minecraft:potion" || name === "minecraft:splash_potion" || name === "minecraft:lingering_potion") {
      id = 373;
      damage = potionDamage(potionId, name !== "minecraft:potion");
    } else if (name === "minecraft:tipped_arrow") {
      id = 262;
      damage = 0;
    } else {
      const found = resolveItem(name, ctx.resolver);
      if (!found) {
        // Pre-1.13 item names ("minecraft:wool") are already what 1.8 expects.
        const stillValid = Object.values(itemNames18).includes(name.replace("minecraft:", ""));
        if (!stillValid) {
          ctx.dropped.set(name, (ctx.dropped.get(name) ?? 0) + 1);
          return null;
        }
        const out: Compound = new Map();
        if (slot !== undefined) out.set("Slot", nbt.byte(slot));
        out.set("id", nbt.string(name));
        out.set("Count", nbt.byte(Math.min(count, 127)));
        out.set("Damage", nbt.short(asNumber(child(source, "Damage")) ?? 0));
        const tag = translateItemTag(sourceTag, components);
        if (tag.size > 0) out.set("tag", nbt.compound(tag));
        return out;
      }
      [id, damage] = found;
    }
    const explicit = asNumber(child(source, "Damage")) ?? asNumber(child(sourceTag, "Damage")) ?? asNumber(child(components, "minecraft:damage"));
    if (explicit && damage === 0 && id !== 373) damage = explicit;
  } else {
    id = asNumber(idTag) ?? 0;
    damage = asNumber(child(source, "Damage")) ?? 0;
  }

  const name = itemNames18[id];
  if (!name) {
    const key = idTag?.t === 8 ? idTag.v : `item #${id}`;
    ctx.dropped.set(key, (ctx.dropped.get(key) ?? 0) + 1);
    return null;
  }
  const out: Compound = new Map();
  if (slot !== undefined) out.set("Slot", nbt.byte(slot));
  out.set("id", nbt.string(`minecraft:${name}`));
  out.set("Count", nbt.byte(Math.min(count, 127)));
  out.set("Damage", nbt.short(damage));
  const tag = translateItemTag(sourceTag, components);
  if (tag.size > 0) out.set("tag", nbt.compound(tag));
  return out;
}

export function translateItems(list: NbtTag[] | undefined, ctx: ItemContext): NbtTag {
  const items: NbtTag[] = [];
  for (const entry of list ?? []) {
    const compound = asCompound(entry);
    if (!compound || compound.size === 0) continue;
    const item = translateItem(compound, ctx);
    if (item) items.push(nbt.compound(item));
  }
  return nbt.list(TAG.Compound, items);
}
