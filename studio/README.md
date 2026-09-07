# Trading Hub

A focused TradingView-style crypto analysis workspace built on the Pine-A-Script transpiler.

## Included

- Live Bybit perpetual candlestick charts for BTC, ETH, SOL, and XRP
- 1m through 1D timeframes with EMA overlays
- Editable Pine Script v5 subset compiled and executed in the browser
- Drag-resizable Pine editor height and editor/console split
- TradingView-style collapsible Pine panel, chart script actions, alerts, and removable indicator legends
- Separate full-tab Pine editor with automatic cross-tab source synchronization
- Price alerts with in-app state and browser notifications
- CCXT-normalized derivatives data from Bybit, Binance, and OKX
- Open interest, funding rate, mark price, index price, and basis
- Experimental AI Analyst with an OpenAI-compatible custom model connector
- AI context containing recent K-lines, Pine plots, built-in indicators, and derivatives data

The CCXT values are also available to Pine scripts as `open_interest`,
`funding_rate`, `mark_price`, and `index_price`.

## Run locally

```bash
npm install
npm run dev
```

Quality checks:

```bash
npm run lint
npm test
```

Market data uses public exchange endpoints and does not require API keys. This
project is an analysis tool, not an execution or financial-advice service.

The AI connector requires a compatible HTTPS chat-completions endpoint, model
ID, and optional API key. Credentials remain in the current browser session and
are forwarded only when the user explicitly requests an analysis.
