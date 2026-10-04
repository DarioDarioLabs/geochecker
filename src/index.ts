import { fetchPage } from "./fetch.js";
import { aggregate } from "./scoring.js";
import { builtinChecks, pageChecks, siteChecks } from "./checks/index.js";
import { isReadable, scanSite, unreachableResult, type SiteOptions } from "./site.js";
import type {
	Candidate,
	Check,
	CheckResult,
	FetchedPage,
	PageRole,
	Report,
	SiteCheck,
	SiteReport,
} from "./types.js";

export { builtinChecks, pageChecks, siteChecks };
export { scanSite, collectCandidates, defaultPick, roleOf, unreachableResult, wallOf, isReadable } from "./site.js";
export type { SiteOptions, PickPages } from "./site.js";
export { visibleText, wordCount } from "./text.js";
export { resetFetchMemo } from "./fetch.js";
export { CATEGORIES, CATEGORY_WEIGHT, aggregate, aggregateSite } from "./scoring.js";

export type RunOptions = {
	/** `Accept-Language` for the page fetch — the audience's language, so a
	 *  language-negotiating site serves the version its visitors actually see.
	 *  Defaults to English. */
	acceptLanguage?: string;
	/** Called after the page is fetched, before any checks run. */
	onFetched?: (page: FetchedPage) => void;
	/** Called once per check as it completes. */
	onCheck?: (result: CheckResult) => void;
	/** Replace the default check set entirely. */
	checks?: Check[];
	/** Add to the default check set (runs in addition to builtins). */
	extraChecks?: Check[];
	/** Called when a caller-supplied check throws. The check is dropped from the
	 *  report rather than failing the scan — see runChecks. */
	onCheckError?: (error: unknown) => void;
};

/**
 * Score ONE page. For a site — the home page plus the pages an assistant
 * would need — use `scanSite`.
 * @example
 *   const report = await runChecks("https://example.com/about");
 *   console.log(report.overall);
 */
export async function runChecks(
	url: string,
	opts: RunOptions = {},
): Promise<Report> {
	const page = await fetchPage(url, { acceptLanguage: opts.acceptLanguage });
	opts.onFetched?.(page);
	const context = { url: page.url, finalUrl: page.finalUrl, fetchedAt: page.fetchedAt };

	// An error page or a bot wall is not the page. Scoring its HTML gave a 404
	// a structure score; the status (or the wall) is the only finding there is.
	if (!isReadable(page)) {
		const r = unreachableResult(page);
		opts.onCheck?.(r);
		return aggregate([r], context);
	}

	const run = async (check: Check) => {
		const r = await check(page);
		opts.onCheck?.(r);
		return r;
	};

	// Built-in checks are pure functions over already-fetched HTML: if one
	// throws that is a bug in this package and should be loud, so they stay
	// under Promise.all.
	const builtins = opts.checks ?? builtinChecks;
	// Caller-supplied checks are a different risk. They are the extension point
	// for things this package deliberately will not do — network calls, paid
	// APIs, model inference — and any of those can fail on a Tuesday. One of
	// them throwing must cost that check and nothing else, so they are settled
	// individually and a rejection is dropped from the report.
	const extras = opts.extraChecks ?? [];

	const [builtinResults, extraResults] = await Promise.all([
		Promise.all(builtins.map(run)),
		Promise.allSettled(extras.map(run)),
	]);

	const results = [
		...builtinResults,
		...extraResults.flatMap((r) => {
			if (r.status === "fulfilled") return [r.value];
			opts.onCheckError?.(r.reason);
			return [];
		}),
	];

	return aggregate(results, context);
}

export type StreamEvent =
	| { type: "fetched"; page: FetchedPage }
	| { type: "check"; result: CheckResult }
	| { type: "done"; report: Report };

