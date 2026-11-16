// main.ts — driver for the markdown-render-speed-02 entry.
//
// The harness runs `node /bot/main.ts`. It reads the case list from
// /input/cases.json (a JSON array of {id, markdown}), renders every case
// on its own with parse() from ./parse.js, and writes the results to
// /output/html.json (a JSON array of HTML strings, in the same order as
// the cases). Outside a container, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case {
  id: string;
  markdown: string;
}

const cases: Case[] = JSON.parse(
  readFileSync(join(inputDir, 'cases.json'), 'utf8'),
);

const html: string[] = new Array(cases.length);
for (let n = 0; n < cases.length; n++) {
  html[n] = parse(cases[n].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
