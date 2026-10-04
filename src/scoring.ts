import type {
	Category,
	CategoryScore,
	CheckResult,
	PageReport,
	Report,
} from "./types.js";

/** Display order. */
export const CATEGORIES: readonly Category[] = [
	"access",
	"structure",
	"substance",
	"identity",
	"freshness",
];

export const CATEGORY_WEIGHT: Record<Category, number> = {
	// A gate: when it is not 100 something is keeping assistants out, and that
	// voids the rest. It enters the overall only then — see COSTS_ONLY.
	access: 1.5,
	structure: 1.3,
	// Whether the site says anything specific enough to quote — the thing a
	// citation actually depends on. The parser's half is `citability`; the
	// judgement over prose is the caller's (`answerability`, via extraChecks or
	// siteChecks), and weighs more inside the category when present.
	substance: 1.6,
	identity: 1.0,
	freshness: 0.8,
};

/**
 * Categories that can only lower the overall, never lift it: at 100 they are
 * left out of both numerator and denominator. Measured across 172 real
 * prospects, crawlability was 100 for 99% of them, and at its weight it handed
 * every site a free ~12% of the total — compressing the range without telling
 * anyone apart. Since 3.0 the whole access category works this way: being
 * reachable is the baseline, not an achievement.
 */
const COSTS_ONLY: ReadonlySet<Category> = new Set<Category>(["access"]);

/**
 * Map a check's score to its status.
 *
 * `hasFindings` says whether the check actually NAMED a problem — the same
 * branch that produced its `finding` string. It matters because status used to
 * be derived from the score alone, and a check can score well while still
 * reporting real gaps: a page with one H1 rule broken out of several scored 80
 * and was labelled `pass`, so a UI rendered a green tick next to the sentence
 * "Heading structure has gaps". Green-plus-a-complaint is a contradiction, and
 * readers resolve it by trusting neither.
 *
 * So a check that named a problem cannot be `pass`; the worst it becomes is
 * `warn`. Scores are untouched — `overall` and every category score are
 * unchanged by this — because the score measures MAGNITUDE and the status
 * answers "is there something here to do?". Those are different questions and
 * conflating them is what produced the contradiction.
 */
export function statusFor(
	score: number,
	hasFindings = false,
): "pass" | "warn" | "fail" {
	const base = score >= 70 ? "pass" : score >= 40 ? "warn" : "fail";
	return hasFindings && base === "pass" ? "warn" : base;
}

/**
 * One category's score from its checks.
 *
 * Access is the weakest link: a site is either reachable or it is not, and
 * averaging a JavaScript shell (5) with four passing hygiene checks (100) gave
 * the shell a 77 — hidden by the mean, which is exactly what a gate must not
 * do. Every other category is a weighted mean, as before.
 *
 * Weight-0 checks (llms.txt) are reported but never move a category.
 */
function categoryScore(category: Category, items: CheckResult[]): number {
	const counted = items.filter((i) => i.weight > 0);
	if (counted.length === 0) return 100;
	if (COSTS_ONLY.has(category)) {
		return Math.round(Math.min(...counted.map((i) => i.score)));
	}
	const totalWeight = counted.reduce((s, i) => s + i.weight, 0);
	return Math.round(
		counted.reduce((s, i) => s + i.score * i.weight, 0) / totalWeight,
	);
}

function overallOf(categories: CategoryScore[]): number {
	const counted = categories.filter(
		(c) => !(COSTS_ONLY.has(c.category) && c.score >= 100),
	);
	const totalWeight =
		counted.reduce((s, c) => s + CATEGORY_WEIGHT[c.category], 0) || 1;
	return Math.round(
		counted.reduce((s, c) => s + c.score * CATEGORY_WEIGHT[c.category], 0) /
			totalWeight,
	);
}

function groupByCategory(checks: CheckResult[]): Map<Category, CheckResult[]> {
	const byCategory = new Map<Category, CheckResult[]>();
	for (const c of checks) {
		const list = byCategory.get(c.category) ?? [];
		list.push(c);
		byCategory.set(c.category, list);
	}
	return byCategory;
}

const byDisplayOrder = (a: CategoryScore, b: CategoryScore) =>
	CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category);

/** Score one page from its check results. */
export function aggregate(
	checks: CheckResult[],
	context: { url: string; finalUrl: string; fetchedAt: string },
): Report {
	const categories: CategoryScore[] = [];
	for (const [category, items] of groupByCategory(checks).entries()) {
		categories.push({
			category,
			score: categoryScore(category, items),
			checks: items,
		});
	}
	return {
		url: context.url,
		finalUrl: context.finalUrl,
		overall: overallOf(categories),
		categories: categories.sort(byDisplayOrder),
		checks,
		fetchedAt: context.fetchedAt,
	};
}

/**
 * Score a site from its pages and its site-level results.
 *
 * Each page-level check is first averaged across the readable pages — so a
 * four-page site does not count `structure` four times against `crawlability`
 * once — then the categories are scored from those averages exactly as for a
 * page, with the site-level results joining as single items. The returned
 * `checks` is every real result, tagged with the page it was measured on.
 */
export function aggregateSite(
	pages: PageReport[],
	siteResults: CheckResult[],
	context: { url: string; site: string; fetchedAt: string },
): { overall: number; categories: CategoryScore[]; checks: CheckResult[] } {
	const readable = pages.filter((p) => !p.unreadable);
	const all: CheckResult[] = [];
	const perId = new Map<string, { sample: CheckResult; scores: number[] }>();
	for (const p of readable) {
		for (const c of p.checks) {
			all.push({ ...c, page: c.page ?? p.finalUrl });
			const entry = perId.get(c.id) ?? { sample: c, scores: [] };
			entry.scores.push(c.score);
			perId.set(c.id, entry);
		}
	}
	const averaged: CheckResult[] = [...perId.values()].map(({ sample, scores }) => ({
		...sample,
		score: Math.round(scores.reduce((s, x) => s + x, 0) / scores.length),
	}));
	for (const c of siteResults) all.push({ ...c, page: c.page ?? context.site });

	const categories: CategoryScore[] = [];
	const scoring = groupByCategory([...averaged, ...siteResults]);
	const listing = groupByCategory(all);
	for (const [category, items] of scoring.entries()) {
		categories.push({
			category,
			score: categoryScore(category, items),
			checks: listing.get(category) ?? [],
		});
	}
	return {
		overall: readable.length === 0 ? 0 : overallOf(categories),
		categories: categories.sort(byDisplayOrder),
		checks: all,
	};
}
