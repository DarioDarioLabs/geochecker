// Hermetic tests — `fetch` is stubbed for the whole file, so nothing here
// touches the network. Node's built-in test runner, no extra deps.
// Tests import from ../dist — BUILD BEFORE TESTING.

import { after, before, test } from "node:test";
import { strict as assert } from "node:assert";

import {
	builtinChecks,
	pageChecks,
	siteChecks,
	defineCheck,
	resetFetchMemo,
	roleOf,
	runChecks,
	scanSite,
	statusFor,
	visibleText,
	wordCount,
	pageProse,
	type Check,
	type CheckResult,
	type FetchedPage,
	type SiteCheck,
} from "../dist/index.js";
import { parse } from "node-html-parser";

// ---- fetch stub ---------------------------------------------------------------
// A tiny router: exact URL, else pathname. Anything unrouted is a 404 with an
// error page, which is also what a real site answers for /llms.txt.

type Route = { status?: number; body?: string; headers?: Record<string, string> };
let routes: Record<string, Route> = {};
const realFetch = globalThis.fetch;

function route(table: Record<string, Route | string>) {
	// robots.txt and the sitemap are memoised for a scan's lifetime; a new
	// routing table is a new site.
	resetFetchMemo();
	routes = {};
	for (const [k, v] of Object.entries(table)) routes[k] = typeof v === "string" ? { body: v } : v;
}

before(() => {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		const path = new URL(url).pathname;
		const r = routes[url] ?? routes[path] ?? { status: 404, body: "<html><body><h1>Not found</h1></body></html>" };
		return new Response(r.body ?? "", {
			status: r.status ?? 200,
			headers: { "content-type": "text/html", ...(r.headers ?? {}) },
		});
	}) as typeof fetch;
});
after(() => {
	globalThis.fetch = realFetch;
});

const page = (html: string, extra: Partial<FetchedPage> = {}): FetchedPage => ({
	url: "https://example.com/",
	finalUrl: "https://example.com/",
	status: 200,
	html,
	headers: { "content-type": "text/html" },
	fetchedAt: new Date().toISOString(),
	...extra,
});

const fakePage = page("<html><head><title>Example</title></head><body><h1>Hello</h1></body></html>");

