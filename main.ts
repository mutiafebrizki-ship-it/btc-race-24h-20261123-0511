// cbBTC 24h race bot — original strategy, written for this competition.
//
// Idea: one asset, one-minute bars, long only, $1,000 paper. The dev window is
// a slow grind up (+3.6%) followed by a long chop, and a 1-minute bar moves
// only ~8 bps, while a full-size round trip costs ~30-40 bps in fee, slippage
// and pool impact. So the bot trades rarely and holds: it rides a confirmed
// trend with a wide trailing stop, and stays out of the chop.
//
// Structure (all decisions on a bar's close, filled at the next bar's open):
//   * Trend: EMA(30) vs EMA(90) of closes, seeded from the first close.
//     A fresh cross up, with 60-minute momentum positive and RSI(14) under 75,
//     buys. The first trade of the window is half size (the opening bars carry
//     almost no history, so a cross there is as likely chop as trend); it is
//     topped up to full size once 2-hour momentum confirms (> +0.8%) and the
//     slow EMA is rising. If the cross is missed (e.g. EMAs already warm), a
//     backup entry buys a strong established uptrend near its 240-bar high.
//   * Re-entry only after a genuine regime reset: the fast EMA spent 180+
//     consecutive bars under the slow one. At most 2 trend trades per window.
//   * Mean-reversion insurance: a tiny (15% of equity) oversold bounce buy
//     (RSI <= 25 and price > 1.8 std below its 20-bar mean) so a flat or
//     falling window still records at least one trade; at most 2, each sold
//     quickly at +1.2%, on RSI recovery, or after 90 bars.
//   * Risk: exit everything on a cross down, on -1.5% vs average cost
//     (-0.8% for an unconfirmed early half position), or on a 2.5% trailing
//     pullback from the highest close since entry. No shorts, no leverage,
//     one open position, at most one order per reply.
//   * Deterministic: float64 math on the bars only, no clock, no randomness,
//     no network, no files outside the repo. Same bars give the same orders.
//
// Backtested locally on the frozen dev window with the kit's own replay model
// (fee 4 bps, slippage 2 bps, constant-product impact vs the bar's open
// depth): net PnL about +$20, 7 trades, max drawdown about 1.8%.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST_SPAN = 30;
const SLOW_SPAN = 90;
const RSI_SPAN = 14;
const MEAN_SPAN = 20;
const MAX_SLIPPAGE_BPS = 100;

// Trend entry.
const MOM_MIN = 0.001; // 60-minute momentum must be positive
const CROSS_RSI_MAX = 75;
const COOLDOWN_BARS = 60; // bars after a trend exit before a new cross entry
const RESET_BARS = 180; // consecutive bars fast EMA under slow EMA = regime reset
const MAX_TREND_TRADES = 2;
// Opening bars carry little history: first trade half size, topped up on confirmation.
const EARLY_BARS = 120;
const EARLY_SIZE = 0.5; // fraction of equity for a trade decided before bar 120
const ADDON_SIZE = 0.6; // fraction of equity the top-up may add
// Backup entry (cross missed, e.g. EMAs already warm at the window's start).
const BACKUP_UNTIL = 400;
const BACKUP_SLOPE_MIN = 0.0005; // slow EMA rising over 60 bars
const BACKUP_MOM_MIN = 0.008; // 120-minute momentum above +0.8%
// Risk exits.
const STOP = 0.015; // vs average cost
const EARLY_STOP = 0.008; // vs average cost, unconfirmed early half position only
const TRAIL = 0.025; // pullback from the highest close since entry
// Oversold-bounce insurance (tiny, rare).
const SCALP_MAX = 2;
const SCALP_RSI_MAX = 25;
const SCALP_Z_MAX = -1.8;
const SCALP_SIZE = 0.15; // fraction of equity
const SCALP_TP = 0.012;
const SCALP_RSI_OUT = 55;
const SCALP_MAX_HOLD = 90; // bars
const SCALP_COOLDOWN = 360; // bars between bounce attempts

