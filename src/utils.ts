import type BN from "bn.js";
import Decimal from "decimal.js";

export interface SignatureRecord {
	signature: string;
	url: string;
}

export interface BinRange {
	lower: number;
	upper: number;
}

export function solscanTxUrl(sig: string): string {
	return `https://solscan.io/tx/${sig}`;
}

export function formatSig(sig: string): string {
	return `${sig} | ${solscanTxUrl(sig)}`;
}

export function formatBinRange(lower: number, upper: number): string {
	return `${lower} to ${upper}`;
}

export function formatBn(value: BN): string {
	return new Decimal(value.toString()).toFixed(0);
}

// Local HH:MM:SS stamp so stage logs form a realtime timeline.
export function nowStamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
