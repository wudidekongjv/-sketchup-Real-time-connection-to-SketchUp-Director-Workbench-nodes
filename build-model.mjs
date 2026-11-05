import { build } from "esbuild";

await build({
    entryPoints: ["src/sketchup-model.js"],
    outfile: "dist/sketchup-model.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "eof",
});

console.log("built dist/sketchup-model.js");