const prose = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 7}`).join(" ");

const fullPage = (title: string, body: string) =>
	`<html><head><title>${title}</title><meta name="description" content="${"A description long enough to pass the length check for this page.".padEnd(80, ".")}"><link rel="canonical" href="https://example.com/"></head><body><header><nav><a href="/about">About us</a><a href="/services">Services</a><a href="/contact">Contact</a><a href="/login">Log in</a></nav></header><main><h1>${title}</h1><h2>One</h2><h2>Two</h2><p>${body}</p></main><footer><a href="/privacy">Privacy</a></footer></body></html>`;

// ---- shape ------------------------------------------------------------------

test("12 built-ins: 9 page checks and 3 site checks", () => {
	assert.equal(builtinChecks.length, 12);
	assert.equal(pageChecks.length, 9);
	assert.equal(siteChecks.length, 3);
	for (const c of siteChecks) assert.ok(builtinChecks.includes(c));
});

test("each builtin check returns a well-formed CheckResult with a namespaced code", async () => {
	route({});
	for (const check of builtinChecks) {
		const r: CheckResult = await check(fakePage);
		assert.ok(r.id.length > 0, `id missing for ${check.name}`);
		assert.ok(["access", "structure", "substance", "identity", "freshness"].includes(r.category), `bad category ${r.category} on ${r.id}`);
		assert.ok(["pass", "warn", "fail"].includes(r.status), `bad status: ${r.status}`);
		assert.ok(r.score >= 0 && r.score <= 100, `score out of range: ${r.score}`);
		assert.ok(typeof r.fix === "string");
		assert.ok(Array.isArray(r.codes) && r.codes.length > 0, `no codes emitted by ${r.id}`);
		for (const c of r.codes) assert.ok(c.code.includes("."), `code "${c.code}" should be namespaced`);
	}
});

test("site checks declare scope site; page checks do not", async () => {
	route({});
	for (const check of siteChecks) assert.equal((await check(fakePage)).scope, "site");
	for (const check of pageChecks) assert.notEqual((await check(fakePage)).scope, "site");
});

test("defineCheck is a passthrough", () => {
	const c: Check = async () => ({
		id: "x", category: "structure", score: 100, status: "pass",
		finding: "ok", detail: "ok", fix: "ok", weight: 1,
	});
	assert.equal(defineCheck(c), c);
});

// ---- statusFor ----------------------------------------------------------------

test("statusFor keeps the plain score thresholds when nothing was found", () => {
	assert.equal(statusFor(100), "pass");
	assert.equal(statusFor(70), "pass");
	assert.equal(statusFor(69), "warn");
	assert.equal(statusFor(40), "warn");
	assert.equal(statusFor(39), "fail");
});

test("statusFor caps a passing score at warn when the check named a problem, and never upgrades", () => {
	assert.equal(statusFor(100, true), "warn");
	assert.equal(statusFor(70, true), "warn");
	assert.equal(statusFor(69, true), "warn");
	assert.equal(statusFor(39, true), "fail");
});

// ---- visible text -----------------------------------------------------------
// node-html-parser keeps script/style/noscript text in `.text`; every word
// count must ignore it or a data blob reads as prose.

test("visibleText ignores script, style, noscript and template content", () => {
	const root = parse(
		`<body><script id="__NEXT_DATA__" type="application/json">{"props":{"x":"${prose(40)}"}}</script><style>.a{color:red}</style><noscript>Please enable JavaScript to use this site</noscript><p>hello world</p></body>`,
	);
	assert.equal(visibleText(root), "hello world");
	assert.equal(wordCount(visibleText(root)), 2);
});

test("pageProse takes the content region and drops the page chrome, not section headings", () => {
	const html = `<html><body><header class="site"><nav><a href="/">Home</a><a href="/about">About</a></nav><p>${prose(60)}</p></header><section><header class="entry-header"><h2>Our work</h2></header><p>${prose(40)}</p></section><article><p>${prose(10)}</p></article><footer><p>© Acme ${prose(20)}</p></footer></body></html>`;
	const text = pageProse(html);
	// The page header (it holds the nav) and the footer go; the section with
	// its own heading stays; the 10-word article teaser is not "the content".
	assert.equal(wordCount(text), 52, text.slice(0, 80));
	assert.match(text, /^Our work/);
	const withMain = `<html><body><nav><a href="/">Home</a></nav><main><h1>Acme</h1><p>${prose(50)}</p></main><footer>${prose(30)}</footer></body></html>`;
	assert.equal(wordCount(pageProse(withMain)), 51);
	const post = `<html><body><nav><a href="/">Home</a></nav><article><h1>Post</h1><p>${prose(300)}</p></article><aside>${prose(100)}</aside></body></html>`;
	assert.equal(wordCount(pageProse(post)), 301, "an article that is most of the page is the content");
	assert.equal(pageProse(`<html><head><title>Shell</title></head><body><div id="root"></div></body></html>`), "");
});

test("a Next.js-style shell with a data blob is an empty shell, not a wordy page", async () => {
	const shell = page(
		`<html><head><title>Shell</title></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"copy":"${prose(400)}"}}}</script><script src="/_next/static/app.js"></script></body></html>`,
	);
	const results = await Promise.all(pageChecks.map((c) => c(shell)));
	const by = (id: string) => results.find((r) => r.id === id)!;
	assert.ok(by("structure").codes!.some((c) => c.code === "structure.empty_shell"), "structure sees a shell");
	assert.ok(by("renderability").codes!.some((c) => c.code === "renderability.spa_shell"), "renderability sees a shell");
	assert.ok(by("citability").codes!.some((c) => c.code === "citability.thin"), "citability sees no text");
});

// ---- structure / schema / citability / freshness ------------------------------

test("a page with heading gaps is not reported as pass", async () => {
	const gappy = page(
		"<html><head><title>Example page title that is long enough</title></head><body><h1>One</h1><h1>Two</h1><p>" +
			prose(400) +
			"</p></body></html>",
	);
	const s = (await Promise.all(pageChecks.map((c) => c(gappy)))).find((r) => r.id === "structure")!;
	assert.match(s.finding, /gaps/i);
	assert.notEqual(s.status, "pass");
});

test("schema: Organization plus a page type reaches 100; Organization alone is 85 with no_page_type", async () => {
	const schema = pageChecks.find((c) => c.name === "checkSchema")!;
	const both = page(
		`<html><head><script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"X"},{"@type":"WebPage","name":"Home"}]}</script></head><body></body></html>`,
	);
	const b = await schema(both);
	assert.equal(b.score, 100);
	assert.equal(b.status, "pass");
	const orgOnly = page(`<html><head><script type="application/ld+json">{"@type":"Organization","name":"X"}</script></head><body></body></html>`);
	const o = await schema(orgOnly);
	assert.equal(o.score, 85);
	assert.ok(o.codes!.some((c) => c.code === "schema.no_page_type"));
	assert.equal(o.status, "warn");
});

test("citability: a brand page can reach 100 when it states specifics; a thin one is 20", async () => {
	const citability = pageChecks.find((c) => c.name === "checkCitability")!;
	const specific = page(
		`<html><head><title>Plumber</title></head><body><main><p>Founded 1998 in Uppsala. We serve 2,400 customers a year across 12 municipalities. Call-out fee 895 kr, hourly rate 1,150 kr. Open 07:00–17:00, 6 days a week. Phone +46 18 123 45 67. ${prose(120)}</p></main></body></html>`,
	);
	const r = await citability(specific);
	assert.equal(r.score, 100, r.detail);
	assert.ok(r.codes!.some((c) => c.code === "citability.ok_brand"));
	const thin = page("<html><head><title>Burger King Sverige</title></head><body><div id=app></div></body></html>");
	const t = await citability(thin);
	assert.equal(t.score, 20);
	assert.ok(t.codes!.some((c) => c.code === "citability.thin"));
	const vague = page(`<html><body><main><p>${"We deliver seamless world-class solutions that empower you. ".repeat(30)}</p></main></body></html>`);
	const v = await citability(vague);
	assert.ok(v.score < 70, `vague copy should not pass, got ${v.score}`);
	assert.ok(v.codes!.some((c) => c.code === "citability.no_specifics"));
});

test("freshness: a future date is not a freshness signal", async () => {
	const freshness = pageChecks.find((c) => c.name === "checkFreshness")!;
	const next = new Date(Date.now() + 90 * 86_400_000).toISOString();
	const onlyFuture = page(`<html><body><time datetime="${next}">soon</time></body></html>`);
	const f = await freshness(onlyFuture);
	assert.equal(f.score, 70);
	assert.ok(f.codes!.some((c) => c.code === "freshness.future_only"));
	const recent = new Date(Date.now() - 10 * 86_400_000).toISOString();
	const mixed = page(`<html><body><time datetime="${next}">soon</time><time datetime="${recent}">updated</time></body></html>`);
	const m = await freshness(mixed);
	assert.equal(m.score, 100);
	assert.ok(m.codes!.some((c) => c.code === "freshness.fresh"));
});

// ---- access -------------------------------------------------------------------

test("a noindex page is scored 0 and reported as fail, from meta or header", async () => {
	const indexable = pageChecks.find((c) => c.name === "checkIndexable")!;
	const meta = await indexable(page('<html><head><meta name="robots" content="noindex, follow"></head><body><p>hi</p></body></html>'));
	assert.equal(meta.score, 0);
	assert.equal(meta.status, "fail");
	assert.ok(meta.codes!.some((c) => c.code === "indexability.noindex"));
	const header = await indexable(page(fakePage.html, { headers: { "x-robots-tag": "noindex" } }));
	assert.equal(header.score, 0);
});

test("canonical: self is 100 pass; missing is a minor warn", async () => {
	const canonical = pageChecks.find((c) => c.name === "checkCanonical")!;
	const self = await canonical(page(`<html><head><link rel="canonical" href="https://example.com/"></head><body></body></html>`));
	assert.equal(self.score, 100);
	assert.equal(self.status, "pass");
	const missing = await canonical(fakePage);
	assert.equal(missing.status, "warn");
	assert.ok(missing.score >= 80, "a missing canonical must not outweigh a blocked crawler inside access");
	assert.ok(missing.codes!.some((c) => c.code === "canonical.missing"));
});

test("access is the weakest link; at 100 it leaves the overall", async () => {
	const fixed = (id: string, category: CheckResult["category"], score: number): Check => async () => ({
		id, category, score, status: statusFor(score), finding: "f", detail: "d", fix: "x", weight: 1,
	});
	route({ "/": fakePage.html });
	const shell = await runChecks("https://example.com/", {
		checks: [fixed("structure", "structure", 60), fixed("renderability", "access", 5), fixed("indexable", "access", 100), fixed("canonical", "access", 100)],
	});
	const access = shell.categories.find((c) => c.category === "access")!;
	assert.equal(access.score, 5, "a mean would have hidden the shell");
	assert.ok(shell.overall < 60);
	const clean = await runChecks("https://example.com/", {
		checks: [fixed("structure", "structure", 60), fixed("indexable", "access", 100)],
	});
	assert.equal(clean.overall, 60, "a passing access category must not pad the score");
});

test("an error page is not scored as the page", async () => {
	route({ "/": { status: 404, body: fullPage("Not found", prose(300)) } });
	const r = await runChecks("https://example.com/");
	assert.equal(r.checks.length, 1);
	assert.equal(r.checks[0].id, "reachable");
	assert.equal(r.overall, 0);
	assert.ok(r.checks[0].codes!.some((c) => c.code === "access.unreachable" && c.data?.status === 404));
});

test("a bot wall served as 200 is not scored as the page", async () => {
	route({ "/": `<html><head><title>Just a moment...</title><meta name="robots" content="noindex"></head><body><div id="challenge-platform">${prose(300)}</div></body></html>` });
	const r = await runChecks("https://example.com/");
	assert.equal(r.checks.length, 1);
	assert.equal(r.overall, 0);
	assert.ok(r.checks[0].codes!.some((c) => c.code === "access.blocked" && c.data?.blocker === "Cloudflare"));
});

// ---- extraChecks isolation -------------------------------------------------

test("a throwing extraCheck is dropped, not fatal; a working one is aggregated", async () => {
	route({ "/": fakePage.html });
	const boom: Check = async () => {
		throw new Error("upstream exploded");
	};
	const errors: unknown[] = [];
	const report = await runChecks("https://example.com/", {
		checks: [builtinChecks[0]],
		extraChecks: [boom],
		onCheckError: (e) => errors.push(e),
	});
	assert.equal(report.checks.length, 1);
	assert.equal(errors.length, 1);
	assert.match(String((errors[0] as Error).message), /upstream exploded/);

	const extra: Check = async () => ({
		id: "answerability", category: "substance", score: 60, status: "warn",
		finding: "f", detail: "d", fix: "x", weight: 1.3, codes: [{ code: "answerability.thin" }],
	});
	const withExtra = await runChecks("https://example.com/", { checks: [builtinChecks[0]], extraChecks: [extra] });
	assert.ok(withExtra.checks.some((c) => c.id === "answerability"));
	assert.ok(withExtra.categories.some((c) => c.category === "substance"));
});

test("a throwing BUILT-IN check is still fatal", async () => {
	route({ "/": fakePage.html });
	const boom: Check = async () => {
		throw new Error("builtin bug");
	};
	await assert.rejects(() => runChecks("https://example.com/", { checks: [boom] }), /builtin bug/);
});

// ---- site scan ----------------------------------------------------------------

test("roleOf reads the last path segment first, then the path and the label", () => {
	assert.equal(roleOf("/us/about-us/contact", null), "contact");
	assert.equal(roleOf("/us/about-us", null), "about");
	assert.equal(roleOf("/om-oss", "Om oss"), "about");
	assert.equal(roleOf("/tjanster/vvs", "Tjänster"), "services");
	assert.equal(roleOf("/kundservice", "Kundservice"), "contact");
	assert.equal(roleOf("/mypages/order-history", null), "other");
	assert.equal(roleOf("/dam", "Dam"), "other");
});

const site = () =>
	route({
		"/": fullPage("Example Co — plumbing in Uppsala", `Founded 1998. ${prose(300)}`),
		"/about": fullPage("About Example Co", `Since 1998 we have served 2,400 customers. ${prose(300)}`),
		"/services": fullPage("Services", `Drain cleaning from 895 kr. ${prose(300)}`),
		"/contact": fullPage("Contact", `Call +46 18 123 45 67. ${prose(300)}`),
		"/prices": fullPage("Prices", `Hourly rate 1,150 kr. ${prose(300)}`),
		"/login": fullPage("Log in", prose(300)),
		"/blog/post": fullPage("A post", prose(300)),
		"/robots.txt": "User-agent: *\nDisallow: /login\nSitemap: https://example.com/sitemap.xml\n",
		"/sitemap.xml": `<?xml version="1.0"?><urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/prices</loc></url><url><loc>https://example.com/blog/post</loc></url><url><loc>https://example.com/login</loc></url></urlset>`,
	});

