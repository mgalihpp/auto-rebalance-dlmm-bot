import { describe, expect, it } from "bun:test";
import {
	decide,
	deriveStatus,
	type PositionSnapshot,
} from "../src/decision.ts";

const snap = (over: Partial<PositionSnapshot>): PositionSnapshot => ({
	poolAddress: "pool",
	activeBinId: 100,
	lowerBinId: 90,
	upperBinId: 110,
	status: "InRange",
	...over,
});

describe("deriveStatus", () => {
	it("returns NoPosition when range is missing", () => {
		expect(deriveStatus(100, null, null, 2)).toBe("NoPosition");
		expect(deriveStatus(100, null, 110, 2)).toBe("NoPosition");
	});

	it("returns OutOfRange outside the range", () => {
		expect(deriveStatus(89, 90, 110, 2)).toBe("OutOfRange");
		expect(deriveStatus(111, 90, 110, 2)).toBe("OutOfRange");
	});

	it("returns NearEdge within buffer of an edge", () => {
		expect(deriveStatus(91, 90, 110, 2)).toBe("NearEdge");
		expect(deriveStatus(109, 90, 110, 2)).toBe("NearEdge");
	});

	it("returns InRange well inside the range", () => {
		expect(deriveStatus(100, 90, 110, 2)).toBe("InRange");
	});
});

describe("decide", () => {
	it("OutOfRange always yields a balanced plan with the policy strategy", () => {
		for (const strategy of ["Spot", "Curve", "BidAsk"] as const) {
			const d = decide(snap({ status: "OutOfRange" }), {
				edgeBufferBins: 2,
				strategy,
			});
			expect(d._tag).toBe("Rebalance");
			if (d._tag === "Rebalance") expect(d.plan).toEqual({ strategy });
		}
	});

	it("InRange and NearEdge hold", () => {
		const inRange = decide(snap({ status: "InRange" }), {
			edgeBufferBins: 2,
			strategy: "Spot",
		});
		expect(inRange._tag).toBe("Hold");
		const nearEdge = decide(snap({ status: "NearEdge" }), {
			edgeBufferBins: 2,
			strategy: "Spot",
		});
		expect(nearEdge._tag).toBe("Hold");
	});

	it("NoPosition and Error hold", () => {
		const noPos = decide(snap({ status: "NoPosition" }), {
			edgeBufferBins: 2,
			strategy: "Spot",
		});
		expect(noPos._tag).toBe("Hold");
		const err = decide(snap({ status: "Error" }), {
			edgeBufferBins: 2,
			strategy: "Spot",
		});
		expect(err._tag).toBe("Hold");
	});
});
