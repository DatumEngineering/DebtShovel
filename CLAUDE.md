# CLAUDE.md — Debt Payoff Calculator

## Project Overview

A fast, browser-native debt payoff calculator built in pure JavaScript with no backend dependencies.
Inspired by undebt.it but with a significantly improved UX: interactive sliders, real-time
recalculation, per-debt payoff dates, and clear visualizations. Deployable as a static site via
GitHub Pages + GitHub Actions.

---

## Core Philosophy

- **No backend, no build step** — pure HTML/CSS/JS, deployable as a flat static file
- **Privacy-first** — all data stays in the browser; nothing is ever sent to a server
- **Fast and responsive** — recalculations happen in real time as sliders move
- **Accessible** — keyboard-navigable, ARIA-labeled sliders and form elements
- **MIT Licensed** — open source, free to reuse with attribution

---

## Features

### 1. Debt Entry Table

Debts are displayed as a table. Each row shows:

| Column | Notes |
|---|---|
| Account Name | Editable inline |
| Current Balance (USD) | Editable inline |
| Min. Monthly Payment (USD) | Editable inline; principal-only for mortgages (see below) |
| APR (%) | Editable inline |
| Freed-Payment Allocation | Per-debt override dropdown (defaults to global setting) |
| **Nominal Payoff Date** | Calculated, read-only; minimum payments only, format `MMM YYYY` |
| Actions | Edit (re-opens modal) / Delete |

The **Nominal Payoff Date** column updates live whenever any field changes. It uses
**minimum payments only**, independent of slider values, giving the user an honest per-debt
baseline.

A totals row at the bottom shows:
- Total balance
- Total minimum monthly payments
- Overall nominal payoff date (when the last debt reaches zero on minimums only)

Rows are added via the **Add Debt modal** (see section 2). Clicking the edit icon on an
existing row re-opens the modal pre-filled with that debt's current values.

---

### 2. Add Debt Modal

Triggered by an "+ Add Debt" button. Opens as a **modal dialog** over the page. Uses a
**short wizard flow**: the user picks an entry mode first, then the relevant fields appear.

#### Step 1 — Choose Entry Mode

Three clearly labeled cards or large radio options:

| Mode | Label | Best for |
|---|---|---|
| **Manual** | "I know my balance & payment" | Credit cards, personal loans |
| **Amortizing Loan** | "I know my original loan details" | Mortgages, auto loans, student loans |
| **Payoff Date** | "I know when it'll be paid off" | Any loan where you have a statement end date |

Selecting a mode transitions to Step 2 with a brief animation. A "← Back" link always
returns to mode selection.

---

#### Step 2a — Manual Entry Mode

Fields:
- **Account Name** (text)
- **Current Balance** (USD)
- **Annual Interest Rate / APR** (%)
- **Monthly Payment** (USD)
  - For mortgages: show a sub-field: **"Escrow (taxes + insurance)"** (USD, optional)
  - The escrow amount is subtracted so only the principal+interest portion is used in
    calculations. A helper note reads: *"Only the principal & interest portion is used —
    escrow doesn't reduce your balance."*

Nominal payoff date previews live at the bottom of the modal as fields are filled in.

---

#### Step 2b — Amortizing Loan Mode

Fields:
- **Account Name** (text)
- **Original Loan Balance** (USD)
- **Loan Start Date** (month/year picker)
- **Loan Term** (years, or months — let user toggle)
- **Annual Interest Rate / APR** (%)
- **Escrow / Extra in Payment** (USD, optional — same mortgage note as above)

**Auto-calculated and shown as read-only previews** (all editable before confirming):
- Monthly payment (P&I): derived from original balance, term, APR using standard amortization formula
- Current remaining balance: derived by simulating payments from start date to today
- Remaining term: months left based on start date + original term

A callout reads: *"Verify these match your latest statement — early payoff, missed payments,
or rate changes won't be reflected."*

The user can override the pre-filled current balance and monthly payment before confirming.