test("scanSite reads the home page and the pages an assistant needs, from links and the sitemap", async () => {
	site();
	const report = await scanSite("example.com");
	assert.equal(report.site, "https://example.com/");
	const roles = report.pages.map((p) => p.role);
	assert.deepEqual(roles, ["home", "about", "services", "prices", "contact"]);
	assert.ok(report.pages.every((p) => !p.unreadable));
	assert.ok(report.candidates.some((c) => c.path === "/prices" && c.source === "sitemap"), "the sitemap contributed /prices");
	assert.ok(!report.candidates.some((c) => c.path === "/login"), "login pages are never candidates");
	assert.ok(report.candidates.some((c) => c.path === "/about" && c.source === "nav"));
	// Site-level checks ran once; page checks on every page.
	assert.equal(report.checks.filter((c) => c.id === "crawlability").length, 1);
	assert.equal(report.checks.filter((c) => c.id === "structure").length, 5);
	assert.ok(report.checks.every((c) => typeof c.page === "string"));
	assert.equal(report.checks.find((c) => c.id === "sitemap")!.page, "https://example.com/");
	assert.ok(report.overall > 0 && report.overall <= 100);
	assert.deepEqual(report.categories.map((c) => c.category), ["access", "structure", "substance", "identity", "freshness"]);
});

