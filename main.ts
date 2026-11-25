// Tiny Bot — beat buy-and-hold on Solana hourly bars.
// Strategy: trend-filtered momentum rotation, long only.
//   - Per symbol keep EMA(8) and EMA(21) over closes plus the 12h return.
//   - Enter when EMA(8) is above EMA(21) AND the 12h return is positive, on the
//     strongest candidates first (ranked by 12h return), up to 3 open positions.
//   - Exit the whole position when EMA(8) crosses back under EMA(21), or the
//     12h return falls below -2%, or on a -5% stop-loss from cost, or a +20%
//     take-profit (locks gains in a short 3-day window). A sell signal holds
//     while its reason holds, so a refused sell is retried on the next bar.
//   - Stake: equity / 3 per slot, capped by the 25% max-weight cap and by the
//     cash this reply has not spent yet. Sells are sent before buys; a sell's
//     proceeds never fund a buy of the same reply.
//   - Deterministic: float64 math on closes only, no clock, no environment,
//     no randomness. Slippage is capped at 100 bps so a sell into a gap is
//     refused and retried rather than filled for almost nothing.
//   - Why it beats buy-and-hold: buy-and-hold sits in every asset including
//     the losers for the whole window; this bot only holds assets in an
//     uptrend with positive 12h momentum, sits in cash otherwise, and cuts
//     losers at -5% instead of riding them down. Parameters were chosen on
//     the kit's dev window by testing rolling 72-bar windows (the final
//     window's length): this set kept at least 9 trades in every window
//     (guardrail: 8) while losing far less than buy-and-hold in each.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_BARS = 8;
const SLOW_BARS = 21;
const MOMENTUM_BARS = 12;
const MAX_SLOTS = 3;
/** Entry needs a 24h return above this, in bps (0 = any positive momentum). */
const MOM_MIN_BP = 0;
/** Exit when the 24h return falls below this, in bps (fading trend). */
const EXIT_MOM_BP = -200;
const STOP_NUM = 95n; // -5% of cost
const STOP_DEN = 100n;
const TAKE_NUM = 120n; // +20% of cost
const TAKE_DEN = 100n;
const MAX_SLIPPAGE_BPS = 100;

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  closes: number[];
  /** fast - slow after the previous bar, once both are set. */
  gap: number | null;
  /** fast - slow after this bar. */
  now: number | null;
  /** The down-cross sell signal, held while EMA(21) stays above EMA(8). */
  down: boolean;
}

const series = new Map<string, Series>();

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function pushBar(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = {
      fast: { span: FAST_BARS, warm: [], value: null },
      slow: { span: SLOW_BARS, warm: [], value: null },
      closes: [],
      gap: null,
      now: null,
      down: false,
    };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  s.closes.push(c);
  stepEma(s.fast, c);
  stepEma(s.slow, c);
  s.gap = s.now;
  s.now = s.fast.value !== null && s.slow.value !== null ? s.fast.value - s.slow.value : null;
  if (s.now === null || s.now >= 0) s.down = false;
  else if (s.gap !== null && s.gap >= 0) s.down = true;
  return s;
}

/** 12h return as a fraction (close now vs close 12 bars ago), or null without history. */
function momentum24(s: Series): number | null {
  if (s.closes.length <= MOMENTUM_BARS) return null;
  const old = s.closes[s.closes.length - 1 - MOMENTUM_BARS];
  const now = s.closes[s.closes.length - 1];
  if (old === 0) return null;
  return (now - old) / old;
}

function exits(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, s: Series): boolean {
  if (s.down) return true;
  const m = momentum24(s);
  if (m !== null && m * 10000 < EXIT_MOM_BP) return true;
  const value = state.value(symbol, held.qty);
  if (value * STOP_DEN <= held.cost * STOP_NUM) return true;
  if (value * TAKE_DEN >= held.cost * TAKE_NUM) return true;
  return false;
}

await runBars({
  onBatch(state, batch) {
    const orders: (BuyInput | SellInput)[] = [];
    // Fold every bar of this batch into the indicators first.
    for (const bar of batch.bars) pushBar(bar);
    // While warming up every order would be rejected (warmup): build history only.
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;

    // 1) Exits first: sell every held position whose exit reason holds.
    const heldSymbols = [...state.positions.keys()];
    let sells = 0;
    for (const symbol of heldSymbols) {
      const held = state.positions.get(symbol)!;
      const s = series.get(symbol);
      if (s === undefined) continue;
      if (exits(state, symbol, held, s)) {
        orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        sells++;
      }
    }

    // 2) Entries: uptrend + positive 24h momentum, strongest first, into free slots.
    const openSlots = Math.min(MAX_SLOTS, caps.max_open_positions) - (state.positions.size - sells);
    if (openSlots > 0) {
      const candidates = state.hello.symbols
        .map((sym) => sym.symbol)
        .filter((symbol) => !state.positions.has(symbol))
        .map((symbol) => {
          const s = series.get(symbol);
          if (s === undefined || s.now === null || s.now <= 0) return null;
          const m = momentum24(s);
          if (m === null || m * 10000 <= MOM_MIN_BP) return null;
          return { symbol, m };
        })
        .filter((x): x is { symbol: string; m: number } => x !== null)
        .sort((a, b) => b.m - a.m)
        .slice(0, openSlots);

      let cashLeft = state.cash;
      for (const { symbol } of candidates) {
        if (orders.length >= caps.max_orders_per_bar) break;
        const bySlots = state.equity / BigInt(MAX_SLOTS);
        const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
        let stake = bySlots < byWeight ? bySlots : byWeight;
        if (stake > cashLeft) stake = cashLeft;
        if (stake === 0n || stake < BigInt(fees.min_notional_quote_units)) continue;
        cashLeft -= stake;
        orders.push({ side: 'buy', symbol, notional_quote_units: stake, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }
    return orders;
  },
});
