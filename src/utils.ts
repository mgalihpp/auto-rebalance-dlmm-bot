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

export function solscanAccountUrl(addr: string): string {
	return `https://solscan.io/account/${addr}`;
}

export function meteoraPoolUrl(pool: string): string {
	return `https://app.meteora.ag/dlmm/${pool}`;
}

export function shortAddr(addr: string): string {
	if (addr.length <= 11) {
		return addr;
	}
	return `${addr.slice(0, 4)}..${addr.slice(-4)}`;
}

export type RangeDirection = "above" | "below" | "inside";

export function rangeDirection(
	active: number,
	lower: number,
	upper: number,
): RangeDirection {
	if (active < lower) {
		return "below";
	}
	if (active > upper) {
		return "above";
	}
	return "inside";
}

export function formatTokenAmount(
	raw: BN,
	decimals: number | undefined,
	symbol: string,
): string {
	if (decimals === undefined) {
		return `${groupThousands(raw.toString())} ${symbol}`;
	}
	const divisor = new Decimal(10).pow(decimals);
	const fixed = new Decimal(raw.toString()).div(divisor).toFixed(decimals);
	const trimmed = fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
	const [head, tail] = trimmed.split(".");
	const grouped = groupThousands(head ?? "0");
	return `${tail === undefined ? grouped : `${grouped}.${tail}`} ${symbol}`;
}

function groupThousands(digits: string): string {
	const sign = digits.startsWith("-") ? "-" : "";
	const body = sign === "" ? digits : digits.slice(1);
	return sign + body.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ASCII range bar for Telegram <pre> blocks. Row 1 marks old '=' / new '+'
// ranges ('*' on overlap), row 2 marks the active bin '^', row 3 labels
// the mapped span. Only <pre>-safe chars: | = + * ^ spaces and digits.
export function renderRangeBar(
	oldLower: number,
	oldUpper: number,
	newLower: number,
	newUpper: number,
	active: number,
	width = 20,
): string {
	const spanWidth = Math.max(oldUpper, newUpper) - Math.min(oldLower, newLower);
	const pad = Math.max(1, Math.floor(spanWidth * 0.1));
	const spanMin = Math.min(oldLower, newLower) - pad;
	const spanMax = Math.max(oldUpper, newUpper) + pad;
	const w = Math.max(8, Math.floor(width));
	const at = (bin: number) => {
		if (spanMax === spanMin) {
			return 0;
		}
		const ratio = (bin - spanMin) / (spanMax - spanMin);
		return Math.min(w - 1, Math.max(0, Math.round(ratio * (w - 1))));
	};
	const row: string[] = new Array(w).fill(" ");
	for (let i = 0; i < w; i++) {
		const bin = spanMin + ((spanMax - spanMin) * i) / (w - 1);
		const inOld = bin >= oldLower && bin <= oldUpper;
		const inNew = bin >= newLower && bin <= newUpper;
		if (inOld && inNew) {
			row[i] = "*";
		} else if (inOld) {
			row[i] = "=";
		} else if (inNew) {
			row[i] = "+";
		}
	}
	row[0] = "|";
	row[w - 1] = "|";
	const marker: string[] = new Array(w).fill(" ");
	marker[at(active)] = "^";
	const minLabel = String(spanMin);
	const maxLabel = String(spanMax);
	const gap = Math.max(1, w - minLabel.length - maxLabel.length);
	const labels = `${minLabel}${" ".repeat(gap)}${maxLabel}`;
	return `${row.join("")}\n${marker.join("")}\n${labels}`;
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

// Local YYYY-MM-DD HH:MM:SS stamp so stage logs form a realtime timeline.
export function nowStamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
