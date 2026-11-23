import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { LANES, type LaneId } from "./config";

const cache = new Map<LaneId, PublicClient>();

export function client(lane: LaneId): PublicClient {
  let c = cache.get(lane);
  if (!c) {
    c = createPublicClient({
      chain: LANES[lane].chain,
      transport: fallback(
        [LANES[lane].rpc, ...LANES[lane].fallbacks].map((url) => http(url, { retryCount: 1, timeout: 5_000 })),
        { retryCount: 2 },
      ),
    }) as PublicClient;
    cache.set(lane, c);
  }
  return c;
}

const blockTs = new Map<string, number>();

/** Block timestamp in seconds, memoised (blocks are final on these chains for our purposes). */
export async function blockTimestamp(lane: LaneId, block: bigint): Promise<number> {
  const key = `${lane}:${block}`;
  const hit = blockTs.get(key);
  if (hit !== undefined) return hit;
  const b = await client(lane).getBlock({ blockNumber: block });
  const ts = Number(b.timestamp);
  blockTs.set(key, ts);
  return ts;
}
