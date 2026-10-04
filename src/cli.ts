#!/usr/bin/env node
import { runChecksStream, scanSiteStream } from "./index.js";
import { CATEGORIES } from "./scoring.js";
import type { Category, CategoryScore, CheckResult, PageReport, PageRole, Report, SiteReport, Status } from "./types.js";

type Flags = {
	json: boolean;
	page: boolean;
	pages?: number;
	lang?: string;
	category?: Category;
	minScore?: number;
	help: boolean;
	url?: string;
};

function parseArgs(argv: string[]): Flags {
	const f: Flags = { json: false, page: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--json") f.json = true;
		else if (a === "--page") f.page = true;
		else if (a === "--pages") f.pages = Number(argv[++i]);
		else if (a === "--lang") f.lang = argv[++i];
		else if (a === "-h" || a === "--help") f.help = true;
		else if (a === "--category") f.category = argv[++i] as Category;
		else if (a === "--min-score") f.minScore = Number(argv[++i]);
		else if (!a.startsWith("--") && !f.url) f.url = a;
	}
	return f;
}

function help() {
	console.log(`
geochecker — open-source GEO scorer

Usage:
  geochecker <url> [options]

Scans the SITE: its home page, the URL you gave if it is a deeper page, and the
pages an assistant would need (About, Services or Products, Prices, Contact),
found among the home page's links and the sitemap.

Options:
  --page                 Score only the given page (the pre-3.0 behaviour)
  --pages <n>            Extra pages to read besides the home page (default 4)
  --lang <tag>           Accept-Language for the fetches, e.g. sv or de,en;q=0.5
  --json                 Output the full report as JSON (machine-readable)
  --category <name>      Only show checks in one category
                         (${CATEGORIES.join(" | ")})
  --min-score <n>        Exit with code 1 if the overall score < n (CI gate)
  -h, --help             Show this help

Examples:
  geochecker example.com
  geochecker https://example.com/about --page
  geochecker example.com --json | jq .overall
  geochecker example.com --min-score 70

Hosted version with an AI read of the site: https://dariodario.com/geochecker
`.trim());
}

function statusGlyph(status: Status): string {
	return status === "pass" ? "✓" : status === "warn" ? "•" : "✗";
}

function pad(s: string, n: number) {
	return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printResult(r: CheckResult, where = "") {
	console.log(`  ${statusGlyph(r.status)} ${pad(r.id, 14)} ${String(r.score).padStart(3)}/100  ${where}${r.finding}`);
}

function grade(overall: number): string {
	return overall >= 90 ? "A" : overall >= 80 ? "B" : overall >= 70 ? "C" : overall >= 60 ? "D" : "F";
}

function printCategories(categories: CategoryScore[], filter?: Category) {
	for (const cat of categories) {
		if (filter && cat.category !== filter) continue;
		console.log(`${cat.category.toUpperCase()}  (${cat.score}/100)`);
		for (const c of cat.checks) {
			printResult(c, c.page && c.scope !== "site" ? `[${pathOf(c.page)}] ` : "");
		}
		console.log("");
	}
}

function printFixes(checks: CheckResult[]) {
	const seen = new Set<string>();
	const fails = checks
		.filter((c) => c.status === "fail" && c.weight > 0)
		.sort((a, b) => a.score - b.score)
		.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
	if (fails.length) {
		console.log("Fix first:");
		for (const f of fails.slice(0, 5)) {
			console.log(`  • ${f.id}${f.page && f.scope !== "site" ? ` (${pathOf(f.page)})` : ""}: ${f.fix}`);
		}
		console.log("");
	}
}

function pathOf(url: string): string {
	try {
		const u = new URL(url);
		return (u.pathname.replace(/\/+$/, "") || "/") + u.search;
	} catch {
		return url;
	}
}

function printPageReport(report: Report, filter?: Category) {
	console.log("");
	console.log(`URL:     ${report.finalUrl}`);
	console.log(`Score:   ${report.overall}/100  (${grade(report.overall)})`);
	console.log("");
	printCategories(report.categories, filter);
	printFixes(report.checks);
}

function printSiteReport(report: SiteReport, filter?: Category) {
	console.log("");
	console.log(`Site:    ${report.site}`);
	console.log(`Score:   ${report.overall}/100  (${grade(report.overall)})`);
	console.log("");
	console.log("Pages:");
	for (const p of report.pages) {
		const line = p.unreadable
			? `unreadable (${p.status || "no answer"})`
			: `${String(p.overall).padStart(3)}/100`;
		console.log(`  ${pad(p.role, 9)} ${line}  ${p.finalUrl}`);
	}
	console.log("");
	printCategories(report.categories, filter);
	printFixes(report.checks);
}

async function main() {
	const flags = parseArgs(process.argv.slice(2));
	if (flags.help || !flags.url) {
		help();
		process.exit(flags.help ? 0 : 1);
	}
	const show = (r: CheckResult) => !flags.category || r.category === flags.category;

	let overall: number | null = null;

	if (flags.page) {
		let report: Report | null = null;
		if (!flags.json) console.log(`Fetching ${flags.url}...`);
		for await (const evt of runChecksStream(flags.url, { acceptLanguage: flags.lang })) {
			if (flags.json) {
				if (evt.type === "done") report = evt.report;
				continue;
			}
			if (evt.type === "fetched") console.log(`Fetched (${evt.page.status}). Running checks...\n`);
			else if (evt.type === "check") {
				if (show(evt.result)) printResult(evt.result);
			} else report = evt.report;
		}
		if (!report) process.exit(2);
		if (flags.json) console.log(JSON.stringify(report, null, 2));
		else printPageReport(report, flags.category);
		overall = report.overall;
	} else {
		let report: SiteReport | null = null;
		if (!flags.json) console.log(`Reading ${flags.url}...`);
		const roles: Record<string, PageRole> = {};
		for await (const evt of scanSiteStream(flags.url, { acceptLanguage: flags.lang, maxPages: flags.pages })) {
			if (flags.json) {
				if (evt.type === "done") report = evt.report;
				continue;
			}
			if (evt.type === "plan") {
				for (const p of evt.pages) roles[p.url] = p.role;
				console.log(`Site ${evt.site} — reading ${evt.pages.length} page(s): ${evt.pages.map((p) => `${p.role} ${pathOf(p.url)}`).join(" · ")}\n`);
			} else if (evt.type === "page") {
				if (evt.page.status >= 400 || evt.page.status === 0) console.log(`  ${evt.role} ${pathOf(evt.page.finalUrl)} → ${evt.page.status || "no answer"}`);
			} else if (evt.type === "check") {
				if (show(evt.result)) printResult(evt.result, evt.result.scope === "site" ? "[site] " : `[${evt.role}] `);
			} else report = evt.report;
		}
		if (!report) process.exit(2);
		if (flags.json) console.log(JSON.stringify(report, null, 2));
		else printSiteReport(report, flags.category);
		overall = report.overall;
	}

	if (!flags.json) console.log(`Hosted version with an AI read of the site → https://dariodario.com/geochecker\n`);

	if (flags.minScore != null && overall != null && overall < flags.minScore) {
		if (!flags.json) console.error(`✗ Score ${overall} below required ${flags.minScore}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Error:", err.message ?? err);
	process.exit(2);
});

export type { PageReport };
