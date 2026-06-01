import fs from 'fs';
import { ethers } from 'ethers';

// ── CONFIG ────────────────────────────────────────────────────────────────────
const API_BASE = 'https://alpha.creator.bid/api';
const RPC = 'http://5.161.35.78:8545';
const FACTORY = '0xE841bCA5A85C76FA667a968C4fe817Ffa2E220e7';
const USDC_ADDR = '0xed38c197b319fdc067f4c3fb58eec1a733a36cf4';
const TRADER_ZH = '0x521FAcaAB630E30614617c9ae5f6508cB4213540';
const ROLE_KEY = '0xfacaf2747a7486cf5730e9265973fb54447d3ace6e7e4711f6360826b0731941';
const ARCHETYPE = process.env.ARCHETYPE || 'Custom';
const STATE_FILE = '.agent.json';

const provider = new ethers.JsonRpcProvider(RPC, 42069, { staticNetwork: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// ── Railway hydration ─────────────────────────────────────────────────────────
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
  catch { /* non-fatal on Railway ephemeral FS */ }
}

// ── Load or register ──────────────────────────────────────────────────────────
async function loadOrBootstrap() {
  if (fs.existsSync(STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    log(`loaded state — Trading Safe: ${state.tradingSafe}`);
    return state;
  }

  let USER_JWT = process.env.USER_JWT;
  if (!USER_JWT) throw new Error('First run: set USER_JWT=<dashboard-jwt> before starting.');

  // Auto-exchange access code (no dots) → session JWT
  if (!USER_JWT.includes('.')) {
    log('USER_JWT looks like an access code — exchanging for session JWT…');
    const r = await api('/auth/login', { method: 'POST', body: { code: USER_JWT } });
    if (!r.token) throw new Error('access-code login failed: ' + JSON.stringify(r));
    USER_JWT = r.token;
    log('session JWT obtained');
  }

  const w = ethers.Wallet.createRandom();
  log('registering new EOA:', w.address);

  const body = await api('/agents/register', {
    method: 'POST',
    token: USER_JWT,
    body: { name: 'achla-' + w.address.slice(2, 10), address: w.address, archetype: ARCHETYPE },
  });

  if (!body.trading_safe) throw new Error('registration failed: ' + JSON.stringify(body));

  const state = {
    name: body.name,
    pk: w.privateKey,
    address: w.address,
    agentJwt: body.token,
    tradingSafe: body.trading_safe,
    treasurySafe: body.treasury_safe || '',
    rolesMod: body.roles_modifier,
  };

  save(state);
  log(`registered "${state.name}" — Trading Safe: ${state.tradingSafe}`);

  const b64 = Buffer.from(JSON.stringify(state, null, 2)).toString('base64');
  console.log('\n' + '═'.repeat(68));
  console.log('RAILWAY ENV VAR — copy this into Railway service variables:');
  console.log('═'.repeat(68));
  console.log(`AGENT_STATE=${b64}`);
  console.log('═'.repeat(68) + '\n');

  // Poll until airdrop lands (up to 45s)
  log('waiting for funding airdrop…');
  const usdcCheck = new ethers.Contract(USDC_ADDR, ERC20_ABI, provider);
  for (let i = 0; i < 15; i++) {
    await sleep(3_000);
    try {
      const bal = Number(await usdcCheck.balanceOf(state.tradingSafe)) / 1e18;
      if (bal > 0) { log(`funded — Safe USDC: ${bal.toFixed(2)}`); break; }
    } catch { }
    log(`  airdrop pending… (${(i + 1) * 3}s)`);
  }
  return state;
}

// ── JWT refresh ───────────────────────────────────────────────────────────────
function jwtExp(t) {
  try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString()).exp || 0; }
  catch { return 0; }
}

async function siweLogin(state) {
  const wallet = new ethers.Wallet(state.pk, provider);
  const { message } = await api('/auth/nonce', { method: 'POST', body: { address: wallet.address } });
  const signature = await wallet.signMessage(message);
  const { token } = await api('/auth/login', { method: 'POST', body: { address: wallet.address, signature } });
  state.agentJwt = token;
  save(state);
  log('JWT refreshed via SIWE');
  return token;
}

