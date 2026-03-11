/**
 * calculator.js — DebtShovel
 * Pure calculation logic. No DOM access. No side effects.
 * All simulation logic, amortization formulas, and strategy sorts live here.
 */

'use strict';

// ---------------------------------------------------------------------------
// Amortization helpers
// ---------------------------------------------------------------------------

/**
 * Standard P&I monthly payment formula.
 * M = P * [r(1+r)^n] / [(1+r)^n - 1]
 * @param {number} principal  - Original loan balance in dollars
 * @param {number} aprPercent - Annual percentage rate as a percent (e.g. 6.5 for 6.5%)
 * @param {number} termMonths - Loan term in months
 * @returns {number} Monthly payment amount
 */
function calcMonthlyPayment(principal, aprPercent, termMonths) {
  if (principal <= 0 || termMonths <= 0) return 0;
  const r = aprPercent / 100 / 12;
  if (r === 0) return principal / termMonths;
  const factor = Math.pow(1 + r, termMonths);
  return (principal * r * factor) / (factor - 1);
}

/**
 * Remaining balance after k payments on an amortizing loan.
 * B_k = P * (1+r)^k - M * [(1+r)^k - 1] / r
 * @param {number} principal    - Original loan balance
 * @param {number} aprPercent   - Annual percentage rate as a percent
 * @param {number} termMonths   - Original loan term in months
 * @param {number} paymentsMade - Number of payments already made
 * @returns {number} Remaining balance (floored at 0)
 */
function calcRemainingBalance(principal, aprPercent, termMonths, paymentsMade) {
  if (paymentsMade <= 0) return principal;
  if (paymentsMade >= termMonths) return 0;
  const r = aprPercent / 100 / 12;
  if (r === 0) {
    const monthlyPmt = principal / termMonths;
    return Math.max(0, principal - monthlyPmt * paymentsMade);
  }
  const M = calcMonthlyPayment(principal, aprPercent, termMonths);
  const factor = Math.pow(1 + r, paymentsMade);
  const balance = principal * factor - M * (factor - 1) / r;
  return Math.max(0, balance);
}

/**
 * Binary search for the required monthly payment to pay off a balance
 * within a given number of months.
 * @param {number} balance      - Current balance in dollars
 * @param {number} aprPercent   - Annual percentage rate as a percent
 * @param {number} targetMonths - Desired payoff horizon in months
 * @returns {number} Required monthly payment (rounded up to nearest cent)
 */
function calcPaymentForPayoffDate(balance, aprPercent, targetMonths) {
  if (balance <= 0 || targetMonths <= 0) return 0;
  const r = aprPercent / 100 / 12;

  // Minimum possible payment (interest only) and a safe upper bound
  const minInterest = balance * r;
  let lo = minInterest + 0.01;
  let hi = balance + balance * r; // overshoot safety

  // Binary search: find payment that results in balance ≤ 0 after targetMonths months
  for (let iter = 0; iter < 60; iter++) {
    const mid = (lo + hi) / 2;
    let bal = balance;
    for (let m = 0; m < targetMonths; m++) {
      bal = bal * (1 + r) - mid;
      if (bal <= 0) break;
    }
    if (bal <= 0) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  // Return ceiling to nearest cent so we don't undershoot
  return Math.ceil(hi * 100) / 100;
}

// ---------------------------------------------------------------------------
// Strategy sort functions
// ---------------------------------------------------------------------------

/**
 * Returns a comparator that sorts debts by a given key function.
 * Ties broken alphabetically by name.
 * @param {function} keyFn    - Returns a numeric sort key from a debt object
 * @param {number}   dir      - 1 for ascending, -1 for descending
 * @returns {function} Comparator function
 */
function makeStrategy(keyFn, dir) {
  return (a, b) => {
    const diff = (keyFn(a) - keyFn(b)) * dir;
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name);
  };
}

const STRATEGIES = {
  avalanche:      makeStrategy(d => d.apr, -1),
  snowball:       makeStrategy(d => d.balance, 1),
  highestPayment: makeStrategy(d => d.minPayment, -1),
  mostInterest:   makeStrategy(d => d.balance * (d.apr / 100 / 12), -1),
};

