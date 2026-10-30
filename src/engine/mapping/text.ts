// Chat text helpers. Since 1.21.5 text components may be SNBT compounds instead of JSON
// strings, and 1.8 wants JSON on signs and plain strings for item and container names.
import { asCompound, asList, child, type NbtTag } from "../nbt/nbt";

const LEGACY_COLORS: Record<string, string> = {
  black: "0",
  dark_blue: "1",
  dark_green: "2",
  dark_aqua: "3",
  dark_red: "4",
  dark_purple: "5",
  gold: "6",
  gray: "7",
  dark_gray: "8",
  blue: "9",
  green: "a",
  aqua: "b",
  red: "c",
  light_purple: "d",
  yellow: "e",
  white: "f",
};

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function tagToJson(tag: NbtTag): Json {
  switch (tag.t) {
    case 8:
      return tag.v;
    case 1:
      return tag.v !== 0;
    case 2:
    case 3:
    case 5:
    case 6:
      return tag.v;
    case 4:
      return Number(tag.v);
    case 9:
      return tag.v.map(tagToJson);
    case 10: {
      const out: Record<string, Json> = {};
      for (const [key, value] of tag.v) out[key] = tagToJson(value);
      return out;
    }
    default:
      return null;
  }
}

// A text component as JSON. Strings holding a JSON component stay as that component;
// anything that doesn't parse is treated as literal text.
function toComponent(tag: NbtTag): Json {
  if (tag.t !== 8) return tagToJson(tag);
  const text = tag.v;
  const first = text.trimStart()[0];
  if (first === "{" || first === "[" || first === '"') {
    try {
      return JSON.parse(text) as Json;
    } catch {
      return text;
    }
  }
  return text;
}

function plain(component: Json): string {
  if (typeof component === "string") return component;
  if (typeof component === "number" || typeof component === "boolean") return String(component);
  if (Array.isArray(component)) return component.map(plain).join("");
  if (component && typeof component === "object") {
    let out = "";
    const color = typeof component.color === "string" ? LEGACY_COLORS[component.color] : undefined;
    if (color) out += `§${color}`;
    if (component.bold) out += "§l";
    if (component.italic) out += "§o";
    if (component.underlined) out += "§n";
    if (component.strikethrough) out += "§m";
    if (component.obfuscated) out += "§k";
    if (typeof component.text === "string") out += component.text;
    else if (typeof component.translate === "string") out += component.translate;
    if (Array.isArray(component.extra)) out += component.extra.map(plain).join("");
    return out;
  }
  return "";
}

// Plain text with § colour codes, for names and lore.
export function flattenText(tag: NbtTag): string {
  return plain(toComponent(tag));
}

// A sign line as 1.8 stores it: always a JSON text component.
export function signLine(tag: NbtTag | undefined): string {
  if (!tag) return '{"text":""}';
  const component = toComponent(tag);
  if (typeof component === "string") return JSON.stringify({ text: component });
  // hover/click events and newer fields don't round trip, so keep the visible parts only.
  return JSON.stringify(simplify(component));
}

function simplify(component: Json): Json {
  if (Array.isArray(component)) {
    if (component.length === 0) return { text: "" };
    const [first, ...rest] = component.map(simplify);
    const head = typeof first === "object" && first !== null && !Array.isArray(first) ? first : { text: plain(first ?? "") };
    return rest.length > 0 ? { ...head, extra: rest } : head;
  }
  if (component && typeof component === "object") {
    const out: Record<string, Json> = {};
    for (const key of ["text", "translate", "color", "bold", "italic", "underlined", "strikethrough", "obfuscated"]) {
      const value = component[key];
      if (value === undefined) continue;
      out[key] = key === "bold" || key === "italic" || key === "underlined" || key === "strikethrough" || key === "obfuscated" ? value === true || value === 1 : value;
    }
    if (Array.isArray(component.extra)) out.extra = component.extra.map(simplify);
    if (out.text === undefined && out.translate === undefined) out.text = "";
    return out;
  }
  return component === null ? { text: "" } : { text: String(component) };
}

export function uuidFromInts(parts: ArrayLike<number>): string {
  const hex = [0, 1, 2, 3].map((i) => ((parts[i] ?? 0) >>> 0).toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function readSignMessages(source: NbtTag | undefined): (NbtTag | undefined)[] {
  const messages = asList(child(asCompound(source), "messages"));
  return [messages?.[0], messages?.[1], messages?.[2], messages?.[3]];
}
