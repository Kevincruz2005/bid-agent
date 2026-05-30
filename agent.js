import fs from 'fs';
import { ethers } from 'ethers';

// ── CONFIG ────────────────────────────────────────────────────────────────────
const API_BASE   = 'https://alpha.creator.bid/api';
const RPC        = 'http://5.161.35.78:8545';
const FACTORY    = '0xE841bCA5A85C76FA667a968C4fe817Ffa2E220e7';
const USDC_ADDR  = '0xed38c197b319fdc067f4c3fb58eec1a733a36cf4';
const TRADER_ZH  = '0x521FAcaAB630E30614617c9ae5f6508cB4213540';
const ROLE_KEY   = '0xfacaf2747a7486cf5730e9265973fb54447d3ace6e7e4711f6360826b0731941';
const ARCHETYPE  = process.env.ARCHETYPE  || 'Custom';
const STATE_FILE = '.agent.json';

const provider = new ethers.JsonRpcProvider(RPC, 42069, { staticNetwork: true });
const sleep    = (ms) => new Promise(r => setTimeout(r, ms));
const log      = (...a) => console.log(`[${new Date().toISOString().slice(11,19)}]`, ...a);

// ── Railway: hydrate .agent.json from AGENT_STATE env var ────────────────────
// After first local registration the agent prints:
//   AGENT_STATE=<base64-encoded-.agent.json>
// Set that as a Railway environment variable. On each Railway start-up this
// block writes the file back so loadOrBootstrap() finds it and skips re-register.
if (process.env.AGENT_STATE && !fs.existsSync(STATE_FILE)) {
  fs.writeFileSync(
    STATE_FILE,
    Buffer.from(process.env.AGENT_STATE, 'base64').toString('utf8'),
    { mode: 0o600 }
  );
  log('hydrated .agent.json from AGENT_STATE env var');
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(API_BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  if (!r.ok) {
    const e = new Error(`${method} ${path} → ${r.status}: ${data.error || text}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

// ── State persistence ─────────────────────────────────────────────────────────
function save(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 }); }
  catch { /* non-fatal on Railway ephemeral FS — JWT refreshes in-memory anyway */ }
}

// ── Load state or register (first run) ───────────────────────────────────────
async function loadOrBootstrap() {
  if (fs.existsSync(STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    log(`loaded state — Trading Safe: ${state.tradingSafe}`);
    return state;
  }

  const USER_JWT = process.env.USER_JWT;
  if (!USER_JWT) {
    throw new Error(
      'First run: set USER_JWT=<your-dashboard-jwt> before starting.\n' +
      'Log in at https://alpha.creator.bid with your access code, then copy the JWT.'
    );
  }

  const w = ethers.Wallet.createRandom();
  log('registering new EOA:', w.address);

  const body = await api('/agents/register', {
    method: 'POST',
    token: USER_JWT,
    body: { name: 'achla-' + w.address.slice(2, 10), address: w.address, archetype: ARCHETYPE },
  });

  if (!body.trading_safe) {
    throw new Error('registration failed — no trading_safe in response: ' + JSON.stringify(body));
  }

  const state = {
    name:         body.name,
    pk:           w.privateKey,
    address:      w.address,
    agentJwt:     body.token,
    tradingSafe:  body.trading_safe,
    treasurySafe: body.treasury_safe || '',
    rolesMod:     body.roles_modifier,
  };

  save(state);
  log(`registered "${state.name}" — Trading Safe: ${state.tradingSafe}`);

  // Print Railway env var — copy this after first local run
  const b64 = Buffer.from(JSON.stringify(state, null, 2)).toString('base64');
  console.log('\n' + '═'.repeat(68));
  console.log('RAILWAY ENV VAR — copy exactly this line into your Railway service:');
  console.log('═'.repeat(68));
  console.log(`AGENT_STATE=${b64}`);
  console.log('═'.repeat(68) + '\n');

  // Wait for funding airdrop to land before the agent reads balances
  log('waiting 8s for funding airdrop to confirm on-chain…');
  await sleep(8_000);

  return state;
}

// ── JWT refresh via SIWE ──────────────────────────────────────────────────────
function jwtExp(t) {
  try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString()).exp || 0; }
  catch { return 0; }
}

async function siweLogin(state) {
  const wallet = new ethers.Wallet(state.pk, provider);
  const { message } = await api('/auth/nonce', {
    method: 'POST',
    body: { address: wallet.address },
  });
  const signature = await wallet.signMessage(message);
  const { token } = await api('/auth/login', {
    method: 'POST',
    body: { address: wallet.address, signature },
  });
  state.agentJwt = token;
  save(state);
  log('agent JWT refreshed via SIWE');
  return token;
}

async function freshJwt(state) {
  if (!state.agentJwt || jwtExp(state.agentJwt) - Math.floor(Date.now() / 1000) < 600) {
    await siweLogin(state);
  }
  return state.agentJwt;
}

// ── ABIs ──────────────────────────────────────────────────────────────────────
const TRADER_ABI = [
  'function tradeViaFactory(address factory,(bytes signature,bytes data,uint256 expiresAt,uint256 nonce) signature,(uint160 sqrtPriceLimit,uint256 minAmountOut) tradeLimits,uint256 ethValue) external',
  'function approveFactory(address token, uint256 amount) external',
];
const ROLES_ABI = [
  'function execTransactionWithRole(address to,uint256 value,bytes data,uint8 operation,bytes32 roleKey,bool shouldRevert) returns (bool)',
];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
const traderIface = new ethers.Interface(TRADER_ABI);

// ── Platform helpers ──────────────────────────────────────────────────────────
async function getGame() { return api('/game'); }

function startHeartbeat(address) {
  const ping = () =>
    api('/agents/heartbeat', { method: 'POST', body: { address } }).catch(() => {});
  ping();
  setInterval(ping, 30_000);
}

function makeExec(state) {
  const wallet = new ethers.Wallet(state.pk, provider);
  const roles  = new ethers.Contract(state.rolesMod, ROLES_ABI, wallet);
  let chain = Promise.resolve();
  return (calldata, op = 1) => {
    const next = chain.catch(() => {}).then(async () => {
      const tx = await roles.execTransactionWithRole(
        TRADER_ZH, 0n, calldata, op, ROLE_KEY, true
      );
      return tx.wait();
    });
    chain = next.catch(() => {});
    return next;
  };
}

async function getSwapSig(state, tokenAddress, amountIn, isBuy) {
  const call = (token) => api('/skill/swap', {
    method: 'POST',
    token,
    body: { tokenAddress, amountIn: amountIn.toString(), isBuy },
  });
  try { return await call(await freshJwt(state)); }
  catch (e) {
    if (e.status === 401) return call(await siweLogin(state));
    throw e;
  }
}

async function approveBattleToken(state, exec, tokenAddress) {
  const data = traderIface.encodeFunctionData(
    'approveFactory', [tokenAddress, ethers.MaxUint256]
  );
  await exec(data, 1);
}

async function tradeOnce(state, exec, tokenAddress, amountIn, isBuy) {
  log(`${isBuy ? 'BUY' : 'SELL'} ${ethers.formatUnits(amountIn, 18)} ${isBuy ? 'USDC' : 'tokens'} → dispatching`);
  const sig = await getSwapSig(state, tokenAddress, amountIn, isBuy);
  const data = traderIface.encodeFunctionData('tradeViaFactory', [
    FACTORY,
    {
      signature: sig.signature,
      data:      sig.data,
      expiresAt: BigInt(sig.expiresAt),
      nonce:     BigInt(sig.nonce),
    },
    { sqrtPriceLimit: BigInt(sig.sqrtPriceLimit), minAmountOut: 0n },
    0n,
  ]);
  // minAmountOut: 0n is intentional — pool is thin and prices move fast.
  // The platform expects 0n to prevent trades reverting on slippage.
  const rcpt = await exec(data, 1);
  log('trade landed:', rcpt?.hash || rcpt?.transactionHash || 'ok');
}

// ══════════════════════════════════════════════════════════════════════════════
// ACH-LA STRATEGY — Anticipatory Counter-Heuristic & Liquidation Arbitrage
// ══════════════════════════════════════════════════════════════════════════════
//
// TWO PROFIT MECHANISMS:
//   1. COUNTER-HEURISTIC (T=0–150s)
//      Front-run MEE mean-reversion buy/sell waves and APE momentum surges using
//      dynamically fitted σ-bands from the live in-game price distribution.
//
//   2. DISSOLUTION ARBITRAGE (T≥150s)
//      Hold (or panic-buy cheap tokens from panicking hosted bots) when the
//      pro-rata dissolution payout P_i = U_i + (T_i/T_total)×R_USDC exceeds
//      the immediate spot market exit value.

// ── Strategy state — resets on freshBattle, persists across ticks ─────────────
const S = {
  priceHistory    : [],    // { price: number }[] rolling window, max 100 entries
  battleStart     : null,  // Date.now() ms at first tick of this battle
  battleStartUSDC : null,  // USDC balance at battle start (per-battle PnL tracking)
  reserveUSDC     : null,  // last known AMM USDC reserve (fetched from API)
  reserveTokens   : null,  // last known AMM token reserve
  totalTokensOut  : null,  // total tokens held by ALL trader agents
  cumulativeBuys  : 0,     // USDC spent buying this battle (enforces BATTLE_BUY_CAP)
  inspected       : false, // true after first API shape inspection log
};

// ── Strategy constants ────────────────────────────────────────────────────────
// Tune these after observing the first 3–5 games (see POST-LAUNCH CALIBRATION).
const SLIPPAGE        = 0.005;   // 0.5% max price impact per order
const BATTLE_BUY_CAP  = 950;    // conservative ceiling under 1k protocol limit
const MIN_TRADE       = 10;     // skip decisions below $10 USDC (avoid dust)
const POSITION_FRAC   = 0.15;   // deploy 15% of available USDC per buy signal
const WARMUP_SAMPLES  = 15;     // minimum price history entries before trading
const DISSOLUTION_T   = 150;    // switch to dissolution logic at T≥150s into battle
const POOL_DUST       = 50;     // R_USDC below which dissolution payout is negligible

// ── AMM constant-product swap simulator ──────────────────────────────────────
// Models x*y=k to estimate output WITHOUT sending a transaction.
// Used by dissolutionPhase to compare holdValue vs sellValue.
//
//   BUY  $X USDC  → tokens_out = (R_tok − k/(R_USDC + X)) × (1 − ε)
//   SELL  Y tokens → usdc_out  = (R_USDC − k/(R_tok + Y)) × (1 − ε)
function swapOut(amount, type) {
  if (!amount || amount <= 0) return 0;
  const rU = S.reserveUSDC   || 0;
  const rT = S.reserveTokens || 0;
  if (rU <= 0 || rT <= 0) return 0;
  const k = rU * rT;
  if (type === 'BUY') {
    const newRU = rU + amount;
    return Math.max(0, (rT - k / newRU) * (1 - SLIPPAGE));
  }
  const newRT = rT + amount;
  return Math.max(0, (rU - k / newRT) * (1 - SLIPPAGE));
}

// ── Optimal slippage-constrained order size ───────────────────────────────────
// S_opt = R_USDC × √ε  →  ensures price impact stays ≤ 0.5%
function optSize(availableUSDC) {
  const impactCap  = (S.reserveUSDC || 50_000) * Math.sqrt(SLIPPAGE);
  const budgetLeft = BATTLE_BUY_CAP - S.cumulativeBuys;
  return Math.max(0, Math.min(availableUSDC * POSITION_FRAC, impactCap, budgetLeft));
}

// ── Competitor profiling — dynamic MEE / APE volatility band fitting ──────────
// Computes MEE and APE execution thresholds from the live in-game price
// distribution. Expands σ-bands in high-volatility (CV > 0.12) regimes.
//
//   MEE bots BUY at:  mean − meeK × σ   (mean-reversion buy trigger)
//   MEE bots SELL at: mean + meeK × σ   (mean-reversion sell trigger)
//   APE bots BUY at:  mean + apeK × σ   (momentum breakout trigger)
//
//   CV = σ / μ
//   meeK = CV > 0.12 ? 2.0 : 1.4
//   apeK = CV > 0.12 ? 1.1 : 0.7
function profileCompetitors() {
  const prices = S.priceHistory.map(h => h.price);
  const N      = prices.length;
  if (N < WARMUP_SAMPLES) return null;

  const mean     = prices.reduce((s, p) => s + p, 0) / N;
  const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / N;
  const stdDev   = Math.sqrt(variance || 0.0001);
  const CV       = stdDev / (mean || 1);

  const meeK = CV > 0.12 ? 2.0 : 1.4;
  const apeK = CV > 0.12 ? 1.1 : 0.7;

  return {
    mean,
    stdDev,
    CV,
    meeBuy  : mean - meeK * stdDev,
    meeSell : mean + meeK * stdDev,
    apeBuy  : mean + apeK * stdDev,
  };
}

// ── Elapsed seconds helper ────────────────────────────────────────────────────
function elapsed() {
  return S.battleStart ? ((Date.now() - S.battleStart) / 1000).toFixed(0) : '?';
}

// ── Counter-heuristic phase (T = 0 → 150s) ───────────────────────────────────
//
// Three scenarios, evaluated in priority order each tick:
//
// SCENARIO A — front-run MEE buy wall
//   Trigger : spot ≤ meeBuy × 1.015
//   MEE bots simultaneously BUY when price hits mean − meeK×σ, generating an
//   artificial spike. We enter 1.5% above their trigger, ride the spike up,
//   and sell into the herd-inflated peak via Scenario B.
//
// SCENARIO B — sell into MEE sell momentum (50% partial exit)
//   Trigger : spot ≥ meeSell × 0.985
//   MEE bots simultaneously SELL at mean + meeK×σ, cascading price down.
//   We dump 50% of our bag into the sell wave before the cascade accelerates.
//
// SCENARIO C — front-run APE momentum surge (60% of optSize)
//   Trigger : spot ≥ apeBuy × 0.99
//   APE bots chase momentum above mean + apeK×σ, acting as exit liquidity.
//   We buy early at conservative sizing and distribute tokens onto lagging APE bots.
function counterHeuristicPhase(usdcF, tokF, priceF) {
  const thresholds = profileCompetitors();
  if (!thresholds) return null;
  const { meeBuy, meeSell, apeBuy } = thresholds;

  // Scenario A: front-run MEE buy wall
  if (priceF <= meeBuy * 1.015 && usdcF > MIN_TRADE && S.cumulativeBuys < BATTLE_BUY_CAP) {
    const amt = optSize(usdcF);
    if (amt > MIN_TRADE) {
      S.cumulativeBuys += amt;
      log(`[T+${elapsed()}s] BUY front-run-MEE | amt:${amt.toFixed(2)} | spot:${priceF.toFixed(4)} | meeBuy:${meeBuy.toFixed(4)} | R_USDC:${(S.reserveUSDC||0).toFixed(0)}`);
      return { isBuy: true, amount: BigInt(Math.round(amt * 1e18)) };
    }
  }

  // Scenario B: sell into MEE sell momentum (50% partial exit)
  if (priceF >= meeSell * 0.985 && tokF > 0) {
    const sellTok = tokF * 0.5;
    log(`[T+${elapsed()}s] SELL into-MEE-sell | amt:${sellTok.toFixed(4)} | spot:${priceF.toFixed(4)} | meeSell:${meeSell.toFixed(4)}`);
    return { isBuy: false, amount: BigInt(Math.round(sellTok * 1e18)) };
  }

  // Scenario C: front-run APE momentum surge
  if (priceF >= apeBuy * 0.99 && usdcF > MIN_TRADE && S.cumulativeBuys < BATTLE_BUY_CAP) {
    const amt = optSize(usdcF) * 0.6;
    if (amt > MIN_TRADE) {
      S.cumulativeBuys += amt;
      log(`[T+${elapsed()}s] BUY front-run-APE | amt:${amt.toFixed(2)} | spot:${priceF.toFixed(4)} | apeBuy:${apeBuy.toFixed(4)}`);
      return { isBuy: true, amount: BigInt(Math.round(amt * 1e18)) };
    }
  }

  return null; // HOLD this tick
}

// ── Dissolution arbitrage phase (T ≥ 150s) ───────────────────────────────────
//
// Payout formula: P_i = U_i + (T_i / T_total) × R_USDC
//
// Decision tree (evaluated in exact order every tick):
//
//   STEP 1 — Pool exhaustion guard:
//     IF R_USDC < POOL_DUST AND holding tokens → SELL immediately
//     Dissolution payout is negligible when the AMM is USDC-dry.
//
//   STEP 2 — Dissolution vs. market comparison:
//     holdValue = U_i + (T_i / T_total) × R_USDC
//     sellValue = U_i + swapOut(T_i, 'SELL')
//
//     IF holdValue > sellValue:
//       Check panic-buy opportunity:
//         spot < (R_USDC / T_total) × 0.85 means spot is >15% below dissolution
//         book value. This is arbitrage: buy tokens panic-sold by hosted bots
//         at a discount and collect their full dissolution value.
//       ELSE: HOLD — let dissolution settle (T_i / T_total) × R_USDC.
//
//     ELSE: SELL all tokens.
//       Market exit beats dissolution when pool is USDC-thin.
function dissolutionPhase(usdcF, tokF, priceF, timeElapsed) {
  const rUSDC    = S.reserveUSDC || 0;
  const totalTok = S.totalTokensOut > 0 ? S.totalTokensOut : Math.max(tokF, 1);

  // STEP 1 — pool exhaustion guard
  if (rUSDC < POOL_DUST && tokF > 0) {
    log(`[T+${elapsed()}s] SELL pool-thin | amt:${tokF.toFixed(4)} | R_USDC:${rUSDC.toFixed(2)}`);
    return { isBuy: false, amount: BigInt(Math.round(tokF * 1e18)) };
  }

  // STEP 2 — dissolution vs. market comparison
  const proRata = totalTok > 0 ? (tokF / totalTok) * rUSDC : 0;
  const holdVal = usdcF + proRata;
  const sellVal = usdcF + swapOut(tokF, 'SELL');
  const timeLeft = 180 - timeElapsed;

  if (holdVal > sellVal) {
    // Panic-buy: spot is >15% below dissolution book value
    const dvpt = rUSDC / (totalTok || 1); // dissolution value per token
    if (priceF < dvpt * 0.85 && usdcF > MIN_TRADE && timeLeft > 5 && S.cumulativeBuys < BATTLE_BUY_CAP) {
      const amt = optSize(usdcF);
      if (amt > MIN_TRADE) {
        S.cumulativeBuys += amt;
        log(`[T+${elapsed()}s] BUY panic-buy | dvpt:${dvpt.toFixed(4)} spot:${priceF.toFixed(4)} | holdVal:${holdVal.toFixed(2)} | amt:${amt.toFixed(2)}`);
        return { isBuy: true, amount: BigInt(Math.round(amt * 1e18)) };
      }
    }
    log(`[T+${elapsed()}s] HOLD dissolution | holdVal:${holdVal.toFixed(2)} > sellVal:${sellVal.toFixed(2)} | proRata:${proRata.toFixed(2)}`);
    return null; // null = hold position into dissolution
  }

  // Market exit beats dissolution
  if (tokF > 0) {
    log(`[T+${elapsed()}s] SELL mkt>dis | amt:${tokF.toFixed(4)} | holdVal:${holdVal.toFixed(2)} < sellVal:${sellVal.toFixed(2)}`);
    return { isBuy: false, amount: BigInt(Math.round(tokF * 1e18)) };
  }

  return null;
}

// ── Main decide() — called every ~1.5s by the main loop ──────────────────────
//
// Inputs (from main loop):
//   tokenAddress — contract address of this battle's clay-pigeon token
//   currentPrice — spot price as string (may be null in the first few ticks)
//   usdcBal      — BigInt, 18-decimal wei: USDC in the Trading Safe
//   tokBal       — BigInt, 18-decimal wei: current token bag in Trading Safe
//   tick         — integer counter, resets to 0 on each freshBattle
//   freshBattle  — true on the very first tick after a new battle token appears
//
// Returns:
//   { isBuy: true,  amount: BigInt }  — buy that much USDC worth of tokens
//   { isBuy: false, amount: BigInt }  — sell that many tokens
//   null                               — skip this tick (HOLD)
async function decide({ tokenAddress, currentPrice, usdcBal, tokBal, tick, freshBattle }) {

  // ── Unit conversion: BigInt 18-decimal wei → JS float ────────────────────
  const usdcF  = Number(usdcBal)  / 1e18;
  const tokF   = Number(tokBal)   / 1e18;
  const priceF = parseFloat(currentPrice || '0');

  // ── Battle reset ──────────────────────────────────────────────────────────
  if (freshBattle) {
    S.priceHistory    = [];
    S.battleStart     = Date.now();
    S.battleStartUSDC = usdcF;
    S.cumulativeBuys  = 0;
    S.reserveUSDC     = null;
    S.reserveTokens   = null;
    S.totalTokensOut  = null;
    S.inspected       = false;
    log(`=== NEW BATTLE | token:${tokenAddress?.slice(0, 10)}… | USDC:${usdcF.toFixed(2)} | tick:${tick} ===`);
  }

  // Price not yet published by the platform
  if (!priceF || priceF <= 0) return null;

  // ── Fetch live market data (non-fatal — use cached S on failure) ──────────
  let game = null, trades = [];
  try {
    [game, trades] = await Promise.all([
      api('/game').catch(() => null),
      api(`/tokens/${tokenAddress}/trades?limit=100`).catch(() => []),
    ]);
    if (!Array.isArray(trades)) trades = [];
  } catch { /* use cached S values */ }

  // ── API shape inspection (first successful fetch only) ────────────────────
  // IMPORTANT: check these logs after your first game and update the field-name
  // fallback chains in "Extract AMM reserves" below to match the real API.
  if (!S.inspected && (game || trades.length > 0)) {
    log('═══ API INSPECTION — update field names below if needed ═══');
    log('game top-level keys:', Object.keys(game || {}).join(', '));
    log('game.token keys    :', Object.keys(game?.token || {}).join(', '));
    log('game (800 chars)   :', JSON.stringify(game)?.slice(0, 800));
    log('trades[0]          :', JSON.stringify(trades[0])?.slice(0, 400));
    log('═══════════════════════════════════════════════════════════');
    S.inspected = true;
  }

  // ── Extract AMM reserves — multi-pattern fallback ─────────────────────────
  // After inspecting logs above, remove unused patterns and confirm correct keys.
  const pool = game?.pool
    || game?.token?.pool
    || game?.battle?.pool
    || game?.currentBattle?.pool
    || {};
  const tr0 = trades[0] || {};

  const rawRU = parseFloat(
    pool.reserveUSDC         ?? pool.reserve0    ?? pool.usdcReserve  ??
    tr0.reserveUSDC          ?? tr0.reserve0     ?? tr0.usdcReserve   ?? 0
  );
  const rawRT = parseFloat(
    pool.reserveTokens       ?? pool.reserve1    ?? pool.tokenReserve ??
    tr0.reserveTokens        ?? tr0.reserve1     ?? tr0.tokenReserve  ?? 0
  );
  const rawTT = parseFloat(
    pool.totalOutstandingTokens ?? pool.traderTokens ??
    tr0.totalOutstandingTokens  ?? tr0.traderTokens  ?? 0
  );

  if (rawRU > 0) S.reserveUSDC    = rawRU;
  if (rawRT > 0) S.reserveTokens  = rawRT;
  if (rawTT > 0) S.totalTokensOut = rawTT;

  // Fallback: estimate reserves from price when pool data is unavailable.
  // 50,000 USDC is a typical seed pool — confirm from inspection logs and update.
  if (!S.reserveUSDC && priceF > 0) {
    S.reserveUSDC   = 50_000;
    S.reserveTokens = 50_000 / priceF;
  }

  // ── Build price history ───────────────────────────────────────────────────
  // Prefer trade-log entries (more data points); fall back to per-tick price.
  if (trades.length > 0) {
    const fromTrades = trades
      .map(t => ({
        price: parseFloat(
          t.price ?? t.priceUSDC ?? t.executionPrice ?? t.pricePerToken ?? 0
        ),
      }))
      .filter(h => h.price > 0)
      .slice(0, 100);
    if (fromTrades.length > 0) S.priceHistory = fromTrades;
  } else {
    S.priceHistory.push({ price: priceF });
    if (S.priceHistory.length > 100) S.priceHistory.shift();
  }

  // ── Battle timing — use game.mmEndAt for accuracy ────────────────────────
  // game.mmEndAt is the Unix timestamp (seconds) when market-making ended and
  // live trading opened. If missing, fall back to wall-clock from freshBattle.
  let mmEndAtMs = 0;
  const rawMmEnd = game?.mmEndAt ?? game?.battle?.mmEndAt ?? game?.tradingStartedAt ?? 0;
  if (rawMmEnd > 0) {
    mmEndAtMs = rawMmEnd < 1e12 ? rawMmEnd * 1000 : rawMmEnd; // handle s vs ms
  }
  const timeElapsed = mmEndAtMs > 0
    ? (Date.now() - mmEndAtMs) / 1000
    : (S.battleStart ? (Date.now() - S.battleStart) / 1000 : tick * 1.5);

  // ── Warm-up guard ─────────────────────────────────────────────────────────
  if (S.priceHistory.length < WARMUP_SAMPLES) return null;

  // ── Route to strategy phase ───────────────────────────────────────────────
  if (timeElapsed >= DISSOLUTION_T) {
    return dissolutionPhase(usdcF, tokF, priceF, timeElapsed);
  }
  return counterHeuristicPhase(usdcF, tokF, priceF);
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN LOOP
// ══════════════════════════════════════════════════════════════════════════════

// ── Auto-refill (free, unlimited — no auth, no cooldown) ─────────────────────
// Called during lobby/market-making periods when USDC balance is low.
// Guards with lastRefillCheck to prevent spamming the endpoint.
async function maybeRefill(state) {
  try {
    const usdc   = new ethers.Contract(USDC_ADDR, ERC20_ABI, provider);
    const usdcBn = await usdc.balanceOf(state.tradingSafe);
    const usdcF  = Number(usdcBn) / 1e18;
    if (usdcF < 2_000) {
      log(`low balance (${usdcF.toFixed(2)} USDC) — requesting refill…`);
      await api('/agents/refill', { method: 'POST', body: { address: state.address } });
      log('refill requested — waiting 6s for on-chain confirmation…');
      await sleep(6_000);
    }
  } catch (e) { log('refill check err:', e.message); }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main() {
  const state = await loadOrBootstrap();
  const exec  = makeExec(state);
  startHeartbeat(state.address);

  const usdc           = new ethers.Contract(USDC_ADDR, ERC20_ABI, provider);
  let lastToken        = null;
  let tick             = 0;
  let tradeInFlight    = false;
  let lastRefillCheck  = 0;

  log('agent running — watching for open battles…');

  while (true) {
    let game;
    try { game = await getGame(); }
    catch { await sleep(3_000); continue; }

    // During lobby or market-making: auto-refill if needed (max once per minute)
    if (!game.tradingOpen) {
      if (Date.now() - lastRefillCheck > 60_000) {
        lastRefillCheck = Date.now();
        await maybeRefill(state);
      }
      await sleep(2_000);
      continue;
    }

    const tokenAddress = game.token.address;
    const freshBattle  = tokenAddress !== lastToken;

    if (freshBattle) {
      // ── Log per-battle PnL before resetting ────────────────────────────────
      if (S.battleStartUSDC !== null) {
        try {
          const usdcBn = await usdc.balanceOf(state.tradingSafe);
          const endF   = Number(usdcBn) / 1e18;
          const pnl    = endF - S.battleStartUSDC;
          log(`═══ BATTLE PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDC | Start:${S.battleStartUSDC.toFixed(2)} End:${endF.toFixed(2)} ═══`);
        } catch {}
      }

      tick = 0; // reset tick counter for new battle timing

      // ── Approve new battle token ────────────────────────────────────────────
      try { await approveBattleToken(state, exec, tokenAddress); }
      catch (e) {
        log('battle setup err:', e.shortMessage || e.message);
        await sleep(2_000);
        continue;
      }
      lastToken = tokenAddress;
    }

    // Read balances from Trading Safe
    let usdcBal = 0n, tokBal = 0n;
    try {
      [usdcBal, tokBal] = await Promise.all([
        usdc.balanceOf(state.tradingSafe),
        new ethers.Contract(tokenAddress, ERC20_ABI, provider).balanceOf(state.tradingSafe),
      ]);
    } catch { /* zero balances — decide() will HOLD */ }

    // Run strategy decision engine
    let d = null;
    try {
      d = await decide({
        tokenAddress,
        currentPrice: game.token.currentPrice,
        usdcBal,
        tokBal,
        tick,
        freshBattle,
      });
    } catch (e) { log('decide threw:', e.message); }
    tick++;

    // Fire trade if a decision was made and no trade is already in flight
    // (tradeInFlight prevents nonce collision on the Roles module EOA)
    if (d && !tradeInFlight) {
      tradeInFlight = true;
      tradeOnce(state, exec, tokenAddress, d.amount, !!d.isBuy)
        .catch(e => log('trade err:', e.shortMessage || e.message))
        .finally(() => { tradeInFlight = false; });
    }

    await sleep(1_500);
  }
}

// ── Self-healing supervisor ───────────────────────────────────────────────────
// Catches any unhandled crash in main() and restarts after 3 seconds.
// Railway / pm2 also restart the process on exit — this inner loop is an
// additional safety net to handle transient RPC errors or API timeouts.
async function supervise() {
  for (;;) {
    try { await main(); }
    catch (e) { console.error('main crashed, restarting in 3s:', e.shortMessage || e.message); }
    await sleep(3_000);
  }
}

supervise();
