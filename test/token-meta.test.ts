import { beforeEach, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { Effect } from "effect";
import {
	clearPoolMetaCache,
	DLMM_DATAPI_BASE,
	fetchPoolMeta,
	parsePoolMetaResponse,
} from "../src/rebalance/tokenMeta.ts";
import { shortAddr } from "../src/utils.ts";

const POOL = Keypair.generate().publicKey.toBase58();
const MINT_X = Keypair.generate().publicKey.toBase58();
const MINT_Y = Keypair.generate().publicKey.toBase58();

function apiPayload(overrides?: Record<string, unknown>) {
	return {
		address: POOL,
		name: "DOGE-SOL",
		token_x: { address: MINT_X, name: "Dogecoin", symbol: "DOGE", decimals: 8 },
		token_y: {
			address: MINT_Y,
			name: "Wrapped SOL",
			symbol: "SOL",
			decimals: 9,
		},
		...overrides,
	};
}

function okFetch(payload: unknown, calls?: string[]) {
	return async (url: string) => {
		calls?.push(url);
		return {
			ok: true,
			status: 200,
			json: async () => payload,
		} as unknown as Response;
	};
}

beforeEach(() => {
	clearPoolMetaCache();
});

describe("parsePoolMetaResponse", () => {
	test("reads both token symbols and decimals", () => {
		expect(parsePoolMetaResponse(apiPayload(), MINT_X, MINT_Y)).toEqual({
			tokenX: { mint: MINT_X, decimals: 8, symbol: "DOGE" },
			tokenY: { mint: MINT_Y, decimals: 9, symbol: "SOL" },
		});
	});

	test("falls back to short mint and undefined decimals", () => {
		expect(parsePoolMetaResponse({}, MINT_X, MINT_Y)).toEqual({
			tokenX: {
				mint: MINT_X,
				decimals: undefined,
				symbol: shortAddr(MINT_X),
			},
			tokenY: {
				mint: MINT_Y,
				decimals: undefined,
				symbol: shortAddr(MINT_Y),
			},
		});
	});

	test("rejects blank symbols and out-of-range decimals", () => {
		const meta = parsePoolMetaResponse(
			{
				token_x: { symbol: "   ", decimals: 99 },
				token_y: { symbol: "", decimals: -1 },
			},
			MINT_X,
			MINT_Y,
		);
		expect(meta.tokenX.symbol).toBe(shortAddr(MINT_X));
		expect(meta.tokenX.decimals).toBeUndefined();
		expect(meta.tokenY.symbol).toBe(shortAddr(MINT_Y));
		expect(meta.tokenY.decimals).toBeUndefined();
	});

	test("never throws on garbage input", () => {
		expect(parsePoolMetaResponse(null, MINT_X, MINT_Y).tokenX.symbol).toBe(
			shortAddr(MINT_X),
		);
	});
});

describe("fetchPoolMeta", () => {
	test("hits the official DLMM Data API pool endpoint", async () => {
		const calls: string[] = [];
		const meta = await Effect.runPromise(
			fetchPoolMeta(POOL, MINT_X, MINT_Y, okFetch(apiPayload(), calls)),
		);
		expect(calls).toEqual([`${DLMM_DATAPI_BASE}/pools/${POOL}`]);
		expect(meta.tokenX.symbol).toBe("DOGE");
		expect(meta.tokenY.symbol).toBe("SOL");
	});

	test("degrades gracefully on HTTP failure", async () => {
		const failing = async () => ({ ok: false, status: 500 }) as Response;
		const meta = await Effect.runPromise(
			fetchPoolMeta(POOL, MINT_X, MINT_Y, failing),
		);
		expect(meta.tokenX).toEqual({
			mint: MINT_X,
			decimals: undefined,
			symbol: shortAddr(MINT_X),
		});
	});

	test("caches per pool across calls", async () => {
		const calls: string[] = [];
		const fetch = okFetch(apiPayload(), calls);
		await Effect.runPromise(fetchPoolMeta(POOL, MINT_X, MINT_Y, fetch));
		await Effect.runPromise(fetchPoolMeta(POOL, MINT_X, MINT_Y, fetch));
		expect(calls.length).toBe(1);
	});
});
