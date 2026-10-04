# Contributing to GEO Checker

Thanks for your interest. A few notes to set expectations.

## Maintenance posture

GEO Checker is maintained by [Dario Dario](https://dariodario.com) as an open-source companion to our hosted GEO scoring service. We triage issues and PRs roughly weekly. For substantial changes, please open a [Discussion](https://github.com/dariodariolabs/geochecker/discussions) before writing the code so we can align on direction.

## Adding a new check

A check is an async function that takes a `FetchedPage` and returns a `CheckResult`:

```ts
import type { Check } from "@dariodario/geochecker";

export const myCheck: Check = async (page) => {
  return {
    id: "my-check",            // unique ID across all checks
    category: "structure",     // access | structure | substance | identity | freshness
    score: 100,                // 0-100
    status: "pass",            // pass | warn | fail — use statusFor(score, hasFindings)
    finding: "Short summary",
    detail: "Longer explanation",
    fix: "What to do about it",
    weight: 1,                 // higher = more impact on category score; 0 = reported only
    codes: [{ code: "my-check.ok" }], // the contract consumers localise from
  };
};
```

Add the check to `src/checks/`, register it in `src/checks/index.ts` — under
`pageChecks` if it is about one page, under `siteChecks` if it is about the site
(robots.txt, the sitemap) and should run once per site scan — and add a test in
`tests/`. Tests are hermetic: `fetch` is stubbed, so route whatever your check
fetches through the `route()` table.

Weight a new check on measured evidence, not on how important it sounds. A check
everyone passes and a check everyone fails are equally useless; ship at weight 0
and raise it once the distribution across real sites is known.

## Local development

```bash
git clone https://github.com/dariodariolabs/geochecker
cd geochecker
npm install
npm run build       # compile TS → dist/
npm test            # run test suite
npm run dev         # tsc --watch
```

## Code style

- TypeScript strict mode
- Tabs for indentation (matches existing files)
- No `any` without justification
- Small functions; avoid premature abstraction

## License

By contributing, you agree your contributions are released under the [MIT License](./LICENSE).
