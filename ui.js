/**
 * ui.js — DebtShovel
 * All DOM manipulation, event wiring, modal lifecycle, and chart rendering.
 * Calls into Calculator (calculator.js) for all numbers.
 */

'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Array<DebtEntry>} */
let debts = [];

/** Monotonically increasing ID counter */
let nextId = 1;

/** Chart instances */
let chartA = null;
let chartB = null;
let chartC = null;

/** Chart A display mode: 'balances' | 'gap' */
let chartAMode = 'balances';

const STRATEGY_HINTS = {
  avalanche:      'Mathematically optimal — minimizes total interest paid.',
  snowball:       'Best for motivation — quick wins build momentum.',
  highestPayment: 'Frees up the largest monthly cash flow soonest.',
  mostInterest:   'Targets the debt costing you the most per month right now.',
};

function updateStrategyHint(selectId, hintId) {
  const val = $(selectId)?.value;
  setVal(hintId, val ? (STRATEGY_HINTS[val] || '') : '');
}

/** Currently editing debt ID (null = adding new) */
let editingId = null;

/** Current wizard mode: 'manual' | 'amortizing' | 'payoffDate' */
let currentMode = null;

/** Today's date (reused throughout) */
const TODAY = new Date();

// ---------------------------------------------------------------------------
// Color palette for chart lines (accessible, distinct)
// ---------------------------------------------------------------------------
// Light-theme-safe chart colors (readable on white and on dark backgrounds)
const DEBT_COLORS_LIGHT = [
  '#2563eb', // blue
  '#db2777', // pink
  '#059669', // emerald
  '#ea580c', // orange
  '#0284c7', // sky
  '#7c3aed', // violet
  '#d97706', // amber
  '#dc2626', // red
  '#0d9488', // teal
  '#a21caf', // fuchsia
];
const DEBT_COLORS_DARK = [
  '#818cf8', // indigo
  '#f472b6', // pink
  '#34d399', // emerald
  '#fb923c', // orange
  '#38bdf8', // sky
  '#a78bfa', // violet
  '#fbbf24', // amber
  '#f87171', // red
  '#2dd4bf', // teal
  '#e879f9', // fuchsia
];

function isDarkTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

function debtColor(index) {
  const palette = isDarkTheme() ? DEBT_COLORS_DARK : DEBT_COLORS_LIGHT;
  return palette[index % palette.length];
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function $(id) { return document.getElementById(id); }

function setVal(id, val) {
  const el = $(id);
  if (el) el.textContent = val;
}

function showEl(id, visible) {
  const el = $(id);
  if (!el) return;
  if (visible) {
    el.style.display = '';
  } else {
    el.style.display = 'none';
  }
}

function clearErrors(...ids) {
  ids.forEach(id => {
    const el = $(id);
    if (el) el.textContent = '';
    // Also remove error class from matching input
    const inputId = id.replace('-err', '');
    const input = $(inputId);
    if (input) input.classList.remove('error');
  });
}

function setError(errId, msg) {
  const el = $(errId);
  if (el) el.textContent = msg;
  const inputId = errId.replace('-err', '');
  const input = $(inputId);
  if (input) input.classList.add('error');
}

function getNum(id) {
  const el = $(id);
  if (!el) return NaN;
  const v = parseFloat(el.value);
  return isNaN(v) ? NaN : v;
}

function getStr(id) {
  const el = $(id);
  return el ? el.value.trim() : '';
}

/** Format months count as "N mo" or "N yr M mo" */
function fmtDuration(months) {
  return Calculator.formatDuration(months);
}

/** Format payoff date from month offset */
function fmtDate(months) {
  if (months === null || months === undefined) return '—';
  return Calculator.formatPayoffDate(months, TODAY);
}

/** Format dollar amount */
function fmtDollars(val) {
  return Calculator.formatDollars(val);
}

// ---------------------------------------------------------------------------
// Debt table rendering
// ---------------------------------------------------------------------------

function renderTable() {
  const tbody = $('debt-tbody');
  const tfoot = $('debt-tfoot');
  const emptyState = $('empty-state');
  const capWarning = $('cap-warning');

  if (!tbody) return;

  // Empty state
  if (debts.length === 0) {
    tbody.innerHTML = '';
    tfoot.innerHTML = '';
    emptyState.style.display = 'flex';
    capWarning.classList.remove('visible');
    return;
  }

  emptyState.style.display = 'none';

  let anyCapWarning = false;
  let maxPayoffMonths = 0;

  // Build rows
  const rows = debts.map(debt => {
    const { months, cappedAt600 } = Calculator.calcNominalPayoffMonths(debt);
    if (cappedAt600) anyCapWarning = true;
    if (months > maxPayoffMonths) maxPayoffMonths = months;

    const payoffLabel = cappedAt600 ? 'Never (50yr cap)' : fmtDate(months);
    const payoffClass = cappedAt600 ? 'payoff-date-cell never' : 'payoff-date-cell';
    const insufficient = Calculator.isPaymentInsufficient(debt);

    const allocVal = debt.freedAllocation === 'global' ? '100' : (debt.freedAllocation || '100');

    return `
      <tr data-id="${debt.id}">
        <td>
          <div class="debt-name">${escapeHtml(debt.name)}</div>
          ${insufficient ? `<div class="warn-badge" role="alert"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Payment doesn't cover interest</div>` : ''}
        </td>
        <td class="tabular">${fmtDollars(debt.balance)}</td>
        <td class="tabular">${fmtDollars(debt.minPayment)}</td>
        <td class="tabular">${debt.apr.toFixed(2)}%</td>
        <td>
          <select class="alloc-select" data-id="${debt.id}"
                  title="When this debt is paid off, put that monthly payment toward the next debt"
                  aria-label="Freed payment allocation for ${escapeHtml(debt.name)}">
            <option value="100" ${allocVal === '100' ? 'selected' : ''}>All of it</option>
            <option value="50"  ${allocVal === '50'  ? 'selected' : ''}>Half &amp; half</option>
            <option value="0"   ${allocVal === '0'   ? 'selected' : ''}>None — keep it</option>
          </select>
        </td>
        <td class="${payoffClass}">${payoffLabel}</td>
        <td>
          <div class="debt-actions">
            <button class="btn-icon" data-action="edit" data-id="${debt.id}" aria-label="Edit ${escapeHtml(debt.name)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button class="btn-icon danger" data-action="delete" data-id="${debt.id}" aria-label="Delete ${escapeHtml(debt.name)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
            <button class="btn-text danger" data-action="delete-confirm" data-id="${debt.id}" aria-label="Confirm delete ${escapeHtml(debt.name)}">Delete</button>
            <button class="btn-text" data-action="delete-cancel" aria-label="Cancel delete">Cancel</button>
          </div>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = rows.join('');

  // Totals row
  const totalBalance = debts.reduce((s, d) => s + d.balance, 0);
  const totalMinPayment = debts.reduce((s, d) => s + d.minPayment, 0);
  // Overall payoff via baseline simulation (minimums only)
  const baseline = Calculator.runBaselineSimulation(debts);
  const overallPayoffLabel = baseline.cappedAt600
    ? 'Never (50yr cap)'
    : fmtDate(baseline.months);
  if (baseline.cappedAt600) anyCapWarning = true;

  tfoot.innerHTML = `
    <tr class="totals-row">
      <td>Totals</td>
      <td class="tabular">${fmtDollars(totalBalance)}</td>
      <td class="tabular">${fmtDollars(totalMinPayment)}</td>
      <td>—</td>
      <td>—</td>
      <td class="payoff-date-cell ${baseline.cappedAt600 ? 'never' : ''}">${overallPayoffLabel}</td>
      <td></td>
    </tr>
  `;

  // Cap warning
  if (anyCapWarning) {
    capWarning.classList.add('visible');
  } else {
    capWarning.classList.remove('visible');
  }

  // Wire up per-debt allocation selects
  document.querySelectorAll('.alloc-select').forEach(sel => {
    sel.addEventListener('change', e => {
      const id = parseInt(e.target.dataset.id);
      const debt = debts.find(d => d.id === id);
      if (debt) {
        debt.freedAllocation = e.target.value;
        refreshAll();
      }
    });
  });

  // Wire up edit/delete buttons
  document.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', e => {
      const id = parseInt(e.currentTarget.dataset.id);
      openEditModal(id);
    });
  });

  document.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.currentTarget.closest('tr').classList.add('confirming-delete');
    });
  });

  document.querySelectorAll('[data-action="delete-confirm"]').forEach(btn => {
    btn.addEventListener('click', e => {
      const id = parseInt(e.currentTarget.dataset.id);
      debts = debts.filter(d => d.id !== id);
      refreshAll();
    });
  });

  document.querySelectorAll('[data-action="delete-cancel"]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.currentTarget.closest('tr').classList.remove('confirming-delete');
    });
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Slider updates
// ---------------------------------------------------------------------------

