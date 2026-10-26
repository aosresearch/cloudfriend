// Copy what the website demo needs from this repository: the built-in model and the
// browser-safe triage modules, so the page scores pasted logs exactly like the server.
//
//   npm run demo:sync -- ../cloudfriend-website
import fs from "node:fs";
import path from "node:path";

const site = process.argv[2];
if (!site || !fs.existsSync(path.join(site, "package.json"))) {
  console.error("usage: npm run demo:sync -- <path to cloudfriend-website>");
  process.exit(2);
}
const root = path.join(import.meta.dirname, "..");
fs.mkdirSync(path.join(site, "src", "triage"), { recursive: true });
fs.mkdirSync(path.join(site, "public", "demo"), { recursive: true });
for (const f of ["features", "gbdt", "classifier"]) {
  const src = fs.readFileSync(path.join(root, "src", "triage", `${f}.ts`), "utf8");
  const header = `// Copied from aosresearch/cloudfriend src/triage/${f}.ts by \`npm run demo:sync\`. Edit it there.\n`;
  fs.writeFileSync(path.join(site, "src", "triage", `${f}.ts`), header + src);
}
fs.copyFileSync(path.join(root, "models", "base.json"), path.join(site, "public", "demo", "model.json"));
console.log(`synced the model and src/triage into ${site}`);
