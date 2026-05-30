# BID Protocol — ACH-LA Agent

Anticipatory Counter-Heuristic & Liquidation Arbitrage trading agent for the
[DoraHacks "Beat the House" hackathon](https://dorahacks.io) on BID Protocol.

## Strategy

**Core edge**: All hosted bots (MEE / APE / ZIP / CHE / 818) exit token positions
before T=180 and cannot collect the dissolution term `(T_i / T_total) × R_USDC`.

**Two profit mechanisms:**
1. **Counter-heuristic (T = 0–150s)** — Front-run MEE mean-reversion buy/sell walls
   and APE momentum surges using dynamically fitted σ-bands from live price data.
2. **Dissolution arbitrage (T ≥ 150s)** — Hold (or panic-buy cheap tokens from
   panicking hosted bots) whenever the pro-rata dissolution payout exceeds the
   immediate spot market exit value.

---

## Quick start — local

```bash
# 1. Install dependencies
npm install

# 2. First run — provide your dashboard JWT (login at alpha.creator.bid)
USER_JWT=<your-jwt> node agent.js

# 3. Copy the AGENT_STATE=... line printed after registration
#    You will need this for Railway deployment.
```

---

## Railway deployment

### One-time setup

1. Push this repo to GitHub.
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
3. Select your `bid-agent` repository.
4. Railway will detect Node.js automatically via `Procfile`.
5. Go to **Service → Variables** and add:

| Variable | Value |
|----------|-------|
| `AGENT_STATE` | The full `AGENT_STATE=<base64>` value from Step 3 of local setup |

6. Click **Deploy**. Done.

### Re-deploys

Every `git push origin main` triggers an automatic Railway redeploy. The agent
reloads `.agent.json` from `AGENT_STATE` on startup — no re-registration needed.

---

## Monitoring

**Railway logs**: Service → Deployments → View Logs

**VPS / local with pm2**:
```bash
npm install -g pm2
pm2 start "node agent.js" --name bid-agent --restart-delay 3000
pm2 logs bid-agent --lines 50
pm2 monit                   # real-time resource dashboard
```

---

## Manual refill

The agent auto-refills when balance drops below 2,000 USDC. To trigger manually:

```bash
./scripts/refill.sh <TRADING_SAFE_ADDRESS>
```

Or directly:

```bash
curl -X POST https://alpha.creator.bid/api/agents/refill \
  -H "Content-Type: application/json" \
  -d '{"address":"<TRADING_SAFE_ADDRESS>"}'
```

---

## Post-launch calibration (do after first 3–5 games)

Check the `API INSPECTION` block in your logs. It prints the raw `/api/game` and
`/api/tokens/:address/trades` response shapes. After seeing real field names:

1. **Update AMM reserve field names** in the `rawRU / rawRT / rawTT` extraction
   block inside `decide()` — remove unused fallback patterns.
2. **Confirm seed pool size** — update the `50_000` fallback if the real initial
   `reserveUSDC` is different.
3. **Confirm `mmEndAt` field name** — if timeElapsed still falls back to wall-clock,
   the field may be named differently (e.g. `tradingOpenedAt`, `mmClosedAt`).

---

## Environment variables

| Variable | When required | Description |
|----------|---------------|-------------|
| `AGENT_STATE` | Railway | base64-encoded `.agent.json` from first local registration |
| `USER_JWT` | First local run only | Dashboard JWT for agent registration |
| `ARCHETYPE` | Never (optional) | Strategy label shown on leaderboard. Default: `Custom` |

---

## Mathematical reference

### Dissolution payout
```
P_i = U_i + (T_i / T_total) × R_USDC
```

### Optimal order size (≤ 0.5% price impact)
```
S_opt = R_USDC × √0.005
```

### AMM constant-product — BUY $X USDC
```
k          = R_USDC × R_tokens
tokens_out = (R_tokens − k / (R_USDC + X)) × (1 − 0.005)
```

### AMM constant-product — SELL Y tokens
```
k       = R_USDC × R_tokens
usdc_out = (R_USDC − k / (R_tokens + Y)) × (1 − 0.005)
```

### Competitor band fitting
```
CV     = σ / μ
meeK   = CV > 0.12 ? 2.0 : 1.4
apeK   = CV > 0.12 ? 1.1 : 0.7

MEE_buy  = μ − meeK × σ
MEE_sell = μ + meeK × σ
APE_buy  = μ + apeK × σ
```

### Dissolution vs. market decision
```
holdValue = U_i + (T_i / T_total) × R_USDC
sellValue = U_i + swapOut(T_i, 'SELL')

IF holdValue > sellValue:
  IF spot < (R_USDC / T_total) × 0.85 AND timeLeft > 5s → BUY (panic-buy arb)
  ELSE → HOLD (ride dissolution)
ELSE → SELL all tokens (market exit wins)
```
