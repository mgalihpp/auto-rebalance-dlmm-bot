export type PositionStatus =
	| "InRange"
	| "NearEdge"
	| "OutOfRange"
	| "NoPosition"
	| "Error";

export interface PositionSnapshot {
	poolAddress: string;
	activeBinId: number;
	lowerBinId: number | null;
	upperBinId: number | null;
	status: PositionStatus;
}

export interface RebalancePlan {
	strategy: "Spot";
	maxActiveBinSlippage: number;
}

export type RebalanceDecision =
	| { readonly _tag: "Hold"; readonly reason: string }
	| { readonly _tag: "Rebalance"; readonly plan: RebalancePlan };

export interface DecidePolicy {
	edgeBufferBins: number;
}

export function deriveStatus(
	activeBinId: number,
	lowerBinId: number | null,
	upperBinId: number | null,
	edgeBufferBins: number,
): PositionStatus {
	if (lowerBinId === null || upperBinId === null) return "NoPosition";
	if (activeBinId < lowerBinId || activeBinId > upperBinId) return "OutOfRange";
	const distToEdge = Math.min(
		activeBinId - lowerBinId,
		upperBinId - activeBinId,
	);
	if (distToEdge <= edgeBufferBins) return "NearEdge";
	return "InRange";
}

export function decide(
	snapshot: PositionSnapshot,
	policy: DecidePolicy,
): RebalanceDecision {
	switch (snapshot.status) {
		case "Error":
			return { _tag: "Hold", reason: "snapshot error, skip rebalance" };
		case "NoPosition":
			return {
				_tag: "Hold",
				reason:
					"no position tracked (POSITION_PUBKEY empty), monitoring pool only",
			};
		case "InRange":
			return {
				_tag: "Hold",
				reason: `active bin ${snapshot.activeBinId} inside [${snapshot.lowerBinId}, ${snapshot.upperBinId}]`,
			};
		case "NearEdge":
			return {
				_tag: "Hold",
				reason: `active bin ${snapshot.activeBinId} near edge of [${snapshot.lowerBinId}, ${snapshot.upperBinId}] (buffer ${policy.edgeBufferBins}), watching`,
			};
		case "OutOfRange": {
			return {
				_tag: "Rebalance",
				plan: {
					strategy: "Spot",
					// why: mirrors SDK MAX_ACTIVE_BIN_SLIPPAGE default; bounds how far
					// the active bin may drift between simulation and execution.
					maxActiveBinSlippage: 3,
				},
			};
		}
	}
}
