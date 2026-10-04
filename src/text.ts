import type { HTMLElement, Node } from "node-html-parser";

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
