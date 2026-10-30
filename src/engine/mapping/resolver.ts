// Turns a block, as a modern state string or a pre-1.13 id:meta pair, into a 1.8 id:data.
import legacyData from "../data/legacy.json";
import names18 from "../data/names18.json";
import { ALIASES, LOSSLESS, type Props } from "./aliases";

export type MatchKind = "exact" | "substitute" | "unmapped";

export interface Resolved {
  data: number;
  id: number;
  kind: MatchKind;
  name: string; // Source block name without properties, e.g. "minecraft:oak_stairs".
  overridden: boolean;
  props: Props;
}

export type Overrides = Record<string, string>;

const MAX_ID_18 = 197;

interface LegacyEntry {
  id: number;
  meta: number;
  props: Props;
}

const legacyByName = new Map<string, LegacyEntry[]>();
const legacyByIdMeta = new Map<string, string>();

function parseState(state: string): { name: string; props: Props } {
  const open = state.indexOf("[");
  const name = open === -1 ? state : state.slice(0, open);
  const props: Props = {};
  if (open !== -1) {
    const close = state.lastIndexOf("]");
    for (const pair of state
      .slice(open + 1, close === -1 ? undefined : close)
      .split(",")) {
      const equals = pair.indexOf("=");
      if (equals > 0) {
        props[pair.slice(0, equals).trim()] = pair.slice(equals + 1).trim();
      }
    }
  }
  return { name, props };
}

const stripNamespace = (name: string): string =>
  name.startsWith("minecraft:") ? name.slice(10) : name;

for (const [idMeta, state] of legacyData.blocks as [string, string][]) {
  legacyByIdMeta.set(idMeta, state);
  const { name, props } = parseState(state);
  const [id, meta] = idMeta.split(":").map(Number) as [number, number];
  if (id > MAX_ID_18) {
    continue;
  }
  const key = stripNamespace(name);
  let entries = legacyByName.get(key);
  if (!entries) {
    legacyByName.set(key, (entries = []));
  }
  entries.push({ id, meta, props });
}

// Some properties change what the block fundamentally is: which half of a door, whether a lever
// is on a wall or the floor. They outweigh everything else when picking the closest legacy entry.
const PROPERTY_WEIGHT: Record<string, number> = {
  age: 100,
  axis: 100,
  delay: 100,
  extended: 50,
  face: 1000,
  facing: 100,
  half: 1000,
  hinge: 50,
  inverted: 50,
  layers: 100,
  level: 100,
  lit: 50,
  mode: 50,
  occupied: 1,
  open: 50,
  part: 1000,
  persistent: 50,
  power: 100,
  powered: 20,
  rotation: 100,
  snowy: 1,
  type: 1000,
  waterlogged: 0,
};

const propertyWeight = (name: string, property: string): number => {
  if (property === "shape" && name.endsWith("_stairs")) {
    return 0;
  }
  return PROPERTY_WEIGHT[property] ?? 10;
};

