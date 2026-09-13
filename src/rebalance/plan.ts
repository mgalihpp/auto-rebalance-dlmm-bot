export function originalHalfRange(
	lowerBinId: number,
	upperBinId: number,
): number {
	return Math.max(1, Math.floor((upperBinId - lowerBinId) / 2));
}

export function shouldRebalance(
	activeBinId: number,
	lowerBinId: number,
	upperBinId: number,
): boolean {
	return activeBinId < lowerBinId || activeBinId > upperBinId;
}
