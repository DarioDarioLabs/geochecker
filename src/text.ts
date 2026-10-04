import { parse, type HTMLElement, type Node } from "node-html-parser";

/**
 * The text a reader — or a crawler that does not run JavaScript — can see.
 *
 * node-html-parser keeps the contents of <script>, <style> and <noscript> in
 * `.text`, so every word count built on it counted inline JavaScript, CSS and
 * JSON as prose. A Next.js shell with a 20 KB `__NEXT_DATA__` blob and two
 * words of copy read as "wordy" and passed the empty-shell gate; a Vite shell
 * with the same two words failed it. Measured 2026-10-04: a test page with a
 * 20-word JSON blob and a 2-word paragraph counted 23 words, 21 of them JSON.
 *
 * So: walk the tree and skip the elements whose content is never rendered.
 */
const NON_CONTENT = new Set([
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"iframe",
	"head",
]);

export function visibleText(el: HTMLElement | null | undefined): string {
	if (!el) return "";
	const parts: string[] = [];
	const walk = (node: Node) => {
		if (node.nodeType === 3) {
			parts.push(node.text);
			return;
		}
		if (node.nodeType !== 1) return;
		const tag = ((node as HTMLElement).rawTagName ?? "").toLowerCase();
		if (NON_CONTENT.has(tag)) return;
		for (const child of node.childNodes) walk(child);
	};
	walk(el);
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function wordCount(text: string): number {
	return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

/**
 * The prose of a page as a reader meets it: the main content region when the
 * page marks one, the chrome removed either way, from the start so that what
 * comes first decides what fits in `max`. For a model that should judge the
 * copy, not the markup — and not the cookie banner, which a whole-document
 * cut used to hand it first.
 *
 * Which region: `<main>` is trusted — a `<main>` that is empty before
 * JavaScript IS the page's prose, however much the footer says. An `<article>`
 * counts only when it holds most of the page's words: a WordPress home page
 * carries a 35-word teaser in an `<article>` beside nine `<section>`s of copy
 * (ipconsulting.bg), and taking the teaser as the content flagged the page as
 * a shell. Otherwise the whole document — `<body>`, or the root when the
 * parser lost the body tag, which node-html-parser does on some documents.
 *
 * Which chrome: `<nav>`, `<footer>` and `<aside>` always; a `<header>` only
 * when it is the page's (a direct child of the region, or one that holds a
 * `<nav>`) — a theme's per-section `<header class="entry-header">` is a
 * heading, not chrome, and stripping it dropped every section title.
 */
export function pageProse(html: string, max = 6000): string {
	const root = parse(html);
	const scope = root.querySelector("body") ?? root.querySelector("html") ?? root;
	const total = wordCount(visibleText(scope));
	const main = root.querySelector("main");
	const article = root.querySelector("article");
	const region =
		main ?? (article && wordCount(visibleText(article)) >= total * 0.5 ? article : scope);
	for (const el of region.querySelectorAll("nav, footer, aside")) el.remove();
	for (const el of region.querySelectorAll("header")) {
		if (el.parentNode === region || el.querySelector("nav")) el.remove();
	}
	return visibleText(region).slice(0, max);
}