function updateSliderRanges() {
  const totalBalance = debts.reduce((s, d) => s + d.balance, 0);
  const totalMinPayment = debts.reduce((s, d) => s + d.minPayment, 0);

  const lumpSlider  = $('slider-lump');
  const extraSlider = $('slider-extra');
  const lumpInput   = $('lump-input');
  const extraInput  = $('extra-input');

  if (lumpSlider) {
    const maxLump = Math.max(0, Math.ceil(totalBalance / 50) * 50);
    lumpSlider.max = maxLump || 1000;
    if (parseFloat(lumpSlider.value) > maxLump) lumpSlider.value = maxLump;
    lumpSlider.setAttribute('aria-valuemax', lumpSlider.max);
    if (lumpInput) lumpInput.max = lumpSlider.max;
    const note = $('lump-range-note');
    if (note && totalBalance > 0) note.textContent = `Max: ${fmtDollars(totalBalance)} (total balance)`;
  }

  if (extraSlider) {
    const maxExtra = Math.max(0, Math.ceil(totalMinPayment * 3 / 25) * 25);
    extraSlider.max = maxExtra || 1000;
    if (parseFloat(extraSlider.value) > maxExtra) extraSlider.value = maxExtra;
    extraSlider.setAttribute('aria-valuemax', extraSlider.max);
    if (extraInput) extraInput.max = extraSlider.max;
    const note = $('extra-range-note');
    if (note && totalMinPayment > 0) note.textContent = `Max: ${fmtDollars(maxExtra || 1000)} (3× your ${fmtDollars(totalMinPayment)} total minimums)`;
  }
}

function updateSliderDisplays() {
  const lumpVal  = parseFloat($('slider-lump')?.value  || 0);
  const extraVal = parseFloat($('slider-extra')?.value || 0);

  const lumpInput  = $('lump-input');
  const extraInput = $('extra-input');
  if (lumpInput  && document.activeElement !== lumpInput)  lumpInput.value  = lumpVal;
  if (extraInput && document.activeElement !== extraInput) extraInput.value = extraVal;

  $('slider-lump')?.setAttribute('aria-valuenow', lumpVal);
  $('slider-extra')?.setAttribute('aria-valuenow', extraVal);
}

// ---------------------------------------------------------------------------
// Simulation and callout updates
// ---------------------------------------------------------------------------

function runAllSimulations() {
  if (debts.length === 0 || debts.every(d => d.balance <= 0)) {
    return { baseline: null, withExtra: null };
  }

  const lumpSum      = parseFloat($('slider-lump')?.value  || 0);
  const extraMonthly = parseFloat($('slider-extra')?.value || 0);
  const lumpStrategy  = $('lump-strategy')?.value  || 'avalanche';
  const extraStrategy = $('extra-strategy')?.value || 'avalanche';

  const baseline = Calculator.runBaselineSimulation(debts);
  const withExtra = Calculator.runSimulation(
    debts, extraMonthly, lumpSum,
    extraStrategy, lumpStrategy,
    '100'
  );

  return { baseline, withExtra };
}

