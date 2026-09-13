import DLMM, { type LbPosition } from "@meteora-ag/dlmm";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import Decimal from "decimal.js";
import { Data, Effect } from "effect";
import { AppSigner, SolanaConnection } from "../services.ts";
import type { PositionSnapshot } from "./types.ts";

export class DlmmError extends Data.TaggedError("DlmmError")<{
	message: string;
}> {}

export type PositionAmount = string | number | BN;

export interface PositionCandidate {
	publicKey: { toBase58(): string };
	positionData: {
		totalXAmount: PositionAmount;
		totalYAmount: PositionAmount;
		feeX?: PositionAmount;
		feeY?: PositionAmount;
	};
}

function toAmount(value: PositionAmount | undefined): BN {
	if (value === undefined) return new BN(0);
	if (typeof value === "number") return new BN(Math.trunc(value));
	if (typeof value === "string") {
		const text = value.trim();
		if (text === "" || text === "-" || text === ".") return new BN(0);
		const dot = text.indexOf(".");
		const head = dot < 0 ? text : text.slice(0, dot);
		if (head === "" || head === "-") return new BN(0);
		return new BN(head);
	}
	return value;
}

function isFunded(candidate: PositionCandidate): boolean {
	const total = toAmount(candidate.positionData.totalXAmount)
		.add(toAmount(candidate.positionData.totalYAmount))
		.add(toAmount(candidate.positionData.feeX))
		.add(toAmount(candidate.positionData.feeY));
	return total.gt(new BN(0));
}

export function resolvePosition<T extends PositionCandidate>(
	candidates: T[],
): T {
	const funded = candidates.filter(isFunded);
	if (funded.length === 0) {
		throw new DlmmError({
			message: "no DLMM position found for owner in this pool",
		});
	}
	const [pick] = funded;
	if (pick !== undefined && funded.length === 1) {
		return pick;
	}
	throw new DlmmError({
		message: `multiple funded positions found in this pool: ${funded.map((c) => c.publicKey.toBase58()).join(", ")}; run one bot instance per pool or withdraw the extra position`,
	});
}

export interface LoadStateInput {
	poolAddress: string;
}

export interface LoadedState {
	dlmm: DLMM;
	position: LbPosition;
	snapshot: PositionSnapshot;
}

function toDlmmError(error: unknown): DlmmError {
	return new DlmmError({
		message: error instanceof Error ? error.message : String(error),
	});
}

export const loadPositionState = Effect.fn("loadPositionState")(function* (
	input: LoadStateInput,
): Effect.fn.Return<LoadedState, DlmmError, SolanaConnection | AppSigner> {
	const connection = yield* SolanaConnection;
	const signer = yield* AppSigner;
	const owner = signer.publicKey;
	const dlmm = yield* Effect.tryPromise({
		try: async () => DLMM.create(connection, new PublicKey(input.poolAddress)),
		catch: toDlmmError,
	});
	const { activeBin, userPositions } = yield* Effect.tryPromise({
		try: () => dlmm.getPositionsByUserAndLbPair(owner),
		catch: toDlmmError,
	});

	const position = yield* Effect.try({
		try: () => resolvePosition(userPositions),
		catch: (error) => (error instanceof DlmmError ? error : toDlmmError(error)),
	});
	console.log(
		`Auto-selected position ${position.publicKey.toBase58()} (${userPositions.length} position(s) in pool)`,
	);

	const data = position.positionData;
	let activeBinPrice = activeBin.price;
	try {
		activeBinPrice = new Decimal(
			dlmm.fromPricePerLamport(Number(activeBin.price)),
		)
			.toSignificantDigits(6)
			.toString();
	} catch {
		activeBinPrice = activeBin.price;
	}

	const snapshot: PositionSnapshot = {
		pool: dlmm.pubkey.toBase58(),
		position: position.publicKey.toBase58(),
		owner: owner.toBase58(),
		activeBinId: activeBin.binId,
		lowerBinId: data.lowerBinId,
		upperBinId: data.upperBinId,
		amountX: new BN(data.totalXAmount),
		amountY: new BN(data.totalYAmount),
		feeX: data.feeX,
		feeY: data.feeY,
		claimedFeeX: data.totalClaimedFeeXAmount,
		claimedFeeY: data.totalClaimedFeeYAmount,
		tokenXMint: dlmm.lbPair.tokenXMint.toBase58(),
		tokenYMint: dlmm.lbPair.tokenYMint.toBase58(),
		activeBinPrice,
	};
	return { dlmm, position, snapshot };
});
