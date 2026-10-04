import type { CheckResult, CheckCode, FetchedPage } from "../types.js";
import { declaredSitemaps, originOf } from "../fetch.js";
import { statusFor } from "../scoring.js";

/**
 * Indexability — can a search engine list this page at all? Three checks in
 * the `access` category since 3.0.
 *
 * These sit apart from `crawlability`, which asks whether AI search crawlers are
 * *allowed in* by robots.txt. Indexability is the next question: once a crawler
 * has the page, is it permitted and able to index it, and is the site telling
 * engines which URL is canonical.
 *
 * Measured on 172 real prospects before these were written, so the hit rates are
 * known rather than guessed: 26% have no canonical tag, 15% have no sitemap, and
 * 3% are actively serving `noindex` — that last group is invisible in Google
 * today and almost always does not know it.
 *
 * All three are answerable from the page already fetched plus at most one extra
 * request, and each has a concrete, ordinary fix.
 */

/** `noindex` can arrive by meta tag or by HTTP header; a site that sets it in
 *  one place and not the other is still noindexed. */
function readsNoindex(page: FetchedPage, head: string): {
	noindex: boolean;
	nofollow: boolean;
	source: string | null;
} {
	const metas = [...head.matchAll(/<meta[^>]*>/gi)].map((m) => m[0]);
	const robotsMeta = metas.find((m) =>
		/name\s*=\s*["'](robots|googlebot)["']/i.test(m),
	);
	const metaContent = robotsMeta
		? (robotsMeta.match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? "")
		: "";
	const header = page.headers["x-robots-tag"] ?? "";
	const noindex = /noindex/i.test(metaContent) || /noindex/i.test(header);
	const nofollow = /nofollow/i.test(metaContent) || /nofollow/i.test(header);
	const source = /noindex/i.test(metaContent)
		? "meta"
		: /noindex/i.test(header)
			? "x-robots-tag"
			: null;
	return { noindex, nofollow, source };
}

function headOf(html: string): string {
	const end = html.search(/<\/head>/i);
	return end > 0 ? html.slice(0, end) : html.slice(0, 30000);
}

/** Serving `noindex` is the most consequential thing on this list: the page is
 *  not in Google at all, and nothing else you do to it matters until it is. */
export async function checkIndexable(page: FetchedPage): Promise<CheckResult> {
	const head = headOf(page.html);
	const { noindex, nofollow, source } = readsNoindex(page, head);
	const codes: CheckCode[] = [];
	let score = 100;
	let finding: string;
	let detail: string;
	let fix: string;

	if (noindex) {
		score = 0;
		finding = "This page tells search engines not to index it.";
		detail = `A \`noindex\` directive was found in the ${source === "meta" ? "robots meta tag" : "X-Robots-Tag response header"}. Search engines that honour it will not list this page at all, and AI search products that build on a search index inherit that exclusion.`;
		fix = `Remove the \`noindex\` directive from the ${source === "meta" ? "<meta name=\"robots\"> tag" : "X-Robots-Tag header"}. If it was added deliberately for a staging site, make sure it is not being served in production — this is the most common way it survives a launch.`;
		codes.push({ code: "indexability.noindex", data: { source } });
	} else if (nofollow) {
		score = 70;
		finding = "Page is indexable, but its links are marked nofollow.";
		detail =
			"No `noindex`, so the page can be listed. `nofollow` tells engines not to follow links out of it, which weakens discovery of everything it links to.";
		fix = "Drop `nofollow` from the robots directive unless you specifically intend not to pass link equity from this page.";
		codes.push({ code: "indexability.nofollow" });
	} else {
		finding = "Page is indexable.";
		detail =
			"No `noindex` in the robots meta tag or the X-Robots-Tag header, so search engines may list this page.";
		fix = "Nothing to do. Keep staging-only `noindex` rules out of production.";
		codes.push({ code: "indexability.ok" });
	}

	return {
		id: "indexable",
		category: "access",
		score,
		status: statusFor(score, noindex || nofollow),
		finding,
		detail,
		fix,
		// Heavier than its siblings: being absent from the index is not a
		// degree of quality, it is a binary that voids the rest.
		weight: 1.6,
		codes,
	};
}

/** A canonical tag tells engines which URL is the real one. Without it, the same
 *  content on several URLs competes with itself. 26% of prospects had none. */
export async function checkCanonical(page: FetchedPage): Promise<CheckResult> {
	const head = headOf(page.html);
	const tag = head.match(/<link[^>]*rel\s*=\s*["']canonical["'][^>]*>/i)?.[0];
	const href = tag?.match(/href\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
	const codes: CheckCode[] = [];
	let score: number;
	let finding: string;
	let detail: string;
	let fix: string;
	let hasIssue = true;

	if (!href) {
		// A hygiene gap, not a wall: engines index the page anyway. Inside the
		// weakest-link access category a 55 would have cost more than a
		// blocked crawler, so it is priced as the minor thing it is.
		score = 85;
		finding = "No canonical tag.";
		detail =
			"No <link rel=\"canonical\"> in the head. Without one, the same page reachable at several URLs (with and without a trailing slash, with tracking parameters, http and https) can be treated as competing duplicates.";
		fix =
			'Add <link rel="canonical" href="..."> to every page, pointing at the URL you want listed. Self-referencing canonicals are correct and expected.';
		codes.push({ code: "canonical.missing" });
	} else {
		let resolved: URL | null = null;
		try {
			resolved = new URL(href, page.finalUrl);
		} catch {
			resolved = null;
		}
		if (!resolved) {
			score = 70;
			finding = "Canonical tag is not a valid URL.";
			detail = `The canonical href (${href}) could not be parsed as a URL, so engines will ignore it.`;
			fix = "Emit an absolute, valid URL in the canonical tag.";
			codes.push({ code: "canonical.malformed", data: { href } });
		} else {
			const here = new URL(page.finalUrl);
			const sameHost =
				resolved.hostname.replace(/^www\./, "").toLowerCase() ===
				here.hostname.replace(/^www\./, "").toLowerCase();
			const samePath =
				resolved.pathname.replace(/\/+$/, "") ===
				here.pathname.replace(/\/+$/, "");
			if (sameHost && samePath) {
				score = 100;
				hasIssue = false;
				finding = "Canonical tag present and self-referencing.";
				detail = `Canonical points at ${resolved.toString()}, which is this page. That is the correct default.`;
				fix = "Nothing to do.";
				codes.push({ code: "canonical.self" });
			} else {
				score = 80;
				finding = "Canonical points to a different URL.";
				detail = `Canonical points at ${resolved.toString()}, not this page. That is deliberate on a duplicate or a syndicated copy, and a mistake anywhere else — it asks engines to list the other URL instead of this one.`;
				fix = "Confirm this page is genuinely a duplicate of the canonical target. If it is not, point the canonical at this page.";
				codes.push({
					code: "canonical.cross",
					data: { target: resolved.toString() },
				});
			}
		}
	}

	return {
		id: "canonical",
		category: "access",
		score,
		status: statusFor(score, hasIssue),
		finding,
		detail,
		fix,
		weight: 1.0,
		codes,
	};
}

/** A sitemap is how an engine finds pages that are not linked prominently.
 *  15% of prospects had neither a /sitemap.xml nor one declared in robots.txt.
 *  Site-level: the sitemap is the site's, whichever page was asked about. */
export async function checkSitemap(page: FetchedPage): Promise<CheckResult> {
	const origin = originOf(page.finalUrl);
	// robots.txt is the site's own declaration and takes precedence; the
	// conventional path is only a fallback.
	const { urls, declared: viaRobots } = await declaredSitemaps(origin);
	const found = urls[0] ?? null;

	const codes: CheckCode[] = [];
	let score: number;
	let finding: string;
	let detail: string;
	let fix: string;

	if (!found) {
		// Discovery still works by following links; priced as a real but
		// partial loss inside the weakest-link access category.
		score = 70;
		finding = "No sitemap found.";
		detail = `Neither a Sitemap: line in robots.txt nor a readable ${origin}/sitemap.xml. Engines then rely entirely on following links, so anything not linked from a crawled page can go undiscovered.`;
		fix =
			"Publish /sitemap.xml listing your canonical URLs and declare it in robots.txt with a `Sitemap:` line. Most CMSs and site frameworks generate one for you.";
		codes.push({ code: "sitemap.missing" });
	} else if (!viaRobots) {
		score = 90;
		finding = "Sitemap exists but is not declared in robots.txt.";
		detail = `Found ${found}, but robots.txt has no Sitemap: line. Engines usually try the conventional path anyway; declaring it removes the guesswork.`;
		fix = `Add "Sitemap: ${found}" to robots.txt.`;
		codes.push({ code: "sitemap.undeclared", data: { url: found } });
	} else {
		score = 100;
		finding = "Sitemap declared in robots.txt.";
		detail = `robots.txt declares ${found}.`;
		fix = "Nothing to do. Keep it current as pages are added and removed.";
		codes.push({ code: "sitemap.declared", data: { url: found } });
	}

	return {
		id: "sitemap",
		category: "access",
		scope: "site",
		score,
		status: statusFor(score, score < 100),
		finding,
		detail,
		fix,
		weight: 0.9,
		codes,
	};
}
