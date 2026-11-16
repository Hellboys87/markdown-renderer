// Driver for the markdown-render-speed-02 harness: read every case from
// /input/cases.json, render each one with parse.js, and write the HTML strings,
// in case order, to /output/html.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse } from './parse.js';

interface Case {
  id: string;
  markdown: string;
}

const inputPath = '/input/cases.json';
const outputPath = '/output/html.json';

const cases = JSON.parse(readFileSync(inputPath, 'utf8')) as Case[];
const rendered = cases.map((entry) => parse(entry.markdown));

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(rendered));
