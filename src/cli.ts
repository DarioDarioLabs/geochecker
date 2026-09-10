#!/usr/bin/env node
import { runChecksStream } from "./index.js";
import type { Status, Category, CheckResult, Report } from "./types.js";

type Flags = {
	json: boolean;
	category?: Category;
	minScore?: number;
	help: boolean;
	url?: string;
};

function parseArgs(argv: string[]): Flags {
	const f: Flags = { json: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--json") f.json = true;
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

Options:
  --json                 Output the full report as JSON (machine-readable)
  --category <name>      Only show checks in one category
                         (structure | citability | crawlability | freshness | authority)
  --min-score <n>        Exit with code 1 if overall score < n (CI gate)
  -h, --help             Show this help

Examples:
  geochecker https://example.com
  geochecker https://example.com --json | jq .
  geochecker https://example.com --min-score 70

Hosted version with an AI read of the page: https://dariodario.com/geochecker
`.trim());
}

function statusGlyph(status: Status): string {
	return status === "pass" ? "✓" : status === "warn" ? "•" : "✗";
}

function pad(s: string, n: number) {
	return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printResult(r: CheckResult) {
	console.log(`  ${statusGlyph(r.status)} ${pad(r.id, 16)} ${String(r.score).padStart(3)}/100  ${r.finding}`);
}

function printReport(report: Report, filterCategory?: Category) {
	const grade =
		report.overall >= 90 ? "A" :
		report.overall >= 80 ? "B" :
		report.overall >= 70 ? "C" :
		report.overall >= 60 ? "D" : "F";

	console.log("");
	console.log(`URL:     ${report.finalUrl}`);
	console.log(`Score:   ${report.overall}/100  (${grade})`);
	console.log("");

	for (const cat of report.categories) {
		if (filterCategory && cat.category !== filterCategory) continue;
		console.log(`${cat.category.toUpperCase()}  (${cat.score}/100)`);
		for (const c of cat.checks) printResult(c);
		console.log("");
	}

	const fails = report.checks.filter((c) => c.status === "fail");
	if (fails.length) {
		console.log("Top fixes:");
		for (const f of fails.slice(0, 5)) {
			console.log(`  • ${f.id}: ${f.fix}`);
		}
		console.log("");
	}
}

async function main() {
	const flags = parseArgs(process.argv.slice(2));
	if (flags.help || !flags.url) {
		help();
		process.exit(flags.help ? 0 : 1);
	}

	let report: Report | null = null;
	if (!flags.json) {
		console.log(`Fetching ${flags.url}...`);
	}

	for await (const evt of runChecksStream(flags.url)) {
		if (flags.json) {
			if (evt.type === "done") report = evt.report;
			continue;
		}
		if (evt.type === "fetched") {
			console.log(`Fetched (${evt.page.status}). Running checks...\n`);
		} else if (evt.type === "check") {
			if (!flags.category || evt.result.category === flags.category) {
				printResult(evt.result);
			}
		} else if (evt.type === "done") {
			report = evt.report;
		}
	}

	if (!report) process.exit(2);
	if (flags.json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		printReport(report, flags.category);
		console.log(`Hosted version with an AI read of the page → https://dariodario.com/geochecker\n`);
	}

	if (flags.minScore != null && report.overall < flags.minScore) {
		if (!flags.json) {
			console.error(`✗ Score ${report.overall} below required ${flags.minScore}`);
		}
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Error:", err.message ?? err);
	process.exit(2);
});
