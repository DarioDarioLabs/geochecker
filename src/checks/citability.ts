import { parse } from "node-html-parser";
import type { CheckCode, CheckResult, FetchedPage } from "../types.js";
import { statusFor } from "../scoring.js";
import { detectGenre } from "../genre.js";

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

	const bodyText = (root.querySelector("body")?.text ?? root.text)
		.replace(/\s+/g, " ")
		.trim();
	const fluffRatio = marketingFluffRatio(bodyText);

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
	} else {
		// A brand page is not expected to cite sources — a plumber's homepage
		// with no outbound links is normal, and "add links to sources" is not
		// advice its owner can use. Outbound links are reported in the detail
		// but neither scored nor listed as a gap; what a brand page IS judged
		// on is whether its copy says anything specific (fluff density).
		score = 55;

		// Fluff density over a handful of words is noise: 19 characters of
		// title scored "substantive" because nothing in them was a superlative.
		const words = bodyText ? bodyText.split(" ").length : 0;
		if (words < 120) {
			score = 20;
			reasons.push("too little text to judge");
			codes.push({ code: "citability.thin", data: { words } });
		} else if (fluffRatio < 0.04) score += 25;
		else if (fluffRatio < 0.08) score += 12;
		else {
			reasons.push("high marketing language density");
			codes.push({ code: "citability.high_fluff", data: { ratio: fluffRatio } });
		}

		score = Math.min(80, score);

		if (codes.length === 0) {
			codes.push({
				code: "citability.ok_brand",
				data: { outboundCitations, fluffRatio },
			});
		}
	}

	score = Math.min(100, score);

	const finding =
		reasons.length === 0
			? genre === "article"
				? "Author, date, and source links present; copy reads as substantive."
				: "Copy reads as specific rather than promotional."
			: `Citability gaps: ${reasons.join("; ")}.`;

	const detail = `Genre: ${genre}. Author signal: ${author ? "yes" : "no"}. Date signal: ${date ? "yes" : "no"}. Outbound citations: ${outboundCitations}. Marketing fluff density: ${(fluffRatio * 100).toFixed(1)}%.`;

	const fix =
		reasons.length === 0
			? genre === "article"
				? "Maintain. Add inline citations (sup/anchor links) when making factual claims."
				: "Maintain. Keep claims specific: numbers, names, dates, and what exactly is offered."
			: genre === "article"
				? "Show an author byline with credentials, expose published and updated dates in <time datetime>, and link out to primary sources when stating facts. Replace superlatives with specific numbers."
				: "Cite primary sources when stating facts and replace superlatives (best-in-class, world-leading) with specific numbers and named comparisons.";

	return {
		id: "citability",
		category: "citability",
		score,
		status: statusFor(score, reasons.length > 0),
		finding,
		detail,
		fix,
		weight: 1.5,
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

function marketingFluffRatio(text: string): number {
	const lower = text.toLowerCase();
	const words = lower.split(/\s+/).filter(Boolean).length || 1;
	let hits = 0;
	for (const term of FLUFF_TERMS) {
		const re = new RegExp(`\\b${term.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "g");
		const matches = lower.match(re);
		if (matches) hits += matches.length;
	}
	return hits / words;
}