/** Closes in raw price units (price_scale 5), one per bar seen, in order. */
const closes: number[] = [];
/** One-bar close-to-close changes, in raw units (length = closes.length - 1). */
const diffs: number[] = [];
let emaFast: number | null = null;
let emaSlow: number | null = null;
/** Slow EMA value per bar, parallel to closes (for the 60-bar slope filter). */
const slowHistory: number[] = [];
/** fast - slow after the previous bar, null until both EMAs exist. */
let prevGap: number | null = null;

const st = {
  lastTrendExit: -9999,
  lastScalp: -9999,
  peak: 0,
  entryBar: 0,
  scalp: false,
  scalps: 0,
  trendTrades: 0,
  belowRun: 0,
  early: false,
  addonDone: false,
  backupDone: false,
};

function emaStep(prev: number | null, span: number, close: number): number {
  if (prev === null) return close;
  return prev + (2 / (span + 1)) * (close - prev);
}

function sma20(): number | null {
  if (closes.length < MEAN_SPAN) return null;
  let s = 0;
  for (let i = closes.length - MEAN_SPAN; i < closes.length; i++) s += closes[i]!;
  return s / MEAN_SPAN;
}

function std20(mean: number): number | null {
  if (closes.length < MEAN_SPAN) return null;
  let s = 0;
  for (let i = closes.length - MEAN_SPAN; i < closes.length; i++) {
    const d = closes[i]! - mean;
    s += d * d;
  }
  return Math.sqrt(s / MEAN_SPAN);
}

