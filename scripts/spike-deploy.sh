#!/usr/bin/env bash
# Deploys the latency spike: Pinger (Base Sepolia) -> SpikeReactive (Lasna)
# -> SpikeCallback (Base Sepolia + Unichain Sepolia), then wires recipients.
# Requires PRIVATE_KEY in the environment. Writes addresses to deployments/spike.env.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/contracts"
# shellcheck disable=SC1091
set -a; source "$ROOT/.env.example"; set +a
: "${PRIVATE_KEY:?export PRIVATE_KEY first}"

# `forge create` (Foundry 1.10) hangs on these RPCs, so deploy raw initcode with `cast send --create`.
create() { # rpc contract value [ctor-sig args...]
  local rpc="$1" target="$2" value="$3"; shift 3
  local code
  code=$(forge inspect "$target" bytecode)
  if [ "$#" -gt 0 ]; then
    local sig="$1"; shift
    code="${code}$(cast abi-encode "$sig" "$@" | sed 's/^0x//')"
  fi
  cast send --rpc-url "$rpc" --private-key "$PRIVATE_KEY" --value "$value" --json --create "$code" \
    | python3 -I -c 'import json,sys; r=json.load(sys.stdin); assert r["status"]=="0x1", r; print(r["contractAddress"])'
}

# Reuse an existing Pinger when PINGER is already exported.
PINGER=${PINGER:-$(create "$BASE_SEPOLIA_RPC" src/spike/Pinger.sol:Pinger 0)}
echo "Pinger (Base Sepolia):          $PINGER"

REACTIVE=$(create "$LASNA_RPC" src/spike/SpikeReactive.sol:SpikeReactive 5ether "constructor(uint256,address)" 84532 "$PINGER")
echo "SpikeReactive (Lasna):          $REACTIVE"

CB_BASE=$(create "$BASE_SEPOLIA_RPC" src/spike/SpikeCallback.sol:SpikeCallback 0.01ether "constructor(address,address)" "$BASE_SEPOLIA_CALLBACK_PROXY" "$REACTIVE")
echo "SpikeCallback (Base Sepolia):   $CB_BASE"

CB_UNI=$(create "$UNICHAIN_SEPOLIA_RPC" src/spike/SpikeCallback.sol:SpikeCallback 0.01ether "constructor(address,address)" "$UNICHAIN_SEPOLIA_CALLBACK_PROXY" "$REACTIVE")
echo "SpikeCallback (Unichain Sep.):  $CB_UNI"

cast send "$REACTIVE" "setRecipients(uint256,address,uint256,address)" 84532 "$CB_BASE" 1301 "$CB_UNI" \
  --rpc-url "$LASNA_RPC" --private-key "$PRIVATE_KEY" >/dev/null
echo "Recipients wired."

mkdir -p "$ROOT/deployments"
cat > "$ROOT/deployments/spike.env" <<EOF
PINGER=$PINGER
SPIKE_REACTIVE=$REACTIVE
SPIKE_CB_BASE=$CB_BASE
SPIKE_CB_UNICHAIN=$CB_UNI
EOF
echo "Saved deployments/spike.env"
