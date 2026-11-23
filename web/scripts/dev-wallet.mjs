#!/usr/bin/env node
// Local test wallet for exercising the dashboard's wallet flows without a browser extension.
//
// The private key stays in this Node process. The page only gets a thin `window.ethereum`
// shim (dev-wallet-inject.js) that forwards EIP-1193 requests here over HTTP.
// Testnet use only; listens on 127.0.0.1 and only answers the dashboard's origin.
//
//   PRIVATE_KEY=0x... node scripts/dev-wallet.mjs   [PORT=8549 ORIGIN=http://localhost:3311]
import http from "node:http";
import { createPublicClient, createWalletClient, http as httpTransport, hexToBigInt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, unichainSepolia } from "viem/chains";

const PORT = Number(process.env.PORT ?? 8549);
const ORIGIN = process.env.ORIGIN ?? "http://localhost:3311";
const key = process.env.PRIVATE_KEY;
if (!key) {
  console.error("export PRIVATE_KEY first");
  process.exit(1);
}
const account = privateKeyToAccount(key);

const lasna = {
  id: 5318007,
  name: "Reactive Lasna",
  nativeCurrency: { name: "lREACT", symbol: "lREACT", decimals: 18 },
  rpcUrls: { default: { http: ["https://lasna-rpc.rnk.dev"] } },
};
const CHAINS = {
  [baseSepolia.id]: { chain: baseSepolia, rpc: "https://base-sepolia-rpc.publicnode.com" },
  [unichainSepolia.id]: { chain: unichainSepolia, rpc: "https://unichain-sepolia-rpc.publicnode.com" },
  [lasna.id]: { chain: lasna, rpc: "https://lasna-rpc.rnk.dev" },
};
let chainId = baseSepolia.id;

function clients() {
  const { chain, rpc } = CHAINS[chainId];
  const transport = httpTransport(rpc, { timeout: 10_000, retryCount: 2 });
  return {
    wallet: createWalletClient({ account, chain, transport }),
    public: createPublicClient({ chain, transport }),
  };
}

const rpcError = (code, message) => Object.assign(new Error(message), { code });

async function handle(method, params = []) {
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts":
      return [account.address];
    case "eth_chainId":
      return `0x${chainId.toString(16)}`;
    case "net_version":
      return String(chainId);
    case "wallet_switchEthereumChain": {
      const id = Number(params[0]?.chainId);
      if (!CHAINS[id]) throw rpcError(4902, `Unrecognized chain ${id}`);
      chainId = id;
      console.log(`switch -> ${id}`);
      return null;
    }
    case "wallet_addEthereumChain":
      throw rpcError(4200, "dev wallet only knows Base Sepolia, Unichain Sepolia and Lasna");
    case "eth_sendTransaction": {
      const tx = params[0] ?? {};
      if (tx.from && tx.from.toLowerCase() !== account.address.toLowerCase())
        throw rpcError(4100, "from is not the dev wallet account");
      const { wallet } = clients();
      const hash = await wallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value ? hexToBigInt(tx.value) : undefined,
        gas: tx.gas ? hexToBigInt(tx.gas) : undefined,
      });
      console.log(`sent chain=${chainId} to=${tx.to} hash=${hash}`);
      return hash;
    }
    case "personal_sign":
    case "eth_sign":
    case "eth_signTypedData_v4":
      throw rpcError(4200, `${method} not supported by dev wallet`);
    default:
      // Read-only calls go to the current chain's RPC.
      return clients().public.request({ method, params });
  }
}

http
  .createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", ORIGIN);
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (req.method !== "POST" || req.headers.origin !== ORIGIN) return res.writeHead(403).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    let id = null;
    try {
      const msg = JSON.parse(body);
      id = msg.id ?? null;
      const result = await handle(msg.method, msg.params);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id, result }));
    } catch (err) {
      const error = { code: err.code ?? -32603, message: err.shortMessage ?? err.message };
      console.log(`error ${error.code}: ${error.message}`);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id, error }));
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`dev wallet ${account.address} on http://127.0.0.1:${PORT} for ${ORIGIN}`));
