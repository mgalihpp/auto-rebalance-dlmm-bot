import { Effect } from "effect";
import { shortAddr } from "../utils.ts";

export interface PoolTokenMeta {
	mint: string;
	decimals: number | undefined;
	symbol: string;
}

export interface PoolMeta {
	tokenX: PoolTokenMeta;
	tokenY: PoolTokenMeta;
}

export const DLMM_DATAPI_BASE = "https://dlmm.datapi.meteora.ag";

// One pool per bot instance, so at most 1 entry. Display-only data, cached
// for the process lifetime to keep it to one HTTP call.
const poolMetaCache = new Map<string, PoolMeta>();

export function clearPoolMetaCache(): void {
	poolMetaCache.clear();
}

function parseTokenMeta(raw: unknown, mint: string): PoolTokenMeta {
	const record =
		typeof raw === "object" && raw !== null
			? (raw as Record<string, unknown>)
			: {};
	const symbol =
		typeof record.symbol === "string" && record.symbol.trim() !== ""
			? record.symbol.trim()
			: shortAddr(mint);
	const decimals =
		Number.isInteger(record.decimals) &&
		(record.decimals as number) >= 0 &&
		(record.decimals as number) <= 18
			? (record.decimals as number)
			: undefined;
	return { mint, decimals, symbol };
}

// Pure parse of GET /pools/{address} from the official Meteora DLMM Data API
// (docs/meteora-llms-full.txt, "Base URLs"). Never throws.
export function parsePoolMetaResponse(
	payload: unknown,
	tokenXMint: string,
	tokenYMint: string,
): PoolMeta {
	const record =
		typeof payload === "object" && payload !== null
			? (payload as Record<string, unknown>)
			: {};
	return {
		tokenX: parseTokenMeta(record.token_x, tokenXMint),
		tokenY: parseTokenMeta(record.token_y, tokenYMint),
	};
}

export type MetaFetch = (url: string) => Promise<Response>;

// Display-only pool metadata (symbols, decimals) from the official Meteora
// DLMM Data API. Degrades to short mints on any failure so metadata can
// never fail the poll loop.
export const fetchPoolMeta = Effect.fn("fetchPoolMeta")(function* (
	poolAddress: string,
	tokenXMint: string,
	tokenYMint: string,
	fetchImpl: MetaFetch = globalThis.fetch,
): Effect.fn.Return<PoolMeta, never> {
	const cached = poolMetaCache.get(poolAddress);
	if (cached !== undefined) {
		return cached;
	}
	const fallback: PoolMeta = {
		tokenX: {
			mint: tokenXMint,
			decimals: undefined,
			symbol: shortAddr(tokenXMint),
		},
		tokenY: {
			mint: tokenYMint,
			decimals: undefined,
			symbol: shortAddr(tokenYMint),
		},
	};
	const meta: PoolMeta = yield* Effect.orElseSucceed(
		Effect.tryPromise({
			try: async () => {
				const response = await fetchImpl(
					`${DLMM_DATAPI_BASE}/pools/${poolAddress}`,
				);
				if (!response.ok) {
					throw new Error(`HTTP ${response.status}`);
				}
				return parsePoolMetaResponse(
					await response.json(),
					tokenXMint,
					tokenYMint,
				);
			},
			catch: () => fallback,
		}),
		() => fallback,
	);
	poolMetaCache.set(poolAddress, meta);
	return meta;
});
