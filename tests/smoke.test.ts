// Smoke tests — keep light, don't hit external network in CI.
// Use `node --test tests/` (Node's built-in test runner, no extra deps).

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
	builtinChecks,
	defineCheck,
	runChecks,
	statusFor,
	type Check,
	type CheckResult,
	type FetchedPage,
} from "../dist/index.js";

const fakePage: FetchedPage = {
	url: "https://example.com/",
	finalUrl: "https://example.com/",
	status: 200,
	html: "<html><head><title>Example</title></head><body><h1>Hello</h1></body></html>",
	headers: { "content-type": "text/html" },
	fetchedAt: new Date().toISOString(),
};

test("builtinChecks contains all 12 built-in checks", () => {
	assert.equal(builtinChecks.length, 12);
});

test("each builtin check returns a well-formed CheckResult", async () => {
	for (const check of builtinChecks) {
		const r: CheckResult = await check(fakePage);
		assert.equal(typeof r.id, "string");
		assert.ok(r.id.length > 0, `id missing for ${check.name}`);
		assert.ok(["pass", "warn", "fail"].includes(r.status), `bad status: ${r.status}`);
		assert.ok(r.score >= 0 && r.score <= 100, `score out of range: ${r.score}`);
		assert.ok(typeof r.fix === "string");
	}
});

test("each builtin check emits at least one structured code", async () => {
	for (const check of builtinChecks) {
		const r: CheckResult = await check(fakePage);
		assert.ok(Array.isArray(r.codes), `codes missing for ${check.name}`);
		assert.ok(r.codes!.length > 0, `no codes emitted by ${check.name}`);
		for (const c of r.codes!) {
			assert.equal(typeof c.code, "string");
			assert.ok(c.code.includes("."), `code "${c.code}" should be namespaced`);
		}
	}
});

test("defineCheck is a passthrough", () => {
	const c: Check = async () => ({
		id: "x", category: "structure", score: 100, status: "pass",
		finding: "ok", detail: "ok", fix: "ok", weight: 1,
	});
	assert.equal(defineCheck(c), c);
});

// --- statusFor: a check that named a problem is never `pass` ----------------
// Status used to come from the score alone, so a check could score 80, be
// labelled `pass`, and sit under the sentence "Heading structure has gaps".
// A green tick next to a complaint is a contradiction, and a reader resolves
// it by trusting neither half.

test("statusFor keeps the plain score thresholds when nothing was found", () => {
	assert.equal(statusFor(100), "pass");
	assert.equal(statusFor(70), "pass");
	assert.equal(statusFor(69), "warn");
	assert.equal(statusFor(40), "warn");
	assert.equal(statusFor(39), "fail");
	assert.equal(statusFor(0), "fail");
});

test("statusFor caps a passing score at warn when the check named a problem", () => {
	assert.equal(statusFor(100, true), "warn");
	assert.equal(statusFor(80, true), "warn");
	assert.equal(statusFor(70, true), "warn");
});

test("statusFor never upgrades a warn or a fail", () => {
	// Findings can only make the label worse, never better — otherwise a bad
	// score could be laundered into something reassuring.
	assert.equal(statusFor(69, true), "warn");
	assert.equal(statusFor(39, true), "fail");
	assert.equal(statusFor(0, true), "fail");
});

test("a page with heading gaps is not reported as pass", async () => {
	// Two H1s and no landmarks: scores well on word count, still a real gap.
	const gappy: FetchedPage = {
		...fakePage,
		html:
			"<html><head><title>Example page title that is long enough</title></head>" +
			"<body><h1>One</h1><h1>Two</h1><p>" +
			"word ".repeat(400) +
			"</p></body></html>",
	};
	const results: CheckResult[] = await Promise.all(
		builtinChecks.map((c) => c(gappy)),
	);
	const s = results.find((r) => r.id === "structure");
	assert.ok(s, "structure check should produce a result");
	assert.ok(
		/gaps/i.test(s.finding),
		`expected a gap finding, got: ${s.finding}`,
	);
	assert.notEqual(
		s.status,
		"pass",
		"a finding that names gaps must not be labelled pass",
	);
});

// --- indexability -----------------------------------------------------------
// The three checks added in 2.3.0. Hit rates measured on 172 real prospects
// before they were written: 26% no canonical, 15% no sitemap, 3% noindex.

test("a noindex page is scored 0 and reported as fail", async () => {
	const noindexed: FetchedPage = {
		...fakePage,
		html: '<html><head><meta name="robots" content="noindex, follow"><title>x</title></head><body><p>hi</p></body></html>',
	};
	const results = await Promise.all(builtinChecks.map((c) => c(noindexed)));
	const r = results.find((x) => x.id === "indexable");
	assert.ok(r, "indexable check should run");
	assert.equal(r.score, 0);
	assert.equal(r.status, "fail");
	assert.ok(r.codes?.some((c) => c.code === "indexability.noindex"));
});

test("noindex is detected from the X-Robots-Tag header too", async () => {
	const viaHeader: FetchedPage = {
		...fakePage,
		headers: { ...fakePage.headers, "x-robots-tag": "noindex" },
	};
	const r = (await Promise.all(builtinChecks.map((c) => c(viaHeader)))).find(
		(x) => x.id === "indexable",
	);
	assert.ok(r);
	assert.equal(r.score, 0);
});

