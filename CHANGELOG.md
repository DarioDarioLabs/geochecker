# Changelog

All notable changes to `@dariodario/geochecker` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.6.1] - 2026-09-10

No engine changes. `repository`, `bugs` and `homepage` follow the GitHub org
rename to `DarioDarioLabs`; the npm package name is unchanged.

## [2.6.0] - 2026-09-10

Scoring that agrees with its own advice. Measured on real prospects first.

- `crawlability` only costs points now: at 100 it is left out of the overall.
  99% of scanned sites score 100 on it, and at its weight it handed every one
  of them a free ~12% of the total. Blocking the search crawlers still costs
  the full weight.
- `freshness` on a brand page without dates scores 70 (the pass line) instead
  of 60. Its own fix said "optional"; a warn that is optional is a
  contradiction. Undated articles are unchanged at 30.
- `citability` on a brand page no longer scores or lists outbound source links
  as a gap — a homepage without citations is normal, and "add links to
  sources" is not advice its owner can use. Brand pages are judged on fluff
  density, base 55, cap 80 as before — and a page with under 120 words is
  `citability.thin` (20) rather than "substantive" for having no superlatives
  in its title.
- `authority` names what is missing when the score is under 100 ("…present;
  no logo in the Organization schema") instead of saying "all present" while
  the detail said otherwise.

## [2.5.0] - 2026-09-05

- `runChecks` / `runChecksStream` accept `acceptLanguage`, sent as the page
  fetch's `Accept-Language`. Until now every fetch asked for English, so a site
  that negotiates language handed its English fallback to every check that reads
  prose — the page its visitors never see. Default unchanged (`en;q=0.9`).
- `freshness` weighs 1.0 on every path. It was 0.9 when no date signal was found
  and 1.0 when one was, so a page's category weight moved with its own result.
- `package.json` is exported, so consumers can read the engine version they are
  running (`import pkg from "@dariodario/geochecker/package.json"`).

## [2.4.0] - 2026-09-04

Makes the `extraChecks` extension point safe to use for work this package
deliberately will not do itself, and reserves a category for it. No behaviour
change for anyone using only the built-ins.

### Changed

- **A caller-supplied check that throws is now dropped, not fatal.** `extraChecks`
  exists for network calls, paid APIs and model inference — all of which fail
  sometimes — and one of them throwing used to reject the whole scan through
  `Promise.all`. Extras are now settled individually and a rejection is omitted
  from the report. **Built-in checks are deliberately still fatal**: they are pure
  functions over already-fetched HTML, so one throwing is a bug in this package
  and should be loud rather than silently missing from someone's report.

### Added

- **`onCheckError(error)`** in `RunOptions` — called when a caller-supplied check
  is dropped, so the failure is visible instead of silent.
- **`answerability` category** (weight `1.3`) — whether a page makes specific,
  quotable, attributable claims, which is what citation actually depends on. No
  built-in produces it: it needs judgement over prose rather than parsing, so it
  is supplied through `extraChecks`. The category is reserved here so such a
  check aggregates and weights consistently across consumers.

## [2.3.0] - 2026-09-04

Adds an `indexability` category with three checks. Additive: existing check ids,
categories, codes and their scores are unchanged. **`overall` will move**, because
the weighted set it averages is larger — a site that scored 80 on the old six
categories is not broken if it now reads differently.

### Added

- **`indexability` category** (weight `1.2`) — whether a search engine may list
  the page at all, as distinct from `crawlability`, which asks whether AI crawlers
  are allowed in by robots.txt.
  - **`indexable`** (weight `1.6`) — `noindex` via robots meta *or* the
    `X-Robots-Tag` header; a site setting it in one place and not the other is
    still noindexed. Scores 0 when found: absence from the index is not a degree
    of quality, it voids everything above it. Also flags `nofollow`.
    Codes: `indexability.noindex`, `indexability.nofollow`, `indexability.ok`.
  - **`canonical`** (weight `1.0`) — self-referencing, cross-referencing, absent
    or malformed. A cross-origin canonical is deliberate on a syndicated copy and
    a mistake anywhere else, so it warns rather than fails.
    Codes: `canonical.self`, `canonical.cross`, `canonical.missing`,
    `canonical.malformed`.
  - **`sitemap`** (weight `0.9`) — declared in robots.txt, present at the
    conventional path, or absent. robots.txt takes precedence because it is the
    site's own declaration.
    Codes: `sitemap.declared`, `sitemap.undeclared`, `sitemap.missing`.

Hit rates were measured on 172 real sites before these were written rather than
guessed: 26% had no canonical, 15% no sitemap, and 3% were actively serving
`noindex` — that last group is absent from Google today and almost never knows it.

## [2.2.0] - 2026-09-03

Fixes a contradiction between a check's status and its own finding text. No
score changes: `overall` and every category score are byte-identical to 2.1.0.
Some checks that reported `pass` now report `warn`, so anything counting
statuses (a "N checks passed" line, a green/amber/red tally) will move.

### Changed

- **A check that named a problem is no longer labelled `pass`.** `status` was
  derived from the score alone, and because a check aggregates several signals
  it could score well while still enumerating real gaps — a page scored 80 on
  structure and was reported `pass` directly under the sentence "Heading
  structure has gaps: 64 H1 elements". A green tick beside a complaint is a
  contradiction, and a reader resolves it by trusting neither half. Such checks
  are now capped at `warn`.

  Affected built-ins: `structure`, `og`, `authority`, `citability`, `schema`,
  `crawlability`, `renderability`. `freshness` is unchanged (its finding states
  a date, not a defect) and so is `llmstxt` (a missing `/llms.txt` is
  explicitly fine for citation).

  Findings can only make a label worse, never better: a `warn` or `fail` score
  is never upgraded, so a poor score cannot be laundered into something
  reassuring.

### Added

- **`statusFor(score, hasFindings?)` is now exported** from the package root, so
  a custom check written with `defineCheck` can label itself the same way the
  built-ins do. The second argument is optional and defaults to `false`, so the
  existing one-argument behaviour is unchanged.

## [2.1.0] - 2026-07-10

Adds a sixth category and folds answerability (AEO) signals into the categories
they belong to. Additive — existing check ids, categories, and codes are
unchanged; scores for JS-rendered pages will drop (correctly) and pages with
question-form Q&A or wired FAQ schema will tick up slightly.

### Added

- **`renderability` category** — a new built-in check (`checkRenderability`)
  measuring whether the primary content is present in the raw server HTML or
  requires JavaScript to render. Most LLM crawlers (GPTBot, ClaudeBot,
  PerplexityBot) do not execute JS, so a client-rendered SPA shell is invisible
  to them. Category weight `1.1` (below the content axes, above authority).
  Codes: `renderability.server_rendered`, `renderability.thin_raw_html`,
  `renderability.spa_shell`, `renderability.spa_shell_noscript`,
  `renderability.meta_refresh`.
- **Answerability (AEO), folded in — no new category:**
  - `structure` now rewards question-form headings that have a self-contained
    answer immediately beneath, and flags the antipattern of a question heading
    with no answer. New codes: `structure.answerable_headings`,
    `structure.unanswered_questions`.
  - `structure`'s schema check now rewards `FAQPage`/`QAPage` wired to
    `acceptedAnswer` (directly extractable by answer engines) and notes the
    unwired shell. New codes: `schema.faq_wired`, `schema.faq_unwired`.

### Notes

- Consumers that render a fixed list of categories should read
  `report.categories` dynamically — a sixth entry now appears. Unknown category
  keys should fall back to the engine's English strings.

## [2.0.0] - 2026-07-08

Evidence-based recalibration. The AI-search landscape moved meaningfully in the
two months after v1.1.0, and two of the eight checks were giving advice that is
now wrong. This release corrects them, grounded in mid-2026 research (Ahrefs,
the Princeton GEO study, the IETF AIPREF draft, Cloudflare's purpose-based
crawler model).

### Breaking changes

- **Scores will shift.** `crawlability` no longer penalizes blocking
  training-only crawlers, and `llms.txt` no longer affects the score at all.
  A site that blocks GPTBot/CCBot while allowing the AI *search* crawlers now
  scores well where v1 marked it down.
- **Structured `codes` changed** (the machine-readable contract consumers use
  to localize findings):
  - `crawlability`: `ai_bots_blocked`, `ok_explicit_allow`, `partial_explicit`,
    `no_ai_rules` → replaced by `all_blocked`, `some_blocked`, `reachable_all`
    (`no_robots_txt` and `wildcard_block` retained, with new copy).
  - `llms_txt`: `missing`, `minimal`, `ok` → replaced by `not_used`, `present`.
  - If you key UI or logic off these codes, update your mapping. Unknown codes
    should fall back to the engine's English `finding`/`detail`/`fix` strings.

### Changed

- **`crawlability` rebuilt around crawler *purpose*.** Bots are now grouped as
  **search** (build the AI-search index — allowing these drives citation),
  **live-fetch** (real-time, user-triggered), and **training** (model training).
  Only blocking the search/live crawlers lowers your score; blocking
  training-only crawlers is treated as a legitimate opt-out that does not affect
  citation — matching the IETF AIPREF `train-ai` vs `search` split and
  Cloudflare's 2026 purpose-based defaults.
- **Refreshed the AI-crawler list.** Added `OAI-SearchBot`, `Claude-SearchBot`,
  `Claude-User`, `ChatGPT-User`, `Perplexity-User`, `MistralAI-User`,
  `Meta-ExternalAgent`, `Meta-ExternalFetcher`, `Meta-WebIndexer`, `Amazonbot`,
  `DuckAssistBot`, `Google-CloudVertexBot`, `cohere-ai`. Removed deprecated
  `Claude-Web` and `anthropic-ai`. Removed `Google-Extended` and
  `Applebot-Extended` — these are robots.txt *control tokens*, not crawlers, and
  blocking them has no effect on search visibility.
- **`llms.txt` is now informational only (weight 0).** As of 2026 no major AI
  search engine consumes it for retrieval or citation (Ahrefs: ~97% of
  `llms.txt` files receive zero bot requests; Google confirms it is unused). It
  remains a useful convention for developer coding agents, and its presence is
  still reported — but its absence is no longer penalized.
- **`schema` down-weighted (1.4 → 1.0) and reframed.** Controlled 2026 tests
  (Ahrefs difference-in-differences) show adding JSON-LD alone does not lift AI
  citations. Schema is kept as an entity-resolution/hygiene signal; the copy now
  steers toward attribute completeness over mere presence.

### Added

- Guidance that **off-page authority is the strongest driver of AI citations**
  (brand mentions across Reddit, YouTube, Wikipedia, reviews, earned media) and
  is invisible to a page-level scanner — a good page score is necessary but not
  sufficient.

## [1.1.0] - 2026-05-03

### Added

- Every built-in check now emits a stable, language-independent `codes:
  CheckCode[]` array alongside its English prose, so frontends can render
  localized copy without parsing strings.

## [1.0.0] - 2026-05-03

- Initial public release. Scores any URL across five GEO categories — structure,
  citability, crawlability, freshness, authority — with a finding, detail, and
  concrete fix per check. CLI (`npx @dariodario/geochecker <url>`), programmatic
  `runChecks` / `runChecksStream`, and `defineCheck` for custom checks.

[2.0.0]: https://github.com/dariodariolabs/geochecker/compare/v1.1.0...v2.0.0
[1.1.0]: https://github.com/dariodariolabs/geochecker/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/dariodariolabs/geochecker/releases/tag/v1.0.0
