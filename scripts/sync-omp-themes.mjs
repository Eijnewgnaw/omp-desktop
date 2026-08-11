import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const sourceRoot = process.argv[2];
const sourceVersion = process.argv[3] ?? "unknown";

if (!sourceRoot) {
  throw new Error("Usage: node scripts/sync-omp-themes.mjs <omp-theme-directory> [version]");
}

const readTheme = async file => JSON.parse(await fs.readFile(file, "utf8"));
const themes = {};

for (const base of ["dark.json", "light.json"]) {
  const theme = await readTheme(path.join(sourceRoot, base));
  themes[theme.name] = theme;
}

const defaultsDir = path.join(sourceRoot, "defaults");
for (const entry of (await fs.readdir(defaultsDir)).sort()) {
  if (!entry.endsWith(".json")) continue;
  const theme = await readTheme(path.join(defaultsDir, entry));
  themes[theme.name] = theme;
}

const output = path.resolve("src/shared/omp-themes.generated.json");
await fs.writeFile(
  output,
  `${JSON.stringify({ source: "can1357/oh-my-pi", sourceVersion, themes }, null, 2)}\n`,
  "utf8",
);
console.log(`Wrote ${Object.keys(themes).length} OMP themes to ${output}`);