/** Queue-backed async generator over a callback-driven run. */
function streamOf<E, R>(
	start: (push: (e: E) => void) => Promise<R>,
	done: (r: R) => E,
): AsyncGenerator<E, void, unknown> {
	const events: E[] = [];
	let terminated = false;
	let runError: unknown = null;
	let resolveNext: (() => void) | null = null;
	const wake = () => {
		const r = resolveNext;
		resolveNext = null;
		r?.();
	};
	const push = (e: E) => {
		events.push(e);
		wake();
	};
	start(push)
		.then((r) => {
			events.push(done(r));
		})
		.catch((err) => {
			runError = err;
		})
		.finally(() => {
			terminated = true;
			wake();
		});

	return (async function* () {
		while (true) {
			while (events.length) yield events.shift()!;
			if (terminated) {
				if (runError) throw runError;
				return;
			}
			await new Promise<void>((resolve) => {
				resolveNext = resolve;
			});
		}
	})();
}

/**
 * Score a page and stream events as they arrive (page fetch, each check, final report).
 * @example
 *   for await (const evt of runChecksStream("https://example.com")) {
 *     if (evt.type === "check") render(evt.result);
 *   }
 */
export function runChecksStream(
	url: string,
	opts: Omit<RunOptions, "onCheck" | "onFetched"> = {},
): AsyncGenerator<StreamEvent, void, unknown> {
	return streamOf<StreamEvent, Report>(
		(push) =>
			runChecks(url, {
				...opts,
				onFetched: (page) => push({ type: "fetched", page }),
				onCheck: (result) => push({ type: "check", result }),
			}),
		(report) => ({ type: "done", report }),
	);
}

export type SiteStreamEvent =
	| { type: "plan"; site: string; candidates: Candidate[]; pages: { url: string; role: PageRole }[] }
	| { type: "page"; page: FetchedPage; role: PageRole }
	| { type: "check"; result: CheckResult; role: PageRole; page: string }
	| { type: "done"; report: SiteReport };

/**
 * Scan a site and stream events as they arrive: the plan (which pages and
 * why), each page as it is fetched, each result, and the site report.
 * @example
 *   for await (const evt of scanSiteStream("https://example.com")) {
 *     if (evt.type === "check") render(evt.result, evt.role);
 *   }
 */
export function scanSiteStream(
	url: string,
	opts: Omit<SiteOptions, "onPlan" | "onPage" | "onCheck"> = {},
): AsyncGenerator<SiteStreamEvent, void, unknown> {
	return streamOf<SiteStreamEvent, SiteReport>(
		(push) =>
			scanSite(url, {
				...opts,
				onPlan: (plan) => push({ type: "plan", ...plan }),
				onPage: (page, role) => push({ type: "page", page, role }),
				onCheck: (result, role, page) => push({ type: "check", result, role, page }),
			}),
		(report) => ({ type: "done", report }),
	);
}

/** Score-to-status mapping, exported so a consumer building its own checks
 *  labels them the same way the built-ins do — including the rule that a check
 *  which named a problem is never `pass`. See ./scoring.ts. */
export { statusFor } from "./scoring.js";

/**
 * Helper for defining a custom page check. Returns the function as-is, with
 * type inference.
 * @example
 *   const myCheck = defineCheck(async (page) => ({
 *     id: "my-check",
 *     category: "structure",
 *     score: 100,
 *     status: "pass",
 *     finding: "Looks great.",
 *     detail: "...",
 *     fix: "Nothing to do.",
 *     weight: 1,
 *   }));
 */
export function defineCheck(check: Check): Check {
	return check;
}

/** The same, for a check that sees every page of a site scan at once. */
export function defineSiteCheck(check: SiteCheck): SiteCheck {
	return check;
}

export type {
	Candidate,
	Category,
	CategoryScore,
	Check,
	CheckCode,
	CheckResult,
	FetchedPage,
	PageReport,
	PageRole,
	Report,
	SiteCheck,
	SiteInput,
	SiteReport,
	Status,
} from "./types.js";
