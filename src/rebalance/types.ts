import { StrategyType } from "@meteora-ag/dlmm";
import type BN from "bn.js";

export type StrategyKind = "Spot" | "Curve" | "BidAsk";

export interface StrategyRange {
	kind: StrategyKind;
	minBinId: number;
	maxBinId: number;
}

export type SwapDirection = "XtoY" | "YtoX" | "None";

export interface SwapLeg {
	direction: SwapDirection;
	inMint: string;
	outMint: string;
	inAmount: BN;
	minOutAmount: BN;
}

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
	activeBinPrice?: string;
}

export interface RebalancePlan {
	pool: string;
	position: string;
	activeBinId: number;
	currentX: BN;
	currentY: BN;
	claimedFeeX: BN;
	claimedFeeY: BN;
	targetX: BN;
	targetY: BN;
	strategy: StrategyRange;
	swap: SwapLeg;
	slippageBps: number;
}

export interface PlanOptions {
	slippageBps: number;
	compoundFees: boolean;
	strategy: StrategyKind;
}

export interface TokenMints {
	xMint: string;
	yMint: string;
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
