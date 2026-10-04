![GEO Checker — by Dario Dario](https://dariodario.com/og.png)

# GEO Checker

> Check any site's readiness for AI search with our open-source Generative Engine Optimization (GEO) checker.

[![npm](https://img.shields.io/npm/v/@dariodario/geochecker.svg)](https://www.npmjs.com/package/@dariodario/geochecker)
[![license](https://img.shields.io/npm/l/@dariodario/geochecker.svg)](./LICENSE)

GEO (Generative Engine Optimization) is the practice of structuring a website so that LLMs — ChatGPT, Claude, Gemini, Perplexity, Google AI Overviews — can find, understand, and cite it.

GEO Checker scans a **site** — its home page and the pages an assistant would need — across five categories and twelve checks, with concrete, actionable findings tagged with the page they were found on.

## Quick start

```bash
npx @dariodario/geochecker example.com
```

```
Site:    https://example.com/
Score:   58/100  (F)

Pages:
  home       61/100  https://example.com/
  about      59/100  https://example.com/about
  services   67/100  https://example.com/services
  contact    53/100  https://example.com/contact

ACCESS  (79/100)
  • renderability   79/100  [/contact] Raw HTML carries 180 words — thinner than ideal for non-JS crawlers.
  ✓ crawlability   100/100  All AI search crawlers can reach this page.
  …
STRUCTURE  (38/100)
  ✗ schema           0/100  [/] No structured data detected.
  …
```

## Why the site, not the URL

A page scanner that reads one URL reads the page the owner polished. Measured across real sites, inner pages score worse than the home page on two sites in three, and more than half of sites have a problem the home page hides entirely. Assistants cite the page that answers a question — the services page, the price list, the contact page — which is rarely the home page.

So a scan is: the home page, always; the URL you entered, if it is a deeper page; and up to four more pages an assistant would need — About, Services or Products, Prices, Contact — found among the home page's links (navigation first) and the sitemap. Login, cart, account, legal and country-chooser pages are never read. Each page gets its own score; the site score averages each check across the pages read.

## What it scores

| Category | The question | Checks |
|---|---|---|
| **Access** | Can an assistant get the page at all? | `crawlability` (robots.txt by crawler **purpose** — search and live-fetch crawlers must be allowed; blocking training-only crawlers is a legitimate opt-out that costs nothing), `indexable` (`noindex` in meta or `X-Robots-Tag`), `canonical`, `sitemap`, `renderability` (is the content in the server HTML, or does it need JavaScript — GPTBot, ClaudeBot and PerplexityBot do not run JS), `llms_txt` (reported, never scored) |
| **Structure** | Can it parse what it got? | `schema` (JSON-LD: an Organization plus a type that says what the page is), `structure` (one H1, H2 sections, landmarks, enough visible prose, question headings with answers beneath), `og_meta` (title, description, Open Graph) |
| **Substance** | Is there anything worth quoting? | `citability` — an article is judged as a source (byline, date, links to what it cites, no sales language); a brand page on whether its copy states anything specific (years, prices, quantities, places) rather than adjectives any company could use. The category also takes a caller-supplied `answerability` check — see below |
| **Identity** | Can it tell who is behind the site? | `authority` — Organization markup with `sameAs` and a logo, an About link, a way to reach a person |
| **Freshness** | Is it current? | `freshness` — the newest past date among `Last-Modified`, `<time>`, Open Graph and schema dates; future dates (events) are ignored; an undated brand page is fine, an undated article is not |

**Access is the weakest link, not an average.** A JavaScript shell averaged with four passing hygiene checks came out at 77 in earlier versions. Now the category scores as its lowest check, and when everything passes it is left out of the overall entirely — being reachable is the baseline, not an achievement.

Every page that answers an error status, or a bot wall served as a 200, gets one result — `reachable`, scored 0 — and in a site scan is listed as unreadable and left out of the site score. Scoring an error page's HTML is not scoring the site.

Each check returns a score, a status, a finding, a detailed explanation, a concrete fix, and structured `codes` that consumers localise from. Codes are the contract: stable within a major version, while the English prose may change.

> **A good score is necessary, not sufficient.** The strongest driver of AI citations in 2025–2026 studies is **off-page authority** — how often a brand is mentioned across the web (Reddit, YouTube, Wikipedia, review sites, earned media). A page scanner cannot see that. Use this tool to remove on-page blockers; win the citation with the brand presence it cannot measure. The hosted version adds a Recognition signal for exactly this.
>
> **On `llms.txt`:** reported informationally, never scored. As of 2026 no major AI search engine consumes it for citation (Ahrefs found ~97% of `llms.txt` files get zero bot requests); it is a developer coding-agent convention.

## Programmatic usage

```ts
import { scanSite } from "@dariodario/geochecker";

const report = await scanSite("example.com");
report.overall;      // 0–100 for the site
report.categories;   // five category scores, each listing every result behind it
report.pages;        // one Report per page read, with its role: home | entered | about | …
report.checks;       // every result, tagged with the `page` it was measured on
report.candidates;   // the pages the scan had to choose from, and where each was found
```

One page only, the pre-3.0 behaviour:

```ts
import { runChecks } from "@dariodario/geochecker";

const page = await runChecks("https://example.com/about");
```

### Streaming

For live UIs that show findings as they come in:

```ts
import { scanSiteStream } from "@dariodario/geochecker";

for await (const evt of scanSiteStream("example.com")) {
  if (evt.type === "plan") console.log("reading", evt.pages.map((p) => `${p.role} ${p.url}`));
  else if (evt.type === "page") console.log("fetched", evt.role, evt.page.status);
  else if (evt.type === "check") console.log(evt.role, evt.result.id, evt.result.score);
  else if (evt.type === "done") console.log("site score:", evt.report.overall);
}
```

### Choosing the pages yourself

`pickPages` receives the home page and every candidate — URL, path, link label, the role its path suggests, and whether it came from the navigation, another link or the sitemap — and returns the ones to read. Hand the list to a language model if you have one; only candidates from the list are honoured.

```ts
const report = await scanSite("example.com", {
  maxPages: 4,
  pickPages: ({ candidates, max }) => myModelPicks(candidates, max),
});
```

### Adding your own checks

This package makes **zero third-party API calls** — it fetches the site's pages, its `robots.txt`, its `llms.txt` and its sitemap, and nothing else. Anything that judges or phones out is yours to add:

- `extraChecks` run on every readable page, like the built-ins.
- `extraSiteChecks` run once with every readable page — the seam for a language model that reads the whole site and fills the `answerability` slot the `substance` category reserves for it. Give it `id: "answerability"`, `category: "substance"` and `weight: 1.3`.

Both are isolated: **a caller-supplied check that throws is dropped and reported through `onCheckError`, while the scan completes.** A built-in that throws still fails the scan. The asymmetry is deliberate — a built-in that cannot run means the score itself is wrong, but your optional signal going down should cost you that section and nothing else.

```ts
import { scanSite, defineCheck, defineSiteCheck, statusFor } from "@dariodario/geochecker";

const wordCountCheck = defineCheck(async (page) => {
  const words = page.html.replace(/<[^>]+>/g, " ").trim().split(/\s+/).length;
  const score = Math.min(100, Math.round((words / 300) * 100));
  return {
    id: "word-count",
    category: "structure",
    score,
    status: statusFor(score, words < 300),
    finding: `Page has ${words} words.`,
    detail: "LLMs prefer pages with substantive content (300+ words).",
    fix: "Expand the page with detailed coverage of the topic.",
    weight: 1,
    codes: [{ code: words < 300 ? "word-count.thin" : "word-count.ok", data: { words } }],
  };
});

const answerability = defineSiteCheck(async ({ pages }) => {
  const verdict = await askYourModel(pages.map((p) => p.page.html));
  return { id: "answerability", category: "substance", weight: 1.3, ...verdict };
});

const report = await scanSite("example.com", {
  extraChecks: [wordCountCheck],
  extraSiteChecks: [answerability],
  onCheckError: (err) => console.warn("optional check skipped:", err),
});
```

## CLI options

| Flag | Description |
|---|---|
| `--page` | Score only the given URL, not the site |
| `--pages <n>` | Extra pages to read besides the home page (default 4) |
| `--lang <tag>` | `Accept-Language` for the fetches, e.g. `sv` or `de,en;q=0.5` — a language-negotiating site serves the version its visitors see |
| `--json` | Output the full report as JSON (machine-readable) |
| `--category <name>` | Show only one category (`access`, `structure`, `substance`, `identity`, `freshness`) |
| `--min-score <n>` | Exit with code 1 if the overall score < `n`. Use as a CI quality gate. |
| `-h`, `--help` | Show help |

### As a CI gate

```yaml
# .github/workflows/seo.yml
- run: npx @dariodario/geochecker https://your-staging-site.com --min-score 75
```

## Hosted version

The hosted version at **[dariodario.com/geochecker](https://dariodario.com/geochecker)** runs this same engine plus the judgement this package deliberately leaves out: a language model picks the pages and reads them, filling `answerability`; a Recognition signal says how well assistants already know the business, independent of its pages; and what Google knows about it (Maps listing, real-user Core Web Vitals). Reports get a shareable permalink and a PDF download. Free.

## Contributing

PRs welcome — particularly for new checks. Please open a [Discussion](https://github.com/dariodariolabs/geochecker/discussions) first if proposing a substantial addition.

```bash
git clone https://github.com/dariodariolabs/geochecker
cd geochecker
npm install
npm run build
npm test
```

## Releasing (maintainers)

Manual: tag pushes only run build/test in CI; `npm publish` runs from a maintainer's laptop.

```bash
npm version patch  # or minor / major — bumps package.json + creates tag
git push --follow-tags
npm publish --access public
```

`npm publish` will prompt for browser OTP if `npm login` has expired. The CI workflow on the tag push runs typecheck/build/test as a release-readiness gate; a green check means the tarball would have built cleanly.

## About

Built and maintained by [Dario Dario](https://dariodario.com), an AI-native studio in Stockholm. We design and ship AI agents for SMEs.

- Web: [dariodario.com](https://dariodario.com)
- Contact: hello@dariodario.com

## License

[MIT](./LICENSE) — do anything.
