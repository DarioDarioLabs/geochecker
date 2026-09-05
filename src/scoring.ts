import type { Category, CategoryScore, CheckResult, Report } from "./types.js";

const CATEGORY_WEIGHT: Record<Category, number> = {
	citability: 1.4,
	structure: 1.3,
	crawlability: 1.2,
	// Being invisible to non-JS crawlers is serious, but it's near-binary and
	// most server-rendered sites pass, so it sits below the content axes.
	renderability: 1.1,
	authority: 1.0,
	// Whether an engine may list the page at all. Weighted just under the content
	// axes: it is mostly binary and most sites pass, but when it fails it voids
	// everything above it — 3% of sampled prospects were serving `noindex`.
	indexability: 1.2,
	// Whether the page makes specific, quotable, attributable claims — the thing
	// citation actually depends on. No built-in check produces this: it needs
	// judgement over prose, so it is supplied by the caller via `extraChecks`.
	answerability: 1.3,
	freshness: 0.8,
};

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
/** Categories that can only lower the overall, never lift it. */
const COSTS_ONLY: ReadonlySet<Category> = new Set<Category>(["crawlability"]);

export function statusFor(
	score: number,
	hasFindings = false,
): "pass" | "warn" | "fail" {
	const base = score >= 70 ? "pass" : score >= 40 ? "warn" : "fail";
	return hasFindings && base === "pass" ? "warn" : base;
}

export function aggregate(
	checks: CheckResult[],
	context: { url: string; finalUrl: string; fetchedAt: string },
): Report {
	const byCategory = new Map<Category, CheckResult[]>();
	for (const c of checks) {
		const list = byCategory.get(c.category) ?? [];
		list.push(c);
		byCategory.set(c.category, list);
	}

	const categories: CategoryScore[] = [];
	for (const [category, items] of byCategory.entries()) {
		const totalWeight = items.reduce((s, i) => s + i.weight, 0) || 1;
		const score =
			items.reduce((s, i) => s + i.score * i.weight, 0) / totalWeight;
		categories.push({
			category,
			score: Math.round(score),
			checks: items,
		});
	}

	// A category in COSTS_ONLY enters the overall only when it has something
	// to say: at 100 it is left out of both numerator and denominator. Measured
	// across 172 real prospects, crawlability was 100 for 99% of them, and at
	// its weight it handed every site a free ~12% of the total — compressing the
	// range without telling anyone apart. Blocking the search crawlers still
	// costs the full weight; passing no longer pads.
	const counted = categories.filter(
		(c) => !(COSTS_ONLY.has(c.category) && c.score >= 100),
	);
	const totalCatWeight =
		counted.reduce((s, c) => s + CATEGORY_WEIGHT[c.category], 0) || 1;
	const overall =
		counted.reduce(
			(s, c) => s + c.score * CATEGORY_WEIGHT[c.category],
			0,
		) / totalCatWeight;

	return {
		url: context.url,
		finalUrl: context.finalUrl,
		overall: Math.round(overall),
		categories: categories.sort((a, b) =>
			a.category.localeCompare(b.category),
		),
		checks,
		fetchedAt: context.fetchedAt,
	};
}
