#!/usr/bin/env bash
# Manual refill script — tops up USDC and ETH on the agent's Trading Safe.
# Usage: ./scripts/refill.sh <TRADING_SAFE_ADDRESS>
# Or:    TRADING_SAFE=0x... ./scripts/refill.sh

set -euo pipefail

ADDRESS="${TRADING_SAFE:-${1:-}}"

if [ -z "$ADDRESS" ]; then
  echo "Usage: ./scripts/refill.sh <trading-safe-address>"
  echo "  or set TRADING_SAFE env var"
  exit 1
fi

echo "Requesting refill for ${ADDRESS}…"
curl -s -X POST https://alpha.creator.bid/api/agents/refill \
  -H "Content-Type: application/json" \
  -d "{\"address\":\"${ADDRESS}\"}" | jq . 2>/dev/null || echo "(raw response above)"

echo ""
echo "Done. Wait ~10s for on-chain confirmation before checking balance."