async function freshJwt(state) {
  if (!state.agentJwt || jwtExp(state.agentJwt) - Math.floor(Date.now() / 1000) < 600)
    await siweLogin(state);
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
  const ping = () => api('/agents/heartbeat', { method: 'POST', body: { address } }).catch(() => { });
  ping();
  setInterval(ping, 30_000);
}

function makeExec(state) {
  const wallet = new ethers.Wallet(state.pk, provider);
  const roles = new ethers.Contract(state.rolesMod, ROLES_ABI, wallet);
  let chain = Promise.resolve();
  return (calldata, op = 1) => {
    const next = chain.catch(() => { }).then(async () => {
      const tx = await roles.execTransactionWithRole(TRADER_ZH, 0n, calldata, op, ROLE_KEY, true);
      return tx.wait();
    });
    chain = next.catch(() => { });
    return next;
  };
}

// Confirmed endpoint from live logs: game.endpoints.swapSignature
async function getSwapSig(state, tokenAddress, amountIn, isBuy) {
  const call = (token) => api(`/tokens/${tokenAddress}/swap/signature`, {
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

async function tradeOnce(state, exec, tokenAddress, amountIn, isBuy) {
  log(`${isBuy ? 'BUY' : 'SELL'} ${ethers.formatUnits(amountIn, 18)} ${isBuy ? 'USDC' : 'tokens'} → dispatching`);
  const res = await getSwapSig(state, tokenAddress, amountIn, isBuy);
  const inner = res.signature; // confirmed structure from live run

  const txData = traderIface.encodeFunctionData('tradeViaFactory', [
    FACTORY,
    { signature: inner.signature, data: inner.data, expiresAt: BigInt(inner.expiresAt), nonce: BigInt(inner.nonce) },
    { sqrtPriceLimit: BigInt(res.sqrtPriceLimit), minAmountOut: 0n },
    0n,
  ]);

  const rcpt = await exec(txData, 1);
  log('trade landed:', rcpt?.hash || rcpt?.transactionHash || 'ok');
  return rcpt;
}

async function approveBattleToken(state, exec, tokenAddress) {
  const data = traderIface.encodeFunctionData('approveFactory', [tokenAddress, ethers.MaxUint256]);
  await exec(data, 1);
}

// Confirmed working: get real AMM reserves from ERC20 balanceOf on pool address
// game.token.pool is a plain string address (verified from live logs)
async function getPoolReserves(poolAddress, tokenAddress) {
  try {
    const [rU, rT] = await Promise.all([
      new ethers.Contract(USDC_ADDR, ERC20_ABI, provider).balanceOf(poolAddress),
      new ethers.Contract(tokenAddress, ERC20_ABI, provider).balanceOf(poolAddress),
    ]);
    return { reserveUSDC: Number(rU) / 1e18, reserveTokens: Number(rT) / 1e18 };
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════════════════════
// ACH-LA v2 — Buy-Hold-Dissolve (BHD) Strategy
// ══════════════════════════════════════════════════════════════════════════════
//
// LIVE DATA FINDINGS (2026-05-31, confirmed):
//   - SELL operations ALWAYS REVERT (Roles module only permits BUY via factory)
//   - Profit mechanism: BUY tokens early → HOLD through dissolution → collect
//     (T_i / T_total) × R_USDC, where R_USDC is amplified by all other agents
//     selling their tokens back to the pool before T=180
//   - Shadow (#1 CUSTOM, consistent 18%+ returns) uses exactly this approach
//   - One battle demonstrated: 100 USDC → 1000 USDC (+900 USDC, 9x return)
//
// ARCHITECTURE (3 phases, no SELL):
//
//   PHASE 1 — EARLY ENTRY (T = 0–30s, fires once)
//     Buy 80% of available USDC immediately. No price condition needed.
//     This is the primary dissolution position. One fill.
//
//   PHASE 2 — DIP BUYING (T = 30–120s, max 3 additional fills)
//     Only if price is at or below the MEE bot buy threshold.
//     Front-run the MEE bot herd: buy just before they pile in at mean − k×σ.
//     Each MEE buy uses 25% of remaining budget.
//     Stop buying after MAX_FILLS_PER_BATTLE total fills.
//
//   PHASE 3 — DISSOLUTION (T = 150–180s, no new buys except deep-discount arb)
//     Always HOLD. Never attempt SELL (confirmed reverts).
//     Exception: panic-buy if spot < dvpt × 0.65 (>35% below dissolution value)
//     AND time remaining > 10s AND budget remains.
//     This amplifies dissolution payout by buying tokens other agents dump at panic prices.

// ── Strategy state ────────────────────────────────────────────────────────────
const S = {
  priceHistory: [],    // { price }[] — rolling price window
  battleStart: null,  // Date.now() ms at battle open
  battleStartUSDC: null,  // USDC at battle start for PnL log
  reserveUSDC: null,  // current pool USDC reserve (from balanceOf)
  reserveTokens: null,  // current pool token reserve
  totalTokensOut: null,  // estimated tokens held by all agents
  cumulativeBuys: 0,     // total USDC spent buying this battle
  fills: 0,     // number of confirmed (non-reverted) fills this battle
  entryMade: false, // true once Phase 1 early-entry has fired
  lastReserveMs: 0,     // ms timestamp of last pool reserve fetch
  lastTradeMs: 0,     // ms timestamp of last dispatched trade (for cooldown)
  inspected: false,
};

// ── Constants ─────────────────────────────────────────────────────────────────
const SLIPPAGE = 0.005;  // 0.5% max price impact
const BATTLE_BUY_CAP = 950;   // per-battle buy cap (BUY-IN/GAME=1000, use 950 for safety)
const MIN_TRADE = 5;     // minimum order size in USDC
const EARLY_ENTRY_FRAC = 0.80;  // Phase 1: buy 80% of available USDC
const DIP_FRAC = 0.25;  // Phase 2: buy 25% of remaining budget per dip
const PANIC_FRAC = 0.50;  // Phase 3 panic-buy: 50% of remaining USDC
const WARMUP_SAMPLES = 5;     // price samples needed before MEE/APE bands activate
const EARLY_ENTRY_T = 30;    // seconds into battle for Phase 1 window
const DIP_BUYING_END_T = 120;   // Phase 2 ends at T=120s; go quiet before dissolution
const DISSOLUTION_T = 150;   // Phase 3 starts at T=150s
const POOL_DUST = 50;    // R_USDC below which dissolution payout ≈ 0
const PANIC_BUY_THRESH = 0.65;  // buy in dissolution when spot < dvpt × 0.65
const MAX_FILLS = 6;     // stop buying after 6 fills per battle (mimic Shadow)
const RESERVE_CACHE_MS = 10_000; // re-fetch pool reserves at most every 10s
const TRADE_COOLDOWN_MS = 2_500;  // minimum gap between dispatched trades (reduces stale-sig reverts)
const MEE_K_HIGH = 1.5;   // MEE band multiplier — high-vol regime (CV > 0.12)
const MEE_K_LOW = 1.0;   // MEE band multiplier — low-vol regime
const REFILL_BELOW = 20;    // USDC threshold to trigger auto-refill

// ── AMM constant-product swap simulator ──────────────────────────────────────
// Only used for dissolution hold vs sell comparison (never actually sells).
function swapOut(amount, type) {
  if (!amount || amount <= 0) return 0;
  const rU = S.reserveUSDC || 0;
  const rT = S.reserveTokens || 0;
  if (rU <= 0 || rT <= 0) return 0;
  const k = rU * rT;
  if (type === 'BUY') return Math.max(0, (rT - k / (rU + amount)) * (1 - SLIPPAGE));
  return Math.max(0, (rU - k / (rT + amount)) * (1 - SLIPPAGE));
}

// ── Order size — slippage-constrained ────────────────────────────────────────
// S_opt = R_USDC × √ε  →  price impact ≤ 0.5%
// Caps to (a) the fraction of effective capital and (b) remaining battle budget.
// Replace optSize with this:
function optSize(availableUSDC, frac) {
  const budgetLeft = BATTLE_BUY_CAP - S.cumulativeBuys;
  return Math.max(0, Math.min(availableUSDC * frac, budgetLeft));
}

// ── Competitor profiling — MEE threshold fitting ──────────────────────────────
// Derives the MEE bot buy trigger from the live price distribution.
// MEE bots BUY at: mean − meeK × σ   ("buy the dip" threshold)
// meeK = CV > 0.12 ? 1.5 : 1.0  (tighter than v1; triggers fire closer to mean)
// NOTE: Scenario C (APE front-run) removed because:
//   (a) APE trigger fires when spot is ABOVE mean — we'd be buying at peaks
//   (b) We cannot sell into APE momentum (SELL operations revert)
//   (c) Front-running only helps if we can exit into the surge
function profileMEE() {
  const prices = S.priceHistory.map(h => h.price);
  const N = prices.length;
  if (N < WARMUP_SAMPLES) return null;

  const mean = prices.reduce((s, p) => s + p, 0) / N;
  const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / N;
  const stdDev = Math.sqrt(variance || 0.0001);
  const CV = stdDev / (mean || 1);
  const meeK = CV > 0.12 ? MEE_K_HIGH : MEE_K_LOW;

  return { mean, stdDev, CV, meeBuy: mean - meeK * stdDev };
}

// ── Elapsed seconds helper ────────────────────────────────────────────────────
function elapsed() {
  return S.battleStart ? ((Date.now() - S.battleStart) / 1000).toFixed(0) : '?';
}

// ── PHASE 1 & 2: counter-heuristic BUY phases ────────────────────────────────
function buyPhase(usdcF, tokF, priceF, timeElapsed) {

  // ── PHASE 1: GUARANTEED EARLY ENTRY (T = 0–30s) ──────────────────────────
  // Buy 80% of available USDC as soon as trading opens.
  // Shadow's winning pattern: buy early, hold into dissolution.
  // No price condition — any price is acceptable at T=0 because:
  //   (a) Pool price at battle open is the "fair" starting price
  //   (b) Every sell by other agents increases our proRata payout
  //   (c) The earlier we buy, the larger our token position for dissolution
  if (timeElapsed < EARLY_ENTRY_T && !S.entryMade && usdcF > MIN_TRADE) {
    const amt = optSize(usdcF, EARLY_ENTRY_FRAC);
    if (amt > MIN_TRADE) {
      S.cumulativeBuys += amt;
      S.entryMade = true;
      log(`[T+${elapsed()}s] BUY early-entry | amt:${amt.toFixed(2)} USDC | spot:${priceF.toFixed(4)} | R_USDC:${(S.reserveUSDC || 0).toFixed(0)}`);
      return { isBuy: true, amount: BigInt(Math.round(amt * 1e18)) };
    }
  }

  // Enforce fills cap and DIP_BUYING_END_T cutoff
  if (S.fills >= MAX_FILLS) return null;
  if (timeElapsed >= DIP_BUYING_END_T) return null;

  // ── PHASE 2: DIP BUYING — front-run MEE buy wall (T = 30–120s) ───────────
  // MEE bots trigger a simultaneous buy when spot hits mean − k×σ.
  // We buy 1.5% ABOVE their trigger to enter before the MEE herd.
  // The herd creates a brief upward spike — we hold through it (we don't sell).
  // This gives us a better average cost for our final token position.
  // Only fires if we've already made the early entry (entryMade ensures Phase 1 went first).
  if (!S.entryMade) return null; // never skip Phase 1
  const mee = profileMEE();
  if (!mee) return null;

  const { meeBuy, mean, CV } = mee;

  if (priceF <= meeBuy * 1.015 && usdcF > MIN_TRADE && S.cumulativeBuys < BATTLE_BUY_CAP) {
    // Remaining budget after early entry for dip buys
    const remaining = BATTLE_BUY_CAP - S.cumulativeBuys;
    const amt = Math.min(usdcF * DIP_FRAC, remaining, optSize(usdcF, DIP_FRAC));
    if (amt > MIN_TRADE) {
      S.cumulativeBuys += amt;
      log(`[T+${elapsed()}s] BUY dip-MEE | amt:${amt.toFixed(2)} | spot:${priceF.toFixed(4)} | meeBuy:${meeBuy.toFixed(4)} | CV:${CV.toFixed(3)} | R_USDC:${(S.reserveUSDC || 0).toFixed(0)}`);
      return { isBuy: true, amount: BigInt(Math.round(amt * 1e18)) };
    }
  }

  return null;
}

// ── PHASE 3: DISSOLUTION (T ≥ 150s) ─────────────────────────────────────────
// Core logic: P_i = U_i + (T_i / T_total) × R_USDC
//
// CONFIRMED from live run: SELL operations ALWAYS REVERT on the Roles module.
// This function NEVER returns a SELL signal.
//
// The dissolution payout works in our favour because:
//   1. All hosted bots sell before T=180, returning USDC to the pool (↑ R_USDC)
//   2. Their sells reduce T_total (↑ our share T_i/T_total)
//   3. Both effects AMPLIFY our proRata payout
//
// Example from live battle: 100 USDC → 1000 USDC via dissolution proRata of 462 USDC
function dissolutionPhase(usdcF, tokF, priceF, timeElapsed) {
  const rUSDC = S.reserveUSDC || 0;
  const totalTok = S.totalTokensOut > 0 ? S.totalTokensOut : Math.max(tokF, 1);

  // Pool exhaustion edge case (rarely happens but guard it)
  // Note: even here we do NOT sell — just log and do nothing
  if (rUSDC < POOL_DUST) {
    log(`[T+${elapsed()}s] pool-thin R_USDC:${rUSDC.toFixed(2)} — hold (SELL not permitted)`);
    return null;
  }

  // Compute hold value vs theoretical sell value (for logging only — we cannot sell)
  const proRata = totalTok > 0 ? (tokF / totalTok) * rUSDC : 0;
  const holdVal = usdcF + proRata;
  const sellVal = usdcF + swapOut(tokF, 'SELL'); // informational only
  const timeLeft = 180 - timeElapsed;
  const dvpt = rUSDC / (totalTok || 1); // dissolution value per token

  // ── PANIC-BUY: spot is >35% below dissolution book value ─────────────────
  // When spot < dvpt × 0.65, tokens are deeply mispriced vs their dissolution value.
  // Other agents are selling in panic — we buy their tokens and collect
  // the full dissolution value at T=180.
  // Tighter threshold (0.65 vs 0.85 in v1) to reduce noise — only fire on real arb.
  // Require timeLeft > 10s so the tx has time to land before dissolution.
  if (priceF < dvpt * PANIC_BUY_THRESH &&
    usdcF > MIN_TRADE &&
    timeLeft > 10 &&
    S.fills < MAX_FILLS &&
    S.cumulativeBuys < BATTLE_BUY_CAP) {
    const discount = ((dvpt - priceF) / dvpt * 100).toFixed(1);
    const amt = optSize(usdcF, PANIC_FRAC);
    if (amt > MIN_TRADE) {
      S.cumulativeBuys += amt;
      log(`[T+${elapsed()}s] BUY panic-arb | spot:${priceF.toFixed(4)} dvpt:${dvpt.toFixed(4)} discount:${discount}% | holdVal:${holdVal.toFixed(2)} | amt:${amt.toFixed(2)}`);
      return { isBuy: true, amount: BigInt(Math.round(amt * 1e18)) };
    }
  }

  // Default: HOLD (this is always the right choice — SELL reverts anyway)
  log(`[T+${elapsed()}s] HOLD dissolution | holdVal:${holdVal.toFixed(2)} sellVal:${sellVal.toFixed(2)} | proRata:${proRata.toFixed(2)} | dvpt:${dvpt.toFixed(4)} | ${timeLeft.toFixed(0)}s left`);
  return null;
}

// ── Main decide() — called every ~1.5s ───────────────────────────────────────
async function decide({ tokenAddress, currentPrice, usdcBal, tokBal, tick, freshBattle, gameRem }) {

  const usdcF = Number(usdcBal) / 1e18;
  const tokF = Number(tokBal) / 1e18;
  const priceF = parseFloat(currentPrice || '0');

  if (freshBattle) {
    S.priceHistory = [];
    S.battleStart = Date.now();
    S.battleStartUSDC = usdcF;
    S.cumulativeBuys = 0;
    S.fills = 0;
    S.entryMade = false;
    S.reserveUSDC = null;
    S.reserveTokens = null;
    S.totalTokensOut = null;
    S.lastReserveMs = 0;
    S.lastTradeMs = 0;
    S.inspected = false;
    log(`=== NEW BATTLE | token:${tokenAddress?.slice(0, 10)}… | USDC:${usdcF.toFixed(2)} | tick:${tick} ===`);
  }

  if (!priceF || priceF <= 0) return null;

  // Fetch live game + trade data
  let game = null, trades = [];
  try {
    [game, trades] = await Promise.all([
      api('/game').catch(() => null),
      api(`/tokens/${tokenAddress}/trades?limit=100`).catch(() => []),
    ]);
    if (!Array.isArray(trades)) trades = [];
  } catch { }

  if (!S.inspected && (game || trades.length > 0)) {
    log('═══ API INSPECTION ═══');
    log('game keys      :', Object.keys(game || {}).join(', '));
    log('game.token keys:', Object.keys(game?.token || {}).join(', '));
    log('game (800 chars):', JSON.stringify(game)?.slice(0, 800));
    log('trades[0]      :', JSON.stringify(trades[0])?.slice(0, 400));
    log('══════════════════════');
    S.inspected = true;
  }

  // ── Pool reserves (ERC20 balanceOf — confirmed working approach) ──────────
  // Cache for RESERVE_CACHE_MS to reduce RPC load.
  const poolAddress = game?.token?.pool;
  if (poolAddress && typeof poolAddress === 'string' &&
    Date.now() - S.lastReserveMs > RESERVE_CACHE_MS) {
    const res = await getPoolReserves(poolAddress, tokenAddress);
    if (res && res.reserveUSDC > 0) {
      S.reserveUSDC = res.reserveUSDC;
      S.reserveTokens = res.reserveTokens;
      // Estimate total tokens outside pool = pool token reserve is what's IN the pool;
      // total supply - reserveTokens = what agents hold (approximation).
      // If we can't get supply, use a conservative multiple of our bag.
      S.lastReserveMs = Date.now();
    }
  }
  if (!S.reserveUSDC && priceF > 0) {
    S.reserveUSDC = 50_000; // generous fallback for early battle ticks
    S.reserveTokens = 50_000 / priceF;
  }

  // ── Total tokens outstanding (estimate from trade volume) ─────────────────
  // A better proxy than totalSupply: sum amount_out of all BUY trades.
  // When agents buy tokens, amount_out represents tokens leaving the pool.
  // This tracks how many tokens are held by all agents combined.
  if (trades.length > 0) {
    let netOut = 0n;
    for (const t of trades) {
      try {
        if (t.is_buy === 1) netOut += BigInt(t.amount_out || 0);
        else netOut -= BigInt(t.amount_in || 0);
      } catch { }
    }
    const netF = Number(netOut) / 1e18;
    if (netF > 0) S.totalTokensOut = netF;
  }

  // ── Price history from confirmed "price" field ────────────────────────────
  if (trades.length > 0) {
    const fromTrades = trades
      .map(t => ({ price: parseFloat(t.price || 0) }))
      .filter(h => h.price > 0)
      .slice(0, 100);
    if (fromTrades.length > 0) S.priceHistory = fromTrades;
  } else {
    S.priceHistory.push({ price: priceF });
    if (S.priceHistory.length > 100) S.priceHistory.shift();
  }

  // ── Accurate timing from game.gameRemaining ───────────────────────────────
  // gameRemaining = seconds left in TRADING phase (confirmed in game JSON).
  // timeElapsed = 180 - gameRemaining  (direct, no mmEndAt math needed)
  const gameRemaining = gameRem ?? game?.gameRemaining ?? null;
  const timeElapsed = gameRemaining !== null
    ? Math.max(0, 180 - gameRemaining)
    : (S.battleStart ? (Date.now() - S.battleStart) / 1000 : tick * 1.5);

  // ── Cooldown: don't signal if last trade was < TRADE_COOLDOWN_MS ago ──────
  // Reduces stale-signature reverts. The previous trade's signature is used up
  // (nonce advances); give the chain time to settle before trying again.
  if (Date.now() - S.lastTradeMs < TRADE_COOLDOWN_MS) return null;

  // ── Route to strategy phase ───────────────────────────────────────────────
  if (timeElapsed >= DISSOLUTION_T) {
    return dissolutionPhase(usdcF, tokF, priceF, timeElapsed);
  }
  return buyPhase(usdcF, tokF, priceF, timeElapsed);
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN LOOP
// ══════════════════════════════════════════════════════════════════════════════

// Refill requires JWT auth — confirmed from live 401 error.
// Threshold lowered to 20 USDC — testnet balance is ~100 USDC max per allocation.
async function maybeRefill(state) {
  try {
    const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, provider);
    const usdcBn = await usdc.balanceOf(state.tradingSafe);
    const usdcF = Number(usdcBn) / 1e18;
    if (usdcF < REFILL_BELOW) {
      log(`low balance (${usdcF.toFixed(2)} USDC) — requesting refill…`);
      await api('/agents/refill', {
        method: 'POST',
        token: await freshJwt(state),
        body: { address: state.tradingSafe },
      });
      log('refill requested — waiting 6s for on-chain confirmation…');
      await sleep(6_000);
    }
  } catch (e) { log('refill check err:', e.message); }
}

async function main() {
  const state = await loadOrBootstrap();
  const exec = makeExec(state);
  startHeartbeat(state.address);

  const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, provider);
  let lastToken = null;
  let tick = 0;
  let tradeInFlight = false;
  let lastRefillCheck = 0;

  log('agent running (v2 BHD) — watching for open battles…');

  while (true) {
    let game;
    try { game = await getGame(); }
    catch { await sleep(3_000); continue; }

    // During lobby/market-making: auto-refill once per minute
    if (!game.tradingOpen) {
      if (Date.now() - lastRefillCheck > 60_000) {
        lastRefillCheck = Date.now();
        await maybeRefill(state);
      }
      await sleep(2_000);
      continue;
    }

    const tokenAddress = game.token.address;
    const freshBattle = tokenAddress !== lastToken;

    if (freshBattle) {
      // Log PnL for the completed battle
      if (S.battleStartUSDC !== null) {
        try {
          const usdcBn = await usdc.balanceOf(state.tradingSafe);
          const endF = Number(usdcBn) / 1e18;
          const pnl = endF - S.battleStartUSDC;
          log(`═══ BATTLE PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDC | Start:${S.battleStartUSDC.toFixed(2)} End:${endF.toFixed(2)} | fills:${S.fills} ═══`);
        } catch { }
      }

      tick = 0;

      try { await approveBattleToken(state, exec, tokenAddress); }
      catch (e) {
        log('battle setup err:', e.shortMessage || e.message);
        await sleep(2_000);
        continue;
      }
      lastToken = tokenAddress;
    }

    let usdcBal = 0n, tokBal = 0n;
    try {
      [usdcBal, tokBal] = await Promise.all([
        usdc.balanceOf(state.tradingSafe),
        new ethers.Contract(tokenAddress, ERC20_ABI, provider).balanceOf(state.tradingSafe),
      ]);
    } catch { }

    let d = null;
    try {
      d = await decide({
        tokenAddress,
        currentPrice: game.token.currentPrice,
        usdcBal,
        tokBal,
        tick,
        freshBattle,
        gameRem: game.gameRemaining,  // direct seconds remaining — most accurate timing
      });
    } catch (e) { log('decide threw:', e.message); }
    tick++;

    if (d && !tradeInFlight) {
      tradeInFlight = true;
      S.lastTradeMs = Date.now();  // start cooldown timer
      tradeOnce(state, exec, tokenAddress, d.amount, !!d.isBuy)
        .then(() => { S.fills++; })  // increment fills on success only
        .catch(e => log('trade err:', e.shortMessage || e.message))
        .finally(() => { tradeInFlight = false; });
    }

    await sleep(1_500);
  }
}

async function supervise() {
  for (; ;) {
    try { await main(); }
    catch (e) { console.error('main crashed, restarting in 3s:', e.shortMessage || e.message); }
    await sleep(3_000);
  }
}

supervise();