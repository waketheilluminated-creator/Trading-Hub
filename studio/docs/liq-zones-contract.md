# Liquidation zones — Trading Hub shell notes (TH-FEAT-10 / TH-FEAT-11)

Companion to the estimator's `TRADINGHUB.md` (owned by 订单流研发). Where they differ, this file
describes what the Trading Hub shell actually does.

## Box anchor (replaces `boxStart: "latest_candle"`)

- The shell **anchors zone boxes at the candle containing `asOf`**, the time of the last calculation or refresh.
  The anchor is the bar whose `open <= asOf < next open` on the interval currently loaded. The box runs from that
  bar to the right edge of the chart (into the future area).
- If `asOf` is older than the loaded history, the anchor is the first loaded bar. If it is newer than the latest
  bar (or missing or invalid), the anchor is the latest bar.
- A refresh (刷新清算) moves the anchor to the new `asOf`. Switching interval recomputes the anchor.
- A dashed vertical marker 「计算于 HH:MM」 (viewer's local time) is drawn at the anchor.
- `boxStart` is accepted (`"latest_candle"` or `"asOf"`) but ignored. Any other value is still rejected as malformed.

## Refresh endpoint

`POST /api/liq-zones/refresh?symbol=ZECUSDT|PYTHUSDT` runs
`<LIQ_ESTIMATOR_CMD argv> --symbol <SYM> --out <server-chosen path>` without a shell.
Exit 0 means the JSON file was written. A non-zero exit, with a message on stderr, is a failure, and the last good
snapshot is kept. stdout (the status line) is ignored. The output must pass the zones sanitizer before it is used.
`venues_failed` (an object keyed by venue) drives the ⚠ warning. Venues in `venues_unlisted` are never warned about.
