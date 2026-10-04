import { parse } from "node-html-parser";
import type { CheckCode, CheckResult, FetchedPage } from "../types.js";
import { statusFor } from "../scoring.js";
import { detectGenre } from "../genre.js";
import { visibleText, wordCount } from "../text.js";

const AUTHOR_HINTS = [
	'meta[name="author"]',
	'meta[property="article:author"]',
	'[rel="author"]',
	'[itemprop="author"]',
	".author",
	".byline",
	".by-author",
];

const DATE_HINTS = [
	"time[datetime]",
	'meta[property="article:published_time"]',
	'meta[property="article:modified_time"]',
	'meta[name="date"]',
	'meta[itemprop="datePublished"]',
	'meta[itemprop="dateModified"]',
];

/**
 * Citability — does the page say anything an assistant could repeat with
 * attribution? An ARTICLE is judged as a source: byline, date, links to what
 * it cites, and copy that is not sales language. A BRAND page is judged on
 * whether its copy states anything specific — a price, a year, a quantity, an
 * address — rather than adjectives any company in the sector could use.
 */
export async function checkCitability(
	page: FetchedPage,
): Promise<CheckResult> {
	const root = parse(page.html);
	const origin = new URL(page.finalUrl).host;
	const genre = detectGenre(page);

	const author = AUTHOR_HINTS.some((sel) => root.querySelector(sel) !== null);
	const date = DATE_HINTS.some((sel) => root.querySelector(sel) !== null);

	const links = root.querySelectorAll("a[href]");
	let outboundCitations = 0;
	for (const a of links) {
		const href = a.getAttribute("href") || "";
		if (!/^https?:\/\//i.test(href)) continue;
		try {
			const u = new URL(href);
			if (u.host !== origin && !u.host.endsWith(`.${origin}`))
				outboundCitations += 1;
		} catch {
			/* ignore */
		}
	}

	const bodyText = visibleText(root.querySelector("body") ?? root);
	const words = wordCount(bodyText);
	const fluffRatio = marketingFluffRatio(bodyText, words);
	const specifics = specificClaims(bodyText);

	let score = 0;
	const reasons: string[] = [];
	const codes: CheckCode[] = [];

	if (genre === "article") {
		if (author) score += 25;
		else {
			reasons.push("no author byline detected");
			codes.push({ code: "citability.no_author" });
		}

		if (date) score += 25;
		else {
			reasons.push("no published/updated date");
			codes.push({ code: "citability.no_date" });
		}

		if (outboundCitations >= 3) score += 25;
		else if (outboundCitations >= 1) score += 12;
		else {
			reasons.push("no outbound source links");
			codes.push({ code: "citability.no_outbound_citations" });
		}

		if (fluffRatio < 0.04) score += 25;
		else if (fluffRatio < 0.08) score += 12;
		else {
			reasons.push("high marketing language density");
			codes.push({ code: "citability.high_fluff", data: { ratio: fluffRatio } });
		}

		if (codes.length === 0) {
			codes.push({
				code: "citability.ok_article",
				data: { outboundCitations, fluffRatio },
			});
		}
	} else if (words < 120) {
		// Fluff density over a handful of words is noise: 19 characters of
		// title scored "substantive" because nothing in them was a superlative.
		score = 20;
		reasons.push("too little text to judge");
		codes.push({ code: "citability.thin", data: { words } });
	} else {
		// A brand page is not expected to cite sources — a plumber's homepage
		// with no outbound links is normal, and "add links to sources" is not
		// advice its owner can use. It is judged on whether the copy states
		// anything specific, and on how much of it is sales language. Until
		// 3.0 the brand branch was capped at 80, which told a page with
		// nothing left to fix that something was missing.
		score = 40;
		if (specifics >= 6) score += 35;
		else if (specifics >= 3) score += 20;
		else if (specifics >= 1) score += 8;
		else {
			reasons.push("no specific claims (numbers, years, prices, places)");
			codes.push({ code: "citability.no_specifics" });
		}

		if (fluffRatio < 0.04) score += 25;
		else if (fluffRatio < 0.08) score += 12;
		else {
			reasons.push("high marketing language density");
			codes.push({ code: "citability.high_fluff", data: { ratio: fluffRatio } });
		}

		if (codes.length === 0) {
			codes.push({
				code: "citability.ok_brand",
				data: { specifics, fluffRatio },
			});
		}
	}

	score = Math.min(100, score);

	const finding =
		reasons.length === 0
			? genre === "article"
				? "Author, date, and source links present; copy reads as substantive."
				: `Copy states specifics (${specifics} concrete figures or facts) rather than slogans.`
			: `Citability gaps: ${reasons.join("; ")}.`;

	const detail = `Genre: ${genre}. Author signal: ${author ? "yes" : "no"}. Date signal: ${date ? "yes" : "no"}. Outbound citations: ${outboundCitations}. Specific claims: ${specifics}. Marketing fluff density: ${(fluffRatio * 100).toFixed(1)}%. Words: ${words}.`;

	const fix =
		reasons.length === 0
			? genre === "article"
				? "Maintain. Add inline citations (sup/anchor links) when making factual claims."
				: "Maintain. Keep claims specific: numbers, names, dates, and what exactly is offered."
			: genre === "article"
				? "Show an author byline with credentials, expose published and updated dates in <time datetime>, and link out to primary sources when stating facts. Replace superlatives with specific numbers."
				: "State the specifics an assistant could repeat: founding year, prices or a price range, what exactly is offered, where, how many. Replace superlatives (best-in-class, world-leading) with those.";

	return {
		id: "citability",
		category: "substance",
		score,
		status: statusFor(score, reasons.length > 0),
		finding,
		detail,
		fix,
		weight: 1.0,
		codes,
	};
}

const FLUFF_TERMS = [
	"world-class",
	"cutting-edge",
	"best-in-class",
	"industry-leading",
	"revolutionary",
	"game-changing",
	"unparalleled",
	"seamless",
	"synergy",
	"empower",
	"unlock",
	"leverage",
	"holistic",
	"next-generation",
	"transform your",
	"take your",
	"elevate your",
];

function marketingFluffRatio(text: string, words: number): number {
	const lower = text.toLowerCase();
	let hits = 0;
	for (const term of FLUFF_TERMS) {
		const re = new RegExp(`\\b${term.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "g");
		const matches = lower.match(re);
		if (matches) hits += matches.length;
	}
	return hits / (words || 1);
}

/**
 * Things a reader could check: years, money, percentages, quantities with a
 * unit, phone numbers, "since 1998". Counted as distinct matches so a price
 * list does not score as fifty facts, capped so the check stays a signal of
 * specificity rather than of length.
 */
const SPECIFIC_PATTERNS = [
	/\b(?:19|20)\d{2}\b/g,
	/\b\d[\d\s.,]*\s?(?:%|kr|sek|nok|dkk|eur|€|usd|\$|gbp|£|chf)\b/gi,
	/(?:€|\$|£)\s?\d[\d.,]*/g,
	/\b\d[\d.,]*\s?(?:st|pcs|m²|m2|kvm|sqm|km|m|cm|kg|g|l|h|hours?|min|minutes?|days?|dagar|years?|år|employees|anställda|customers|kunder|clients|projects|projekt|locations|stores|butiker)\b/gi,
	/(?:\+|00)\d[\d\s()-]{7,}\d/g,
	/\b(?:since|sedan|est\.|established|founded|grundat|grundades)\s+(?:19|20)\d{2}\b/gi,
];

function specificClaims(text: string): number {
	const seen = new Set<string>();
	for (const re of SPECIFIC_PATTERNS) {
		for (const m of text.matchAll(re)) seen.add(m[0].replace(/\s+/g, " ").toLowerCase());
	}
	return Math.min(seen.size, 20);
}
