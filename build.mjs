import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const outfile = "assets/dashboard.bundle.js";

await build({
    entryPoints: ["src/dashboard-chart.js"],
    bundle: true,
    minify: true,
    legalComments: "inline",
    format: "iife",
    target: "es2019",
    outfile,
});

// Cache-busting: point index.html at dashboard.bundle.js?v=<content hash>, so browsers fetch
// the new chart code after every change instead of reusing an old cached copy.
const version = createHash("sha256").update(readFileSync(outfile)).digest("hex").slice(0, 10);
const html = readFileSync("index.html", "utf8");
const stamped = html.replace(/assets\/dashboard\.bundle\.js(\?v=[0-9a-f]+)?"/, `assets/dashboard.bundle.js?v=${version}"`);
if (stamped === html && !html.includes(`?v=${version}"`)) throw new Error("bundle <script> tag not found in index.html");
writeFileSync("index.html", stamped);
console.log(`built ${outfile} (v=${version})`);