**Amortization formula** (for reference in `calculator.js`):
```
M = P * [r(1+r)^n] / [(1+r)^n - 1]

where:
  P = original principal
  r = APR / 12 (monthly rate)
  n = term in months
```

To derive current remaining balance after `k` payments:
```
B_k = P * (1+r)^k - M * [(1+r)^k - 1] / r
```

---

#### Step 2c — Payoff Date Mode

Fields:
- **Account Name** (text)
- **Current Balance** (USD)
- **Annual Interest Rate / APR** (%)
- **Target Payoff Date** (month/year picker)

**Auto-calculated preview**:
- Required monthly payment to hit that payoff date (derived via binary search on the
  simulation, since the closed-form solution may not be exact for month-boundary alignment)

The user can override the calculated payment before confirming.

---

#### Modal Footer

- **"Add Debt"** / **"Save Changes"** primary button — validates all required fields,
  closes modal, adds/updates the row in the debt table
- **"Cancel"** — closes modal, discards changes
- Inline validation errors appear next to fields (not as alerts)
- Nominal payoff date preview updates live throughout Step 2

---

### 2. Simulation Model (Core Logic)

All calculations use a **month-by-month simulation loop**, not closed-form approximations.
This is more accurate for real-world debt payoff, especially when balances cross zero mid-month
and freed-up payments roll into the next debt.

#### Monthly Loop

```
// Initialization (month 0 only):
Apply one-time lump sum to debts in priority order (per lump sum strategy),
cascading any remainder to the next debt until lump sum is exhausted.

// Each month:
for each debt (all debts simultaneously):
  accrue interest: balance += balance * (APR / 12)
  apply this debt's minimum payment to its balance

determine the "snowball pool" for this month:
  snowball pool = extra monthly payment (slider)
               + sum of minimum payments from any debts paid off in prior months

apply snowball pool to the highest-priority unpaid debt (per monthly strategy),
cascading remainder to the next debt if that debt is fully paid off mid-application

record each debt's remaining balance as a data point for charts
until all balances = 0 (or 600-month safety cap is hit)
```

#### Key Rules

- **Minimums are always paid first.** The extra monthly slider is strictly additional.
- **Freed minimums roll forward per allocation setting.** When a debt reaches $0, its minimum
  payment is split according to the **freed-payment allocation** setting (see section 6) before
  being added to the snowball pool.
- **Lump sum cascades.** If the lump sum fully pays off one debt, the remainder is immediately
  applied to the next priority debt, and so on, until exhausted.
- **Lump sum applied at month 0**, before any interest accrues.
- **Safety cap**: If total payoff exceeds 600 months (50 years), stop the simulation and
  display a warning. This prevents infinite loops when minimum payments don't cover monthly
  interest.

#### Baseline Simulation

Run a separate simulation with no extra monthly payment and no lump sum. This is used for:
- The **Nominal Payoff Date** column in the debt table
- The **minimum payments only** line in Chart A
- Delta calculations (interest saved, months saved)

---

### 3. One-Time Lump Sum Slider

*"If I had a windfall today, how much would I save?"*

- **Range**: $0 – total of all entered balances, step $50
- **Strategy picker** (independent of the monthly slider): Avalanche / Snowball / Highest Payment / Most Interest/Month
- **Live output callout**:
  - Interest saved vs. baseline ($)
  - Months/years sooner payoff completes

---

### 4. Extra Monthly Payment Slider

*"If I put an extra $X/month toward debt, what happens?"*

- **Range**: $0 – 3× total minimum payments, step $25
- **Strategy picker** (independent of the lump sum slider): Avalanche / Snowball / Highest Payment / Most Interest/Month
- **Live output callout**:
  - Total interest saved over life of payoff ($)
  - Months/years sooner payoff completes

Both sliders are active simultaneously. The simulation always includes both the lump sum
(applied at month 0) and the extra monthly payment together. Savings callouts reflect the
combined effect.

---

### 5. Freed-Payment Allocation

When a debt is fully paid off, its former minimum payment becomes available. This setting
controls how much of that freed amount rolls into the snowball pool vs. stays with the user
as a personal reward.

