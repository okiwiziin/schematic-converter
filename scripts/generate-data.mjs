// Builds the compact mapping tables the engine ships with, from the MIT-licensed
// minecraft-data package. Run with `npm run generate-data`; the output is committed
// so minecraft-data is never needed at runtime.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(
  root,
  "node_modules/minecraft-data/minecraft-data/data/pc"
);
const read = (path) => JSON.parse(readFileSync(join(dataDir, path), "utf8"));

const legacy = read("common/legacy.json");
const blocks18 = read("1.8/blocks.json");
const items18 = read("1.8/items.json");

// minecraft-data has some of these wrong. Set FLATTENING_TABLE and run the tests to compare it
// with a dump of Mojang's own flattening, which is how these were found.
function correct(idMeta, state) {
  const [id, meta] = idMeta.split(":").map(Number);
  const open = state.indexOf("[");
  if (open === -1) {
    return state;
  }
  const name = state.slice(0, open);
  const props = Object.fromEntries(
    state
      .slice(open + 1, -1)
      .split(",")
      .map((pair) => pair.split("="))
  );
  const rebuild = () =>
    `${name}[${Object.entries(props)
      .map(([key, value]) => `${key}=${value}`)
      .join(",")}]`;

  switch (id) {
    case 96: // Wooden trapdoors don't store power, but the table ties it to being open.
      delete props.powered;
      return rebuild();
    case 69: // Levers on floors and ceilings have their handle directions swapped.
      if (props.face === "wall") {
        return state;
      }
      props.facing = meta & 1 ? "north" : "west";
      return rebuild();
    case 77:
    case 143: // Buttons on floors and ceilings have no direction at all.
      if (props.face !== "wall") {
        delete props.facing;
      }
      return rebuild();
    case 149:
    case 150: // Whether a comparator is on is bit 8, not which of its two ids it has.
      props.powered = meta & 8 ? "true" : "false";
      return rebuild();
    default:
      return state;
  }
}

// Flattened state -> "id:meta" pairs, every 1.12 block. The resolver filters out
// ids above 197 itself so that 1.9-1.12 blocks can still be recognised by name.
const legacyBlocks = Object.entries(legacy.blocks).map(([idMeta, state]) => [
  idMeta,
  correct(idMeta, state),
]);
const legacyItems = Object.entries(legacy.items).map(([idMeta, name]) => [
  idMeta,
  name,
]);

const blockNames = {};
for (const block of blocks18) {
  blockNames[block.id] = { display: block.displayName, name: block.name };
}

const variants = {};
for (const block of blocks18) {
  for (const variation of block.variations ?? []) {
    variants[`${block.id}:${variation.metadata}`] = variation.displayName;
  }
}

const itemNames = {};
for (const item of items18) {
  itemNames[item.id] = item.name;
}
for (const block of blocks18) {
  itemNames[block.id] ??= block.name;
}

// Data version to release name, for telling the user what made their file.
const protocol = read("common/protocolVersions.json");
const releases = protocol
  .filter(
    (entry) =>
      entry.dataVersion && /^\d+\.\d+(?:\.\d+)?$/u.test(entry.minecraftVersion)
  )
  .map((entry) => [entry.dataVersion, entry.minecraftVersion])
  .sort((a, b) => a[0] - b[0]);

const outDir = join(root, "src/engine/data");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "legacy.json"),
  JSON.stringify({ blocks: legacyBlocks, items: legacyItems })
);
writeFileSync(join(outDir, "versions.json"), JSON.stringify(releases));
writeFileSync(
  join(outDir, "names18.json"),
  JSON.stringify({ blocks: blockNames, items: itemNames, variants })
);
console.log(
  `legacy.json: ${legacyBlocks.length} block states, ${legacyItems.length} items; names18.json: ${blocks18.length} blocks, ${items18.length} items`
);
