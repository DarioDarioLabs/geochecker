import { parse } from "node-html-parser";
import { visibleText, wordCount } from "./text.js";
import type { FetchedPage } from "./types.js";

export type Genre = "article" | "brand";

const ARTICLE_PATH = /\/(blog|news|article|articles|post|posts|signals|insights|stories)\//i;

/**
 * Best-effort page genre detection. Drives genre-aware scoring in
 * citability and freshness — author/date signals are required for
 * articles but inappropriate for brand/marketing pages.
 */
export function detectGenre(page: FetchedPage): Genre {
	const root = parse(page.html);

	for (const block of root.querySelectorAll(
		'script[type="application/ld+json"]',
	)) {
		try {
			const json = JSON.parse(block.text);
			const items = Array.isArray(json) ? json : [json];
			for (const item of items) {
				if (hasArticleType(item)) return "article";
				const graph = item?.["@graph"];
				if (Array.isArray(graph)) {
					for (const g of graph) if (hasArticleType(g)) return "article";
				}
			}
		} catch {
			/* ignore */
		}
	}

	if (ARTICLE_PATH.test(page.finalUrl)) return "article";

	const articleEl = root.querySelector("article");
	if (articleEl && wordCount(visibleText(articleEl)) >= 500) return "article";

	return "brand";
}

function hasArticleType(item: unknown): boolean {
	if (!item || typeof item !== "object") return false;
	const t = (item as { "@type"?: unknown })["@type"];
	if (typeof t === "string")
		return t === "Article" || t === "NewsArticle" || t === "BlogPosting";
	if (Array.isArray(t))
		return t.some(
			(v) => v === "Article" || v === "NewsArticle" || v === "BlogPosting",
		);
	return false;
}
