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
    category: "structure",     // structure | citability | crawlability | freshness | authority
    score: 100,                // 0-100
    status: "pass",            // pass | warn | fail
    finding: "Short summary",
    detail: "Longer explanation",
    fix: "What to do about it",
    weight: 1,                 // higher = more impact on category score
  };
};
```

Add the check to `src/checks/`, register it in `src/index.ts` under `builtinChecks`, and add a corresponding test in `tests/`.

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
