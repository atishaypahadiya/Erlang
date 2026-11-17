# The shared contract

`finding.schema.json` and `report.schema.json` are copies of ITTEN's `schema/finding.schema.json` and `schema/report.schema.json` at the release tag `v0.3.5` (commit `f79c18f`), where finding/1 and report/1 are released. `../schema.js` is ITTEN's validator at the same tag (`scripts/lib/schema.js`), with only its header comment changed.

They were read with `git show v0.3.5:<path>` and nothing in ITTEN was written. They replace the copy taken from the unmerged `release/0.3.5` branch at `0b8837b`. Between the two, only `location.symbol`'s description changed: it now reads "The function, method, class or variable", which covers the variable name `secret-public-prefix` puts there. `report.schema.json` and the validator are unchanged. To update after the contract changes, copy the files from the new release tag the same way, record it here, and run `npm test`.

| File | SHA-256 at v0.3.5 |
|---|---|
| finding.schema.json | `40d045272bd878a15f5c804cb3fd78ce5b4bd3623d53910110a78f8f1d8d61b1` |
| report.schema.json | `00efc3e15d106ba40760fd8d6a26177909d02ccbb397b280636801ec95bb6d83` |
| ../schema.js (before the header change) | `fd7498913f8b481bac3872772b857708120a60b2866432d06a51869fee8f52fb` |
