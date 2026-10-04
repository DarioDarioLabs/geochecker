import type { CheckResult, FetchedPage } from "../types.js";
import { fetchText, originOf } from "../fetch.js";

/**
 * llms.txt is INFORMATIONAL ONLY — weight 0, never affects the score.
 *
 * As of mid-2026 the evidence is that no major AI search engine consumes
 * llms.txt for retrieval or citation: Ahrefs found ~97% of llms.txt files
 * received zero bot requests (137K domains, Jun 2026) and Google (Mueller,
 * Illyes) states no AI system uses it. Its only confirmed real use is routing
 * for developer coding agents (Cursor, Mintlify, docs tooling). We still report
 * its presence as a neutral note, but we no longer treat its absence as a
 * problem — docking points for a missing file that AI search ignores would be
 * misleading.
 */
export async function checkLlmsTxt(page: FetchedPage): Promise<CheckResult> {
	const url = `${originOf(page.finalUrl)}/llms.txt`;
	const res = await fetchText(url);
	const present = Boolean(res && res.status < 400);

	// Always score 100 / pass: this check no longer penalises. The signal is
	// entirely in the copy.
	if (!present) {
		return {
			id: "llms_txt",
			category: "access",
			scope: "site",
			score: 100,
			status: "pass",
			finding: "No /llms.txt — not needed for AI-search citation.",
			detail: `Fetched ${url} → ${res?.status ?? "no response"}. As of 2026 no major AI search engine reads llms.txt (Ahrefs: ~97% of such files get zero bot requests; Google confirms it is unused). This is informational only and does not affect your score.`,
			fix: "Nothing required. Only publish /llms.txt if you want to help developer coding agents (Cursor, Mintlify, docs tooling) navigate your content — it is not an AI-search ranking or citation signal.",
			weight: 0,
			codes: [{ code: "llms_txt.not_used", data: { status: res?.status ?? null } }],
		};
	}

	const bytes = res!.text.trim().length;
	return {
		id: "llms_txt",
		category: "access",
		scope: "site",
		score: 100,
		status: "pass",
		finding: "/llms.txt present — useful for coding agents, not AI search.",
		detail: `${bytes} bytes. llms.txt helps developer coding agents (Cursor, Mintlify, docs tooling) route your content, but no major AI search engine uses it for citation. Informational only — it does not affect your score.`,
		fix: "Keep it if it serves your docs/coding-agent audience. It has no effect on AI-search visibility either way.",
		weight: 0,
		codes: [{ code: "llms_txt.present", data: { bytes } }],
	};
}
