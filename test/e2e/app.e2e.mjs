// Drives the built app with Playwright: `npm run test:e2e [out dir]`. Uses a throwaway profile, so
// it never touches real settings. Screenshots go to the out dir. Set E2E_EXE to a packaged
// executable to test that instead of the development build.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { _electron as electron } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const shots = process.argv[2] ?? mkdtempSync(join(tmpdir(), "sc-shots-"));
mkdirSync(shots, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "sc-e2e-"));
const inputs = join(work, "in");
const outputDir = join(work, "out");
const profile = join(work, "profile");
mkdirSync(inputs);
mkdirSync(profile);
// Seeded so nothing is ever written to the real Documents folder.
writeFileSync(join(profile, "settings.json"), JSON.stringify({ outputDir }));

// A small hand-rolled .schem, with a replaced block, a sign and a mod block in it.
function schem(width, height, length, states, data) {
  const str = (text) => {
    const bytes = Buffer.from(text);
    const head = Buffer.alloc(2);
    head.writeUInt16BE(bytes.length);
    return Buffer.concat([head, bytes]);
  };
  const tag = (type, name) => Buffer.concat([Buffer.from([type]), str(name)]);
  const short = (name, value) => {
    const body = Buffer.alloc(2);
    body.writeUInt16BE(value);
    return Buffer.concat([tag(2, name), body]);
  };
  const int = (name, value) => {
    const body = Buffer.alloc(4);
    body.writeInt32BE(value);
    return Buffer.concat([tag(3, name), body]);
  };
  const parts = [tag(10, "Schematic"), int("Version", 2), int("DataVersion", 3465), short("Width", width), short("Height", height), short("Length", length)];
  parts.push(tag(10, "Palette"));
  states.forEach((state, index) => parts.push(int(state, index)));
  parts.push(Buffer.from([0]));
  const length4 = Buffer.alloc(4);
  length4.writeInt32BE(data.length);
  parts.push(tag(7, "BlockData"), length4, Buffer.from(data), Buffer.from([0]));
  return zlib.gzipSync(Buffer.concat(parts));
}

const STATES = [
  "minecraft:air",
  "minecraft:stone",
  "minecraft:grass_block[snowy=false]",
  "minecraft:deepslate[axis=y]",
  "minecraft:red_concrete",
  "minecraft:cherry_planks",
  "minecraft:oak_wall_sign[facing=north,waterlogged=false]",
  "create:brass_block",
];
const castle = Array.from({ length: 64 * 16 * 64 }, (_, i) => (i % 11 === 0 ? 3 : i % 7 === 0 ? 4 : i % 5 === 0 ? 5 : i % 3 === 0 ? 1 : i % 97 === 0 ? 7 : i % 53 === 0 ? 6 : 0));
writeFileSync(join(inputs, "castle.schem"), schem(64, 16, 64, STATES, castle));
writeFileSync(join(inputs, "spawn hub.schem"), schem(8, 2, 8, STATES.slice(0, 2), Array.from({ length: 128 }, (_, i) => i % 2)));
writeFileSync(join(inputs, "not a schematic.schem"), Buffer.from("return { hello = true }"));

const log = (message) => console.log(`  ${message}`);
const failures = [];
const check = (condition, message) => {
  log(`${condition ? "ok  " : "FAIL"} ${message}`);
  if (!condition) failures.push(message);
};

