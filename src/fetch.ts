import type { FetchedPage } from "./types.js";

const UA =
	"Mozilla/5.0 (compatible; DarioGeoBot/1.0; +https://dariodario.com/geochecker)";

const TIMEOUT_MS = 12_000;
const MAX_BYTES = 2_500_000;

export type FetchOptions = {
	/** Sent as `Accept-Language`. A site that negotiates language serves the
	 *  version its visitors see only if this matches them; the default `en`
	 *  hands a Swedish or German site's English fallback to every check that
	 *  reads prose. Pass the audience's language, e.g. `"sv"` or `"de,en;q=0.5"`. */
	acceptLanguage?: string;
};

export async function fetchPage(
	url: string,
	{ acceptLanguage = "en;q=0.9" }: FetchOptions = {},
): Promise<FetchedPage> {
	const target = normalizeUrl(url);

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

	let res: Response;
	try {
		res = await fetch(target, {
			method: "GET",
			redirect: "follow",
			signal: controller.signal,
			headers: {
				"User-Agent": UA,
				Accept: "text/html,application/xhtml+xml",
				"Accept-Language": acceptLanguage,
			},
		});
	} finally {
		clearTimeout(timeout);
	}

	const html = await readCapped(res, MAX_BYTES);
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => {
		headers[k.toLowerCase()] = v;
	});

	return {
		url: target,
		finalUrl: res.url || target,
		status: res.status,
		html,
		headers,
		fetchedAt: new Date().toISOString(),
	};
}

export async function fetchText(
	url: string,
	{ timeoutMs = 6_000 }: { timeoutMs?: number } = {},
): Promise<{ status: number; text: string } | null> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const res = await fetch(url, {
			redirect: "follow",
			signal: controller.signal,
			headers: { "User-Agent": UA },
		});
		const text = await readCapped(res, 200_000);
		return { status: res.status, text };
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

function normalizeUrl(input: string): string {
	const trimmed = input.trim();
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	return `https://${trimmed}`;
}

async function readCapped(res: Response, max: number): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return await res.text();

	const decoder = new TextDecoder();
	let bytes = 0;
	let out = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		out += decoder.decode(value, { stream: true });
		if (bytes >= max) {
			await reader.cancel();
			break;
		}
	}
	out += decoder.decode();
	return out;
}

export function originOf(url: string): string {
	const u = new URL(url);
	return `${u.protocol}//${u.host}`;
}
