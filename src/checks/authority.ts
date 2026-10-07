import { parse } from "node-html-parser";
import type { CheckCode, CheckResult, FetchedPage, SiteInput } from "../types.js";
import { statusFor } from "../scoring.js";

const ABOUT_PATTERNS = [
	/\babout\b/i,
	/\bom\b/i,
	/\bteam\b/i,
	/\bcompany\b/i,
];

// A way to reach a person: a contact page, or the customer-service page a
// shop calls it by.
const CONTACT_PATTERNS = [
	/\bcontact\b/i,
	/\bkontakt\b/i,
	/\bkundservice\b/i,
	/\bkundtj[aä]nst\b/i,
	/\bcustomer[- ]?service\b/i,
	/\bsupport\b/i,
];

/** The identity signals one page carries. */
export type AuthorityFacts = {
	hasOrg: boolean;
	sameAsCount: number;
	hasLogo: boolean;
	aboutLink: boolean;
	contactLink: boolean;
	mailto: boolean;
	tel: boolean;
};

export function authorityFacts(page: FetchedPage): AuthorityFacts {
	const root = parse(page.html);

	let hasOrg = false;
	let sameAsCount = 0;
	let hasLogo = false;

	for (const block of root.querySelectorAll('script[type="application/ld+json"]')) {
		try {
			const parsed = JSON.parse(block.text);
			const items = flatten(parsed);
			for (const item of items) {
				const t = item["@type"];
				const isOrg =
					t === "Organization" ||
					t === "LocalBusiness" ||
					(Array.isArray(t) && t.some((v: unknown) => v === "Organization" || v === "LocalBusiness"));
				if (isOrg) {
					hasOrg = true;
					// The best-described Organization node counts; a second,
					// sparser one (a publisher stub inside an Article) used to
					// overwrite the first.
					const n = Array.isArray(item.sameAs) ? item.sameAs.length : typeof item.sameAs === "string" ? 1 : 0;
					sameAsCount = Math.max(sameAsCount, n);
					if (item.logo) hasLogo = true;
				}
			}
		} catch {
			/* ignore */
		}
	}

	const links = root.querySelectorAll("a[href]");
	let aboutLink = false;
	let contactLink = false;
	let mailto = false;
	let tel = false;

	for (const a of links) {
		const href = a.getAttribute("href") || "";
		const text = (a.text || "").trim();
		if (href.startsWith("mailto:")) mailto = true;
		if (href.startsWith("tel:")) tel = true;
		if (
			ABOUT_PATTERNS.some((p) => p.test(href) || p.test(text)) &&
			href !== "" &&
			!href.startsWith("#")
		)
			aboutLink = true;
		if (
			CONTACT_PATTERNS.some((p) => p.test(href) || p.test(text)) &&
			href !== "" &&
			!href.startsWith("#")
		)
			contactLink = true;
	}
	return { hasOrg, sameAsCount, hasLogo, aboutLink, contactLink, mailto, tel };
}

export async function checkAuthority(page: FetchedPage): Promise<CheckResult> {
	return authorityResult(authorityFacts(page));
}

/**
 * Identity is the SITE's, not each page's: an email address on the contact
 * page, or Organization markup on the home page, answers "who is behind this"
 * for the whole site. Scored per page, every inner page without its own
 * markup failed and the report told a shop whose customer-service page
 * carries mailto: and tel: links to "expose at least one mailto: address"
 * (lyko.com, 2026-10-07). Each signal counts wherever it is found, and the
 * detail names the page.
 */
export async function checkAuthoritySite(input: SiteInput): Promise<CheckResult> {
	const merged: AuthorityFacts = { hasOrg: false, sameAsCount: 0, hasLogo: false, aboutLink: false, contactLink: false, mailto: false, tel: false };
	const where: Partial<Record<keyof AuthorityFacts, string>> = {};
	for (const { page } of input.pages) {
		const f = authorityFacts(page);
		const path = pathOf(page.finalUrl);
		for (const k of Object.keys(merged) as (keyof AuthorityFacts)[]) {
			if (k === "sameAsCount") {
				if (f.sameAsCount > merged.sameAsCount) {
					merged.sameAsCount = f.sameAsCount;
					where.sameAsCount = path;
				}
			} else if (f[k] && !merged[k]) {
				merged[k] = true;
				where[k] = path;
			}
		}
	}
	return authorityResult(merged, where, input.pages.length);
}

