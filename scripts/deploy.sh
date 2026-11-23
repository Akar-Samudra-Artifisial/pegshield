#!/usr/bin/env bash
# Deploys PegShield to testnets and seeds demo state.
#   Base Sepolia:     MockStable (mSTB), MockUSD (mUSD), MockPair, PegKeeper
#   Lasna:            DepegSentinel (subscribes to the pair's Sync)
#   Unichain Sepolia: MockUSD (mUSD), PolicyVault
# Order matters: pair -> sentinel (needs pair) -> keeper/vault (need sentinel) -> setDestinations.
# Requires PRIVATE_KEY in the environment. Writes addresses to deployments/testnet.env.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/contracts"
# shellcheck disable=SC1091
set -a; source "$ROOT/.env.example"; set +a
: "${PRIVATE_KEY:?export PRIVATE_KEY first}"

BASE_ID=84532
UNI_ID=1301
SENTINEL_FUNDS=${SENTINEL_FUNDS:-10ether}   # lREACT
CALLBACK_FUNDS=${CALLBACK_FUNDS:-0.02ether} # native ETH per callback contract
ME=$(cast wallet address --private-key "$PRIVATE_KEY")

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

tx() { # rpc to sig [args...]
  local rpc="$1"; shift
  local out
  out=$(cast send --rpc-url "$rpc" --private-key "$PRIVATE_KEY" --json "$@")
  # Public RPCs sometimes answer without a receipt; fail loudly instead of retrying,
  # because a retry could double-apply a mint that was actually mined.
  if ! printf '%s' "$out" | python3 -I -c 'import json,sys; r=json.load(sys.stdin); sys.exit(r.get("status")!="0x1")'; then
    echo "tx failed or receipt missing: $* -> $out" >&2
    return 1
  fi
}

MAX=0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff

# --- Base Sepolia: pool ---------------------------------------------------------------
STABLE=$(create "$BASE_SEPOLIA_RPC" src/mocks/MockToken.sol:MockToken 0 "constructor(string,string)" "Mock Stable" "mSTB")
echo "MockStable (Base):   $STABLE"
USD_BASE=$(create "$BASE_SEPOLIA_RPC" src/mocks/MockToken.sol:MockToken 0 "constructor(string,string)" "Mock USD" "mUSD")
echo "MockUSD (Base):      $USD_BASE"
PAIR=$(create "$BASE_SEPOLIA_RPC" src/mocks/MockPair.sol:MockPair 0 "constructor(address,address)" "$STABLE" "$USD_BASE")
echo "MockPair (Base):     $PAIR"

# --- Lasna: sentinel ------------------------------------------------------------------
# watch 0.97, recover 0.99, 3 confirmations, keeper cooldown 1 block, max 3 rounds/epoch
SENTINEL=$(create "$LASNA_RPC" src/DepegSentinel.sol:DepegSentinel "$SENTINEL_FUNDS" \
  "constructor(uint256,address,bool,uint256,uint256,uint256,uint256,uint256)" \
  "$BASE_ID" "$PAIR" true 9700 9900 3 1 3)
echo "DepegSentinel (Lasna): $SENTINEL"

# --- Base Sepolia: keeper -------------------------------------------------------------
KEEPER=$(create "$BASE_SEPOLIA_RPC" src/PegKeeper.sol:PegKeeper "$CALLBACK_FUNDS" \
  "constructor(address,address,address,bool,uint256)" \
  "$BASE_SEPOLIA_CALLBACK_PROXY" "$SENTINEL" "$PAIR" true 50000ether)
echo "PegKeeper (Base):    $KEEPER"
# One-click depeg drill for the dashboard (testnet only)
DRILL=$(create "$BASE_SEPOLIA_RPC" src/mocks/DepegDrill.sol:DepegDrill 0 \
  "constructor(address,address)" "$PAIR" "$STABLE")
echo "DepegDrill (Base):   $DRILL"

# --- Unichain Sepolia: vault ----------------------------------------------------------
USD_UNI=$(create "$UNICHAIN_SEPOLIA_RPC" src/mocks/MockToken.sol:MockToken 0 "constructor(string,string)" "Mock USD" "mUSD")
echo "MockUSD (Unichain):  $USD_UNI"
# 2% premium, 7-day term, no warmup (demo)
VAULT=$(create "$UNICHAIN_SEPOLIA_RPC" src/PolicyVault.sol:PolicyVault "$CALLBACK_FUNDS" \
  "constructor(address,address,address,uint256,uint256,uint256)" \
  "$UNICHAIN_SEPOLIA_CALLBACK_PROXY" "$SENTINEL" "$USD_UNI" 200 604800 0)
echo "PolicyVault (Unichain): $VAULT"

# --- Wire ----------------------------------------------------------------------------
tx "$LASNA_RPC" "$SENTINEL" "setDestinations(uint256,address,uint256,address)" "$UNI_ID" "$VAULT" "$BASE_ID" "$KEEPER"
echo "Sentinel destinations set."

# --- Seed demo state ------------------------------------------------------------------
# Pool 100k/100k, keeper treasury 100k mUSD, deployer holds 50k mSTB to simulate a dump.
tx "$BASE_SEPOLIA_RPC" "$STABLE" "mint(address,uint256)" "$ME" 150000ether
tx "$BASE_SEPOLIA_RPC" "$USD_BASE" "mint(address,uint256)" "$ME" 100000ether
tx "$BASE_SEPOLIA_RPC" "$USD_BASE" "mint(address,uint256)" "$KEEPER" 100000ether
tx "$BASE_SEPOLIA_RPC" "$STABLE" "approve(address,uint256)" "$PAIR" "$MAX"
tx "$BASE_SEPOLIA_RPC" "$USD_BASE" "approve(address,uint256)" "$PAIR" "$MAX"
tx "$BASE_SEPOLIA_RPC" "$PAIR" "addLiquidity(uint256,uint256)" 100000ether 100000ether
echo "Base pool seeded."

# Vault: 50k underwriter capital, one 10k-coverage policy for the deployer.
tx "$UNICHAIN_SEPOLIA_RPC" "$USD_UNI" "mint(address,uint256)" "$ME" 60000ether
tx "$UNICHAIN_SEPOLIA_RPC" "$USD_UNI" "approve(address,uint256)" "$VAULT" "$MAX"
tx "$UNICHAIN_SEPOLIA_RPC" "$VAULT" "deposit(uint256)" 50000ether
tx "$UNICHAIN_SEPOLIA_RPC" "$VAULT" "buyPolicy(uint256)" 10000ether
echo "Vault seeded."

mkdir -p "$ROOT/deployments"
cat > "$ROOT/deployments/testnet.env" <<EOF
MOCK_STABLE_BASE=$STABLE
MOCK_USD_BASE=$USD_BASE
MOCK_PAIR_BASE=$PAIR
PEG_KEEPER_BASE=$KEEPER
DEPEG_SENTINEL_LASNA=$SENTINEL
MOCK_USD_UNICHAIN=$USD_UNI
POLICY_VAULT_UNICHAIN=$VAULT
DEPEG_DRILL_BASE=$DRILL
EOF
echo "Saved deployments/testnet.env"
