import DLMM, { StrategyType } from "@meteora-ag/dlmm";
import { type Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { Effect } from "effect";
import {
	deriveStatus,
	type LiquidityStrategy,
	type PositionSnapshot,
} from "./decision.ts";

export class DlmmError extends Error {
	readonly _tag = "DlmmError";
}

export const loadKeypair = (
	walletPrivateKey: string | null,
): Effect.Effect<Keypair | null, DlmmError> =>
	Effect.tryPromise({
		try: async () => {
			if (!walletPrivateKey) return null;
			const raw = walletPrivateKey.trim();
			const bytes = parseSecretBytes(raw);
			if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
			if (bytes.length === 32) return Keypair.fromSeed(bytes);
			throw new Error(
				`expected 64-byte secret key or 32-byte seed, got ${bytes.length} bytes`,
			);
		},
		catch: (e) =>
			new DlmmError(
				`Failed to load wallet from WALLET_PRIVATE_KEY: ${e instanceof Error ? e.message : String(e)}`,
			),
	});

// why: beacon format is wallet UX, JSON array is solana-keygen UX. Both
// decode to the same bytes, so accept either instead of forcing a conversion.
function parseSecretBytes(raw: string): Uint8Array {
	if (raw.startsWith("[")) {
		const arr = JSON.parse(raw) as unknown;
		if (
			!Array.isArray(arr) ||
			!arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
		) {
			throw new Error("JSON key must be an array of bytes (0-255)");
		}
		return Uint8Array.from(arr as number[]);
	}
	return bs58.decode(raw);
}

export const fetchSnapshot = (
	connection: Connection,
	poolAddress: string,
	positionPubkey: string | null,
	edgeBufferBins: number,
): Effect.Effect<PositionSnapshot, DlmmError> =>
	Effect.tryPromise({
		try: async (): Promise<PositionSnapshot> => {
			const dlmm = await DLMM.create(connection, new PublicKey(poolAddress));
			const active = await dlmm.getActiveBin();
			const activeBinId = active.binId;

			if (!positionPubkey) {
				return {
					poolAddress,
					activeBinId,
					lowerBinId: null,
					upperBinId: null,
					status: "NoPosition",
				};
			}

			const pos = await dlmm.getPosition(new PublicKey(positionPubkey));
			const lowerBinId = pos.positionData.lowerBinId;
			const upperBinId = pos.positionData.upperBinId;
			return {
				poolAddress,
				activeBinId,
				lowerBinId,
				upperBinId,
				status: deriveStatus(
					activeBinId,
					lowerBinId,
					upperBinId,
					edgeBufferBins,
				),
			};
		},
		catch: (e) =>
			new DlmmError(
				`fetchSnapshot failed: ${e instanceof Error ? e.message : String(e)}`,
			),
	});

export interface RebalanceContext {
	connection: Connection;
	dlmm: InstanceType<typeof DLMM>;
	owner: Keypair;
}

const slippagePct = (bps: number): number => bps / 100;

export { slippagePct };

export const sdkStrategyOf = (s: LiquidityStrategy): StrategyType =>
	toSdkStrategy[s];

const toSdkStrategy: Record<LiquidityStrategy, StrategyType> = {
	Spot: StrategyType.Spot,
	Curve: StrategyType.Curve,
	BidAsk: StrategyType.BidAsk,
};
