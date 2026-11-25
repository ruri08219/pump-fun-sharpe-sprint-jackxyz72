// Climber — paper-trading bot for the make.fun Pump.fun Sharpe Sprint.
//
// Idea, measured on the house dev window (24 h, 1,222 mints) before this
// file was written: the opening spike of a new pump.fun coin is faster than
// the replay's 2-slot fill latency, so sniping the launch loses a little on
// almost every coin. What does work is the slower reserve climb. A coin
// whose real SOL reserve reaches 20 SOL has proven demand — most new coins
// never get there — and its bonding-curve price rises with the reserve, so
// the bot buys the crossing and sells when the reserve climbs half as far
// again. Winners are protected by a trailing stop; losers are never cut on
// a fixed stop (dips recover on this tape — every stop-loss tested made the
// result worse) and are only left when the coin goes quiet for a long time
// or the trailing stop gives the gain back. Each coin is bought once and
// then topped up to 1 SOL while its reserve keeps climbing (a top-up on
// every batch where the reserve has not fallen below the last buy's level);
// a value gate on top-ups was tried and graded worse.
//
// Exits, in order: reserve target reached, trailing stop (arms at +20% over
// cost, sells on a 35% fall from the best value), or no trade for 60,000
// slots. No hard stop-loss, no take-profit cap, no clock, no randomness:
// every decision is a pure function of the batches the harness feeds in,
// so two runs on the same data produce the same action log.
//
// Guardrails: at most 5 open positions; one first buy per coin, at least
// 0.01 SOL (the round-trip minimum); buys capped at 1% of the coin's real
// SOL reserve, as the harness requires.

import { BPS, LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

// --- tunables (swept on the dev window with the kit's own simulator) ---
const ENTRY_REAL = 20n * LAMPORTS_PER_SOL; // enter when real SOL first reaches this
const ENTRY_MAX_REAL = 26n * LAMPORTS_PER_SOL; // never enter above this (climb missed)
const STAKE = 300_000_000n; // target first-buy size (the 1% reserve cap usually binds first)
const MIN_BUY = 10_000_000n; // 0.01 SOL, the round-trip minimum
const EXIT_MULT_BPS = 15000n; // sell when real reserve reaches 1.5x the entry reserve
const TRAIL_ARM_BPS = 2000n; // arm the trailing stop at +20% over cost
const TRAIL_BPS = 3500n; // sell on a 35% fall from the position's best value
const MAX_HOLD_SLOTS = 200000; // ~12 h: effectively never binds inside a 6 h window
const STALE_SLOTS = 60000; // sell a coin with no trade for this long (~3.5 h)
const ADD_STEP_BPS = 0n; // top up whenever the reserve has not fallen below the last buy's level
const ADD_SIZE = 200_000_000n; // 0.2 SOL per top-up
const MAX_POSITION = 1_000_000_000n; // 1 SOL total per coin
const MAX_POSITIONS = 5;

const FEE_BPS = 125n; // protocol 95 + creator 30 bps of curve fees per leg

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const quote = (tokens * vq) / (vt + tokens);
  return quote - (quote * FEE_BPS + BPS - 1n) / BPS;
}

interface Coin {
  mint: Pubkey;
  prevReal: bigint;
  entryReal: bigint;
  lastBuyReal: bigint;
  lastTradeSlot: number;
  done: boolean;
  buyPending: boolean;
  complete: boolean;
}

