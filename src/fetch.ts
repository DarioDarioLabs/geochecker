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

type TextResponse = { status: number; text: string } | null;

/**
 * Small, short-lived memo for the site files several checks ask for. Two
 * checks read robots.txt and a site scan reads the sitemap for candidates too;
 * without this a scan fetched robots.txt twice per page. Thirty seconds is
 * long enough for one scan and short enough that a scanner process never
 * serves yesterday's robots.txt.
 */
const MEMO_TTL_MS = 30_000;
const MEMO_MAX = 100;
const memo = new Map<string, { at: number; result: Promise<TextResponse> }>();

/** Forget every memoised site file. For tests that stub `fetch` between
 *  cases; a scanner never needs it. */
export function resetFetchMemo(): void {
	memo.clear();
}

export async function fetchText(
	url: string,
	{ timeoutMs = 6_000 }: { timeoutMs?: number } = {},
): Promise<TextResponse> {
	const hit = memo.get(url);
	if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.result;
	if (memo.size >= MEMO_MAX) {
		const oldest = memo.keys().next().value;
		if (oldest) memo.delete(oldest);
	}
	const result = fetchTextUncached(url, timeoutMs);
	memo.set(url, { at: Date.now(), result });
	return result;
}

async function fetchTextUncached(url: string, timeoutMs: number): Promise<TextResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const res = await fetch(url, {
			redirect: "follow",
			signal: controller.signal,
			headers: { "User-Agent": UA },
		});
		const text = await readCapped(res, 400_000);
		return { status: res.status, text };
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

/** The first sitemap URL robots.txt declares, else the conventional path if
 *  it serves a sitemap. Shared by the sitemap check and the site scan. */
export async function declaredSitemaps(origin: string): Promise<{ urls: string[]; declared: boolean }> {
	const robots = await fetchText(`${origin}/robots.txt`);
	const declared =
		robots && robots.status < 400
			? [...robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1])
			: [];
	if (declared.length) return { urls: declared, declared: true };
	const guess = await fetchText(`${origin}/sitemap.xml`);
	if (guess && guess.status < 400 && /<(urlset|sitemapindex)/i.test(guess.text)) {
		return { urls: [`${origin}/sitemap.xml`], declared: false };
	}
	return { urls: [], declared: false };
}

/** Child sitemaps worth opening first when a site publishes an index: the ones
 *  that hold the site's own pages rather than products, posts or locales.
 *  Tested on the name with "sitemap" removed — every child is called
 *  sitemap-something, and "site" matched all of them. */
const SITEMAP_PAGES_HINT = /(page|main|about|marketing|static|general|company|service|content|misc)/i;
const sitemapName = (url: string) => url.replace(/sitemap/gi, "");

/**
 * Page URLs from the site's sitemap(s): up to three declared sitemaps, and for
 * a sitemap index up to four child sitemaps, the ones named like page
 * sitemaps first. Capped, same host only. Best-effort — an unreadable sitemap
 * contributes nothing and throws nothing.
 */
export async function sitemapUrls(origin: string, max = 300): Promise<string[]> {
	const { urls } = await declaredSitemaps(origin);
	const host = hostOf(origin);
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (u: string) => {
		if (seen.has(u) || out.length >= max) return;
		try {
			if (hostOf(u) !== host) return;
		} catch {
			return;
		}
		seen.add(u);
		out.push(u);
	};
	const bodies = await Promise.all(urls.slice(0, 3).map((u) => fetchText(u)));
	const children: string[] = [];
	for (const body of bodies) {
		if (!body || body.status >= 400) continue;
		if (/<sitemapindex/i.test(body.text)) {
			const locs = locsOf(body.text);
			children.push(
				...locs.filter((l) => SITEMAP_PAGES_HINT.test(sitemapName(l))),
				...locs.filter((l) => !SITEMAP_PAGES_HINT.test(sitemapName(l))),
			);
		} else {
			for (const loc of locsOf(body.text)) push(loc);
		}
	}
	if (children.length) {
		const childBodies = await Promise.all(children.slice(0, 4).map((u) => fetchText(u)));
		for (const body of childBodies) {
			if (!body || body.status >= 400 || /<sitemapindex/i.test(body.text)) continue;
			for (const loc of locsOf(body.text)) push(loc);
		}
	}
	return out;
}

function locsOf(xml: string): string[] {
	return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) =>
		m[1].replace(/&amp;/g, "&"),
	);
}

export function hostOf(url: string): string {
	return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

export function normalizeUrl(input: string): string {
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
