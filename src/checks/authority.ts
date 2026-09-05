import { parse } from "node-html-parser";
import type { CheckCode, CheckResult, FetchedPage } from "../types.js";
import { statusFor } from "../scoring.js";

const ABOUT_PATTERNS = [
	/\babout\b/i,
	/\bom\b/i,
	/\bteam\b/i,
	/\bcompany\b/i,
];

const CONTACT_PATTERNS = [/\bcontact\b/i, /\bkontakt\b/i];

export async function checkAuthority(
	page: FetchedPage,
): Promise<CheckResult> {
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
					if (Array.isArray(item.sameAs)) sameAsCount = item.sameAs.length;
					else if (typeof item.sameAs === "string") sameAsCount = 1;
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
			: `Authority gaps: ${issues.join("; ")}.`;

	const detail = `Organization schema: ${hasOrg ? "yes" : "no"}. sameAs entries: ${sameAsCount}. Logo in schema: ${hasLogo ? "yes" : "no"}. About link: ${aboutLink ? "yes" : "no"}. Contact link: ${contactLink ? "yes" : "no"}. mailto: ${mailto ? "yes" : "no"}. tel: ${tel ? "yes" : "no"}.`;

	const fix =
		issues.length === 0
			? "Maintain. Add Person schema with credentials for any individual authors."
			: "Add Organization JSON-LD with sameAs links to your verified social profiles (LinkedIn, X, GitHub, Crunchbase). Link prominently to /about and /contact. Expose at least one mailto: address.";

	return {
		id: "authority",
		category: "authority",
		score,
		status: statusFor(score, issues.length > 0),
		finding,
		detail,
		fix,
		weight: 1.2,
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
