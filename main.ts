// Entry point for the markdown-render-speed-02 harness.
//
// The harness mounts the case set at /input and expects the rendered
// results at /output. When the kit's local grader runs this program on a
// developer machine instead of inside the sandbox it points the two
// MAKEFUN_*_DIR variables at scratch directories, so honour those first
// and fall back to the sandbox mounts.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const raw = readFileSync(join(inputDir, "cases.json"), "utf8");
const cases = JSON.parse(raw) as { id: string; markdown: string }[];

const html = cases.map((c) => parse(c.markdown));

writeFileSync(join(outputDir, "html.json"), JSON.stringify(html));
