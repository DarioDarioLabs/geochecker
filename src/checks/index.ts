import type { Check } from "../types.js";
import { checkSchema } from "./schema.js";
import { checkStructure } from "./structure.js";
import { checkCitability } from "./citability.js";
import { checkCrawlability } from "./crawlability.js";
import { checkLlmsTxt } from "./llmstxt.js";
import { checkFreshness } from "./freshness.js";
import { checkOg } from "./og.js";
import { checkAuthority } from "./authority.js";
import { checkRenderability } from "./renderability.js";
import { checkIndexable, checkCanonical, checkSitemap } from "./indexability.js";

/** Checks about one page: run on every page of a site scan. */
export const pageChecks: Check[] = [
	checkSchema,
	checkStructure,
	checkCitability,
	checkFreshness,
	checkOg,
	checkAuthority,
	checkRenderability,
	checkIndexable,
	checkCanonical,
];

/** Checks about the site: robots.txt, the sitemap, llms.txt. Run once per site
 *  scan, against the home page; run like any other in a single-page scan. */
export const siteChecks: Check[] = [checkCrawlability, checkSitemap, checkLlmsTxt];

/** Every built-in, in the order a single-page scan runs them. */
export const builtinChecks: Check[] = [...pageChecks, ...siteChecks];
