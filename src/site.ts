import { parse } from "node-html-parser";
import { pageChecks as builtinPageChecks, siteChecks as builtinSiteChecks } from "./checks/index.js";
import { checkAuthority, checkAuthoritySite } from "./checks/authority.js";
import { fetchPage, hostOf, normalizeUrl, originOf, sitemapUrls } from "./fetch.js";
import { aggregate, aggregateSite } from "./scoring.js";
import type {
	Candidate,
	Check,
	CheckResult,
	FetchedPage,
	PageReport,
	PageRole,
	SiteCheck,
	SiteReport,
} from "./types.js";

/**
 * Page families never offered: they state nothing about the business, and
 * picking them is exactly how an early multi-page scan went wrong (it read
 * /tos and /login).
 */
const EXCLUDED_PATH =
	/(login|logga-?in|signin|sign-?up|register|account|konto|my-?pages?|mypages|mina-?sidor|order|wishlist|favou?rites|cart|kundvagn|checkout|kassa|basket|search|\/sok\b|s%C3%B6k|privacy|integritet|cookie|terms|villkor|gdpr|legal|policy|impressum|sitemap|feed|rss|wp-admin|wp-login|password|unsubscribe|(select|choose)-?(your-)?(country|region|language|location)|country-region|\.(pdf|jpe?g|png|gif|svg|webp|zip|xml|json|css|js)(\?|$))/i;

/** The role a path or link label suggests, in the languages our sites speak.
 *  Order matters: the first pattern that matches wins, and `contact` is tested
 *  late because "contact" appears inside other words less than "about" does. */
const ROLE_PATTERNS: [PageRole, RegExp][] = [
	["about", /\b(about|about-?us|om|om-?oss|om-?foretaget|om-?f%C3%B6retaget|over-?ons|ueber-?uns|uber-?uns|%C3%BCber-?uns|a-?propos|chi-?siamo|sobre|quienes-?somos|company|who-?we-?are|our-?story|team|tietoa)\b/i],
	["prices", /\b(pricing|prices?|priser|prislista|preise|prijzen|tarifs?|precios|plans|planer|hinnat|hinnasto|rates|packages|paket)\b/i],
	["services", /\b(services?|tjanster|tj%C3%A4nster|tjenester|palvelut|diensten|leistungen|dienstleistungen|what-?we-?do|solutions|losningar|l%C3%B6sningar|offer|erbjudande|treatments|behandlingar|menu|meny)\b/i],
	["products", /\b(products?|produkter|produkte|producten|tuotteet|shop|store|butik|catalog(ue)?|katalog|sortiment|collections?|kollektion|assortment|range)\b/i],
	["contact", /\b(contact|contact-?us|kontakt|kontakta-?oss|contacto|contatti|yhteystiedot|find-?us|hitta-?hit|visit|besok|bes%C3%B6k|hours|oppettider|%C3%B6ppettider|book|boka|booking|kundservice|customer-?service|support)\b/i],
];

export function roleOf(path: string, label: string | null): PageRole {
	// The last segment names the page (/about-us/contact is a contact page);
	// the whole path and the link label are the fallbacks.
	const last = path.replace(/\?.*$/, "").split("/").filter(Boolean).pop() ?? "";
	const subjects = [last.replace(/[_.-]+/g, " "), `${path.replace(/[/_.-]+/g, " ")} ${label ?? ""}`];
	for (const subject of subjects) {
		for (const [role, re] of ROLE_PATTERNS) if (re.test(subject)) return role;
	}
	return "other";
}

/** `/`, or a locale root like `/en/` or `/sv-se/` — the home page again. */
function isHomePath(path: string): boolean {
	return /^\/?$/.test(path) || /^\/[a-z]{2}(?:[-_][a-z]{2})?\/?$/i.test(path);
}

function cleanPath(u: URL): string {
	return (u.pathname.replace(/\/+$/, "") || "/") + (u.search || "");
}

/**
 * Where an assistant could be sent on this site: the home page's links (nav
 * first), then the sitemap. Same site only (either the entered or the final
 * origin — a brand that redirects its apex to a product host still keeps its
 * marketing pages on the original one), no page family that states nothing.
 */