/**
 * Sort an array of active debt states by the given strategy key.
 * Does NOT mutate the input array.
 * @param {object[]} debts        - Array of debt state objects
 * @param {string}   strategyKey  - One of: 'avalanche'|'snowball'|'highestPayment'|'mostInterest'
 * @returns {object[]} Sorted copy
 */
function sortByStrategy(debts, strategyKey) {
  const cmp = STRATEGIES[strategyKey] || STRATEGIES.avalanche;
  return [...debts].sort(cmp);
}

// ---------------------------------------------------------------------------
// Core simulation
// ---------------------------------------------------------------------------

/**
 * Run a month-by-month debt payoff simulation.
 *
 * @param {object[]} debts            - Array of debt definition objects:
 *   { id, name, balance, minPayment, apr, freedAllocation }
 *   freedAllocation: 'global'|'100'|'50'|'0'
 * @param {number}   extraMonthly     - Extra monthly payment above minimums ($)
 * @param {number}   lumpSum          - One-time lump sum applied at month 0 ($)
 * @param {string}   monthlyStrategy  - Strategy key for extra monthly payment
 * @param {string}   lumpSumStrategy  - Strategy key for lump sum
 * @param {string}   globalAllocation - '100'|'50'|'0' global freed-payment allocation
 *
 * @returns {object} Simulation result:
 *   {
 *     months: number,            // Total months to pay off (or 600 cap)
 *     cappedAt600: boolean,      // True if simulation hit the safety cap
 *     totalInterestPaid: number, // Sum of all interest accrued
 *     monthlyTotals: number[],   // Total remaining balance per month (index 0 = start)
 *     debtHistory: {             // Per-debt balance at each month
 *       [id]: number[]
 *     },
 *     keptPerMonth: number,      // Monthly amount kept (not in pool) at final state
 *   }
 */
function runSimulation(debts, extraMonthly, lumpSum, monthlyStrategy, lumpSumStrategy, globalAllocation) {
  if (!debts || debts.length === 0) {
    return {
      months: 0, cappedAt600: false, totalInterestPaid: 0,
      monthlyTotals: [0], debtHistory: {}, keptPerMonth: 0,
    };
  }

  const MAX_MONTHS = 600;

  // Deep-clone working state; track which debts are paid off
  const state = debts.map(d => ({
    id: d.id,
    name: d.name,
    balance: Math.max(0, d.balance),
    minPayment: d.minPayment,
    apr: d.apr,
    freedAllocation: d.freedAllocation || 'global',
    paidOff: false,
    paidOffMonth: null,
  }));

  // Helper: resolve effective allocation percent for a debt
  const resolveAlloc = (debt) => {
    const key = debt.freedAllocation === 'global' ? globalAllocation : debt.freedAllocation;
    if (key === '50') return 0.5;
    if (key === '0') return 0;
    return 1; // '100' or fallback
  };

  let totalInterestPaid = 0;

  // Per-debt balance history: debtHistory[id][month]
  const debtHistory = {};
  state.forEach(d => { debtHistory[d.id] = [d.balance]; });

  // Month 0 totals (initial balances)
  const monthlyTotals = [state.reduce((s, d) => s + d.balance, 0)];
  const monthlyInterest = [0]; // interest accrued each month (month 0 = 0)

  // ---- Month 0: Apply lump sum ----
  if (lumpSum > 0) {
    const sorted = sortByStrategy(
      state.filter(d => !d.paidOff && d.balance > 0),
      lumpSumStrategy
    );
    let remaining = lumpSum;
    for (const debt of sorted) {
      if (remaining <= 0) break;
      const apply = Math.min(remaining, debt.balance);
      debt.balance -= apply;
      remaining -= apply;
      if (debt.balance <= 0) {
        debt.balance = 0;
        debt.paidOff = true;
        debt.paidOffMonth = 0;
      }
    }
  }

  // Snowball pool starts from freed minimums only (extra is added each month)
  // Track which debts were paid off at month 0 for pool calculation
  let snowballPool = 0; // accumulated freed payments from paid-off debts
  state.forEach(d => {
    if (d.paidOff) {
      const contrib = d.minPayment * resolveAlloc(d);
      snowballPool += contrib;
    }
  });

  // ---- Monthly simulation loop ----
  let month = 0;
  let cappedAt600 = false;

  while (true) {
    // Check if all debts are paid off
    if (state.every(d => d.paidOff || d.balance <= 0)) break;
    if (month >= MAX_MONTHS) {
      cappedAt600 = true;
      break;
    }

    month++;

    // Step 1: Accrue interest and apply minimum payments to ALL debts simultaneously
    let monthInterest = 0;
    for (const debt of state) {
      if (debt.paidOff || debt.balance <= 0) continue;

      const monthlyRate = debt.apr / 100 / 12;
      const interest = debt.balance * monthlyRate;
      debt.balance += interest;
      totalInterestPaid += interest;
      monthInterest += interest;

      // Apply minimum payment
      const applied = Math.min(debt.balance, debt.minPayment);
      debt.balance -= applied;

      if (debt.balance <= 0) {
        debt.balance = 0;
        debt.paidOff = true;
        debt.paidOffMonth = month;
        // Freed minimum joins pool (after this month)
        const contrib = debt.minPayment * resolveAlloc(debt);
        snowballPool += contrib;
      }
    }

    // Step 2: Build this month's extra pool = extra monthly + accumulated freed minimums
    let pool = extraMonthly + snowballPool;

    // Step 3: Apply pool to highest-priority unpaid debts, cascading
    const unpaid = sortByStrategy(
      state.filter(d => !d.paidOff && d.balance > 0),
      monthlyStrategy
    );

    for (const debt of unpaid) {
      if (pool <= 0) break;
      const apply = Math.min(pool, debt.balance);
      debt.balance -= apply;
      pool -= apply;

      if (debt.balance <= 0) {
        debt.balance = 0;
        debt.paidOff = true;
        debt.paidOffMonth = month;
        const contrib = debt.minPayment * resolveAlloc(debt);
        snowballPool += contrib;
      }
    }

    // Record balances at end of this month
    state.forEach(d => {
      debtHistory[d.id].push(d.balance);
    });
    monthlyTotals.push(state.reduce((s, d) => s + d.balance, 0));
    monthlyInterest.push(monthInterest);
  }

  // Calculate total "kept per month" at final state
  // = sum of freed minimums × (1 - alloc) for all paid-off debts
  let keptPerMonth = 0;
  state.filter(d => d.paidOff).forEach(d => {
    const allocPct = resolveAlloc(d);
    keptPerMonth += d.minPayment * (1 - allocPct);
  });

  return {
    months: month,
    cappedAt600,
    totalInterestPaid,
    monthlyTotals,
    monthlyInterest,
    debtHistory,
    keptPerMonth,
  };
}