#### Global Default

A segmented control or radio group shown above the debt table (or in a settings area), with
three options:

| Option | Label | Behavior |
|---|---|---|
| **100%** | "Roll it all forward" | Full freed minimum joins the snowball pool each month |
| **50/50** | "Split the difference" | Half joins the snowball pool; half is kept by the user |
| **0%** | "Keep it all" | Freed minimum does not join the snowball pool at all |

Default selection: **100%**.

#### Per-Debt Override

Each debt row has an optional override — a small inline control (e.g. a compact dropdown or
toggle) that defaults to "Use global setting" and can be changed to any of the three options
independently. This lets a user say, for example, "when my car loan is paid off I want to
keep that payment, but roll everything else forward."

#### Simulation Behavior

When a debt clears in month M, for every subsequent month:
```
freed_amount = that debt's minimum payment
pool_contribution = freed_amount * allocation_percent   // 100%, 50%, or 0%
kept_amount = freed_amount - pool_contribution

snowball pool += pool_contribution
```

The `kept_amount` is removed from the simulation entirely — it is assumed the user spends it.

#### "You're Keeping" Callout

Display a live callout below the allocation control (or near the savings summary) showing:

> **You're keeping $X/month** as debts are paid off

Where `$X` is the sum of all `kept_amount` values that will accumulate by the final payoff
month under the current plan. This updates live as sliders and debt rows change, giving the
user a tangible sense of the reward they're building in.

---

### 6. Payoff Strategies

Each strategy is a **pure sort function** that takes the array of active (unpaid) debts and
returns them sorted by priority. The first debt in the sorted result receives the extra payment.

| Strategy | Sort Key | Direction |
|---|---|---|
| **Avalanche** (highest interest first) | APR | descending |
| **Snowball** (lowest balance first) | current balance | ascending |
| **Highest Monthly Payment** | minimum payment | descending |
| **Most Interest Per Month** | `balance × (APR / 12)` | descending |

**Tie-breaking**: When two debts share the same sort key value, break ties alphabetically by
account name for determinism.

---

### 7. Visualizations

Load **Chart.js** via CDN (`https://cdn.jsdelivr.net/npm/chart.js`). No npm required.
Both charts update live on every slider move or debt table change.

#### Chart A — Total Debt Over Time

- **Type**: Line chart
- **Lines**:
  - *Minimum payments only* (baseline, muted color)
  - *With extra payments* (accent color, reflects both sliders + their strategies)
- **X-axis**: Months from today
- **Y-axis**: Total remaining balance across all debts (USD)
- **Purpose**: Show how much sooner the user will be debt-free and how the curves diverge

#### Chart B — Balance Per Debt Over Time

- **Type**: Multi-line chart (one line per debt)
- **Scenario**: Always reflects current slider values (both sliders + their selected strategies)
- **X-axis**: Months from today
- **Y-axis**: Individual debt balance (USD)
- **Purpose**: Show how each individual debt decreases and when it hits zero under the active plan

---

## Advanced Features

### Balance Back-Calculator

