# Aperture Phone

A phone-first **paper-only analysis companion in development**. The host can fetch free daily price history, produce a simple deterministic trend screen, preserve the most recent successful sheet, and let a paired phone pause or resume scans. Signals are not advice, orders, a verified strategy, or proof of profitability. The upstream feed may be delayed, rate-limited, unavailable, or change without notice.

## Termux on Android

Install a current version of [Termux](https://termux.dev/) first. Run these commands **in Termux**, not in the Android browser. Keep the project in Termux's home directory rather than shared phone storage.

### 1. Install prerequisites (once)

```sh
pkg update && pkg upgrade -y
pkg install -y git nodejs-lts npm
node --version
```

Node.js **22.13 or newer** is required for the built-in SQLite module. If the printed version is older, update your Termux packages before continuing.

### 2. Download and start for the first time

```sh
cd ~
git clone https://github.com/thisgmailisminelilfella-dev/aprture-mibole.git
cd aprture-mibole
npm ci --include=dev
npm start
```

When prompted in Termux, choose and confirm a **6–12 digit PIN**. The PIN will not appear while you type it. Once the server starts, open **http://localhost:7421** in the browser on the same phone and enter that PIN. Leave Termux running while you use Aperture; press **Ctrl+C** in Termux to stop it. If you already cloned the project, skip `git clone` and use your existing project directory instead.

### 3. Start again later

Open Termux and run:

```sh
cd ~/aprture-mibole
npm start
```

Open **http://localhost:7421** again. Use the PIN you created on first startup; it is not recreated on subsequent starts. To change it, stop the server and run `npm run change-pin` from the project directory.

Termux and Android may stop background processes, so restart the command if the page cannot connect. Termux itself has not been tested in this development environment. The server listens on the network as well as localhost; use it only on trusted networks and do not expose its port to the internet.

## Start on other systems

Requires Node.js **22.13+** (the application uses Node's built-in SQLite) and npm.

```sh
npm install
npm start
```

Open `http://localhost:7421` on the host, or `http://HOST_LAN_IP:7421` from a phone on the same trusted Wi-Fi. On first startup, choose and confirm a **6–12 digit host PIN** in the host terminal. Input is not echoed, and the PIN is stored as a salted scrypt hash in the local database. For non-interactive startup only, supply `APERTURE_PIN` on first startup; environment variables may be visible to other processes and deployment tools, so an interactive terminal is preferred. Existing installations keep their current PIN. To change it, stop the server and run `npm run change-pin`; the current PIN is required, and existing sessions will be invalidated. If you have lost it, stop the app and remove the local database **after backing it up**; this also removes stored snapshots and pause state. `PORT` overrides 7421 and `APERTURE_DATA_DIR` overrides the data directory.

## Paper trading setup

India uses a **local simulator**, not an Indian broker or exchange service. It needs no account. For US stocks and supported crypto, the optional adapter connects only to Alpaca's **paper** API. Create a paper-only account with Alpaca separately; do not send credentials in chat. The host sends simulated orders and position requests to Alpaca, so this feature is not LAN-only.

On the host (including Termux), start from the project directory and enter your Alpaca **paper** credentials privately when prompted:

```sh
read -rs -p "Alpaca paper key ID: " ALPACA_PAPER_KEY_ID; echo
read -rs -p "Alpaca paper secret: " ALPACA_PAPER_SECRET_KEY; echo
export ALPACA_PAPER_KEY_ID ALPACA_PAPER_SECRET_KEY
npm start
```

These values are not saved by Aperture; repeat the prompts in a new terminal session. Environment variables can be visible to other processes on the host. Without both credentials, Indian simulation still works and Alpaca is unavailable. Do not use live-account credentials. The adapter hard-codes `https://paper-api.alpaca.markets/v2` and rejects redirects; there is no live endpoint option.

Run a scan, open a **LONG** signal, choose **Open paper position**, review the provider and quantity, then confirm. The positions shelf displays local Indian positions or Alpaca paper positions for the selected market. Close from that shelf; Alpaca close requests may remain pending. A fresh scan is required to open a position: the last daily data point must be no more than 72 hours old. Paper orders are manual; there is no automatic execution or stop monitoring. Pausing blocks new opens, but does not cancel already submitted Alpaca orders. Close requests remain available while paused.

The local simulator supports only whole-share long NSE cash symbols, up to 100 shares and ₹100,000 notional per position. It fills at the latest available **daily close**, not a live quote, rejects data older than 72 hours, and does not model funds, fees, slippage, settlement, shorts, derivatives, circuit limits or automatic stops. Its P/L and trade statistics are approximations, not a realistic broker simulation. If a network error occurs while submitting an Alpaca order, check the Alpaca dashboard before retrying because the broker may have received it. Alpaca's paper fills have their own simulation limitations.

## How it works

- Each market's default sweep requests six months of daily closes from Yahoo Finance's public chart endpoint. A target symbol can also be entered (Indian symbols without a suffix use `.NS`; crypto symbols without a pair use `-USD`). At least 50 valid closes are required. The trend screen compares 20- and 50-day simple averages and uses recent return volatility for illustrative stop/target distances. It is **not** bootstrapped or backtested. Values and market availability depend on the upstream provider. If an OpenRouter or Google AI Studio key is available, a free-tier-eligible model can add a short AI summary based only on the quantitative scan. Model output can be wrong and is not financial advice.
- Local Indian closed trades are stored in SQLite by strategy. The learnings shelf shows counts and, after three closed trades, a simple win rate and average P/L before costs. It does not change the strategy. Alpaca fills are not yet reconciled into local learning.
- The last successful sheet is kept in local SQLite if the feed fails. A partially successful sweep replaces the sheet with the successful symbols. The pause switch is persistent, requests cancellation of in-flight network work, and prevents a cancelled scan from publishing later results. An upstream provider may already have processed an in-flight request. The current build has no background scheduler.
- Pairing uses the host PIN, an eight-hour in-memory HttpOnly/SameSite session cookie, rate-limited PIN attempts and same-origin checks on writes. Restarting the host invalidates sessions. The database directory is created with mode 0700 and database mode 0600 on Unix. The PIN hash and saved keys are never returned to the browser.
- **Key pool:** open the three-dot menu → **Key pool** to add or remove OpenRouter and Google AI Studio keys. Choose the provider before pasting its key. Adding/removing requires the host PIN again. Key entry is permitted only on the host device via `localhost` or over a direct HTTPS connection to the server, not over plain remote LAN HTTP. Keys are encrypted with AES-256-GCM in SQLite; the host master key is in `data/keypool.master` (mode 0600), and the data directory is gitignored. Back up the database and master key together; losing the master key makes saved keys unreadable. This protects against casual file disclosure, not someone with full access to the host. Keys are never returned by the API or stored in browser storage.
- **Automatic model selection:** OpenRouter models are discovered on each scan and must have a `:free` ID, text input/output, and zero advertised pricing. Google models are selected automatically from a maintained allowlist of free-tier-eligible Gemini text models intersected with the models the key can access. No eligible model, no available key, or provider errors leave the quant snapshot intact. The pool tries up to three keys and three eligible models per key, parks rejected keys, and applies short cooldowns after rate limits and other failures. The provider's catalog, pricing and quotas can change; Google’s allowlist is not a live pricing feed.
- **Important Google billing limitation:** Gemini free-tier eligibility is not the same as a free API call on a billed project. Aperture cannot independently verify a Google key's project or billing status. Before adding a Google key, verify in Google AI Studio that its project is on the free tier with billing disabled, confirm this in the form, and keep billing disabled. Otherwise requests may incur charges. Multiple Google keys for the same project share its quotas; rotating them does not increase free allowance. See [Google's billing documentation](https://ai.google.dev/gemini-api/docs/billing) and [pricing](https://ai.google.dev/gemini-api/docs/pricing).
- On a successful price scan, the selected provider receives only the symbol and calculated market indicators. Key health is based on actual use, not a separate live validation. Model selection is limited to text generation; the app does not invoke paid tools or grounding. Full provider quota-calendar reset calculations are not implemented.
- For direct HTTPS, provide both `APERTURE_TLS_CERT` and `APERTURE_TLS_KEY` paths before starting the server. Use a certificate trusted by the phone for the hostname you visit. A reverse proxy alone is not treated as direct HTTPS for key entry.
- A live activation request requires an authenticated session and the host PIN again, with the same PIN attempt limit and origin checks. It always fails closed because no broker or verified readiness gate exists. There is no way to switch out of paper mode in this build. The phone shows this limitation rather than presenting a fake switch.
- The installable shell is cached by a service worker where supported. Service workers generally require HTTPS or localhost; plain LAN HTTP usually does not qualify. Authenticated snapshots are not cached for offline access, to avoid exposing them without the host PIN.

## Security limitations

This server binds to all interfaces for LAN use but **does not enforce a LAN-only firewall**. Do not port-forward it or expose it to the internet. Ordinary LAN HTTP does not encrypt PINs, session cookies or data in transit; use only a trusted private network or arrange a trusted local HTTPS termination. This is not an independently audited security implementation.

## What's not implemented

There is no automatic trading, scheduler, real-money broker integration, live trading, protective-stop execution, Alpaca fill-to-strategy ledger, verified readiness score, playbook training/activation, verified Google billing status, full provider quota management, news feed, workstation build, or offline authenticated snapshot. The readiness and positions panels explicitly show missing data instead of fabricated scores or trades. `books/` contains bibliographic metadata only: the books were not downloaded, their full contents were not ingested, and their strategies are not implemented or learned automatically. Do not rely on this build for trading or risk management.

## Development

```sh
npm run check
npm test
npm run build
```

The tests cover the basic quant calculation, PIN authentication, fail-closed live activation, same-origin write checks, key-pool encryption, migration, automatic model filtering and provider failover, persistent pause, paper-only endpoint isolation and the local Indian ledger. Alpaca calls are mocked in tests; no live paper account was tested. They do not validate market data accuracy or trading performance.
