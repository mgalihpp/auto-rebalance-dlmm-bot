import { StrategyType } from "@meteora-ag/dlmm";
import type BN from "bn.js";

export type StrategyKind = "Spot" | "Curve" | "BidAsk";

export interface PositionSnapshot {
	pool: string;
	position: string;
	owner: string;
	activeBinId: number;
	lowerBinId: number;
	upperBinId: number;
	amountX: BN;
	amountY: BN;
	feeX: BN;
	feeY: BN;
	claimedFeeX: BN;
	claimedFeeY: BN;
	tokenXMint: string;
	tokenYMint: string;
}

export function toStrategyType(kind: StrategyKind): StrategyType {
	switch (kind) {
		case "Spot":
			return StrategyType.Spot;
		case "Curve":
			return StrategyType.Curve;
		case "BidAsk":
			return StrategyType.BidAsk;
	}
}