function updateCallouts(baseline, withExtra) {
  if (!baseline || !withExtra) {
    setVal('baseline-interest', '$0.00');
    setVal('accelerated-interest', '$0.00');
    setVal('combined-interest-saved', '$0.00');
    setVal('combined-months-saved', '—');
    setVal('baseline-payoff-date', '—');
    return;
  }

  const interestSaved = Math.max(0, baseline.totalInterestPaid - withExtra.totalInterestPaid);

  setVal('baseline-interest',       fmtDollars(baseline.totalInterestPaid));
  setVal('accelerated-interest',    fmtDollars(withExtra.totalInterestPaid));
  setVal('combined-interest-saved', fmtDollars(interestSaved));
  setVal('combined-months-saved',   withExtra.months > 0 ? fmtDate(withExtra.months) : '—');
  setVal('baseline-payoff-date',    baseline.months > 0 ? fmtDate(baseline.months) : '—');
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

function chartColors() {
  const dark = isDarkTheme();
  return {
    text:   dark ? '#e8eaf0' : '#212121',
    muted:  dark ? '#7c82a0' : '#616161',
    grid:   dark ? '#333755' : '#e0e0e0',
    accent: dark ? '#4ade80' : '#16a34a',
    accentFill: dark ? 'rgba(74,222,128,0.15)' : 'rgba(22,163,74,0.12)',
    accentFillLight: dark ? 'rgba(74,222,128,0.08)' : 'rgba(22,163,74,0.08)',
    baseline: dark ? '#7c82a0' : '#94a3b8',
    baselineFill: dark ? 'rgba(124,130,160,0.08)' : 'rgba(100,116,139,0.08)',
  };
}

function buildChartDefaults() {
  const cc = chartColors();
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 200 },
    plugins: {
      legend: {
        labels: {
          color: cc.text,
          font: { size: 11 },
          boxWidth: 12,
          padding: 12,
        }
      },
      tooltip: {
        mode: 'index',
        intersect: false,
        callbacks: {
          title: items => {
            const idx = items[0]?.dataIndex;
            if (idx == null) return '';
            if (idx === 0) return 'Now';
            const d = new Date(TODAY.getFullYear(), TODAY.getMonth() + idx, 1);
            return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
          },
          label: ctx => `${ctx.dataset.label}: $${ctx.raw.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
        }
      }
    },
    scales: {
      x: {
        ticks: {
          color: cc.muted,
          maxTicksLimit: 8,
          font: { size: 10 },
          callback: (val) => {
            if (val === 0) return 'Now';
            const d = new Date(TODAY.getFullYear(), TODAY.getMonth() + val, 1);
            return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
          },
        },
        grid:  { color: cc.grid },
      },
      y: {
        ticks: {
          color: cc.muted,
          maxTicksLimit: 6,
          font: { size: 10 },
          callback: val => {
            if (val >= 1_000_000) return '$' + (val / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
            if (val >= 10_000)    return '$' + Math.round(val / 1_000) + 'k';
            if (val >= 1_000)     return '$' + (val / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
            return '$' + val.toFixed(0);
          },
        },
        grid:  { color: cc.grid },
        beginAtZero: true,
      }
    },
  };
}

function updateCharts(baseline, withExtra) {
  const canvasA = $('chart-a');
  const canvasB = $('chart-b');
  const emptyA  = $('chart-a-empty');
  const emptyB  = $('chart-b-empty');

  if (!baseline || !withExtra || debts.length === 0) {
    if (emptyA) emptyA.style.display = 'flex';
    if (emptyB) emptyB.style.display = 'flex';
    if (canvasA) canvasA.style.display = 'none';
    if (canvasB) canvasB.style.display = 'none';
    if (chartA) { chartA.destroy(); chartA = null; }
    if (chartB) { chartB.destroy(); chartB = null; }
    return;
  }

  if (emptyA) emptyA.style.display = 'none';
  if (emptyB) emptyB.style.display = 'none';
  if (canvasA) canvasA.style.display = '';
  if (canvasB) canvasB.style.display = '';

  // X-axis clips to accelerated payoff; baseline note shows if it extends further
  const maxMonths = Math.max(withExtra.months, 1);
  const labels = Array.from({ length: maxMonths + 1 }, (_, i) => i);

  // Show a note if the baseline runs longer than the accelerated scenario
  const baselineNote = $('chart-a-baseline-note');
  if (baselineNote) {
    if (baseline.months > withExtra.months) {
      baselineNote.textContent = `Without extra payments, payoff extends to ${fmtDate(baseline.months)} — ${fmtDuration(baseline.months - withExtra.months)} after this chart ends.`;
      baselineNote.style.display = '';
    } else {
      baselineNote.textContent = '';
      baselineNote.style.display = 'none';
    }
  }

  // ---- Chart A: Total debt over time ----
  const padToLength = (arr, len) => {
    const result = [...arr];
    while (result.length <= len) result.push(0);
    return result.slice(0, len + 1);
  };

  const baselineTotals    = padToLength(baseline.monthlyTotals, maxMonths);
  const withExtraTotals   = padToLength(withExtra.monthlyTotals, maxMonths);
  const baselineInterest  = padToLength(baseline.monthlyInterest  || [], maxMonths);
  const withExtraInterest = padToLength(withExtra.monthlyInterest || [], maxMonths);

  const cc = chartColors();
  let dataA;
  if (chartAMode === 'gap') {
    // Savings gap: how much less you owe vs. minimum-only at each month
    const gapData = baselineTotals.map((b, i) => Math.max(0, b - (withExtraTotals[i] || 0)));
    dataA = {
      labels,
      datasets: [{
        label: 'Balance saved vs. minimums',
        data: gapData,
        borderColor: cc.accent,
        backgroundColor: cc.accentFill,
        borderWidth: 2.5,
        pointRadius: 0,
        fill: true,
        tension: 0.1,
      }]
    };
  } else {
    dataA = {
      labels,
      datasets: [
        {
          label: 'Minimum payments only',
          data: baselineTotals,
          borderColor: cc.baseline,
          backgroundColor: cc.baselineFill,
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          tension: 0.1,
        },
        {
          label: 'With your accelerators',
          data: withExtraTotals,
          borderColor: cc.accent,
          backgroundColor: cc.accentFillLight,
          borderWidth: 2.5,
          pointRadius: 0,
          fill: true,
          tension: 0.1,
        }
      ]
    };
  }

  const defaults = buildChartDefaults();
  const optionsA = {
    ...defaults,
    plugins: {
      ...defaults.plugins,
      tooltip: {
        mode: 'index',
        intersect: false,
        callbacks: {
          title: items => {
            const idx = items[0]?.dataIndex;
            if (idx == null) return '';
            if (idx === 0) return 'Now';
            const d = new Date(TODAY.getFullYear(), TODAY.getMonth() + idx, 1);
            return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
          },
          label: ctx => `${ctx.dataset.label}: $${ctx.raw.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          afterBody: items => {
            const idx = items[0]?.dataIndex;
            if (idx == null || idx === 0) return [];
            const bi = baselineInterest[idx]  || 0;
            const wi = withExtraInterest[idx] || 0;
            const fmt = v => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 });
            return [
              '',
              `Interest this month (min): ${fmt(bi)}`,
              `Interest this month (accel): ${fmt(wi)}`,
            ];
          }
        }
      }
    }
  };

  if (chartA) {
    chartA.data = dataA;
    chartA.options = optionsA;
    chartA.update('none');
  } else {
    chartA = new Chart(canvasA, {
      type: 'line',
      data: dataA,
      options: optionsA,
    });
  }

  // Accessibility summary for chart A
  const summaryA = `Baseline payoff: ${fmtDuration(baseline.months)}. With accelerators: ${fmtDuration(withExtra.months)}.`;
  const elSummA = $('chart-a-summary');
  if (elSummA) elSummA.textContent = summaryA;

  // ---- Chart B: Per-debt balances ----
  const datasetsB = debts.map((debt, idx) => {
    const history = withExtra.debtHistory[debt.id] || [debt.balance];
    const padded  = padToLength(history, maxMonths);
    return {
      label: debt.name,
      data: padded,
      borderColor: debtColor(idx),
      backgroundColor: debtColor(idx) + '18',
      borderWidth: 2,
      pointRadius: 0,
      fill: false,
      tension: 0.1,
    };
  });

  const dataB = { labels, datasets: datasetsB };

  if (chartB) {
    chartB.data = dataB;
    chartB.update('none');
  } else {
    chartB = new Chart(canvasB, {
      type: 'line',
      data: dataB,
      options: buildChartDefaults(),
    });
  }

  // Accessibility summary for chart B
  const summaryB = debts.map((d, i) => {
    const payoff = Calculator.calcNominalPayoffMonths(d);
    return `${d.name}: pays off in approximately ${fmtDuration(payoff.months)}.`;
  }).join(' ');
  const elSummB = $('chart-b-summary');
  if (elSummB) elSummB.textContent = summaryB;
}

// ---------------------------------------------------------------------------
// Main refresh (called on any state change)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Debt vs. Investing comparison (Chart C)
// ---------------------------------------------------------------------------

function getCompareHorizonMonths() {
  const active = document.querySelector('#horizon-picker .seg-btn.active');
  return active ? parseInt(active.dataset.years, 10) * 12 : 360;
}

function getCompareTaxRate() {
  if ($('compare-tax-advantaged')?.checked) return 0;
  return (parseFloat($('compare-tax-rate')?.value) || 15) / 100;
}