/**
 * Calculate the nominal payoff date for a single debt using minimum payments only.
 * @param {object} debt - { balance, minPayment, apr }
 * @returns {object} { months: number, cappedAt600: boolean }
 */
function calcNominalPayoffMonths(debt) {
  if (!debt || debt.balance <= 0) return { months: 0, cappedAt600: false };

  const MAX_MONTHS = 600;
  const monthlyRate = debt.apr / 100 / 12;
  let balance = debt.balance;
  let months = 0;

  while (balance > 0 && months < MAX_MONTHS) {
    balance += balance * monthlyRate;
    balance -= Math.min(balance, debt.minPayment);
    months++;
    if (balance < 0.005) { balance = 0; break; }
  }

  return { months, cappedAt600: months >= MAX_MONTHS && balance > 0 };
}

/**
 * Calculate total interest paid in a baseline (minimums-only) simulation for all debts.
 * Used for delta calculations.
 * @param {object[]} debts
 * @returns {object} { months, totalInterest, cappedAt600, monthlyTotals }
 */
function runBaselineSimulation(debts) {
  return runSimulation(debts, 0, 0, 'avalanche', 'avalanche', '100');
}

/**
 * Compute the 25th/50th/75th percentile annualized CAGR over a given horizon,
 * given an arithmetic mean and annual standard deviation of returns.
 *
 * The geometric mean (center of the CAGR distribution) is:
 *   μ_geo = μ_arith − σ²/2   (Jensen's inequality on log-normal returns)
 *
 * The standard deviation of the CAGR narrows with the horizon as:
 *   σ_cagr = σ / √N   (CLT — annualized variance is σ²/N)
 *
 * Percentiles use z = ±0.6745 (25th/75th of a standard normal), which becomes
 * increasingly accurate as N grows due to the CLT.
 *
 * @param {number} meanPct      - Arithmetic mean annual return, in percent (e.g. 10.5)
 * @param {number} sigmaPct     - Annual std dev of returns, in percent (e.g. 16)
 * @param {number} horizonYears - Investment horizon in years (≥ 1)
 * @returns {{ p25: number, p50: number, p75: number }} Percentile CAGRs in percent
 */
