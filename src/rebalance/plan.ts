import type { RebalanceRange } from "../config.ts";

export function originalHalfRange(
	lowerBinId: number,
	upperBinId: number,
): number {
	return Math.max(1, Math.floor((upperBinId - lowerBinId) / 2));
}

export function rebalanceHalfRange(
	range: RebalanceRange,
	lowerBinId: number,
	upperBinId: number,
): number {
	if (range.kind === "fixed") {
		return range.halfWidth;
	}
	return originalHalfRange(lowerBinId, upperBinId);
}

export function shouldRebalance(
	activeBinId: number,
	lowerBinId: number,
	upperBinId: number,
): boolean {
	return activeBinId < lowerBinId || activeBinId > upperBinId;
}