function updateCompareChart() {
  const details = $('compare-details');
  if (!details?.open) return; // lazy: skip if section is collapsed

  const hasDebts = debts.length > 0 && debts.some(d => d.balance > 0);
  const emptyC  = $('chart-c-empty');
  const canvasC = $('chart-c');
  if (emptyC)  emptyC.style.display  = hasDebts ? 'none' : '';
  if (canvasC) canvasC.style.display = hasDebts ? '' : 'none';

  if (!hasDebts) {
    if (chartC) { chartC.destroy(); chartC = null; }
    ['compare-paydebt-val','compare-low-val','compare-mid-val','compare-high-val']
      .forEach(id => setVal(id, '—'));
    return;
  }

  const horizonMonths = getCompareHorizonMonths();
  const lumpSum       = parseFloat($('slider-lump')?.value  || 0);
  const extraMonthly  = parseFloat($('slider-extra')?.value || 0);
  const lumpStrategy  = $('lump-strategy')?.value  || 'avalanche';
  const extraStrategy = $('extra-strategy')?.value || 'avalanche';

  const pretaxLow  = parseFloat($('rate-low')?.value)  || 7;
  const pretaxMid  = parseFloat($('rate-mid')?.value)  || 10.5;
  const pretaxHigh = parseFloat($('rate-high')?.value) || 14;
  const taxRate    = getCompareTaxRate();

  const effLow  = +(pretaxLow  * (1 - taxRate)).toFixed(2);
  const effMid  = +(pretaxMid  * (1 - taxRate)).toFixed(2);
  const effHigh = +(pretaxHigh * (1 - taxRate)).toFixed(2);

  // Update labels in callout
  setVal('compare-low-pct-label',  effLow.toFixed(1));
  setVal('compare-mid-pct-label',  effMid.toFixed(1));
  setVal('compare-high-pct-label', effHigh.toFixed(1));

  const taxLabel = taxRate === 0
    ? 'tax-advantaged'
    : `${(taxRate * 100).toFixed(0)}% cap gains`;
  setVal('compare-effective-rates',
    `After-tax returns (${taxLabel}): ${effLow.toFixed(1)}% / ${effMid.toFixed(1)}% / ${effHigh.toFixed(1)}%`
  );

  // Run scenarios
  const payDebt   = Calculator.runPayDebtThenInvest(
    debts, extraMonthly, lumpSum, extraStrategy, lumpStrategy, pretaxMid, taxRate, horizonMonths
  );
  const investLow  = Calculator.runInvestInstead(debts, extraMonthly, lumpSum, pretaxLow,  taxRate, horizonMonths);
  const investMid  = Calculator.runInvestInstead(debts, extraMonthly, lumpSum, pretaxMid,  taxRate, horizonMonths);
  const investHigh = Calculator.runInvestInstead(debts, extraMonthly, lumpSum, pretaxHigh, taxRate, horizonMonths);

  // Summary callout
  setVal('compare-paydebt-val', fmtDollars(payDebt.netWorthByMonth[horizonMonths]));
  setVal('compare-low-val',     fmtDollars(investLow.netWorthByMonth[horizonMonths]));
  setVal('compare-mid-val',     fmtDollars(investMid.netWorthByMonth[horizonMonths]));
  setVal('compare-high-val',    fmtDollars(investHigh.netWorthByMonth[horizonMonths]));

  // Build chart
  const cc     = chartColors();
  const labels = Array.from({ length: horizonMonths + 1 }, (_, i) => i);
  const dark   = isDarkTheme();

  const opts = buildChartDefaults();
  opts.scales.y.beginAtZero = false; // net worth can be negative
  opts.scales.y.grid = {
    ...(opts.scales.y.grid || {}),
    color: (ctx) => ctx.tick.value === 0 ? cc.muted : cc.grid,
  };

  const dataC = {
    labels,
    datasets: [
      {
        label: 'Pay debt first',
        data: payDebt.netWorthByMonth,
        borderColor: cc.accent,
        backgroundColor: cc.accentFill,
        borderWidth: 2.5,
        pointRadius: 0,
        tension: 0.3,
        fill: false,
        order: 1,
      },
      {
        label: `Invest @ ${effLow.toFixed(1)}% after tax`,
        data: investLow.netWorthByMonth,
        borderColor: cc.baseline,
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderDash: [6, 3],
        pointRadius: 0,
        tension: 0.3,
        fill: false,
        order: 4,
      },
      {
        label: `Invest @ ${effMid.toFixed(1)}% after tax`,
        data: investMid.netWorthByMonth,
        borderColor: dark ? '#818cf8' : '#4f46e5',
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.3,
        fill: false,
        order: 3,
      },
      {
        label: `Invest @ ${effHigh.toFixed(1)}% after tax`,
        data: investHigh.netWorthByMonth,
        borderColor: dark ? '#fbbf24' : '#d97706',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderDash: [3, 3],
        pointRadius: 0,
        tension: 0.3,
        fill: false,
        order: 2,
      },
    ],
  };

  if (chartC) {
    chartC.data    = dataC;
    chartC.options = opts;
    chartC.update('none');
  } else if (canvasC) {
    chartC = new Chart(canvasC, { type: 'line', data: dataC, options: opts });
  }

  setVal('chart-c-summary',
    `Net worth at ${horizonMonths / 12} years: pay debt = ${fmtDollars(payDebt.netWorthByMonth[horizonMonths])}, ` +
    `invest at ${effMid.toFixed(1)}% after tax = ${fmtDollars(investMid.netWorthByMonth[horizonMonths])}.`
  );
}

function refreshAll() {
  renderTable();
  updateSliderRanges();
  updateSliderDisplays();

  const hasDebts = debts.length > 0 && debts.some(d => d.balance > 0);
  $('section-sliders').style.display  = hasDebts ? '' : 'none';
  $('section-charts').style.display   = hasDebts ? '' : 'none';
  $('section-compare').style.display  = hasDebts ? '' : 'none';

  const { baseline, withExtra } = runAllSimulations();
  updateCallouts(baseline, withExtra);
  updateCharts(baseline, withExtra);
  updateCompareChart(); // no-op if compare-details is collapsed

  saveToStorage();
}

// ---------------------------------------------------------------------------
// Modal: lifecycle
// ---------------------------------------------------------------------------

function openAddModal() {
  editingId = null;
  currentMode = null;
  resetModal();
  $('modal-title').textContent = 'Add Debt';
  $('modal-confirm').textContent = 'Add Debt';
  showEl('modal-confirm', false);
  showStep('step-1');
  $('modal-backdrop').classList.remove('hidden');
  // Focus first interactive element
  setTimeout(() => $('mode-manual')?.focus(), 50);
}

function openEditModal(id) {
  const debt = debts.find(d => d.id === id);
  if (!debt) return;

  editingId = id;
  currentMode = debt.mode || 'manual';
  resetModal();
  $('modal-title').textContent = 'Edit Debt';
  $('modal-confirm').textContent = 'Save Changes';
  showEl('modal-confirm', true);

  // Pre-fill based on mode
  prefillModal(debt);
  showStep('step-2' + modeToStepSuffix(currentMode));
  $('modal-backdrop').classList.remove('hidden');
}

function closeModal() {
  $('modal-backdrop').classList.add('hidden');
  editingId = null;
  currentMode = null;
}

function modeToStepSuffix(mode) {
  if (mode === 'amortizing')  return 'b';
  if (mode === 'payoffDate')  return 'c';
  return 'a'; // manual
}

function showStep(stepId) {
  ['step-1', 'step-2a', 'step-2b', 'step-2c'].forEach(id => {
    const el = $(id);
    if (el) el.classList.remove('active');
  });
  const target = $(stepId);
  if (target) {
    target.classList.add('active');
    // Focus first focusable element
    setTimeout(() => {
      const first = target.querySelector('button, input, select, textarea');
      if (first) first.focus();
    }, 50);
  }
  // Show alloc selector only on step-2 variants
  const allocSection = $('modal-alloc-section');
  if (allocSection) allocSection.style.display = stepId !== 'step-1' ? '' : 'none';
}

