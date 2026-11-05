import { build } from "esbuild";

await build({
    entryPoints: ["src/sketchup-sync.js"],
    outfile: "dist/sketchup-sync.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "eof",
});

console.log("built dist/sketchup-sync.js");
