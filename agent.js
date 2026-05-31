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

// ── Railway: hydrate .agent.json from AGENT_STATE env var ────────────────────
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

// ── Load state or register (first run) ───────────────────────────────────────
// Supports both raw access code (no dots) and proper dashboard JWT as USER_JWT.
async function loadOrBootstrap() {
  if (fs.existsSync(STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    log(`loaded state — Trading Safe: ${state.tradingSafe}`);
    return state;
  }

  let USER_JWT = process.env.USER_JWT;
  if (!USER_JWT) {
    throw new Error(
      'First run: set USER_JWT=<your-dashboard-jwt-or-access-code> before starting.\n' +
      'Log in at https://alpha.creator.bid with your access code, then copy the JWT.'
    );
  }

  // Auto-exchange: access code (no dots) → session JWT
  if (!USER_JWT.includes('.')) {
    log('USER_JWT looks like an access code — exchanging for session JWT…');
    const loginRes = await api('/auth/login', { method: 'POST', body: { code: USER_JWT } });
    if (!loginRes.token) throw new Error('access-code login failed: ' + JSON.stringify(loginRes));
    USER_JWT = loginRes.token;
    log('session JWT obtained successfully');
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
  console.log('RAILWAY ENV VAR — copy exactly this line into your Railway service:');
  console.log('═'.repeat(68));
  console.log(`AGENT_STATE=${b64}`);
  console.log('═'.repeat(68) + '\n');

  // Poll until airdrop lands (max 45s)
  log('waiting for funding airdrop to confirm on-chain…');
  const usdcCheck = new ethers.Contract(USDC_ADDR, ERC20_ABI, provider);
  for (let i = 0; i < 15; i++) {
    await sleep(3_000);
    try {
      const bal = Number(await usdcCheck.balanceOf(state.tradingSafe)) / 1e18;
      if (bal > 0) { log(`funding confirmed — Trading Safe USDC: ${bal.toFixed(2)}`); break; }
    } catch { }
    log(`  airdrop pending… (${(i + 1) * 3}s elapsed)`);
  }

  return state;
}

// ── JWT refresh via SIWE ──────────────────────────────────────────────────────
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
    api('/agents/heartbeat', { method: 'POST', body: { address } }).catch(() => { });
  ping();
  setInterval(ping, 30_000);
}

function makeExec(state) {
  const wallet = new ethers.Wallet(state.pk, provider);
  const roles = new ethers.Contract(state.rolesMod, ROLES_ABI, wallet);
  let chain = Promise.resolve();
  return (calldata, op = 1) => {
    const next = chain.catch(() => { }).then(async () => {
      const tx = await roles.execTransactionWithRole(
        TRADER_ZH, 0n, calldata, op, ROLE_KEY, true
      );
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

  // Confirmed response structure: { signature: {signature,data,expiresAt,nonce}, sqrtPriceLimit }
  const inner = res.signature;

  const txData = traderIface.encodeFunctionData('tradeViaFactory', [
    FACTORY,
    {
      signature: inner.signature,
      data: inner.data,
      expiresAt: BigInt(inner.expiresAt),
      nonce: BigInt(inner.nonce),
    },
    { sqrtPriceLimit: BigInt(res.sqrtPriceLimit), minAmountOut: 0n },
    0n,
  ]);

  const rcpt = await exec(txData, 1);
  log('trade landed:', rcpt?.hash || rcpt?.transactionHash || 'ok');
}

async function approveBattleToken(state, exec, tokenAddress) {
  const data = traderIface.encodeFunctionData('approveFactory', [tokenAddress, ethers.MaxUint256]);
  await exec(data, 1);
}


// Query actual AMM reserves from on-chain ERC20 balances.
// game.token.pool is a plain string address (confirmed from live logs).
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
// ACH-LA STRATEGY — Anticipatory Counter-Heuristic & Liquidation Arbitrage
// ══════════════════════════════════════════════════════════════════════════════
//
// LIVE LOG FINDINGS (2026-05-31):
//   - Testnet balance is ~100 USDC (not 100k as spec suggested)
//   - Prior strategy bands (2σ/1.4σ) were too wide — zero triggers in 2 full battles
//   - Shadow (#1 CUSTOM, 176 USDC winnings) achieves this with only 5 fills
//   - Proof: BUY early → HOLD tokens → collect (T_i/T_total) × R_USDC at dissolution
//   - All hosted bots exit before T=180 → they collect ZERO from the pool term
//
// STRATEGY (4 scenarios, evaluated in priority order each tick):
//   A. Front-run MEE buy wall  (T < 150s, price ≤ meeBuy × 1.015)
//   B. Sell into MEE sell momentum (T < 150s, price ≥ meeSell × 0.985, partial exit)
//   C. Front-run APE momentum surge (T < 150s, price ≥ apeBuy × 0.99)
//   D. GUARANTEED EARLY ENTRY — buy regardless of price conditions if no position
//      held within first 20s. This is the core dissolution edge — forces entry
//      so the agent always participates in the (T_i/T_total) × R_USDC pool term.
//   E. Dissolution panic-buy arb (T ≥ 150s, spot < dissolution book value × 0.85)

// ── Strategy state ────────────────────────────────────────────────────────────
const S = {
  priceHistory: [],
  battleStart: null,
  battleStartUSDC: null,
  reserveUSDC: null,
  reserveTokens: null,
  totalTokensOut: null,
  cumulativeBuys: 0,
  inspected: false,
  entryMade: false, // tracks whether Scenario D early-entry has fired this battle
};

// ── Strategy constants ────────────────────────────────────────────────────────
// TUNED from live data (2026-05-31):
//   - WARMUP_SAMPLES reduced 15→5: fewer samples needed, faster entry
//   - meeK reduced 2.0/1.4→1.5/1.0: tighter bands, triggers fire closer to mean
//   - apeK reduced 1.1/0.7→0.8/0.5: same reasoning
//   - REFILL_THRESHOLD reduced 2000→20: testnet max balance is ~100 USDC
//   - EARLY_ENTRY_T added: guaranteed entry window (seconds after mm phase)
const SLIPPAGE = 0.005;   // 0.5% max price impact per order
const BATTLE_BUY_CAP = 90_000;  // conservative ceiling under 100k protocol limit
const MIN_TRADE = 5;       // reduced from 10 — allows trades with 100 USDC balance
const POSITION_FRAC = 0.70;    // deploy 70% of USDC on early entry (maximise dissolution)
const WARMUP_SAMPLES = 5;       // reduced from 15 — need fewer samples to compute bands
const DISSOLUTION_T = 150;     // switch to dissolution logic at T≥150s
const POOL_DUST = 50;      // R_USDC below which dissolution payout is negligible
const EARLY_ENTRY_T = 20;      // guaranteed buy window: 0–20s from trading open
const MEE_K_HIGH = 1.5;     // reduced from 2.0 — tighter high-vol MEE band
const MEE_K_LOW = 1.0;     // reduced from 1.4 — tighter low-vol MEE band
const APE_K_HIGH = 0.8;     // reduced from 1.1
const APE_K_LOW = 0.5;     // reduced from 0.7

// ── AMM constant-product swap simulator ──────────────────────────────────────
function swapOut(amount, type) {
  if (!amount || amount <= 0) return 0;
  const rU = S.reserveUSDC || 0;
  const rT = S.reserveTokens || 0;
  if (rU <= 0 || rT <= 0) return 0;
  const k = rU * rT;
  if (type === 'BUY') {
    return Math.max(0, (rT - k / (rU + amount)) * (1 - SLIPPAGE));
  }
  return Math.max(0, (rU - k / (rT + amount)) * (1 - SLIPPAGE));
}

// ── Optimal slippage-constrained order size ───────────────────────────────────
function optSize(availableUSDC, frac = POSITION_FRAC) {
  const impactCap = (S.reserveUSDC || 50_000) * Math.sqrt(SLIPPAGE);
  const budgetLeft = BATTLE_BUY_CAP - S.cumulativeBuys;
  return Math.max(0, Math.min(availableUSDC * frac, impactCap, budgetLeft));
}

// ── Competitor profiling — dynamic MEE / APE volatility band fitting ──────────
function profileCompetitors() {
  const prices = S.priceHistory.map(h => h.price);
  const N = prices.length;
  if (N < WARMUP_SAMPLES) return null;

  const mean = prices.reduce((s, p) => s + p, 0) / N;
  const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / N;
  const stdDev = Math.sqrt(variance || 0.0001);
  const CV = stdDev / (mean || 1);

  // TUNED: reduced multipliers so bands sit closer to the mean.
  // Old: meeK = CV>0.12 ? 2.0 : 1.4  — bands too wide, zero triggers in live data.
  // New: meeK = CV>0.12 ? 1.5 : 1.0  — triggers fire closer to current price.
  const meeK = CV > 0.12 ? MEE_K_HIGH : MEE_K_LOW;
  const apeK = CV > 0.12 ? APE_K_HIGH : APE_K_LOW;

  return {
    mean, stdDev, CV,
    meeBuy: mean - meeK * stdDev,
    meeSell: mean + meeK * stdDev,
    apeBuy: mean + apeK * stdDev,
  };
}

// ── Elapsed seconds ───────────────────────────────────────────────────────────
function elapsed() {
  return S.battleStart ? ((Date.now() - S.battleStart) / 1000).toFixed(0) : '?';
}

// ── Counter-heuristic phase (T = 0 → 150s) ───────────────────────────────────
function counterHeuristicPhase(usdcF, tokF, priceF, timeElapsed) {

  // ── SCENARIO D — GUARANTEED EARLY ENTRY ────────────────────────────────────
  // The single most important fix from live data analysis.
  // Shadow (#1 CUSTOM) wins with 5 fills by holding tokens into dissolution.
  // Hosted bots (MEE/APE/ZIP/CHE/818) ALL sell before T=180.
  // We must hold tokens to collect (T_i / T_total) × R_USDC.
  // If no position has been entered within the first EARLY_ENTRY_T seconds,
  // buy 70% of our USDC at market price — no price condition required.
  if (timeElapsed < EARLY_ENTRY_T && !S.entryMade && tokF === 0 && usdcF > MIN_TRADE) {
    const amt = optSize(usdcF, 0.70); // 70% of bankroll into tokens
    if (amt > MIN_TRADE) {
      S.cumulativeBuys += amt;
      S.entryMade = true;
      log(`[T+${elapsed()}s] BUY early-entry | amt:${amt.toFixed(2)} | spot:${priceF.toFixed(4)} | dissolution-hold strategy`);
      return { isBuy: true, amount: BigInt(Math.round(amt * 1e18)) };
    }
  }

  // Need price history for Scenarios A/B/C
  const thresholds = profileCompetitors();
  if (!thresholds) return null;
  const { meeBuy, meeSell, apeBuy, mean, stdDev } = thresholds;

  // ── SCENARIO A — front-run MEE buy wall ───────────────────────────────────
  if (priceF <= meeBuy * 1.015 && usdcF > MIN_TRADE && S.cumulativeBuys < BATTLE_BUY_CAP) {
    const amt = optSize(usdcF, 0.30); // 30% sizing for tactical buys
    if (amt > MIN_TRADE) {
      S.cumulativeBuys += amt;
      log(`[T+${elapsed()}s] BUY front-run-MEE | amt:${amt.toFixed(2)} | spot:${priceF.toFixed(4)} | meeBuy:${meeBuy.toFixed(4)} | R_USDC:${(S.reserveUSDC || 0).toFixed(0)}`);
      return { isBuy: true, amount: BigInt(Math.round(amt * 1e18)) };
    }
  }

  // ── SCENARIO B — sell into MEE sell momentum (50% partial exit) ───────────
  // Only sell if we have meaningful tokens AND we entered early (have a position worth protecting)
  if (priceF >= meeSell * 0.985 && tokF > 0) {
    const sellTok = tokF * 0.5;
    log(`[T+${elapsed()}s] SELL into-MEE-sell | amt:${sellTok.toFixed(4)} | spot:${priceF.toFixed(4)} | meeSell:${meeSell.toFixed(4)}`);
    return { isBuy: false, amount: BigInt(Math.round(sellTok * 1e18)) };
  }

  // ── SCENARIO C — front-run APE momentum surge ─────────────────────────────
  if (priceF >= apeBuy * 0.99 && usdcF > MIN_TRADE && S.cumulativeBuys < BATTLE_BUY_CAP) {
    const amt = optSize(usdcF, 0.30) * 0.6;
    if (amt > MIN_TRADE) {
      S.cumulativeBuys += amt;
      log(`[T+${elapsed()}s] BUY front-run-APE | amt:${amt.toFixed(2)} | spot:${priceF.toFixed(4)} | apeBuy:${apeBuy.toFixed(4)}`);
      return { isBuy: true, amount: BigInt(Math.round(amt * 1e18)) };
    }
  }

  return null;
}

// ── Dissolution arbitrage phase (T ≥ 150s) ───────────────────────────────────
function dissolutionPhase(usdcF, tokF, priceF, timeElapsed) {
  const rUSDC = S.reserveUSDC || 0;
  const totalTok = S.totalTokensOut > 0 ? S.totalTokensOut : Math.max(tokF, 1);

  // Pool exhaustion guard
  if (rUSDC < POOL_DUST && tokF > 0) {
    log(`[T+${elapsed()}s] SELL pool-thin | amt:${tokF.toFixed(4)} | R_USDC:${rUSDC.toFixed(2)}`);
    return { isBuy: false, amount: BigInt(Math.round(tokF * 1e18)) };
  }

  const proRata = totalTok > 0 ? (tokF / totalTok) * rUSDC : 0;
  const holdVal = usdcF + proRata;
  const sellVal = usdcF + swapOut(tokF, 'SELL');
  const timeLeft = 180 - timeElapsed;

  if (holdVal > sellVal) {
    // Panic-buy: spot is >15% below dissolution book value
    const dvpt = rUSDC / (totalTok || 1);
    if (priceF < dvpt * 0.85 && usdcF > MIN_TRADE && timeLeft > 5 && S.cumulativeBuys < BATTLE_BUY_CAP) {
      const amt = optSize(usdcF, 0.50);
      if (amt > MIN_TRADE) {
        S.cumulativeBuys += amt;
        log(`[T+${elapsed()}s] BUY panic-buy | dvpt:${dvpt.toFixed(4)} spot:${priceF.toFixed(4)} | holdVal:${holdVal.toFixed(2)} | amt:${amt.toFixed(2)}`);
        return { isBuy: true, amount: BigInt(Math.round(amt * 1e18)) };
      }
    }
    log(`[T+${elapsed()}s] HOLD dissolution | holdVal:${holdVal.toFixed(2)} > sellVal:${sellVal.toFixed(2)} | proRata:${proRata.toFixed(2)}`);
    return null;
  }

  if (tokF > 0) {
    log(`[T+${elapsed()}s] SELL mkt>dis | amt:${tokF.toFixed(4)} | holdVal:${holdVal.toFixed(2)} < sellVal:${sellVal.toFixed(2)}`);
    return { isBuy: false, amount: BigInt(Math.round(tokF * 1e18)) };
  }

  return null;
}

// ── Main decide() ─────────────────────────────────────────────────────────────
async function decide({ tokenAddress, currentPrice, usdcBal, tokBal, tick, freshBattle }) {
  const usdcF = Number(usdcBal) / 1e18;
  const tokF = Number(tokBal) / 1e18;
  const priceF = parseFloat(currentPrice || '0');

  if (freshBattle) {
    S.priceHistory = [];
    S.battleStart = Date.now();
    S.battleStartUSDC = usdcF;
    S.cumulativeBuys = 0;
    S.reserveUSDC = null;
    S.reserveTokens = null;
    S.totalTokensOut = null;
    S.inspected = false;
    S.entryMade = false; // reset entry flag for new battle
    log(`=== NEW BATTLE | token:${tokenAddress?.slice(0, 10)}… | USDC:${usdcF.toFixed(2)} | tick:${tick} ===`);
  }

  if (!priceF || priceF <= 0) return null;

  // Fetch live market data
  let game = null, trades = [];
  try {
    [game, trades] = await Promise.all([
      api('/game').catch(() => null),
      api(`/tokens/${tokenAddress}/trades?limit=100`).catch(() => []),
    ]);
    if (!Array.isArray(trades)) trades = [];
  } catch { }

  // API shape inspection (once per battle)
  if (!S.inspected && (game || trades.length > 0)) {
    log('═══ API INSPECTION ═══');
    log('game top-level keys:', Object.keys(game || {}).join(', '));
    log('game.token keys    :', Object.keys(game?.token || {}).join(', '));
    log('game (800 chars)   :', JSON.stringify(game)?.slice(0, 800));
    log('trades[0]          :', JSON.stringify(trades[0])?.slice(0, 400));
    log('═══════════════════════════════════════════════════════════');
    S.inspected = true;
  }

  // Query real AMM reserves from on-chain balances
  // game.token.pool is a string address — confirmed from live logs
  const poolAddress = game?.token?.pool;
  if (poolAddress && typeof poolAddress === 'string') {
    const res = await getPoolReserves(poolAddress, tokenAddress);
    if (res && res.reserveUSDC > 0) {
      S.reserveUSDC = res.reserveUSDC;
      S.reserveTokens = res.reserveTokens;
    }
  }

  // Fallback reserve estimate when on-chain query fails
  if (!S.reserveUSDC && priceF > 0) {
    S.reserveUSDC = 50_000;
    S.reserveTokens = 50_000 / priceF;
  }

  // Build price history from confirmed "price" field in trade objects
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

  // Accurate battle timing from confirmed game.mmEndAt field
  let mmEndAtMs = 0;
  const rawMmEnd = game?.mmEndAt ?? game?.battle?.mmEndAt ?? game?.tradingStartedAt ?? 0;
  if (rawMmEnd > 0) {
    mmEndAtMs = rawMmEnd < 1e12 ? rawMmEnd * 1000 : rawMmEnd;
  }
  const timeElapsed = mmEndAtMs > 0
    ? (Date.now() - mmEndAtMs) / 1000
    : (S.battleStart ? (Date.now() - S.battleStart) / 1000 : tick * 1.5);

  // Route to strategy phase (no warmup guard for early-entry — Scenario D needs to fire fast)
  if (timeElapsed >= DISSOLUTION_T) {
    return dissolutionPhase(usdcF, tokF, priceF, timeElapsed);
  }
  return counterHeuristicPhase(usdcF, tokF, priceF, timeElapsed);
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN LOOP
// ══════════════════════════════════════════════════════════════════════════════

// TUNED: threshold lowered from 2000 to 20.
// Live data shows testnet balance cap is ~100 USDC, not 100k.
// Refilling when balance > 20 USDC was firing constantly (100 < 2000).
async function maybeRefill(state) {
  try {
    const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, provider);
    const usdcBn = await usdc.balanceOf(state.tradingSafe);
    const usdcF = Number(usdcBn) / 1e18;
    if (usdcF < 20) {
      log(`low balance (${usdcF.toFixed(2)} USDC) — requesting refill…`);
      await api('/agents/refill', {
        method: 'POST',
        token: await freshJwt(state),       // JWT auth required (confirmed from live 401)
        body: { address: state.tradingSafe }, // tradingSafe holds the USDC
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

  log('agent running — watching for open battles…');

  while (true) {
    let game;
    try { game = await getGame(); }
    catch { await sleep(3_000); continue; }

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
      if (S.battleStartUSDC !== null) {
        try {
          const usdcBn = await usdc.balanceOf(state.tradingSafe);
          const endF = Number(usdcBn) / 1e18;
          const pnl = endF - S.battleStartUSDC;
          log(`═══ BATTLE PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDC | Start:${S.battleStartUSDC.toFixed(2)} End:${endF.toFixed(2)} ═══`);
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
      });
    } catch (e) { log('decide threw:', e.message); }
    tick++;

    if (d && !tradeInFlight) {
      tradeInFlight = true;
      tradeOnce(state, exec, tokenAddress, d.amount, !!d.isBuy)
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