function resetModal() {
  // Clear all inputs
  [
    'm-name', 'm-balance', 'm-apr', 'm-payment', 'm-escrow',
    'a-name', 'a-orig-balance', 'a-apr', 'a-escrow',
    'a-override-balance', 'a-override-payment',
    'p-name', 'p-balance', 'p-apr', 'p-override-payment',
  ].forEach(id => {
    const el = $(id);
    if (el) el.value = '';
  });

  // Reset month/year dropdowns
  ['a-start-month', 'a-start-year', 'p-target-month', 'p-target-year'].forEach(id => {
    const el = $(id);
    if (el) el.value = '';
  });

  // Clear errors
  clearErrors(
    'm-name-err', 'm-balance-err', 'm-apr-err', 'm-payment-err',
    'a-name-err', 'a-orig-balance-err', 'a-apr-err', 'a-start-date-err', 'a-term-err',
    'p-name-err', 'p-balance-err', 'p-apr-err', 'p-target-date-err',
  );

  // Reset previews
  setVal('m-payoff-preview', '—');
  setVal('a-payoff-preview', '—');
  setVal('p-payoff-preview', '—');
  setVal('a-calc-payment', '—');
  setVal('a-calc-balance', '—');
  setVal('a-calc-remaining', '—');
  setVal('p-calc-payment', '—');

  showEl('m-payment-warn', false);

  // Reset freed-payment allocation
  const allocEl = $('modal-freed-alloc');
  if (allocEl) allocEl.value = '100';

  // Reset term unit
  const termYearsRadio = $('term-years');
  if (termYearsRadio) termYearsRadio.checked = true;
  const termEl = $('a-term');
  if (termEl) termEl.value = '';
}

function prefillModal(debt) {
  const mode = debt.mode || 'manual';

  if (mode === 'manual') {
    $('m-name').value    = debt.name;
    $('m-balance').value = debt.balance;
    $('m-apr').value     = debt.apr;
    // Effective payment = minPayment (P&I only); escrow was already stripped
    $('m-payment').value = debt.minPayment;
    if (debt.escrow) $('m-escrow').value = debt.escrow;
    updateManualPreview();

  } else if (mode === 'amortizing') {
    $('a-name').value = debt.name;
    if (debt.origBalance)   $('a-orig-balance').value = debt.origBalance;
    if (debt.apr !== undefined) $('a-apr').value = debt.apr;
    if (debt.startDate) {
      const [sy, sm] = debt.startDate.split('-').map(Number);
      if ($('a-start-month')) $('a-start-month').value = sm;
      if ($('a-start-year'))  $('a-start-year').value  = sy;
    }
    if (debt.termMonths) {
      // Show in years if divisible
      if (debt.termMonths % 12 === 0) {
        $('a-term').value = debt.termMonths / 12;
        $('term-years').checked = true;
      } else {
        $('a-term').value = debt.termMonths;
        $('term-months-radio').checked = true;
      }
    }
    if (debt.escrow) $('a-escrow').value = debt.escrow;
    // Only pre-fill overrides if user explicitly set them; otherwise let fields auto-calculate
    if (debt.overrideBalance != null) $('a-override-balance').value = Number(debt.overrideBalance).toFixed(2);
    if (debt.overridePayment != null) $('a-override-payment').value = Number(debt.overridePayment).toFixed(2);
    updateAmortizingPreview();

  } else if (mode === 'payoffDate') {
    $('p-name').value    = debt.name;
    $('p-balance').value = debt.balance;
    $('p-apr').value     = debt.apr;
    if (debt.targetDate) {
      const [ty, tm] = debt.targetDate.split('-').map(Number);
      if ($('p-target-month')) $('p-target-month').value = tm;
      if ($('p-target-year'))  $('p-target-year').value  = ty;
    }
    $('p-override-payment').value = debt.minPayment;
    updatePayoffDatePreview();
  }

  // Pre-fill freed-payment allocation
  const allocEl = $('modal-freed-alloc');
  if (allocEl) allocEl.value = debt.freedAllocation ?? '100';
}

// ---------------------------------------------------------------------------
// Modal: live previews
// ---------------------------------------------------------------------------

function updateManualPreview() {
  const balance  = getNum('m-balance');
  const apr      = getNum('m-apr');
  const payment  = getNum('m-payment');
  const escrow   = getNum('m-escrow') || 0;

  const warn = $('m-payment-warn');

  if (isNaN(balance) || isNaN(apr) || isNaN(payment) || balance <= 0 || payment <= 0) {
    setVal('m-payoff-preview', '—');
    if (warn) warn.style.display = 'none';
    return;
  }

  const effectivePayment = Math.max(0, payment - escrow);
  const debt = { balance, minPayment: effectivePayment, apr };

  const insufficient = Calculator.isPaymentInsufficient(debt);
  if (warn) warn.style.display = insufficient ? 'inline-flex' : 'none';

  const { months, cappedAt600 } = Calculator.calcNominalPayoffMonths(debt);
  setVal('m-payoff-preview', cappedAt600 ? 'Never (50yr cap)' : fmtDate(months));
}

function getMonthYear(monthId, yearId) {
  const m = parseInt($(`${monthId}`)?.value);
  const y = parseInt($(`${yearId}`)?.value);
  if (!m || !y || m < 1 || m > 12 || y < 1900 || y > 2100) return null;
  return { month: m, year: y, str: `${y}-${String(m).padStart(2, '0')}` };
}

function updateAmortizingPreview() {
  const origBalance = getNum('a-orig-balance');
  const apr         = getNum('a-apr');
  const startDate   = getMonthYear('a-start-month', 'a-start-year');
  const startDateStr = startDate?.str || null;
  const termVal      = getNum('a-term');
  const termUnit     = document.querySelector('input[name="term-unit"]:checked')?.value || 'years';
  const escrow       = getNum('a-escrow') || 0;

  const calcPayEl     = $('a-calc-payment');
  const calcBalEl     = $('a-calc-balance');
  const calcRemainEl  = $('a-calc-remaining');
  const payoffPrev    = $('a-payoff-preview');

  // Reset all to — first
  if (calcPayEl)    calcPayEl.textContent    = '—';
  if (calcBalEl)    calcBalEl.textContent    = '—';
  if (calcRemainEl) calcRemainEl.textContent = '—';
  if (payoffPrev)   payoffPrev.textContent   = '—';

  // Need at least start date and term to show remaining term
  if (!startDateStr || isNaN(termVal) || termVal <= 0) return;

  const termMonths = termUnit === 'years' ? Math.round(termVal * 12) : Math.round(termVal);

  const startDateObj = startDate ? new Date(startDate.year, startDate.month - 1, 1) : null;
  if (!startDateObj) {
    if (calcRemainEl) calcRemainEl.textContent = '—';
    return;
  }

  const monthsSinceStart = Math.max(0,
    (TODAY.getFullYear() - startDateObj.getFullYear()) * 12 +
    (TODAY.getMonth()    - startDateObj.getMonth())
  );
  const remainingMonths = Math.max(0, termMonths - monthsSinceStart);
  if (calcRemainEl) calcRemainEl.textContent = fmtDuration(remainingMonths);

  // APR + balance needed for payment and current balance
  if (isNaN(origBalance) || origBalance <= 0 || isNaN(apr) || apr < 0) return;

  const monthlyPmt = Calculator.calcMonthlyPayment(origBalance, apr, termMonths);
  const currentBal = Calculator.calcRemainingBalance(origBalance, apr, termMonths, monthsSinceStart);

  if (calcPayEl)    calcPayEl.textContent    = fmtDollars(monthlyPmt);
  if (calcBalEl)    calcBalEl.textContent    = fmtDollars(currentBal);

  // Show total payment (P&I + escrow) when escrow is set
  const totalPmtRow  = $('a-total-payment-row');
  const totalPmtEl   = $('a-calc-total-payment');
  const escrowNote   = $('a-escrow-persist-note');
  if (escrow > 0) {
    if (totalPmtRow) totalPmtRow.style.display = '';
    if (totalPmtEl)  totalPmtEl.textContent = fmtDollars(monthlyPmt + escrow);
    if (escrowNote)  escrowNote.style.display = '';
  } else {
    if (totalPmtRow) totalPmtRow.style.display = 'none';
    if (escrowNote)  escrowNote.style.display = 'none';
  }

  // Update override field placeholders with rounded calculated values
  const overrideBalEl = $('a-override-balance');
  const overridePayEl = $('a-override-payment');
  if (overrideBalEl) overrideBalEl.placeholder = currentBal.toFixed(2);
  if (overridePayEl) overridePayEl.placeholder = monthlyPmt.toFixed(2);

  // Effective balance/payment (use overrides if provided)
  const overrideBalance = getNum('a-override-balance');
  const overridePayment = getNum('a-override-payment');
  const effectiveBalance = (!isNaN(overrideBalance) && overrideBalance >= 0) ? overrideBalance : currentBal;
  // monthlyPmt is already P&I only — only subtract escrow from a user-supplied override payment
  const effectivePayment = (!isNaN(overridePayment) && overridePayment >= 0)
    ? Math.max(0, overridePayment - escrow)
    : monthlyPmt;

  const debt = { balance: effectiveBalance, minPayment: effectivePayment, apr };
  const { months, cappedAt600 } = Calculator.calcNominalPayoffMonths(debt);
  if (payoffPrev) payoffPrev.textContent = cappedAt600 ? 'Never (50yr cap)' : fmtDate(months);
}