const app = await electron.launch({
  executablePath: process.env.E2E_EXE ?? createRequire(import.meta.url)("electron"),
  args: [...(process.env.E2E_EXE ? [] : [root]), `--user-data-dir=${profile}`],
  cwd: root,
  // Terminals inside Electron apps can inherit this, and it would start us as plain Node.
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  // Playwright otherwise pins the page to light mode, hiding the app's own theme.
  colorScheme: "no-override",
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow, nativeTheme }) => {
    nativeTheme.themeSource = "dark";
    BrowserWindow.getAllWindows()[0].setContentSize(1040, 640);
  });
  await page.getByText("Drop your schematics here").waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, "1-empty-dark.png") });
  check(true, "empty state shows");

  // A real drop event, with real files, through the handler, preload and main process.
  const added = [join(inputs, "castle.schem"), join(inputs, "spawn hub.schem"), join(inputs, "not a schematic.schem")];
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.id = "e2e-files";
    input.style.display = "none";
    document.body.append(input);
  });
  await page.setInputFiles("#e2e-files", added);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    for (const file of document.getElementById("e2e-files").files) transfer.items.add(file);
    window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: transfer, cancelable: true }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, cancelable: true }));
  });

  await page.getByRole("row", { name: /castle\.schem/ }).waitFor();
  await page.getByText("64×16×64").waitFor();
  check(true, "file was inspected: dimensions shown");
  await page.getByText("1.20.1").first().waitFor();
  check(true, "source Minecraft version shown");
  await page.getByRole("row", { name: /not a schematic/ }).getByText("isn't a Minecraft schematic", { exact: false }).waitFor();
  check(true, "a non-schematic file says why it failed");
  await page.getByRole("row", { name: /not a schematic/ }).click();
  await page.getByRole("alert").getByText("doesn't contain NBT data", { exact: false }).waitFor();
  check(true, "selecting it shows a clear reason");
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, "2-ready-dark.png") });

  // Options are all on screen.
  await page.getByRole("radiogroup", { name: "Split big maps" }).getByRole("radio", { name: "512" }).click();
  await page.getByText("the pieces line up", { exact: false }).first().waitFor();
  await page.getByRole("radiogroup", { name: "Split big maps" }).getByRole("radio", { name: "Off" }).click();
  await page.getByRole("button", { name: "More options" }).click();
  await page.getByRole("radiogroup", { name: "Blocks from mods become" }).getByRole("radio", { name: "Stone" }).click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(shots, "2b-more-options-dark.png") });
  await page.getByRole("button", { name: "More options" }).click();
  check(true, "options change in place and More options expands");

  // Convert everything.
  await page.getByRole("row", { name: /castle\.schem/ }).click();
  await page.getByRole("button", { name: /^Convert/ }).first().click();
  await page.getByRole("row", { name: /castle\.schem/ }).getByText("Done").waitFor({ timeout: 60000 });
  await page.getByRole("row", { name: /spawn hub/ }).getByText("Done").waitFor({ timeout: 60000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, "3-done-dark.png") });
  check(true, "conversion finished");

  const finished = await page.evaluate(() => window.api.getState());
  const castleJob = finished.jobs.find((job) => job.name === "castle.schem");
  check(castleJob?.status === "done", "castle.schem is done");
  check(existsSync(castleJob?.report?.outputs?.[0]?.path ?? "nope"), "the output file exists on disk");
  check(
    castleJob?.report?.blocks.some((row) => row.name === "create:brass_block" && row.kind === "unmapped" && row.id === 1),
    "the mod block used the Stone fallback chosen in the options",
  );
  check(castleJob?.report?.warnings.some((warning) => warning.includes("create:brass_block")), "the mod block is called out in a note");
  const leftovers = readdirSync(dirname(castleJob.report.outputs[0].path)).filter((name) => name.startsWith(".schematic-converter-"));
  check(leftovers.length === 0, "no temporary files left behind");

  // Tabs, filter and search.
  await page.getByRole("button", { name: /Show in folder/ }).waitFor();
  check((await page.getByText("unknown block type", { exact: false }).count()) > 0, "the summary says there's an unknown block");
  await page.getByRole("button", { name: /block types? replaced/ }).click();
  await page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: "All" }).click();
  await page.getByLabel("Filter blocks").fill("deep");
  await page.getByRole("button", { name: "Choose a different block for minecraft:deepslate" }).waitFor();
  check((await page.getByRole("button", { name: "Choose a different block for minecraft:red_concrete" }).count()) === 0, "filtering the block list works");
  await page.screenshot({ path: join(shots, "4-blocks-dark.png") });

  // Override a block.
  await page.getByRole("button", { name: "Choose a different block for minecraft:deepslate" }).click();
  await page.getByLabel("Search 1.8 blocks").fill("stone brick");
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(shots, "5-block-picker-dark.png") });
  await page.getByRole("button", { name: /stone bricks?\s*98:0/i }).first().click();
  await page.getByRole("button", { name: "Apply changes" }).click();
  for (let attempt = 0; attempt < 240; attempt++) {
    const state = await page.evaluate(() => window.api.getState());
    const job = state.jobs.find((item) => item.name === "castle.schem");
    if (job.status === "done" && job.report?.blocks.some((row) => row.name === "minecraft:deepslate" && row.overridden)) break;
    await page.waitForTimeout(250);
  }
  const again = await page.evaluate(() => window.api.getState());
  const deepslate = again.jobs.find((job) => job.name === "castle.schem").report.blocks.find((row) => row.name === "minecraft:deepslate");
  check(deepslate?.id === 98 && deepslate?.overridden, "the override was applied on reconversion");
  check(again.jobs.find((job) => job.name === "castle.schem").report.outputs[0].path.endsWith("castle (2).schematic"), "existing output isn't overwritten");

  // Keyboard.
  await page.getByRole("row", { name: /spawn hub/ }).click();
  await page.keyboard.press("ArrowUp");
  await page.getByRole("row", { name: /castle\.schem/, selected: true }).waitFor();
  check(true, "arrow keys move the selection");
  await page.getByRole("row", { name: /not a schematic/ }).click();
  await page.keyboard.press("Delete");
  await page.getByRole("row", { name: /not a schematic/ }).waitFor({ state: "detached" });
  check(true, "Delete removes the selected file");

  // Narrow window: nothing should overflow.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(720, 440));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, "6-narrow-dark.png") });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!overflow, "fits the minimum window size");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1040, 640));

  // Light theme, through the real control.
  await page.getByRole("button", { name: "More options" }).click();
  await page.getByText(/^Version \d+\.\d+\.\d+$/).waitFor();
  check(true, "the app shows its version");
  await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
  await page.waitForTimeout(350);
  await page.getByRole("row", { name: /castle\.schem/ }).click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(shots, "7-done-light.png") });
  check(await page.evaluate(() => matchMedia("(prefers-color-scheme: light)").matches), "the theme control applies");

  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`);
} catch (error) {
  await app.windows()[0]?.screenshot({ path: join(shots, "failure.png") }).catch(() => {});
  console.error("Page errors:", errors.slice(0, 5));
  throw error;
} finally {
  await app.close().catch(() => {});
  rmSync(work, { recursive: true, force: true });
}

console.log(`\nScreenshots: ${shots}`);
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("All checks passed");