test("a self-referencing canonical scores 100 and passes", async () => {
	const withCanonical: FetchedPage = {
		...fakePage,
		html: `<html><head><link rel="canonical" href="${fakePage.finalUrl}"><title>x</title></head><body><p>hi</p></body></html>`,
	};
	const r = (await Promise.all(builtinChecks.map((c) => c(withCanonical)))).find(
		(x) => x.id === "canonical",
	);
	assert.ok(r);
	assert.equal(r.score, 100);
	assert.equal(r.status, "pass");
});

test("a missing canonical is reported, not silently passed", async () => {
	const r = (await Promise.all(builtinChecks.map((c) => c(fakePage)))).find(
		(x) => x.id === "canonical",
	);
	assert.ok(r);
	assert.notEqual(r.status, "pass");
	assert.ok(r.codes?.some((c) => c.code === "canonical.missing"));
});

test("indexability checks all declare the indexability category", async () => {
	const results = await Promise.all(builtinChecks.map((c) => c(fakePage)));
	for (const id of ["indexable", "canonical", "sitemap"]) {
		const r = results.find((x) => x.id === id);
		assert.ok(r, `${id} should run`);
		assert.equal(r.category, "indexability");
	}
});

// --- extraChecks isolation --------------------------------------------------
// The extension point exists for things this package will not do itself:
// network calls, paid APIs, model inference. All of those fail sometimes, and
// one failing must not cost the caller the entire scan.
//
// fetch is stubbed so these stay hermetic — this file does not hit the network.

const realFetch = globalThis.fetch;
function stubFetch() {
	globalThis.fetch = (async () =>
		new Response(fakePage.html, {
			status: 200,
			headers: { "content-type": "text/html" },
		})) as typeof fetch;
}
function restoreFetch() {
	globalThis.fetch = realFetch;
}

test("a throwing extraCheck is dropped, not fatal", async () => {
	stubFetch();
	try {
		const boom: Check = async () => {
			throw new Error("upstream exploded");
		};
		const errors: unknown[] = [];
		const report = await runChecks("https://example.com/", {
			checks: [builtinChecks[0]],
			extraChecks: [boom],
			onCheckError: (e) => errors.push(e),
		});
		assert.equal(report.checks.length, 1, "the good check still lands");
		assert.equal(errors.length, 1, "the caller is told what failed");
		assert.match(String((errors[0] as Error).message), /upstream exploded/);
	} finally {
		restoreFetch();
	}
});

test("a working extraCheck is aggregated like any other", async () => {
	stubFetch();
	try {
		const extra: Check = async () => ({
			id: "answerability",
			category: "answerability",
			score: 60,
			status: "warn",
			finding: "f",
			detail: "d",
			fix: "x",
			weight: 1,
			codes: [{ code: "answerability.thin" }],
		});
		const report = await runChecks("https://example.com/", {
			checks: [builtinChecks[0]],
			extraChecks: [extra],
		});
		assert.ok(report.checks.some((c) => c.id === "answerability"));
		assert.ok(report.categories.some((c) => c.category === "answerability"));
	} finally {
		restoreFetch();
	}
});

test("a throwing BUILT-IN check is still fatal", async () => {
	// Deliberate asymmetry: a builtin throwing is a bug in this package and
	// should be loud, not silently missing from somebody's report.
	stubFetch();
	try {
		const boom: Check = async () => {
			throw new Error("builtin bug");
		};
		await assert.rejects(
			() => runChecks("https://example.com/", { checks: [boom] }),
			/builtin bug/,
		);
	} finally {
		restoreFetch();
	}
});

const fixed = (
	id: string,
	category: CheckResult["category"],
	score: number,
): Check =>
	async () => ({
		id,
		category,
		score,
		status: score >= 70 ? "pass" : score >= 40 ? "warn" : "fail",
		finding: "f",
		detail: "d",
		fix: "x",
		weight: 1,
	});

test("crawlability at 100 does not lift the overall; below 100 it counts", async () => {
	// 99% of real sites pass crawlability. At its weight that padded every
	// score by ~12% without telling anyone apart, so a pass is left out of the
	// mean; a block still costs the full weight.
	stubFetch();
	try {
		const padded = await runChecks("https://example.com/", {
			checks: [fixed("structure", "structure", 50), fixed("crawlability", "crawlability", 100)],
		});
		assert.equal(padded.overall, 50);
		const blocked = await runChecks("https://example.com/", {
			checks: [fixed("structure", "structure", 50), fixed("crawlability", "crawlability", 0)],
		});
		assert.ok(blocked.overall < 50);
	} finally {
		restoreFetch();
	}
});

test("a brand page with almost no text is thin, not substantive", async () => {
	const thin: FetchedPage = {
		...fakePage,
		html: "<html><head><title>Burger King Sverige</title></head><body><div id=app></div></body></html>",
	};
	const citability = builtinChecks.find((c) => c.name === "checkCitability");
	assert.ok(citability, "citability check present");
	const r = await citability(thin);
	assert.equal(r.score, 20);
	assert.ok(r.codes?.some((c) => c.code === "citability.thin"));
});
