# Alerts (TH-FEAT-15)

Server-side price alerts with email + in-app toast. The engine runs inside the Trading Hub Node server on the
**alert host** (Windows) and keeps firing while no browser tab is open.

## Enable the engine
`ALERTS_ENGINE=1` starts the poller (every 5 s, REST klines per venue:symbol:interval). Without it, alerts can be
created/managed but never fire. `Start TradingHub.bat` sets it; the Mac launcher leaves it off by default.

Data: `%USERPROFILE%\.tradinghub\alerts.db` (SQLite; override `ALERTS_DB_PATH`). Requires Node ≥ 22.13.

## Email sender (Gmail SMTP, app password)
Create a Google app password and put it in a local file **on the alert host** (never in the repo or UI):

```
%USERPROFILE%\.tradinghub\alerts.env        (macOS/Linux: ~/.tradinghub/alerts.env, chmod 600)
GMAIL_USER=you@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
```

Override the location with `ALERTS_ENV_FILE`. The file is read at send time (no restart). Sent via
`smtp.gmail.com:465` (implicit TLS). Then open **Settings → 通知邮箱**, save the recipient, click
**发送测试邮件**, and enter the 6-digit code. Changing the address resets verification.

## Limits
- Frequencies: Only Once, Once Per Minute (≤ 1/min), Once Per Bar Close. Default expiry 30 days.
- Global cap 30 emails/hour (excess fires are logged as "capped"); retries 30 s → 2 m → 10 m → 30 m → 1 h.
- Placeholders: `{{ticker}} {{exchange}} {{interval}} {{level}} {{open}} {{high}} {{low}} {{close}} {{volume}} {{time}} {{timenow}} {{name}}`.

## Testing without Gmail
```
node tools/mock-smtp.mjs --port 2525 --out captured-mail.jsonl
ALERTS_SMTP_HOST=127.0.0.1 ALERTS_SMTP_PORT=2525 ALERTS_SMTP_SECURE=0 ALERTS_ENGINE=1 npx vinext start --hostname 127.0.0.1
```
Plaintext SMTP is only allowed to loopback, and credentials are never sent over it.

## API (localhost + same-origin only; mutations are JSON POST ≤ 8 KB)
`GET/POST /api/alerts`, `POST /api/alerts/action {id, action: pause|resume|delete}`, `GET /api/alerts/log?after=`,
`GET/POST /api/alerts/settings {action: set|send-test|verify|clear}`, `GET /api/alerts/engine`.

## Liquidation-zone alerts (TH-FEAT-16)

Bell toggle 🔔 in the liquidation legend: 「价格触及支撑/阻力区时提醒」. One server-side group per symbol + venue
(`POST /api/alerts/zones {action: "enable"|"disable", symbol, venue}`, same localhost/same-origin/JSON guard as the rest of `/api/alerts`).

- Zones come from the same sanitized snapshot the chart shows (a 刷新清算 refresh wins over the bundled fixture) and are re-synced on every engine poll (5 s): unchanged zones (same role/lo/hi) keep their state, new zones start unarmed.
- Fires when the 1m live price enters any zone [lo, hi] (or jumps through it between polls). If price is already inside when the group is created or the zone appears, nothing fires until price has left by more than 0.1 % and comes back.
- Once per entry, re-arms after exit + 0.1 % buffer, at most one fire per minute per zone. Delivery = log/toast + email to the verified address, sharing the hourly cap and dedupe (`zone:<group>:<zone>:<minute>`).
- Live testing only: the operator may set `ALERTS_TEST_ZONES_FILE` to a JSON file `{ "symbol": "BTCUSDT", "zones": [{ "role": "support", "lo": 1, "hi": 2, "liq_m": 0 }] }`; those zones are labeled `[TEST ZONE]`. Never set it in normal use; clients cannot inject zones.
