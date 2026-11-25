// Copies the shared tax conformance vectors from api-specs into src/tax/__vectors__/.
//
//   node scripts/sync-tax-vectors.mjs
//
// API_SPECS_DIR   path to a local api-specs clone (default: ../api-specs)
// The example rule set (draft-unreviewed.v1.json) is YAML in api-specs; convert it with any YAML tool when it changes.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const specs = resolve(process.env.API_SPECS_DIR ?? join(root, "..", "api-specs"));
const src = join(specs, "tax", "conformance", "vectors.v1.json");
if (!existsSync(src)) {
  console.error(`No vectors at ${src}. Set API_SPECS_DIR.`);
  process.exit(1);
}
const dest = join(root, "src", "tax", "__vectors__");
mkdirSync(dest, { recursive: true });
copyFileSync(src, join(dest, "vectors.v1.json"));
console.log("copied vectors.v1.json");