function updatePayoffDatePreview() {
  const balance    = getNum('p-balance');
  const apr        = getNum('p-apr');
  const targetDate = getMonthYear('p-target-month', 'p-target-year');
  const targetStr  = targetDate?.str || null;

  const calcPmtEl  = $('p-calc-payment');
  const prevEl     = $('p-payoff-preview');

  if (isNaN(balance) || isNaN(apr) || !targetDate || balance <= 0) {
    if (calcPmtEl) calcPmtEl.textContent = '—';
    if (prevEl)    prevEl.textContent    = '—';
    return;
  }

  const targetDateObj = new Date(targetDate.year, targetDate.month - 1, 1);
  const targetMonths = Math.max(1,
    (targetDateObj.getFullYear() - TODAY.getFullYear()) * 12 +
    (targetDateObj.getMonth()    - TODAY.getMonth())
  );

  const requiredPmt = Calculator.calcPaymentForPayoffDate(balance, apr, targetMonths);
  if (calcPmtEl) calcPmtEl.textContent = fmtDollars(requiredPmt);

  const overridePmt = getNum('p-override-payment');
  const effectivePmt = (!isNaN(overridePmt) && overridePmt >= 0) ? overridePmt : requiredPmt;
  if (prevEl) prevEl.textContent = fmtDollars(effectivePmt) + '/mo';
}

// ---------------------------------------------------------------------------
// Modal: validation and confirmation
// ---------------------------------------------------------------------------

function validateAndConfirm() {
  if (!currentMode) return;

  let debt = null;

  if (currentMode === 'manual') {
    debt = validateManual();
  } else if (currentMode === 'amortizing') {
    debt = validateAmortizing();
  } else if (currentMode === 'payoffDate') {
    debt = validatePayoffDate();
  }

  if (!debt) return; // validation failed

  const freedAllocation = $('modal-freed-alloc')?.value || '100';

  if (editingId !== null) {
    // Update existing
    const idx = debts.findIndex(d => d.id === editingId);
    if (idx !== -1) {
      debts[idx] = { ...debt, id: editingId, freedAllocation };
    }
  } else {
    // Add new
    debts.push({ ...debt, id: nextId++, freedAllocation });
  }

  closeModal();
  refreshAll();
}

function validateManual() {
  clearErrors('m-name-err', 'm-balance-err', 'm-apr-err', 'm-payment-err');
  let ok = true;

  const name    = getStr('m-name');
  const balance = getNum('m-balance');
  const apr     = getNum('m-apr');
  const payment = getNum('m-payment');
  const escrow  = getNum('m-escrow') || 0;

  if (!name)            { setError('m-name-err',    'Account name is required'); ok = false; }
  if (isNaN(balance) || balance < 0)  { setError('m-balance-err',  'Enter a valid balance'); ok = false; }
  if (isNaN(apr)     || apr < 0)      { setError('m-apr-err',      'Enter a valid APR'); ok = false; }
  if (isNaN(payment) || payment <= 0) { setError('m-payment-err',  'Enter a payment greater than $0'); ok = false; }

  if (!ok) return null;

  const effectivePayment = Math.max(0, payment - escrow);

  return {
    name,
    balance,
    apr,
    minPayment: effectivePayment,
    escrow: escrow || 0,
    mode: 'manual',
  };
}

function validateAmortizing() {
  clearErrors('a-name-err', 'a-orig-balance-err', 'a-apr-err', 'a-start-date-err', 'a-term-err');
  let ok = true;

  const name        = getStr('a-name');
  const origBalance = getNum('a-orig-balance');
  const apr         = getNum('a-apr');
  const startDateMY = getMonthYear('a-start-month', 'a-start-year');
  const termVal     = getNum('a-term');
  const termUnit    = document.querySelector('input[name="term-unit"]:checked')?.value || 'years';
  const escrow      = getNum('a-escrow') || 0;

  if (!name)                          { setError('a-name-err',         'Account name is required'); ok = false; }
  if (isNaN(origBalance) || origBalance <= 0) { setError('a-orig-balance-err', 'Enter a valid original balance'); ok = false; }
  if (isNaN(apr)         || apr < 0)  { setError('a-apr-err',          'Enter a valid APR'); ok = false; }
  if (!startDateMY)                   { setError('a-start-date-err',   'Select a start month and year'); ok = false; }
  if (isNaN(termVal)     || termVal <= 0) { setError('a-term-err',     'Enter a valid term'); ok = false; }

  if (!ok) return null;

  const termMonths = termUnit === 'years' ? Math.round(termVal * 12) : Math.round(termVal);
  const monthlyPmt = Calculator.calcMonthlyPayment(origBalance, apr, termMonths);

  const startDateObj = new Date(startDateMY.year, startDateMY.month - 1, 1);
  const monthsSinceStart = Math.max(0,
    (TODAY.getFullYear() - startDateObj.getFullYear()) * 12 +
    (TODAY.getMonth()    - startDateObj.getMonth())
  );
  const currentBal = Calculator.calcRemainingBalance(origBalance, apr, termMonths, monthsSinceStart);

  const overrideBalanceRaw = getNum('a-override-balance');
  const overridePaymentRaw = getNum('a-override-payment');
  const userSetBalance = !isNaN(overrideBalanceRaw) && overrideBalanceRaw >= 0;
  const userSetPayment = !isNaN(overridePaymentRaw) && overridePaymentRaw >= 0;
  const finalBalance = userSetBalance ? overrideBalanceRaw : currentBal;
  // Auto-calculated monthly payment is P&I only; only strip escrow from user-supplied override
  const finalPayment = userSetPayment
    ? Math.max(0, overridePaymentRaw - escrow)
    : monthlyPmt;

  return {
    name,
    balance: finalBalance,
    apr,
    minPayment: finalPayment,
    escrow: escrow || 0,
    origBalance,
    startDate: startDateMY.str,
    termMonths,
    overrideBalance: userSetBalance ? overrideBalanceRaw : null,
    overridePayment: userSetPayment ? overridePaymentRaw : null,
    mode: 'amortizing',
  };
}

