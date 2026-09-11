import { describe, expect, it } from "bun:test";
import {
	parseQuoteResponse,
	parseSwapResponse,
	SwapError,
} from "../src/swap.ts";

const X_MINT = "So11111111111111111111111111111111111111112";
const Y_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const expectSwapError = (fn: () => unknown, contains: string): void => {
	try {
		fn();
	} catch (e) {
		expect(e).toBeInstanceOf(SwapError);
		expect((e as SwapError).message).toContain(contains);
		return;
	}
	throw new Error("expected SwapError, got success");
};

describe("parseQuoteResponse", () => {
	it("decodes a valid quote and trims mints", () => {
		const quote = parseQuoteResponse({
			inputMint: ` ${X_MINT} `,
			outputMint: Y_MINT,
			inAmount: "1000",
			outAmount: "990",
			extra: "ignored",
		});
		expect(quote).toEqual({
			inputMint: X_MINT,
			outputMint: Y_MINT,
			inAmount: "1000",
			outAmount: "990",
		});
	});

	it("rejects a missing field", () => {
		expectSwapError(
			() =>
				parseQuoteResponse({
					inputMint: X_MINT,
					outputMint: Y_MINT,
					inAmount: "1000",
				}),
			"Jupiter quote",
		);
	});

	it("rejects a non base-unit amount", () => {
		expectSwapError(
			() =>
				parseQuoteResponse({
					inputMint: X_MINT,
					outputMint: Y_MINT,
					inAmount: "1.5",
					outAmount: "990",
				}),
			"Jupiter quote",
		);
	});

	it("rejects an invalid mint", () => {
		expectSwapError(
			() =>
				parseQuoteResponse({
					inputMint: "not-a-mint",
					outputMint: Y_MINT,
					inAmount: "1000",
					outAmount: "990",
				}),
			"Jupiter quote",
		);
	});
});

describe("parseSwapResponse", () => {
	it("returns the base64 transaction string", () => {
		const b64 = Buffer.from("hello").toString("base64");
		expect(parseSwapResponse({ swapTransaction: b64 })).toBe(b64);
	});

	it("rejects a missing swapTransaction", () => {
		expectSwapError(() => parseSwapResponse({}), "missing swapTransaction");
	});

	it("rejects broken base64", () => {
		expectSwapError(
			() => parseSwapResponse({ swapTransaction: "!!!not-base64!!!" }),
			"not valid base64",
		);
	});
});