/** RSI(14) as a plain 14-bar mean of gains/losses (not Wilder's smoothing). */
function rsi14(): number | null {
  if (closes.length <= RSI_SPAN) return null;
  let g = 0;
  let l = 0;
  for (let i = diffs.length - RSI_SPAN; i < diffs.length; i++) {
    const d = diffs[i]!;
    if (d > 0) g += d;
    else l -= d;
  }
  g /= RSI_SPAN;
  l /= RSI_SPAN;
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

function pushBar(close: number): void {
  if (closes.length > 0) diffs.push(close - closes[closes.length - 1]!);
  closes.push(close);
  emaFast = emaStep(emaFast, FAST_SPAN, close);
  emaSlow = emaStep(emaSlow, SLOW_SPAN, close);
  slowHistory.push(emaSlow);
}

/** Whole quote units (1e-6 USDC) for a fraction of equity, clamped to cash. */
function buyUnits(state: BarsState, frac: number): bigint {
  const units = BigInt(Math.floor(Number(state.equity) * frac));
  const cash = state.cash;
  const n = units < cash ? units : cash;
  return n < 1_000_000n ? 0n : n;
}

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      pushBar(Number(bar.c));
    }
    if (state.warmingUp) return [];
    const i = closes.length - 1;
    if (i < 1 || emaFast === null || emaSlow === null) return [];
    const r = rsi14();
    if (r === null) return [];
    const c = closes[i]!;
    const gap = emaFast - emaSlow;
    const trendUp = gap > 0;
    const crossUp = prevGap !== null && gap > 0 && prevGap <= 0;
    const crossDn = prevGap !== null && gap < 0 && prevGap >= 0;
    prevGap = gap;

    const mom60 = c / closes[Math.max(0, i - 60)]! - 1;
    const mom120 = c / closes[Math.max(0, i - 120)]! - 1;
    const slowBase = slowHistory[Math.max(0, slowHistory.length - 1 - 60)]!;
    const slowSlope60 = emaSlow / slowBase - 1;
    const mean = sma20();
    const sd = mean === null ? null : std20(mean);
    const z = mean !== null && sd !== null && sd > 0 ? (c - mean) / sd : 0;
    let hi240 = c;
    for (let k = Math.max(0, i - 240); k <= i; k++) if (closes[k]! > hi240) hi240 = closes[k]!;

    if (trendUp) st.belowRun = 0;
    else st.belowRun += 1;

    const held = state.positions.get(SYMBOL);
    const orders: (BuyInput | SellInput)[] = [];
    const sellAll = (): void => {
      if (held !== undefined) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    };

    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      const gain = Number(value) / Number(held.cost) - 1;
      if (c > st.peak) st.peak = c;
      const trailDd = (st.peak - c) / st.peak;
      const stop = st.early && !st.addonDone ? EARLY_STOP : STOP;
      if (gain <= -stop || crossDn) {
        sellAll();
        if (st.scalp) st.lastScalp = i;
        else st.lastTrendExit = i;
        st.peak = 0;
        st.scalp = false;
        st.early = false;
        return orders;
      }
      if (TRAIL > 0 && gain > 0 && trailDd >= TRAIL) {
        sellAll();
        if (st.scalp) st.lastScalp = i;
        else st.lastTrendExit = i;
        st.peak = 0;
        st.scalp = false;
        st.early = false;
        return orders;
      }
      if (st.scalp) {
        if (gain >= SCALP_TP || r >= SCALP_RSI_OUT || i - st.entryBar >= SCALP_MAX_HOLD) {
          sellAll();
          st.lastScalp = i;
          st.peak = 0;
          st.scalp = false;
          st.early = false;
        }
        return orders;
      }
      // Top up an unconfirmed early half position once the trend confirms.
      if (
        st.early &&
        !st.addonDone &&
        i >= EARLY_BARS &&
        trendUp &&
        mom120 > BACKUP_MOM_MIN &&
        slowSlope60 > BACKUP_SLOPE_MIN &&
        r < CROSS_RSI_MAX
      ) {
        const room = state.equity - value;
        let size = (state.equity * BigInt(Math.round(ADDON_SIZE * 1e6))) / 1_000_000n;
        if (size > room) size = room;
        if (size > state.cash) size = state.cash;
        if (size >= 1_000_000n) {
          orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
          st.addonDone = true;
          st.early = false;
        }
      }
      return orders;
    }

    // Flat: trend entry on a fresh cross, after a reset (or at the start).
    const resetOk = st.trendTrades === 0 || st.belowRun >= RESET_BARS;
    if (
      st.trendTrades < MAX_TREND_TRADES &&
      trendUp &&
      crossUp &&
      mom60 > MOM_MIN &&
      r < CROSS_RSI_MAX &&
      resetOk &&
      i - st.lastTrendExit >= COOLDOWN_BARS
    ) {
      const early = i < EARLY_BARS;
      const n = buyUnits(state, early ? EARLY_SIZE : 1);
      if (n > 0n) {
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: n, max_slippage_bps: MAX_SLIPPAGE_BPS });
        st.peak = c;
        st.entryBar = i;
        st.scalp = false;
        st.trendTrades += 1;
        st.early = early;
        st.addonDone = false;
      }
      return orders;
    }

    // Backup entry: strong uptrend already established, cross missed.
    if (
      st.trendTrades === 0 &&
      !st.backupDone &&
      i >= EARLY_BARS &&
      i < BACKUP_UNTIL &&
      trendUp &&
      slowSlope60 > BACKUP_SLOPE_MIN &&
      mom120 > BACKUP_MOM_MIN &&
      r < CROSS_RSI_MAX &&
      c >= 0.999 * hi240
    ) {
      const n = buyUnits(state, 1);
      if (n > 0n) {
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: n, max_slippage_bps: MAX_SLIPPAGE_BPS });
        st.peak = c;
        st.entryBar = i;
        st.scalp = false;
        st.trendTrades += 1;
        st.backupDone = true;
        st.early = false;
      }
      return orders;
    }

    // Tiny oversold bounce: guardrail insurance for flat/falling windows.
    if (
      st.scalps < SCALP_MAX &&
      r <= SCALP_RSI_MAX &&
      z < SCALP_Z_MAX &&
      i - st.lastScalp >= SCALP_COOLDOWN
    ) {
      const n = buyUnits(state, SCALP_SIZE);
      if (n > 0n) {
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: n, max_slippage_bps: MAX_SLIPPAGE_BPS });
        st.peak = c;
        st.entryBar = i;
        st.scalp = true;
        st.scalps += 1;
        st.early = false;
      }
      return orders;
    }
    return orders;
  },
});