function validatePayoffDate() {
  clearErrors('p-name-err', 'p-balance-err', 'p-apr-err', 'p-target-date-err');
  let ok = true;

  const name        = getStr('p-name');
  const balance     = getNum('p-balance');
  const apr         = getNum('p-apr');
  const targetDateMY = getMonthYear('p-target-month', 'p-target-year');

  if (!name)                         { setError('p-name-err',        'Account name is required'); ok = false; }
  if (isNaN(balance) || balance < 0) { setError('p-balance-err',     'Enter a valid balance'); ok = false; }
  if (isNaN(apr)     || apr < 0)     { setError('p-apr-err',         'Enter a valid APR'); ok = false; }
  if (!targetDateMY)                 { setError('p-target-date-err', 'Select a target payoff month and year'); ok = false; }

  if (!ok) return null;

  const targetDateObj = new Date(targetDateMY.year, targetDateMY.month - 1, 1);
  const targetMonths = Math.max(1,
    (targetDateObj.getFullYear() - TODAY.getFullYear()) * 12 +
    (targetDateObj.getMonth()    - TODAY.getMonth())
  );

  const requiredPmt = Calculator.calcPaymentForPayoffDate(balance, apr, targetMonths);
  const overridePmt = getNum('p-override-payment');
  const finalPayment = (!isNaN(overridePmt) && overridePmt >= 0) ? overridePmt : requiredPmt;

  return {
    name,
    balance,
    apr,
    minPayment: finalPayment,
    targetDate: targetDateMY.str,
    mode: 'payoffDate',
  };
}

// ---------------------------------------------------------------------------
// LocalStorage save/load
// ---------------------------------------------------------------------------

function saveToStorage() {
  try {
    const ui = {
      lumpSum:              parseFloat($('slider-lump')?.value  || 0),
      extraMonthly:         parseFloat($('slider-extra')?.value || 0),
      lumpStrategy:         $('lump-strategy')?.value  || 'avalanche',
      extraStrategy:        $('extra-strategy')?.value || 'avalanche',
      chartAMode,
      compareOpen:          $('compare-details')?.open || false,
      compareHorizonYears:  parseInt(document.querySelector('#horizon-picker .seg-btn.active')?.dataset.years || 30),
      compareRateLow:       parseFloat($('rate-low')?.value  || 7),
      compareRateMid:       parseFloat($('rate-mid')?.value  || 10.5),
      compareRateHigh:      parseFloat($('rate-high')?.value || 14),
      compareTaxRate:       parseFloat($('compare-tax-rate')?.value || 15),
      compareTaxAdvantaged: $('compare-tax-advantaged')?.checked || false,
    };
    localStorage.setItem('debtshovel-v1', JSON.stringify({ debts, nextId, ui }));
  } catch (e) {
    console.warn('Could not save to localStorage:', e);
  }
}

let _toastTimer = null;
function showToast(message, type = 'success') {
  const el = $('toast');
  if (!el) return;
  if (_toastTimer) clearTimeout(_toastTimer);
  el.textContent = message;
  el.className = `show toast-${type}`;
  _toastTimer = setTimeout(() => {
    el.className = '';
    _toastTimer = null;
  }, 2800);
}

function exportToFile() {
  const data = JSON.stringify({ debts, nextId }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'debtshovel-backup.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Saved to file');
}

function importFromFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (Array.isArray(data.debts)) {
        debts = data.debts.map(d => ({
          ...d,
          freedAllocation: d.freedAllocation === 'global' ? '100' : (d.freedAllocation || '100'),
        }));
      }
      if (data.nextId) nextId = data.nextId;
      refreshAll();
      const count = debts.length;
      showToast(`Loaded ${count} debt${count !== 1 ? 's' : ''}`);
    } catch (err) {
      showToast('Could not load file — check it is a DebtShovel backup', 'error');
    }
  };
  reader.readAsText(file);
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem('debtshovel-v1');
    if (!raw) return;
    const data = JSON.parse(raw);

    // Debts
    if (data.debts)  debts  = data.debts.map(d => ({
      ...d,
      freedAllocation: d.freedAllocation === 'global' ? '100' : (d.freedAllocation || '100'),
    }));
    if (data.nextId) nextId = data.nextId;

    // UI state (absent in saves from older versions — all guarded with ??)
    const ui = data.ui;
    if (!ui) return;

    // Sliders (set value on both range and number input)
    const setSlider = (sliderId, inputId, val) => {
      if (val == null) return;
      const s = $(sliderId); if (s) s.value = val;
      const i = $(inputId);  if (i) i.value = val;
    };
    setSlider('slider-lump',  'lump-input',  ui.lumpSum);
    setSlider('slider-extra', 'extra-input', ui.extraMonthly);

    // Strategy selects + hints
    if (ui.lumpStrategy)  { const el = $('lump-strategy');  if (el) { el.value = ui.lumpStrategy;  updateStrategyHint('lump-strategy',  'lump-strategy-hint');  } }
    if (ui.extraStrategy) { const el = $('extra-strategy'); if (el) { el.value = ui.extraStrategy; updateStrategyHint('extra-strategy', 'extra-strategy-hint'); } }

    // Chart A mode
    if (ui.chartAMode) {
      chartAMode = ui.chartAMode;
      const btn = $('chart-a-toggle');
      const sub = $('chart-a-subtitle');
      if (chartAMode === 'gap') {
        if (btn) btn.textContent = 'Show balances';
        if (sub) sub.textContent = 'Interest + balance saved vs. minimum payments';
      }
    }

    // Compare: rate inputs
    if (ui.compareRateLow  != null) { const el = $('rate-low');          if (el) el.value = ui.compareRateLow;  }
    if (ui.compareRateMid  != null) { const el = $('rate-mid');          if (el) el.value = ui.compareRateMid;  }
    if (ui.compareRateHigh != null) { const el = $('rate-high');         if (el) el.value = ui.compareRateHigh; }
    if (ui.compareTaxRate  != null) { const el = $('compare-tax-rate');  if (el) el.value = ui.compareTaxRate;  }

    // Compare: tax-advantaged checkbox
    if (ui.compareTaxAdvantaged) {
      const el = $('compare-tax-advantaged');
      if (el) {
        el.checked = true;
        const field = $('tax-rate-field');
        if (field) field.style.display = 'none';
      }
    }

    // Compare: horizon picker
    if (ui.compareHorizonYears != null) {
      document.querySelectorAll('#horizon-picker .seg-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.years) === ui.compareHorizonYears);
      });
    }

    // Compare: reopen details if it was open (refreshAll will trigger updateCompareChart)
    if (ui.compareOpen) {
      const details = $('compare-details');
      if (details) details.open = true;
    }
  } catch (e) {
    console.warn('Could not load from localStorage:', e);
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const sunIcon  = $('icon-sun');
  const moonIcon = $('icon-moon');
  if (sunIcon)  sunIcon.style.display  = theme === 'dark' ? 'none' : '';
  if (moonIcon) moonIcon.style.display = theme === 'dark' ? ''     : 'none';
  // Destroy charts so they rebuild with new colors
  if (chartA) { chartA.destroy(); chartA = null; }
  if (chartB) { chartB.destroy(); chartB = null; }
  if (chartC) { chartC.destroy(); chartC = null; }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('debtshovel-theme', next); } catch (e) {}
  const { baseline, withExtra } = runAllSimulations();
  updateCharts(baseline, withExtra);
  updateCompareChart();
}

