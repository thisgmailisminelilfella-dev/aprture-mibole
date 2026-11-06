# Aperture Phone

A local, phone-first **paper-only analysis companion in development**. The host can fetch free daily price history, produce a simple deterministic trend screen, preserve the most recent successful sheet, and let a paired phone pause or resume scans. Signals are not advice, orders, a verified strategy, or proof of profitability. The upstream feed may be delayed, rate-limited, unavailable, or change without notice.

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

## How it works

- Each market's default sweep requests six months of daily closes from Yahoo Finance's public chart endpoint. A target symbol can also be entered (Indian symbols without a suffix use `.NS`; crypto symbols without a pair use `-USD`). At least 50 valid closes are required. The trend screen compares 20- and 50-day simple averages and uses recent return volatility for illustrative stop/target distances. It is **not** bootstrapped or backtested. Values and market availability depend on the upstream provider. No API keys or LLMs are used.
- The last successful sheet is kept in local SQLite if the feed fails. A partially successful sweep replaces the sheet with the successful symbols. The pause switch is persistent and invalidates an in-flight scan; the current build has no background scheduler.
- Pairing uses the host PIN, an eight-hour in-memory HttpOnly/SameSite session cookie, rate-limited PIN attempts and same-origin checks on writes. Restarting the host invalidates sessions. The database directory is created with mode 0700 and database mode 0600 on Unix. The browser never receives a key or the PIN hash.
- A live activation request requires an authenticated session and the host PIN again, with the same PIN attempt limit and origin checks. It always fails closed because no broker or verified readiness gate exists. There is no way to switch out of paper mode in this build. The phone shows this limitation rather than presenting a fake switch.
- The installable shell is cached by a service worker where supported. Service workers generally require HTTPS or localhost; plain LAN HTTP usually does not qualify. Authenticated snapshots are not cached for offline access, to avoid exposing them without the host PIN.

## Security limitations

This server binds to all interfaces for LAN use but **does not enforce a LAN-only firewall**. Do not port-forward it or expose it to the internet. Ordinary LAN HTTP does not encrypt PINs, session cookies or data in transit; use only a trusted private network or arrange a trusted local HTTPS termination. This is not an independently audited security implementation.

## What's not implemented

There is no paper broker, position opening/closing, auto-trading, scheduler, trade ledger, live trading, broker integration, verified readiness score, playbook training/activation, LLM key pool, news feed, key-health monitoring, workstation build, or offline authenticated snapshot. The readiness and positions panels explicitly show missing data instead of fabricated scores or trades. `books/` contains reference metadata, not complete executable playbooks. Do not rely on this build for trading or risk management.

## Development

```sh
npm run check
npm test
npm run build
```

The tests cover the basic quant calculation, PIN authentication, fail-closed live activation, same-origin write checks, and persistent pause. They do not validate market data accuracy or trading performance.
