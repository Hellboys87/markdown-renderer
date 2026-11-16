# markdown-renderer

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Hellboys87/markdown-renderer/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Hellboys87/markdown-renderer/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A from-scratch Markdown renderer in dependency-free JavaScript that reproduces the reference renderer's HTML output byte for byte. It covers the full CommonMark 0.31.2 spec plus the GFM 0.29 extensions: tables, task lists, strikethrough and extended autolinks. The block parser works on line arrays with container recursion for blockquotes and list items; the inline parser builds a node list with bracket and delimiter stacks, so emphasis, links and images nest the way the spec's algorithm prescribes. `parse.js` exports a single `parse(markdown)` function; `main.ts` is the thin driver that reads the case file, renders every case and writes the results out as JSON.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=9xcq3bkm&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
