# DebtShovel — Debt Payoff Calculator

A fast, private, browser-native debt payoff calculator. No backend, no sign-up, no data ever leaves your browser.

**[Live Demo →](https://datumengineering.github.io/DebtShovel/)**

## Features

- **Four payoff strategies** — Avalanche (highest APR), Snowball (lowest balance), Highest Payment, Most Interest/Month
- **Interactive sliders** — extra monthly payment and one-time lump sum with live chart updates
- **Freed-payment allocation** — choose how much of each paid-off debt's minimum rolls into the snowball: 100%, 50%, or 0% (per-debt override supported)
- **Three debt entry modes** — Manual, Amortizing Loan (auto-calculates current balance from original terms), and Payoff Date (back-calculates required payment)
- **Real-time charts** — total debt over time vs. minimum-payments-only baseline, plus per-debt balance lines
- **Auto-save** — your data persists across page reloads via localStorage
- **Light/dark theme** toggle

## Privacy

All data stays in your browser. Nothing is sent to any server. Ever.

## Usage

Open `index.html` directly in any modern browser — no build step, no server needed.

Or deploy to any static host (GitHub Pages, Netlify, Vercel, etc.) by pointing it at this directory.

## File Structure

| File | Purpose |
|---|---|
| `index.html` | Single-page app markup |
| `style.css` | All styles (light + dark theme) |
| `calculator.js` | Pure calculation logic — no DOM |
| `ui.js` | DOM, events, charts |
| `favicon.svg` | Shovel icon |
| `.github/workflows/deploy.yml` | GitHub Actions → GitHub Pages |

## Development

No build step. Edit files and refresh the browser.

## License

MIT — see [LICENSE](LICENSE). Free to use and adapt with attribution.

## Disclaimer

This calculator is for informational and educational purposes only. It does not constitute financial advice. Results are estimates; actual payoff timelines may vary.
