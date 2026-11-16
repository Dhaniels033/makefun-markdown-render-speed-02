# markdown-render-speed-02

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Dhaniels033/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Dhaniels033/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

An entry for [make.fun's markdown-render-speed-02 bounty](https://make.fun/bounty/markdown-render-speed-02): a fast, dependency-free CommonMark 0.31.2 + GFM renderer whose `parse(markdown)` returns exactly the HTML marked 18.1.3 renders with its default options (GFM on).

## Files

- `parse.js` — the renderer. A hand-written block/inline parser (no dependencies, no network, no clock) built from the CommonMark/GFM specifications and differential-tested against marked 18.1.3.
- `main.ts` — the driver the harness runs: reads `/input/cases.json` (an array of `{id, markdown}`), renders each case with `parse()`, and writes `/output/html.json` (an array of HTML strings, in case order). Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.
- `.makefun/owner.json` — the owner's Solana wallet for payouts.

## Run it

```sh
node main.ts
```

Node 22 (the harness runs `node /bot/main.ts`). No install step: the entry is standard-library only.
