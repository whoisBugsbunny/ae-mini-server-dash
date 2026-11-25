import { build } from "esbuild";

await build({
    entryPoints: ["src/dashboard-chart.js"],
    bundle: true,
    minify: true,
    legalComments: "inline",
    format: "iife",
    target: "es2019",
    outfile: "assets/dashboard.bundle.js",
});