test("a deeper URL is read as 'entered' alongside the home page; maxPages caps the picks", async () => {
	site();
	const report = await scanSite("https://example.com/blog/post", { maxPages: 2 });
	assert.deepEqual(report.pages.map((p) => p.role), ["home", "entered", "about", "services"]);
	assert.equal(report.pages[1].finalUrl, "https://example.com/blog/post");
});

test("an unreadable page is listed and left out of the site score", async () => {
	site();
	route({ ...routes, "/services": { status: 500, body: "<html><body>boom</body></html>" } });
	const report = await scanSite("example.com");
	const services = report.pages.find((p) => p.role === "services")!;
	assert.equal(services.unreadable, true);
	assert.equal(services.status, 500);
	assert.ok(services.checks.some((c) => c.id === "reachable"));
	const structureRuns = report.checks.filter((c) => c.id === "structure");
	assert.equal(structureRuns.length, 4, "the unreadable page contributes no page checks");
	assert.ok(report.overall > 0);
});

test("an unreachable home page is the whole report", async () => {
	route({ "/": { status: 503, body: "<html><body>down</body></html>" } });
	const report = await scanSite("example.com");
	assert.equal(report.overall, 0);
	assert.equal(report.pages.length, 1);
	assert.equal(report.pages[0].unreadable, true);
	assert.equal(report.candidates.length, 0);
});