function closestEntry(
  name: string,
  entries: LegacyEntry[],
  props: Props
): LegacyEntry {
  // Water and lava: sources use the stationary ids, flowing levels use the flowing ones.
  if (name === "water" || name === "lava") {
    const level = Number(props.level ?? 0);
    const flowing = name === "water" ? 8 : 10;
    const id = level === 0 ? flowing + 1 : flowing;
    return { id, meta: level, props };
  }
  // A lever on a floor or ceiling lies along an axis, so opposite directions are the same to 1.8.
  const wanted =
    name === "lever" &&
    props.face !== "wall" &&
    (props.facing === "south" || props.facing === "east")
      ? { ...props, facing: props.facing === "south" ? "north" : "west" }
      : props;
  let best = entries[0]!;
  let bestScore = -1;
  for (const entry of entries) {
    let score = 0;
    for (const [property, value] of Object.entries(entry.props)) {
      if (wanted[property] === value) {
        score += propertyWeight(name, property);
      }
    }
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

const idByOldName = new Map<string, number>();
for (const [id, block] of Object.entries(
  names18.blocks as Record<string, { name: string }>
)) {
  idByOldName.set(block.name, Number(id));
}

const ID_META = /^\d+:\d+$/u;

function parseIdMeta(value: string): [number, number] {
  const [id, meta] = value.split(":").map(Number) as [number, number];
  return [id, meta];
}

export class BlockResolver {
  private readonly cache = new Map<string, Resolved>();
  private readonly legacyCache = new Map<number, Resolved>();

  constructor(
    private readonly fallback: [number, number] = [0, 0],
    private readonly overrides: Overrides = {}
  ) {}

  resolveState(state: string): Resolved {
    const cached = this.cache.get(state);
    if (cached) {
      return cached;
    }
    const { name, props } = parseState(state);
    const resolved = this.resolveParts(name, props);
    this.cache.set(state, resolved);
    return resolved;
  }

  resolveParts(rawName: string, props: Props): Resolved {
    const fullName = rawName.includes(":") ? rawName : `minecraft:${rawName}`;
    const override = this.overrides[fullName];
    if (override !== undefined && ID_META.test(override)) {
      const [id, data] = parseIdMeta(override);
      return {
        data,
        id,
        kind: "substitute",
        name: fullName,
        overridden: true,
        props,
      };
    }
    if (fullName.startsWith("minecraft:")) {
      const short = stripNamespace(fullName);
      const found = lookup(short, props);
      if (found) {
        return { ...found, name: fullName, overridden: false, props };
      }
      // Structure files from before 1.13 use the old block names, which 1.8 shares.
      const oldId = idByOldName.get(short);
      if (oldId !== undefined) {
        return {
          data: 0,
          id: oldId,
          kind: "substitute",
          name: fullName,
          overridden: false,
          props,
        };
      }
    }
    return {
      data: this.fallback[1],
      id: this.fallback[0],
      kind: "unmapped",
      name: fullName,
      overridden: false,
      props,
    };
  }

  // Pre-1.13 numeric blocks. Ids a 1.8 client knows pass straight through; later ones are
  // looked up through the flattening table so they share the rules above.
  resolveLegacy(id: number, meta: number): Resolved {
    const key = id * 16 + meta;
    const cached = this.legacyCache.get(key);
    if (cached) {
      return cached;
    }
    const flattened =
      legacyByIdMeta.get(`${id}:${meta}`) ?? legacyByIdMeta.get(`${id}:0`);
    let resolved: Resolved;
    if (flattened) {
      const { name, props } = parseState(flattened);
      const override = this.overrides[name];
      if (override !== undefined && ID_META.test(override)) {
        const [targetId, targetData] = parseIdMeta(override);
        resolved = {
          data: targetData,
          id: targetId,
          kind: "substitute",
          name,
          overridden: true,
          props,
        };
      } else if (id <= MAX_ID_18) {
        resolved = {
          data: meta,
          id,
          kind: "exact",
          name,
          overridden: false,
          props,
        };
      } else {
        resolved = this.resolveParts(name, props);
      }
    } else if (id <= MAX_ID_18) {
      resolved = {
        data: meta,
        id,
        kind: "exact",
        name: `legacy:${id}`,
        overridden: false,
        props: {},
      };
    } else {
      resolved = {
        data: this.fallback[1],
        id: this.fallback[0],
        kind: "unmapped",
        name: `legacy:${id}`,
        overridden: false,
        props: {},
      };
    }
    this.legacyCache.set(key, resolved);
    return resolved;
  }
}

function lookup(
  name: string,
  props: Props,
  depth = 0
): { id: number; data: number; kind: MatchKind } | null {
  if (depth > 4) {
    return null;
  }
  const alias = ALIASES.get(name);
  if (alias !== undefined) {
    const target = typeof alias === "function" ? alias(props) : alias;
    if (ID_META.test(target)) {
      const [id, data] = parseIdMeta(target);
      return { data, id, kind: LOSSLESS.has(name) ? "exact" : "substitute" };
    }
    const found = lookup(target, props, depth + 1);
    if (!found) {
      return null;
    }
    return {
      ...found,
      kind:
        LOSSLESS.has(name) && found.kind === "exact" ? "exact" : "substitute",
    };
  }
  const entries = legacyByName.get(name);
  if (!entries) {
    return null;
  }
  const entry = closestEntry(name, entries, props);
  return { data: entry.meta, id: entry.id, kind: "exact" };
}

// What the report shows for a target, e.g. "Red Wool".
export function displayName18(id: number, data: number): string {
  const variants = names18.variants as Record<string, string>;
  const variant = variants[`${id}:${data}`];
  if (variant) {
    return variant;
  }
  const block = (
    names18.blocks as Record<string, { display: string } | undefined>
  )[String(id)];
  return block?.display ?? `Block ${id}`;
}

export interface Block18Option {
  data: number;
  id: number;
  label: string;
}

// Every block and sub-type, for the override picker.
export function listBlocks18(): Block18Option[] {
  const options: Block18Option[] = [];
  const blocks = names18.blocks as Record<string, { display: string }>;
  const variants = names18.variants as Record<string, string>;
  for (const [idText, block] of Object.entries(blocks)) {
    const id = Number(idText);
    const own = Object.entries(variants).filter(([key]) =>
      key.startsWith(`${id}:`)
    );
    if (own.length === 0) {
      options.push({ data: 0, id, label: block.display });
    }
    for (const [key, label] of own) {
      options.push({ data: Number(key.split(":")[1]), id, label });
    }
  }
  return options;
}
