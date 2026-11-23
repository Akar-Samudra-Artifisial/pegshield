import {
  type Address,
  BaseError,
  type EIP1193Provider,
  type WalletClient,
  createWalletClient,
  custom,
  numberToHex,
} from "viem";
import { LANES, type LaneId } from "./config";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export function injected(): EIP1193Provider | null {
  return typeof window !== "undefined" && window.ethereum ? window.ethereum : null;
}

export async function requestAccount(): Promise<Address> {
  const provider = injected();
  if (!provider) throw new Error("No browser wallet found. Install MetaMask or Rabby, then reload.");
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const first = accounts[0];
  if (!first) throw new Error("The wallet returned no account.");
  return first;
}

/** Switches the wallet to the lane's chain, adding it first if the wallet does not know it. */
export async function walletFor(lane: LaneId, account: Address): Promise<WalletClient> {
  const provider = injected();
  if (!provider) throw new Error("No browser wallet found.");
  const chain = LANES[lane].chain;
  const chainId = numberToHex(chain.id);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 4902) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [LANES[lane].rpc],
          blockExplorerUrls: [LANES[lane].explorer],
        },
      ],
    });
  }
  return createWalletClient({ account, chain, transport: custom(provider) });
}

/** One readable sentence from a viem or wallet error. */
export function errorMessage(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