test("pickPages decides, but only among the candidates offered", async () => {
	site();
	const report = await scanSite("example.com", {
		pickPages: ({ candidates }) => [
			...candidates.filter((c) => c.path === "/contact"),
			{ url: "https://example.com/invented", path: "/invented", label: null, role: "other", source: "link" },
		],
	});
	assert.deepEqual(report.pages.map((p) => p.role), ["home", "contact"]);
});

test("extraSiteChecks see every readable page once; a throwing one is dropped", async () => {
	site();
	let seen = 0;
	const answerability: SiteCheck = async (input) => {
		seen = input.pages.length;
		return {
			id: "answerability", category: "substance", score: 80, status: "pass",
			finding: "f", detail: "d", fix: "x", weight: 1.3, codes: [{ code: "answerability.citable" }],
		};
	};
	const boom: SiteCheck = async () => {
		throw new Error("model down");
	};
	const errors: unknown[] = [];
	const report = await scanSite("example.com", { extraSiteChecks: [answerability, boom], onCheckError: (e) => errors.push(e) });
	assert.equal(seen, 5);
	assert.equal(report.checks.filter((c) => c.id === "answerability").length, 1);
	assert.equal(report.checks.find((c) => c.id === "answerability")!.scope, "site");
	assert.equal(errors.length, 1);
});

test("site categories average each page check across pages, then score like a page", async () => {
	site();
	const report = await scanSite("example.com", { maxPages: 1 });
	const structure = report.categories.find((c) => c.category === "structure")!;
	// Two pages, both scored; the category sees one averaged `structure`, one
	// `schema`, one `og_meta` — not six items.
	assert.equal(structure.checks.length, 6, "the listing carries every real result");
	const pageStructure = report.pages.map((p) => p.categories.find((c) => c.category === "structure")!.score);
	const mean = Math.round(pageStructure.reduce((s, x) => s + x, 0) / pageStructure.length);
	assert.ok(Math.abs(structure.score - mean) <= 1, `site structure ${structure.score} should be the mean of ${pageStructure}`);
});
