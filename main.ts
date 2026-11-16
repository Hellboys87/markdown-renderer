// Driver for the markdown-render-speed-02 harness: read every case from
// cases.json in the input directory, render each one with parse.js, and
// write the HTML strings, in case order, as html.json in the output
// directory. The harness mounts the directories at /input and /output in
// its container; outside a container the MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR environment variables stand in for them.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface Case {
  id: string;
  markdown: string;
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
const rendered = cases.map((entry) => parse(entry.markdown));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