function computePercentileRates(meanPct, sigmaPct, horizonYears) {
  const mu    = meanPct  / 100;
  const sigma = sigmaPct / 100;
  const n     = Math.max(1, horizonYears);

  const muGeo     = (mu - (sigma * sigma) / 2) * 100; // geometric mean, %
  const sigmaCAGR = (sigma / Math.sqrt(n))      * 100; // CAGR std dev at horizon, %
  const z = 0.6745; // z-score for 25th/75th percentile of standard normal

  return {
    p25: muGeo - z * sigmaCAGR,
    p50: muGeo,
    p75: muGeo + z * sigmaCAGR,
  };
}

/**
 * Scenario A: Pay debt aggressively (per current plan), then invest everything after payoff.
 * While any debt remains, all extra cash attacks debt. After the last debt clears,
 * extraMonthly + sum(all original minPayments) is invested each month.
 *
 * @param {object[]} debts
 * @param {number}   extraMonthly      - Extra monthly slider value
 * @param {number}   lumpSum           - Lump sum slider value
 * @param {string}   monthlyStrategy   - Strategy for monthly extra payments
 * @param {string}   lumpSumStrategy   - Strategy for lump sum
 * @param {number}   annualReturnRate  - Pre-tax annual return percent (e.g. 10.5)
 * @param {number}   taxRate           - Decimal tax rate on gains (e.g. 0.15); 0 for tax-advantaged
 * @param {number}   horizonMonths     - Total months to project
 * @returns {{ netWorthByMonth: number[], portfolioByMonth: number[], debtByMonth: number[] }}
 */
function runPayDebtThenInvest(debts, extraMonthly, lumpSum, monthlyStrategy, lumpSumStrategy, annualReturnRate, taxRate, horizonMonths) {
  const sim = runSimulation(debts, extraMonthly, lumpSum, monthlyStrategy, lumpSumStrategy, '100');
  const effectiveRate = annualReturnRate * (1 - taxRate) / 100 / 12;
  const totalMinPayments = debts.reduce((s, d) => s + d.minPayment, 0);
  const monthlyContrib = extraMonthly + totalMinPayments;
  const payoffMonth = sim.months;

  const netWorthByMonth = [], portfolioByMonth = [], debtByMonth = [];
  let portfolio = 0;

  for (let t = 0; t <= horizonMonths; t++) {
    // sim.monthlyTotals[t]: index 0 = original balance (pre-lump-sum);
    // index 1+ = post-lump-sum + month-t payments
    const debt = t <= payoffMonth ? (sim.monthlyTotals[t] ?? 0) : 0;

    if (t > payoffMonth) {
      portfolio = portfolio * (1 + effectiveRate) + monthlyContrib;
    }

    debtByMonth.push(debt);
    portfolioByMonth.push(portfolio);
    netWorthByMonth.push(portfolio - debt);
  }
  return { netWorthByMonth, portfolioByMonth, debtByMonth };
}

/**
 * Scenario B: Pay minimums only on debt; invest extraMonthly + lump sum from day one.
 * Uses a true minimum-only simulation (allocation '0') so freed minimums do NOT cascade
 * to other debts — they go to the investment portfolio instead.
 *
 * @param {object[]} debts
 * @param {number}   extraMonthly      - Extra monthly slider value (invested each month)
 * @param {number}   lumpSum           - Lump sum slider value (invested at month 0)
 * @param {number}   annualReturnRate  - Pre-tax annual return percent
 * @param {number}   taxRate           - Decimal tax rate on gains; 0 for tax-advantaged
 * @param {number}   horizonMonths     - Total months to project
 * @returns {{ netWorthByMonth: number[], portfolioByMonth: number[], debtByMonth: number[] }}
 */