interface Held {
  cost: bigint;
  best: bigint;
  buySlot: number;
  armed: boolean;
  entryReal: bigint;
  spent: bigint;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
const selling = new Set<Pubkey>();

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  // Fold this batch's fills in first: a filled buy starts tracking, a
  // filled sell frees the coin; a rejected or failed buy may be retried.
  for (const fill of batch.fills) {
    if (fill.side === 'buy') {
      const coin = coins.get(fill.mint);
      if (coin) coin.buyPending = false;
      if (fill.status === 'filled') {
        const pos = state.positions.get(fill.mint);
        if (pos && coin) {
          const prev = held.get(fill.mint);
          if (prev) {
            prev.cost = pos.cost_lamports;
            prev.spent = pos.cost_lamports;
            if (prev.best < pos.cost_lamports) prev.best = pos.cost_lamports;
          } else {
            held.set(fill.mint, {
              cost: pos.cost_lamports,
              best: pos.cost_lamports,
              buySlot: batch.slot,
              armed: false,
              entryReal: coin.entryReal,
              spent: pos.cost_lamports,
            });
          }
        }
      }
    } else {
      selling.delete(fill.mint);
      if (fill.status === 'filled') held.delete(fill.mint);
    }
  }
  // Track new coins and each coin's latest trade from this batch's events.
  for (const event of batch.events) {
    if (event.event === 'CreateEvent') {
      if (!coins.has(event.mint)) {
        coins.set(event.mint, {
          mint: event.mint,
          prevReal: 0n,
          entryReal: 0n,
          lastBuyReal: 0n,
          lastTradeSlot: event.slot,
          done: false,
          buyPending: false,
          complete: false,
        });
      }
    } else if (event.event === 'CompleteEvent') {
      const coin = coins.get(event.mint);
      if (coin) coin.complete = true;
    } else if (event.event === 'TradeEvent') {
      const coin = coins.get(event.mint);
      if (coin) coin.lastTradeSlot = event.slot;
    }
  }
  const txFee = state.txFeeLamports();
  let free = state.freeCashLamports();
  // Exits first, so a slot freed here can be reused by an entry below.
  for (const [mint, hold] of held) {
    if (selling.has(mint)) continue;
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (!pos || !curve || curve.complete) continue;
    const value = sellValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (value > hold.best) hold.best = value;
    if (value >= (hold.cost * (BPS + TRAIL_ARM_BPS)) / BPS) hold.armed = true;
    const age = batch.slot - hold.buySlot;
    let exit = false;
    if (curve.real_quote_reserves >= (hold.entryReal * EXIT_MULT_BPS) / BPS) exit = true;
    if (hold.armed && value <= (hold.best * (BPS - TRAIL_BPS)) / BPS) exit = true;
    if (age >= MAX_HOLD_SLOTS) exit = true;
    const coin = coins.get(mint);
    if (coin && batch.slot - coin.lastTradeSlot >= STALE_SLOTS) exit = true;
    if (exit) {
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
      selling.add(mint);
      continue;
    }
    // Top up a climb that keeps climbing: whenever the reserve has not
    // fallen below the last buy's level, add another slice, up to 1 SOL per
    // coin. Gating top-ups on the position being above water was tried and
    // graded worse (+1.05 SOL vs +1.47): a coin whose reserve is still
    // climbing usually recovers, so the top-up rides the recovery.
    if (coin && hold.spent < MAX_POSITION && curve.real_quote_reserves >= (coin.lastBuyReal * (BPS + ADD_STEP_BPS)) / BPS) {
      const cap = state.maxBuyLamports(mint);
      const amount = cap < ADD_SIZE ? cap : ADD_SIZE;
      if (amount >= MIN_BUY && free >= amount + txFee && orders.length < state.hello.caps.max_orders_per_batch) {
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: 10000 });
        coin.buyPending = true;
        coin.lastBuyReal = curve.real_quote_reserves;
        free -= amount + txFee;
      }
    }
  }
  // Entries: a coin whose real reserve crosses ENTRY_REAL upward, while it
  // is still inside the entry band and still rising.
  let slots = MAX_POSITIONS - state.committedPositionCount();
  for (const coin of coins.values()) {
    if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    if (slots <= 0) break;
    if (coin.done || coin.complete || coin.buyPending || held.has(coin.mint)) continue;
    const curve = state.curves.get(coin.mint);
    if (!curve || curve.complete) continue;
    const real = curve.real_quote_reserves;
    const crossed = coin.prevReal < ENTRY_REAL && real >= ENTRY_REAL;
    const inBand = real >= ENTRY_REAL && real <= ENTRY_MAX_REAL && coin.prevReal < real;
    if (!crossed && !inBand) continue;
    const cap = state.maxBuyLamports(coin.mint);
    const amount = cap < STAKE ? cap : STAKE;
    if (amount < MIN_BUY) continue;
    if (free < amount + txFee) continue;
    orders.push({ side: 'buy', mint: coin.mint, quote_lamports: amount, max_slippage_bps: 10000 });
    coin.buyPending = true;
    coin.done = true;
    coin.entryReal = real;
    coin.lastBuyReal = real;
    free -= amount + txFee;
    slots -= 1;
  }
  // Keep each coin's previous reserve current for the next batch's crossing.
  for (const coin of coins.values()) {
    if (coin.done || coin.complete) continue;
    const curve = state.curves.get(coin.mint);
    if (curve) coin.prevReal = curve.real_quote_reserves;
  }
  return orders;
}

await runBot({ onBatch });