export function collectCandidates(
	home: FetchedPage,
	origins: string[],
	sitemap: string[],
	limits = { links: 80, sitemap: 300 },
): Candidate[] {
	const hosts = new Set(origins.map(hostOf));
	let base: URL;
	try {
		base = new URL(home.finalUrl);
	} catch {
		return [];
	}
	const seen = new Set<string>();
	const out: Candidate[] = [];
	const consider = (raw: string, label: string | null, source: Candidate["source"]) => {
		let u: URL;
		try {
			u = new URL(raw, base);
		} catch {
			return;
		}
		if (!/^https?:$/.test(u.protocol)) return;
		if (!hosts.has(hostOf(u.toString()))) return;
		u.hash = "";
		const path = cleanPath(u);
		if (isHomePath(path)) return;
		if (EXCLUDED_PATH.test(path)) return;
		const key = `${hostOf(u.toString())}${path}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ url: u.toString(), path, label, role: roleOf(path, label), source });
	};

	const root = parse(home.html);
	const labelOf = (a: { text: string; getAttribute: (n: string) => string | undefined }) => {
		const t = a.text.replace(/\s+/g, " ").trim() || a.getAttribute("aria-label")?.trim() || a.getAttribute("title")?.trim() || "";
		return t.length >= 2 && t.length <= 60 ? t : null;
	};
	let links = 0;
	for (const a of root.querySelectorAll("nav a[href], header a[href]")) {
		if (links++ >= limits.links) break;
		consider(a.getAttribute("href") ?? "", labelOf(a), "nav");
	}
	for (const a of root.querySelectorAll("a[href]")) {
		if (links++ >= limits.links) break;
		consider(a.getAttribute("href") ?? "", labelOf(a), "link");
	}
	for (const u of sitemap.slice(0, limits.sitemap)) consider(u, null, "sitemap");
	return out;
}

const ROLE_ORDER: PageRole[] = ["about", "services", "products", "prices", "contact"];
const SOURCE_RANK: Record<Candidate["source"], number> = { nav: 0, link: 1, sitemap: 2 };

/**
 * Without a model: one page per role, in the order an assistant would want
 * them, a navigation link before a sitemap entry, a shorter path before a
 * deeper one. Returns fewer than `max` rather than padding with pages it
 * cannot name a reason for.
 */
export function defaultPick(candidates: Candidate[], max: number): Candidate[] {
	const picks: Candidate[] = [];
	for (const role of ROLE_ORDER) {
		if (picks.length >= max) break;
		const best = candidates
			.filter((c) => c.role === role)
			.sort(
				(a, b) =>
					SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
					a.path.split("/").length - b.path.split("/").length ||
					a.path.length - b.path.length,
			)[0];
		if (best) picks.push(best);
	}
	return picks;
}

export type PickPages = (ctx: {
	home: FetchedPage;
	candidates: Candidate[];
	max: number;
}) => Candidate[] | Promise<Candidate[]>;

export type SiteOptions = {
	/** `Accept-Language` for every fetch — the audience's language. */
	acceptLanguage?: string;
	/** Pages read besides the home page (and the entered URL, if deeper).
	 *  Default 4. */
	maxPages?: number;
	/** Choose the extra pages yourself — a model given the candidates, say.
	 *  Only candidates from the list are honoured. Default: `defaultPick`. */
	pickPages?: PickPages;
	/** Replace the page-level check set. */
	checks?: Check[];
	/** Add page-level checks; run on every readable page. A throwing one is
	 *  dropped and reported through `onCheckError` — see `runChecks`. */
	extraChecks?: Check[];
	/** Replace the site-level check set (robots.txt, sitemap, llms.txt). */
	siteChecks?: SiteCheck[];
	/** Add site-level checks; run once with every readable page. Dropped on a
	 *  throw, like `extraChecks`. */
	extraSiteChecks?: SiteCheck[];
	onCheckError?: (error: unknown) => void;
	/** After the home page is read and the pages are chosen, before they are
	 *  fetched. */
	onPlan?: (plan: { site: string; candidates: Candidate[]; pages: { url: string; role: PageRole }[] }) => void;
	/** Each page as it arrives, readable or not. */
	onPage?: (page: FetchedPage, role: PageRole) => void;
	/** Each result as it completes, with the role and URL of the page it was
	 *  measured on. Site-level results carry role `home` and the site origin. */
	onCheck?: (result: CheckResult, role: PageRole, page: string) => void;
};

/**
 * Score a SITE: always its home page, the entered URL if it is a deeper page,
 * and the pages an assistant would need — About, Services or Products, Prices,
 * Contact — found among the home page's links and the sitemap.
 *
 * Why the site and not the URL: inner pages are worse than the home page on
 * two sites in three, and more than half of sites have a problem the home
 * page hides. Assistants cite the page that answers, which is rarely the
 * home page.
 */
export async function scanSite(url: string, opts: SiteOptions = {}): Promise<SiteReport> {
	const entered = normalizeUrl(url);
	const enteredUrl = new URL(entered);
	const homeUrl = `${enteredUrl.origin}/`;
	const isDeep = cleanPath(enteredUrl) !== "/";
	const fetchOpts = { acceptLanguage: opts.acceptLanguage };

	const home = await fetchPage(homeUrl, fetchOpts);
	opts.onPage?.(home, "home");
	const finalOrigin = originOf(home.finalUrl);
	const site = `${finalOrigin}/`;
	const fetchedAt = home.fetchedAt;

	if (!isReadable(home)) {
		// Nothing to scan. Say so with one result rather than scoring the
		// error page or the bot wall as if it were the site.
		const unreachable = unreachableResult(home);
		opts.onCheck?.(unreachable, "home", home.finalUrl);
		const page = pageReport(home, "home", [unreachable]);
		opts.onPlan?.({ site, candidates: [], pages: [{ url: home.finalUrl, role: "home" }] });
		return {
			url: entered,
			site,
			...aggregateSite([page], [], { url: entered, site, fetchedAt }),
			pages: [page],
			candidates: [],
			fetchedAt,
		};
	}

	const origins = [...new Set([enteredUrl.origin, finalOrigin])];
	const sitemap = (await Promise.all(origins.map((o) => sitemapUrls(o)))).flat();
	const candidates = collectCandidates(home, origins, sitemap);
	const max = Math.max(0, opts.maxPages ?? 4);
	const allowed = new Map(candidates.map((c) => [c.url, c]));
	const picked = opts.pickPages
		? (await opts.pickPages({ home, candidates, max }))
				.map((p) => allowed.get(p.url))
				.filter((c): c is Candidate => Boolean(c))
		: defaultPick(candidates, max);

	const planned: { url: string; role: PageRole }[] = [{ url: home.finalUrl, role: "home" }];
	const taken = new Set([home.finalUrl, home.url]);
	const add = (u: string, role: PageRole) => {
		if (taken.has(u)) return;
		taken.add(u);
		planned.push({ url: u, role });
	};
	if (isDeep) add(entered, "entered");
	for (const c of picked.slice(0, max)) add(c.url, c.role);
	opts.onPlan?.({ site, candidates, pages: planned });

	// Every other page in parallel; one that cannot be fetched is listed as
	// unreadable, never thrown — the entered URL being down is a finding, a
	// candidate being down is our pick.
	const fetched: { page: FetchedPage; role: PageRole }[] = [
		{ page: home, role: "home" },
		...(await Promise.all(
			planned.slice(1).map(async ({ url: u, role }) => {
				try {
					const page = await fetchPage(u, fetchOpts);
					opts.onPage?.(page, role);
					return { page, role };
				} catch {
					const page: FetchedPage = { url: u, finalUrl: u, status: 0, html: "", headers: {}, fetchedAt: new Date().toISOString() };
					opts.onPage?.(page, role);
					return { page, role };
				}
			}),
		)),
	];
	// A pick that redirected onto a page already in the scan is the same page.
	const unique = fetched.filter(
		(f, i) => fetched.findIndex((g) => g.page.finalUrl === f.page.finalUrl) === i,
	);

	// Identity is scored once for the site (checkAuthoritySite), not per page.
	const pageChecks = opts.checks ?? builtinPageChecks.filter((c) => c !== checkAuthority);
	const extraChecks = opts.extraChecks ?? [];
	const pages: PageReport[] = await Promise.all(
		unique.map(async ({ page, role }) => {
			if (!isReadable(page)) {
				const r = unreachableResult(page);
				opts.onCheck?.(r, role, page.finalUrl);
				return pageReport(page, role, [r]);
			}
			const run = async (check: Check) => {
				const r = await check(page);
				opts.onCheck?.(r, role, page.finalUrl);
				return r;
			};
			const [builtin, extra] = await Promise.all([
				Promise.all(pageChecks.map(run)),
				Promise.allSettled(extraChecks.map(run)),
			]);
			const results = [...builtin, ...settled(extra, opts.onCheckError)];
			return pageReport(page, role, results);
		}),
	);

	const readable = unique.filter((f) => isReadable(f.page));
	const siteInput = { site, pages: readable };
	const runSite = async (check: SiteCheck) => {
		const r = await check(siteInput);
		r.scope = "site";
		opts.onCheck?.(r, "home", site);
		return r;
	};
	// Built-in site checks take the home page: robots.txt and the sitemap are
	// the site's, whichever page was asked about.
	const builtinSite = (opts.siteChecks ?? [...builtinSiteChecks.map(fromPageCheck), ...(opts.checks ? [] : [checkAuthoritySite])]).map(runSite);
	const extraSite = (opts.extraSiteChecks ?? []).map(runSite);
	const [siteBuiltin, siteExtra] = await Promise.all([
		Promise.all(builtinSite),
		Promise.allSettled(extraSite),
	]);
	const siteResults = [...siteBuiltin, ...settled(siteExtra, opts.onCheckError)];

	return {
		url: entered,
		site,
		...aggregateSite(pages, siteResults, { url: entered, site, fetchedAt }),
		pages,
		candidates,
		fetchedAt,
	};
}

/** A built-in site-level check is written as a page check over the home page. */
function fromPageCheck(check: Check): SiteCheck {
	return async (input) => check(input.pages[0].page);
}

function settled(
	results: PromiseSettledResult<CheckResult>[],
	onError?: (error: unknown) => void,
): CheckResult[] {
	return results.flatMap((r) => {
		if (r.status === "fulfilled") return [r.value];
		onError?.(r.reason);
		return [];
	});
}

function pageReport(page: FetchedPage, role: PageRole, results: CheckResult[]): PageReport {
	const unreadable = !isReadable(page);
	return {
		...aggregate(results, { url: page.url, finalUrl: page.finalUrl, fetchedAt: page.fetchedAt }),
		role,
		status: page.status,
		unreadable,
	};
}

/**
 * The security layer answered instead of the site. Scoring the challenge page
 * as the page is wrong twice: it is not the page, and the wall IS the finding
 * — a service that turns away an unknown bot from a datacentre is likely to
 * be turning away AI crawlers too, unless told otherwise. Markers only; no
 * network, no API.
 */
export function wallOf(page: Pick<FetchedPage, "status" | "html" | "headers">): string | null {
	const h = page.html.slice(0, 40_000);
	if (page.headers["cf-mitigated"] === "challenge") return "Cloudflare";
	if (/Attention Required! \| Cloudflare|Sorry, you have been blocked|cf-error-details|challenge-platform|Just a moment\.\.\./i.test(h)) return "Cloudflare";
	if (/Access Denied.*Reference #\d|AkamaiGHost/is.test(h)) return "Akamai";
	if (/_Incapsula_Resource|Incapsula incident ID/i.test(h)) return "Imperva";
	if (/Access Denied - Sucuri Website Firewall/i.test(h)) return "Sucuri";
	if (/px-captcha|_pxAppId|PerimeterX/i.test(h)) return "PerimeterX";
	if (/datadome/i.test(h) && /captcha|blocked/i.test(h)) return "DataDome";
	if (page.status === 403 && /captcha|bot detection|automated access/i.test(h)) return "the site's security service";
	return null;
}

/** Whether a fetched page can be scored at all: it answered, it is not an
 *  error, and it is not a bot wall. */
export function isReadable(page: FetchedPage): boolean {
	return page.status > 0 && page.status < 400 && wallOf(page) === null;
}

/**
 * The one result an error page or a bot wall gets. Scoring a 404's HTML as
 * the page was wrong twice: it is not the page, and the status IS the finding.
 */
export function unreachableResult(page: FetchedPage): CheckResult {
	const status = page.status;
	const wall = wallOf(page);
	if (wall) {
		return {
			id: "reachable",
			category: "access",
			score: 0,
			status: "fail",
			finding: `${wall} blocked the scanner before it could read the page.`,
			detail: `${page.finalUrl} answered with a ${wall} challenge page (HTTP ${status}) rather than the content. A bot wall that stops an unknown crawler from a datacentre address stops the AI crawlers the same way unless they are allowed through.`,
			fix: `Allow the AI search and live-fetch crawlers (OAI-SearchBot, ChatGPT-User, PerplexityBot, Claude-SearchBot, Claude-User) through ${wall} — most bot-management products have a verified-bots or AI-crawlers setting — and re-scan.`,
			weight: 1,
			codes: [{ code: "access.blocked", data: { status, blocker: wall } }],
		};
	}
	return {
		id: "reachable",
		category: "access",
		score: 0,
		status: "fail",
		finding:
			status === 0
				? "The page could not be fetched."
				: `The page answered ${status} instead of content.`,
		detail:
			status === 0
				? `${page.url} did not answer within the timeout, or the connection failed. Assistants fetching it get nothing.`
				: `${page.finalUrl} returned HTTP ${status}. An assistant fetching it gets an error page, not the content — nothing else on the page can be measured.`,
		fix:
			status >= 500
				? "Fix the server error, then re-scan."
				: status === 404 || status === 410
					? "Publish the page at this URL, or redirect it to the page that replaced it."
					: status === 401 || status === 403
						? "The page refuses the scanner. If a bot wall is in front of it, allow the AI crawlers' user agents through."
						: "Make the URL answer 200 with the page's content.",
		weight: 1,
		codes: [{ code: "access.unreachable", data: { status } }],
	};
}
