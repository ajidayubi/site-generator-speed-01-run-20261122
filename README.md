# Site Generator Speed — 22 November 2026

[![site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/ajidayubi/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/ajidayubi/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's makefun-site 1.0.0: `solve.js` returns byte-for-byte the same
output tree for every case, in about a third of the reference's CPU time. One pass, no token
trees, no per-line regexes, no repeated escaping; the Markdown renderer works over index
ranges so no span ever copies its text, and the template renderer walks a flat list of
operations with an explicit scope chain.

Run: `MAKEFUN_INPUT_DIR=in MAKEFUN_OUTPUT_DIR=out node main.ts`
