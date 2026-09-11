# SplitUPI

**Split bills with flatmates or travel friends, then settle the smallest set of balances through UPI.**

SplitUPI is a polished, privacy-first expense splitter built as a dependency-free progressive web app. It runs entirely in the browser: no account, backend, analytics, or database is required.

## What it does

- Create separate groups for homes, trips, events, or anything else.
- Add people and optionally save their UPI IDs locally on the device.
- Capture expenses with an amount, payer, category, date, notes, and participants.
- Split an expense equally, by exact amounts, percentage, shares, adjustments, or itemised items.
- Calculate exact balances in integer paise so every bill reconciles to the last paisa.
- Reduce the number of repayments needed to settle a group.
- Open a UPI payment intent, copy a UPI link, or use a payment QR where a recipient has a valid UPI ID.
- Record UPI, cash, or other settlements and automatically update balances.
- Review expense history, category spending, monthly trends, and member totals.
- Export/import local data and share a group as a compact URL.
- Install it as an offline-capable PWA.

## Privacy and safety

Your ledger is saved only in your browser's `localStorage`. A group is shared only when you use the share action, and exports are created only when you ask for them. SplitUPI never processes payments; it creates a payment request for a UPI app and you approve the transaction there.

UPI deep links are a convenience, not proof of payment. Always verify the recipient and payment amount in your UPI app before paying, then use **Mark paid** to record the settlement in SplitUPI.

## Run locally

Requirements: Node.js 20 or later. There are no production dependencies to install.

```bash
git clone https://github.com/Nischay2008/upi-expense-splitter.git
cd upi-expense-splitter
npm test
npm start
```

Open [http://localhost:5173](http://localhost:5173). The static server mirrors the way GitHub Pages serves the app.

## How to use it

1. Select **Create group** and enter a group name plus at least one person.
2. Add an expense. Start with the amount, choose who paid, and choose who shared it.
3. Visit **Balances** to see the current net position of every person.
4. Open **Settle up**. The app suggests the fewest practical transfers.
5. Select a transfer to pay over UPI (or pay outside the app), then mark it paid.

Tip: set **This is me** in Settings to make the dashboard and settlement view personally relevant.

## Architecture

This project deliberately uses plain browser technologies:

```text
index.html                 App shell and PWA metadata
assets/styles.css          Responsive design system and themes
src/core/                  Ledger, split, balance, UPI, sharing, CSV, and QR logic
src/ui/                    Accessible DOM views and routing
tests/                     Node test suites for deterministic core behavior
sw.js                      Offline cache strategy
```

Money is represented as integer paise throughout the domain model. This avoids floating-point rounding errors: shares and settlements always reconcile exactly.

The app is entirely static, so it can be hosted safely on GitHub Pages. The hash router also means deep app links work without server-side rewrites.

For the full module contracts, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). UI expectations live in [docs/UI-CONTRACT.md](docs/UI-CONTRACT.md).

## Testing

```bash
npm test
```

The tests cover money parsing/formatting, exact split strategies, ledger balances, settlement minimisation, UPI link creation, CSV round-trips, and application-module smoke checks.

## Deploying to GitHub Pages

The included [deploy workflow](.github/workflows/deploy-pages.yml) publishes every push to `main`.

1. In the repository's **Settings → Pages**, set **Build and deployment** to **GitHub Actions** once.
2. Push to `main`.
3. After the workflow completes, the site is available at:

   `https://nischay2008.github.io/upi-expense-splitter/`

If you fork the repository, update the clone URL and Pages address for your GitHub account.

## License

MIT. See the package metadata for details.