The **Payoff Date entry mode** in the Add Debt modal (Section 2, Step 2c) serves as the
primary back-calculator. For users who added a debt via Manual or Amortizing mode and later
want to adjust the balance to match a known payoff date, the edit modal (re-opened via the
row's edit icon) allows switching modes — including switching to Payoff Date mode to
recalculate the balance from a target date.

No separate per-row inline toggle is needed; the modal handles all entry and re-entry flows.

---

## File Structure

```
/
├── index.html              # Single-page app, all markup
├── style.css               # All styles
├── calculator.js           # Pure calculation logic (no DOM touches)
├── ui.js                   # DOM manipulation, event wiring, chart rendering
├── LICENSE                 # MIT License text
├── README.md               # Project description, usage, screenshot
├── CLAUDE.md               # This file
└── .github/
    └── workflows/
        └── deploy.yml      # GitHub Actions → GitHub Pages
```

All JS is vanilla ES6+. No bundler, no npm, no build step. The project must run correctly
by opening `index.html` directly in a browser (file:// protocol) or from any static host.

---

## GitHub Actions Deployment

Target: **GitHub Pages** (static site hosting, no build step).

```yaml
# .github/workflows/deploy.yml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]

permissions:
  pages: write
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: '.'
      - id: deployment
        uses: actions/deploy-pages@v4
```

---

## Design Direction

- **Aesthetic**: Clean, trustworthy financial tool — data-forward, fast-feeling, no clutter
- **Layout**: Debt table at top → sliders + callouts in the middle → charts at the bottom
- **Dark mode preferred** with a single strong accent color for savings callouts
- **Typography**: Use `font-variant-numeric: tabular-nums` for all financial figures so columns
  align as values change live
- **Responsiveness**: Mobile-first; charts reflow gracefully on narrow screens
- **Accessibility**: All inputs and sliders have associated `<label>` elements and ARIA attributes;
  charts include a visually-hidden data summary as fallback

---

## Edge Cases & Validation

| Condition | Behavior |
|---|---|
| Minimum payment ≤ monthly interest accrued | Warn inline on that row: "Payment doesn't cover interest — debt will never pay off" |
| All balances reach $0 | Disable sliders, show "Debt free! 🎉" state |
| Lump sum ≥ total balance | Cap slider to total balance; result shows full payoff |
| Extra monthly slider at $0 | Charts still render; callout shows $0 saved |
| Simulation exceeds 600 months | Stop loop, show warning, render partial chart |
| Single debt entered | All four strategies produce identical results; no special handling needed |

---

## Implementation Notes

1. **Separation of concerns**: `calculator.js` must contain only pure functions — no `document`,
   no `window`, no side effects. All simulation logic, sort strategies, amortization formulas,
   and delta math live here. `ui.js` handles all DOM reads/writes, modal lifecycle, and chart
   rendering, calling into `calculator.js` for all numbers.

2. **Amortization helpers in `calculator.js`**:
   - `calcMonthlyPayment(principal, aprPercent, termMonths)` — standard P&I formula
   - `calcRemainingBalance(principal, aprPercent, termMonths, paymentsMade)` — balance after k payments
   - `calcPaymentForPayoffDate(balance, aprPercent, targetMonths)` — binary search for required payment

3. **Slider performance**: Bind chart updates to the `input` event (fires continuously while
   dragging), not `change` (fires only on release). With typical debt counts (2–10 debts) the
   simulation is fast enough that live updates feel instantaneous.

4. **Nominal payoff date format**: Display as `MMM YYYY` (e.g. "Jun 2031") — specific enough
   to be useful, not so precise it implies false accuracy.

5. **localStorage (optional)**: A "Save" button may serialize the debt table to `localStorage`
   so data persists across page reloads. Opt-in only, clearly labeled. No auto-save.

6. **Chart color palette**: Assign each debt a distinct color from a predefined accessible
   palette. Colors remain stable as debts are added/removed (assign by index, not by name).

7. **Both sliders interact**: The live simulation always runs with both the lump sum and the
   extra monthly payment active simultaneously. The savings callout on each slider should
   reflect the combined scenario, not each slider in isolation.

8. **Modal state**: The modal maintains wizard step state in memory only. Closing without
   confirming discards all changes. Re-opening an existing debt pre-fills Step 2 in whatever
   mode that debt was originally entered with.

---

## License & Disclaimer

**License**: MIT

```
MIT License

Copyright (c) [YEAR] [AUTHOR]

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

**Footer disclaimer** (include verbatim in `index.html`):

> This calculator is provided for informational and educational purposes only. It does not
> constitute financial advice. Results are estimates based on the data you enter and standard
> amortization formulas; actual payoff timelines and interest savings may vary. The author is
> not liable for any decisions made based on this tool's output.
>
> This source code is free to use and reuse under the MIT License. If you reuse or adapt this
> code, please retain attribution to the original project. Do not hold the author liable for
> any failures, inaccuracies, or unintended consequences arising from use of this software.