function runInvestInstead(debts, extraMonthly, lumpSum, annualReturnRate, taxRate, horizonMonths) {
  // allocation '0' prevents freed minimums from cascading to other debts
  const minSim = runSimulation(debts, 0, 0, 'avalanche', 'avalanche', '0');
  const effectiveRate = annualReturnRate * (1 - taxRate) / 100 / 12;

  // Determine when each debt pays off in the true min-only simulation
  const paidOffAt = {};
  for (const [id, history] of Object.entries(minSim.debtHistory)) {
    const idx = history.findIndex((bal, i) => i > 0 && bal <= 0);
    paidOffAt[id] = idx === -1 ? Infinity : idx;
  }
  const minPayById = {};
  debts.forEach(d => { minPayById[d.id] = d.minPayment; });

  const netWorthByMonth = [], portfolioByMonth = [], debtByMonth = [];

  // Month 0: invest lump sum immediately
  let portfolio = lumpSum;
  const debt0 = minSim.monthlyTotals[0] ?? 0;
  debtByMonth.push(debt0);
  portfolioByMonth.push(portfolio);
  netWorthByMonth.push(portfolio - debt0);

  for (let t = 1; t <= horizonMonths; t++) {
    // Contribution = extraMonthly + freed minimums from debts paid off before month t
    let contribution = extraMonthly;
    for (const [id, paidOff] of Object.entries(paidOffAt)) {
      if (paidOff < t) contribution += minPayById[id] ?? 0;
    }

    portfolio = portfolio * (1 + effectiveRate) + contribution;
    const debt = t <= minSim.months ? (minSim.monthlyTotals[t] ?? 0) : 0;

    debtByMonth.push(debt);
    portfolioByMonth.push(portfolio);
    netWorthByMonth.push(portfolio - debt);
  }
  return { netWorthByMonth, portfolioByMonth, debtByMonth };
}

/**
 * Format a month offset as a human-readable "MMM YYYY" date string.
 * @param {number} monthsFromNow - Number of months in the future
 * @param {Date}   [baseDate]    - Base date (defaults to today)
 * @returns {string} e.g. "Jun 2031", or "Never" if capped
 */
function formatPayoffDate(monthsFromNow, baseDate) {
  if (monthsFromNow === null || monthsFromNow === undefined) return '—';
  const base = baseDate || new Date();
  const d = new Date(base.getFullYear(), base.getMonth() + monthsFromNow, 1);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/**
 * Format a duration in months as a human-readable string.
 * @param {number} months
 * @returns {string} e.g. "3 yrs 4 mo", "8 mo"
 */
function formatDuration(months) {
  if (months <= 0) return '0 mo';
  const yrs = Math.floor(months / 12);
  const mo = months % 12;
  if (yrs === 0) return `${mo} mo`;
  if (mo === 0) return `${yrs} yr${yrs !== 1 ? 's' : ''}`;
  return `${yrs} yr${yrs !== 1 ? 's' : ''} ${mo} mo`;
}

/**
 * Format a dollar value with commas and 2 decimal places.
 * @param {number} value
 * @returns {string} e.g. "$12,345.67"
 */
function formatDollars(value) {
  if (!isFinite(value) || isNaN(value)) return '$0.00';
  return '$' + Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Check if a debt's minimum payment covers its monthly interest.
 * @param {object} debt - { balance, minPayment, apr }
 * @returns {boolean} true if payment does NOT cover interest (warning condition)
 */
function isPaymentInsufficient(debt) {
  if (!debt || debt.balance <= 0) return false;
  const monthlyInterest = debt.balance * (debt.apr / 100 / 12);
  return debt.minPayment <= monthlyInterest;
}

// ---------------------------------------------------------------------------
// Exports (for use in ui.js via global scope — no module bundler)
// ---------------------------------------------------------------------------
const Calculator = {
  calcMonthlyPayment,
  calcRemainingBalance,
  calcPaymentForPayoffDate,
  sortByStrategy,
  runSimulation,
  runBaselineSimulation,
  computePercentileRates,
  runPayDebtThenInvest,
  runInvestInstead,
  calcNominalPayoffMonths,
  formatPayoffDate,
  formatDuration,
  formatDollars,
  isPaymentInsufficient,
  STRATEGY_KEYS: ['avalanche', 'snowball', 'highestPayment', 'mostInterest'],
  STRATEGY_LABELS: {
    avalanche:      'Avalanche (highest APR first)',
    snowball:       'Snowball (lowest balance first)',
    highestPayment: 'Highest Monthly Payment first',
    mostInterest:   'Most Interest/Month first',
  },
};
