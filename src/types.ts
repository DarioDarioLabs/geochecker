export type Status = "pass" | "warn" | "fail";

/**
 * Five categories since 3.0. Each answers one question a reader has:
 *
 *   access     — can an assistant get the page at all? robots.txt, noindex,
 *                canonical, sitemap, and whether the content exists before
 *                JavaScript runs. A gate, not a merit: scored as its WEAKEST
 *                check, and left out of the overall when nothing is wrong.
 *   structure  — can it parse what it got? JSON-LD, headings, meta tags.
 *   substance  — is there anything worth quoting? Specific claims, sources,
 *                and (supplied by the caller) a judgement over the prose.
 *   identity   — can it tell who is behind the site? Organization markup,
 *                About and contact affordances.
 *   freshness  — is it current?
 */
export type Category =
	| "access"
	| "structure"
	| "substance"
	| "identity"
	| "freshness";

/**
 * A structured, language-independent identifier for a specific finding within
 * a check. Frontends use these to render localized copy. Each code is
 * namespaced by check id (e.g. `structure.no_h2_sections`). Optional `data`
 * carries values for interpolation (e.g. `{ wordCount: 17 }` for
 * `structure.thin_content`).
 *
 * Code IDs are stable within a major version; the English prose in
 * `CheckResult.finding` may be rewritten freely. Treat codes as the contract.
 */
export type CheckCode = {
	code: string;
	data?: Record<string, unknown>;
};

export type CheckResult = {
	id: string;
	category: Category;
	score: number;
	status: Status;
	finding: string;
	detail: string;
	fix: string;
	weight: number;
	/** Structured codes describing the specific issues observed. Every built-in
	 *  check emits at least one. */
	codes?: CheckCode[];
	/** `site` for a check about the site rather than one page (robots.txt, the
	 *  sitemap, llms.txt) — run once per site scan. Page checks leave it unset. */
	scope?: "page" | "site";
	/** In a site report: the URL this result was measured on. Site-level
	 *  results carry the site origin. */
	page?: string;
};

export type FetchedPage = {
	url: string;
	finalUrl: string;
	status: number;
	html: string;
	headers: Record<string, string>;
	fetchedAt: string;
};

export type CategoryScore = {
	category: Category;
	score: number;
	checks: CheckResult[];
};

/** One page, scored. */
export type Report = {
	url: string;
	finalUrl: string;
	overall: number;
	categories: CategoryScore[];
	checks: CheckResult[];
	fetchedAt: string;
};

export type Check = (input: FetchedPage) => Promise<CheckResult>;

// ---- Site scanning (3.0) -------------------------------------------------------

/** Why a page is in the scan. `home` is always the site root; `entered` is a
 *  deeper URL the caller asked about; the rest are the pages an assistant would
 *  need to describe the business. */
export type PageRole =
	| "home"
	| "entered"
	| "about"
	| "services"
	| "products"
	| "prices"
	| "contact"
	| "other";

/** A page an assistant could be sent to, found on the home page or in the
 *  sitemap, with the role its path or link label suggests. */
export type Candidate = {
	url: string;
	path: string;
	/** The link text, when the candidate came from a link. */
	label: string | null;
	role: PageRole;
	source: "nav" | "link" | "sitemap";
};

export type PageReport = Report & {
	role: PageRole;
	status: number;
	/** The page answered with an error status (or not at all) and was not
	 *  scored — it does not enter the site score. */
	unreadable: boolean;
};

export type SiteReport = {
	/** What was asked for, normalised. */
	url: string;
	/** The site's origin after redirects, with a trailing slash. */
	site: string;
	overall: number;
	categories: CategoryScore[];
	/** Every result from every readable page plus the site-level ones, each
	 *  tagged with the `page` it was measured on. */
	checks: CheckResult[];
	/** The pages scanned, home first. */
	pages: PageReport[];
	/** What the scan had to choose from, so a caller can see why a page was
	 *  or was not read. */
	candidates: Candidate[];
	fetchedAt: string;
};

/** Input to a site-level check: every readable page of the scan with its
 *  role, home first. */
export type SiteInput = {
	site: string;
	pages: { page: FetchedPage; role: PageRole }[];
};

export type SiteCheck = (input: SiteInput) => Promise<CheckResult>;
