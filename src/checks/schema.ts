import { parse } from "node-html-parser";
import type { CheckCode, CheckResult, FetchedPage } from "../types.js";
import { statusFor } from "../scoring.js";

const RECOGNIZED = new Set([
	"Organization",
	"LocalBusiness",
	"Article",
	"NewsArticle",
	"BlogPosting",
	"Product",
	"FAQPage",
	"HowTo",
	"Person",
	"WebSite",
	"WebPage",
	"BreadcrumbList",
	"SoftwareApplication",
	"Service",
]);

/** Types that describe the page itself, as opposed to the site or its owner. */
const PAGE_TYPES = new Set([
	"Article",
	"NewsArticle",
	"BlogPosting",
	"Product",
	"FAQPage",
	"HowTo",
	"WebPage",
	"SoftwareApplication",
	"Service",
]);

type Json = Record<string, unknown>;

export async function checkSchema(page: FetchedPage): Promise<CheckResult> {
	const root = parse(page.html);
	const blocks = root
		.querySelectorAll('script[type="application/ld+json"]')
		.map((n) => n.text);

	const parsed: Json[] = [];
	let invalid = 0;
	for (const block of blocks) {
		try {
			const json = JSON.parse(block) as Json | Json[];
			if (Array.isArray(json)) {
				for (const j of json) if (j && typeof j === "object") parsed.push(j);
			} else if (json && typeof json === "object") {
				parsed.push(json);
			}
		} catch {
			invalid += 1;
		}
	}

	const types = new Set<string>();
	const items = flatten(parsed);
	for (const item of items) {
		const t = item["@type"];
		if (typeof t === "string") types.add(t);
		else if (Array.isArray(t)) for (const v of t) if (typeof v === "string") types.add(v);
	}

	const recognized = [...types].filter((t) => RECOGNIZED.has(t));
	const hasOrg = types.has("Organization") || types.has("LocalBusiness");
	// A type that says what THIS page is. Until 3.0 only an Article counted,
	// so no brand page could reach 100 — "add Article schema" is not advice a
	// shop or a clinic can use, and a page with nothing left to fix was told
	// something was missing.
	const hasPageType = recognized.some((t) => PAGE_TYPES.has(t));

	// Answerability (folded-in AEO signal): FAQPage/QAPage schema whose
	// questions are wired to acceptedAnswer is directly extractable by answer
	// engines. Reward proper wiring; note the shell (FAQ type, no answers).
	const faq = analyzeFaq(items, types);

	let score = 0;
	if (parsed.length === 0) {
		score = 0;
	} else {
		score += 35;
		if (recognized.length > 0) score += 25;
		if (hasOrg) score += 20;
		if (hasPageType) score += 15;
		if (invalid === 0) score += 5;
		if (faq === "wired") score += 10;
	}
	score = Math.min(100, score);

	let finding: string;
	let detail: string;
	let fix: string;
	// True on every branch that names a gap, so a well-scoring page with (say)
	// no Organization schema is not labelled `pass` next to that sentence.
	let hasFindings = true;
	const codes: CheckCode[] = [];

	if (parsed.length === 0) {
		finding = "No structured data detected.";
		detail =
			"No JSON-LD blocks found in the page source. LLMs use structured data to identify entities, articles, and authority signals.";
		fix =
			"Add a JSON-LD <script type=\"application/ld+json\"> block. Start with Organization (name, url, sameAs to social profiles) and add Article or Product schema on relevant pages.";
		codes.push({ code: "schema.no_jsonld" });
	} else if (invalid > 0) {
		finding = `${parsed.length} JSON-LD block(s) found, ${invalid} could not be parsed.`;
		detail = `Recognized types: ${[...types].join(", ") || "none"}. ${invalid} block(s) contained invalid JSON.`;
		fix = "Validate JSON-LD with a linter before deploy. Invalid blocks are silently dropped by Google and most LLM crawlers.";
		codes.push({
			code: "schema.invalid_blocks",
			data: { invalidCount: invalid, totalCount: parsed.length + invalid },
		});
	} else if (!hasOrg) {
		finding = "Structured data present, but no Organization schema.";
		detail = `Recognized types: ${[...types].join(", ") || "none"}. Without Organization, entity resolution falls back to name-matching.`;
		fix =
			"Add Organization schema with name, url, logo, and sameAs links to your verified social profiles (LinkedIn, X, GitHub).";
		codes.push({
			code: "schema.no_organization",
			data: { recognizedTypes: [...types] },
		});
	} else if (!hasPageType) {
		finding = `Organization present; nothing says what this page is.`;
		detail = `Recognized types: ${[...types].join(", ")}. The entity is declared, but no page-level type (WebPage, Article, Product, Service, FAQPage…) tells an engine what it is looking at.`;
		fix =
			"Add the type this page is — WebPage on a general page, Article with author and dates on a post, Product with offers on a product page, Service, FAQPage with answers — alongside the Organization.";
		codes.push({
			code: "schema.no_page_type",
			data: { recognizedTypes: [...types] },
		});
	} else {
		hasFindings = false;
		finding = `${parsed.length} structured data block(s), Organization present.`;
		detail = `Recognized types: ${[...types].join(", ")}. Note: controlled 2026 tests (Ahrefs) found adding schema alone does not lift AI citations — its value is entity resolution and completeness, not mere presence.`;
		fix =
			"Table-stakes done. The lever now is completeness: use attribute-rich types on the pages they apply to (Product with brand/price/rating, Article with author + dates). Bare schema won't move citations on its own.";
		codes.push({
			code: "schema.ok",
			data: { blockCount: parsed.length, recognizedTypes: [...types] },
		});
	}

	if (faq === "wired") {
		codes.push({ code: "schema.faq_wired" });
	} else if (faq === "unwired") {
		codes.push({ code: "schema.faq_unwired" });
	}

	return {
		id: "schema",
		category: "structure",
		score,
		status: statusFor(score, hasFindings),
		finding,
		detail,
		fix,
		// Down-weighted from 1.4: 2026 controlled tests show bare JSON-LD does
		// not causally lift AI citations. Kept as a hygiene/entity-resolution
		// signal, not a primary lever.
		weight: 1.0,
		codes,
	};
}

/**
 * Classifies FAQ/QA structured data: "wired" = FAQPage/QAPage with at least
 * one Question carrying an acceptedAnswer; "unwired" = the type is present but
 * no answer is attached; "none" = no FAQ/QA schema at all.
 */
function analyzeFaq(items: Json[], types: Set<string>): "wired" | "unwired" | "none" {
	if (!types.has("FAQPage") && !types.has("QAPage")) return "none";
	for (const item of items) {
		const t = item["@type"];
		const isFaq =
			t === "FAQPage" ||
			t === "QAPage" ||
			(Array.isArray(t) && t.some((v) => v === "FAQPage" || v === "QAPage"));
		if (!isFaq) continue;
		const main = item["mainEntity"] ?? item["mainEntityOfPage"];
		const questions = Array.isArray(main) ? main : main ? [main] : [];
		for (const q of questions) {
			if (q && typeof q === "object") {
				const ans = (q as Json)["acceptedAnswer"] ?? (q as Json)["suggestedAnswer"];
				if (ans && typeof ans === "object") return "wired";
			}
		}
	}
	return "unwired";
}

function flatten(items: Json[]): Json[] {
	const out: Json[] = [];
	const walk = (node: unknown) => {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const n of node) walk(n);
			return;
		}
		out.push(node as Json);
		const graph = (node as Json)["@graph"];
		if (Array.isArray(graph)) for (const g of graph) walk(g);
	};
	for (const item of items) walk(item);
	return out;
}