function loadTheme() {
  try {
    const saved = localStorage.getItem('debtshovel-theme');
    if (saved === 'dark' || saved === 'light') {
      applyTheme(saved);
    }
  } catch (e) {}
}

function wireEvents() {
  // Header buttons
  $('btn-add-debt')?.addEventListener('click', openAddModal);
  $('btn-theme')?.addEventListener('click', toggleTheme);
  $('btn-export')?.addEventListener('click', exportToFile);
  $('import-file')?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) { importFromFile(file); e.target.value = ''; }
  });

  // Modal close
  $('modal-close')?.addEventListener('click', closeModal);
  $('modal-cancel')?.addEventListener('click', closeModal);
  $('modal-confirm')?.addEventListener('click', validateAndConfirm);

  // Close on backdrop click
  $('modal-backdrop')?.addEventListener('click', e => {
    if (e.target === $('modal-backdrop')) closeModal();
  });

  // Close on Escape key
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('modal-backdrop').classList.contains('hidden')) {
      closeModal();
    }
  });

  // Mode cards (Step 1)
  ['mode-manual', 'mode-amortizing', 'mode-payoff-date'].forEach(id => {
    $(id)?.addEventListener('click', e => {
      const mode = e.currentTarget.dataset.mode;
      currentMode = mode;
      showEl('modal-confirm', true);
      showStep('step-2' + modeToStepSuffix(mode));
    });
  });

  // Back links
  $('back-from-manual')?.addEventListener('click', () => {
    showEl('modal-confirm', false);
    showStep('step-1');
  });
  $('back-from-amortizing')?.addEventListener('click', () => {
    showEl('modal-confirm', false);
    showStep('step-1');
  });
  $('back-from-payoff')?.addEventListener('click', () => {
    showEl('modal-confirm', false);
    showStep('step-1');
  });

  // Manual form — live preview
  ['m-name', 'm-balance', 'm-apr', 'm-payment', 'm-escrow'].forEach(id => {
    $(id)?.addEventListener('input', updateManualPreview);
  });

  // Amortizing form — live preview
  ['a-name', 'a-orig-balance', 'a-apr', 'a-start-month', 'a-start-year', 'a-term',
   'a-escrow', 'a-override-balance', 'a-override-payment'].forEach(id => {
    const el = $(id);
    if (el) {
      el.addEventListener('input', updateAmortizingPreview);
      el.addEventListener('change', updateAmortizingPreview);
    }
  });
  document.querySelectorAll('input[name="term-unit"]').forEach(radio => {
    radio.addEventListener('change', updateAmortizingPreview);
  });

  // Payoff date form — live preview
  ['p-name', 'p-balance', 'p-apr', 'p-target-month', 'p-target-year', 'p-override-payment'].forEach(id => {
    const el = $(id);
    if (el) {
      el.addEventListener('input', updatePayoffDatePreview);
      el.addEventListener('change', updatePayoffDatePreview);
    }
  });

  // Sliders — bind to 'input' for live updates
  $('slider-lump')?.addEventListener('input', () => {
    const lumpInput = $('lump-input');
    if (lumpInput) lumpInput.value = $('slider-lump').value;
    updateSliderDisplays();
    const { baseline, withExtra } = runAllSimulations();
    updateCallouts(baseline, withExtra);
    updateCharts(baseline, withExtra);
  });

  $('slider-extra')?.addEventListener('input', () => {
    const extraInput = $('extra-input');
    if (extraInput) extraInput.value = $('slider-extra').value;
    updateSliderDisplays();
    const { baseline, withExtra } = runAllSimulations();
    updateCallouts(baseline, withExtra);
    updateCharts(baseline, withExtra);
  });

  // Number inputs — type to set slider value
  // On input: update live if valid, mark error if not
  // On blur: always clamp and correct
  function wireSliderInput(inputId, sliderId) {
    const input  = $(inputId);
    const slider = $(sliderId);
    if (!input || !slider) return;

    input.addEventListener('input', () => {
      const raw = parseFloat(input.value);
      if (isNaN(raw) || raw < 0) {
        input.classList.add('error');
        return; // don't update charts while mid-typing an invalid value
      }
      input.classList.remove('error');
      const v = Math.min(raw, parseFloat(slider.max));
      slider.value = v;
      updateSliderDisplays();
      const { baseline, withExtra } = runAllSimulations();
      updateCallouts(baseline, withExtra);
      updateCharts(baseline, withExtra);
    });

    input.addEventListener('blur', () => {
      const raw = parseFloat(input.value);
      const v = isNaN(raw) || raw < 0 ? 0 : Math.min(raw, parseFloat(slider.max));
      input.value = v;
      input.classList.remove('error');
      slider.value = v;
      updateSliderDisplays();
      const { baseline, withExtra } = runAllSimulations();
      updateCallouts(baseline, withExtra);
      updateCharts(baseline, withExtra);
    });
  }

  wireSliderInput('lump-input',  'slider-lump');
  wireSliderInput('extra-input', 'slider-extra');

  // Chart A toggle: balance view ↔ savings gap
  $('chart-a-toggle')?.addEventListener('click', () => {
    chartAMode = chartAMode === 'balances' ? 'gap' : 'balances';
    const btn = $('chart-a-toggle');
    const sub = $('chart-a-subtitle');
    if (chartAMode === 'gap') {
      if (btn) btn.textContent = 'Show balances';
      if (sub) sub.textContent = 'Interest + balance saved vs. minimum payments';
    } else {
      if (btn) btn.textContent = 'Show savings gap';
      if (sub) sub.textContent = 'Baseline vs. with your accelerators';
    }
    const { baseline, withExtra } = runAllSimulations();
    updateCharts(baseline, withExtra);
  });

  // Empty state CTA
  $('btn-add-debt-empty')?.addEventListener('click', openAddModal);

  // Strategy pickers — update simulation on change + show hint
  ['lump-strategy', 'extra-strategy'].forEach(id => {
    const hintId = id + '-hint';
    updateStrategyHint(id, hintId);
    $(id)?.addEventListener('change', () => {
      updateStrategyHint(id, hintId);
      const { baseline, withExtra } = runAllSimulations();
      updateCallouts(baseline, withExtra);
      updateCharts(baseline, withExtra);
      updateCompareChart();
    });
  });

  // Compare section: horizon picker
  document.querySelectorAll('#horizon-picker .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#horizon-picker .seg-btn')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateCompareChart();
    });
  });

  // Compare section: rate inputs and tax rate
  ['rate-low', 'rate-mid', 'rate-high', 'compare-tax-rate'].forEach(id => {
    $(id)?.addEventListener('input', updateCompareChart);
  });

  // Compare section: tax-advantaged toggle
  $('compare-tax-advantaged')?.addEventListener('change', () => {
    const isTaxAdv = $('compare-tax-advantaged').checked;
    const field = $('tax-rate-field');
    if (field) field.style.display = isTaxAdv ? 'none' : '';
    updateCompareChart();
  });

  // Compare section: open/close details — lazy init
  $('compare-details')?.addEventListener('toggle', () => {
    if ($('compare-details').open) updateCompareChart();
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  loadTheme();
  wireEvents();
  loadFromStorage();
  refreshAll();
}

// Wait for DOM + Chart.js to be ready
document.addEventListener('DOMContentLoaded', () => {
  // Chart.js is loaded via defer — it should be available by DOMContentLoaded
  // but guard just in case
  if (typeof Chart === 'undefined') {
    // Retry once Chart.js loads
    window.addEventListener('load', init);
  } else {
    init();
  }
});