function pathOf(url: string): string {
	try {
		const u = new URL(url);
		return u.pathname + u.search;
	} catch {
		return url;
	}
}

function authorityResult(
	f: AuthorityFacts,
	where?: Partial<Record<keyof AuthorityFacts, string>>,
	pageCount = 1,
): CheckResult {
	const { hasOrg, sameAsCount, hasLogo, aboutLink, contactLink, mailto, tel } = f;
	let score = 0;
	const issues: string[] = [];
	const codes: CheckCode[] = [];

	if (hasOrg) score += 30;
	else {
		issues.push("no Organization schema");
		codes.push({ code: "authority.no_organization" });
	}

	if (sameAsCount >= 3) score += 25;
	else if (sameAsCount >= 1) score += 12;
	else if (hasOrg) {
		issues.push("Organization has no sameAs links");
		codes.push({ code: "authority.no_sameas" });
	}

	if (hasLogo) score += 10;

	if (aboutLink) score += 15;
	else {
		issues.push("no About page link");
		codes.push({ code: "authority.no_about_link" });
	}

	if (contactLink || mailto) score += 10;
	else {
		issues.push("no contact link or mailto");
		codes.push({ code: "authority.no_contact" });
	}

	if (tel) score += 10;

	score = Math.min(100, score);

	if (codes.length === 0) {
		codes.push({
			code: "authority.ok",
			data: { sameAsCount, hasLogo, aboutLink, contactLink, mailto, tel },
		});
	}

	// Logo and phone are worth points but are not "gaps" — so a 90 used to be
	// announced as "all present" while its own detail said "Logo: no". Name
	// what is missing instead.
	const optionalMissing = [
		!hasLogo && "no logo in the Organization schema",
		!tel && "no tel: link",
	].filter((x): x is string => Boolean(x));
	const finding =
		issues.length === 0
			? optionalMissing.length === 0
				? "Organization schema, sameAs links, About, and contact signals all present."
				: `Organization schema, sameAs links, About, and contact signals present; ${optionalMissing.join(", ")}.`
			: `Identity gaps: ${issues.join("; ")}.`;

	// On a site scan each "yes" names the page it was found on.
	const yes = (k: keyof AuthorityFacts) => (where?.[k] ? `yes (${where[k]})` : "yes");
	const scope = where ? ` Across the ${pageCount} page${pageCount === 1 ? "" : "s"} read.` : "";
	const detail = `Organization schema: ${hasOrg ? yes("hasOrg") : "no"}. sameAs entries: ${sameAsCount}${where?.sameAsCount ? ` (${where.sameAsCount})` : ""}. Logo in schema: ${hasLogo ? yes("hasLogo") : "no"}. About link: ${aboutLink ? yes("aboutLink") : "no"}. Contact link: ${contactLink ? yes("contactLink") : "no"}. mailto: ${mailto ? yes("mailto") : "no"}. tel: ${tel ? yes("tel") : "no"}.${scope}`;

	// The advice names only what is missing — a site with a mailto: link was
	// told to add one.
	const steps = [
		!hasOrg
			? "Add Organization JSON-LD to the home page, with sameAs links to your verified profiles (LinkedIn, X, GitHub, Crunchbase) and your logo."
			: sameAsCount === 0
				? "Add sameAs links to your verified profiles (LinkedIn, X, GitHub, Crunchbase) to the Organization JSON-LD."
				: null,
		!aboutLink ? "Link prominently to an About page." : null,
		!contactLink && !mailto ? "Link to a contact page and expose at least one mailto: address." : null,
	].filter((x): x is string => Boolean(x));
	const fix = issues.length === 0 ? "Maintain. Add Person schema with credentials for any individual authors." : steps.join(" ");

	return {
		id: "authority",
		// On-page markup and links that say who is behind the site — not
		// reputation, which no page scanner can see. Hence `identity`.
		category: "identity",
		score,
		status: statusFor(score, issues.length > 0),
		finding,
		detail,
		fix,
		weight: 1.0,
		codes,
	};
}

type Json = Record<string, unknown>;

function flatten(node: unknown): Json[] {
	const out: Json[] = [];
	const walk = (n: unknown) => {
		if (!n || typeof n !== "object") return;
		if (Array.isArray(n)) {
			for (const x of n) walk(x);
			return;
		}
		out.push(n as Json);
		const graph = (n as Json)["@graph"];
		if (Array.isArray(graph)) for (const g of graph) walk(g);
	};
	walk(node);
	return out;
}
