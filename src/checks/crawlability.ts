import type { CheckCode, CheckResult, FetchedPage } from "../types.js";
import { fetchText, originOf } from "../fetch.js";
import { statusFor } from "../scoring.js";

/**
 * AI crawlers grouped by PURPOSE. This distinction is the whole point of the
 * 2026 robots.txt model (IETF AIPREF `train-ai` vs `search`; Cloudflare's
 * purpose-based defaults): being cited by AI search depends on letting the
 * SEARCH and LIVE-fetch crawlers through. Blocking TRAINING-only crawlers is a
 * legitimate IP/privacy choice that does NOT reduce citation — so we never
 * penalise it.
 *
 * `Google-Extended` / `Applebot-Extended` are intentionally omitted: they are
 * robots.txt control tokens, not crawlers. They govern downstream training use
 * of content already fetched by Googlebot/Applebot, and blocking them has no
 * effect on search or citation.
 */

// Crawlers that build the retrieval index AI search products answer from.
// Allowing these is what keeps you eligible to be cited.
const SEARCH_BOTS = [
	"OAI-SearchBot",
	"PerplexityBot",
	"Claude-SearchBot",
	"Applebot",
	"Amazonbot",
	"Meta-WebIndexer",
	"DuckAssistBot",
];

// User-triggered agents that fetch a page in real time when someone asks about
// it. Secondary to search but still a live path into an answer.
const LIVE_BOTS = [
	"ChatGPT-User",
	"Claude-User",
	"Perplexity-User",
	"MistralAI-User",
	"Meta-ExternalFetcher",
	"Google-CloudVertexBot",
];

// Training-only crawlers. Blocking these does not affect AI-search citation.
const TRAINING_BOTS = [
	"GPTBot",
	"ClaudeBot",
	"Meta-ExternalAgent",
	"CCBot",
	"cohere-ai",
	"Bytespider",
];

// Crawlers that build the citation surface. Search matters most, but a blocked
// live-fetch agent still removes a real path into an answer, so we score
// reachability across both.
const CITATION_BOTS = [...SEARCH_BOTS, ...LIVE_BOTS];

type RobotsRule = {
	agents: string[];
	disallows: string[];
	allows: string[];
};

export async function checkCrawlability(
	page: FetchedPage,
): Promise<CheckResult> {
	const robotsUrl = `${originOf(page.finalUrl)}/robots.txt`;
	const res = await fetchText(robotsUrl);

	// No robots.txt → every crawler reaches you by default. For citation that's
	// the good outcome, not an ambiguity to punish.
	if (!res || res.status >= 400) {
		return result({
			// The good outcome, not an ambiguity: nothing is blocked.
			hasFindings: false,
			score: 90,
			finding:
				"No robots.txt — AI search crawlers can reach you by default.",
			detail: `Fetched ${robotsUrl} → ${res?.status ?? "no response"}. Without rules, well-behaved crawlers proceed, so you stay eligible for AI-search citation. The only thing you give up is the ability to opt out of model training.`,
			fix: "Optional: add a robots.txt only if you want to opt out of AI training (block GPTBot, ClaudeBot, CCBot) while keeping the search crawlers (OAI-SearchBot, PerplexityBot, Claude-SearchBot) allowed. Blocking training does not hurt citation.",
			codes: [
				{
					code: "crawlability.no_robots_txt",
					data: { status: res?.status ?? null },
				},
			],
		});
	}

	const rules = parseRobots(res.text);
	const wildcardBlocksAll = rules
		.find((r) => r.agents.includes("*"))
		?.disallows.some((d) => d === "/");

	const blockedCitation: string[] = [];
	const reachableCitation: string[] = [];
	for (const bot of CITATION_BOTS) {
		if (isBlocked(bot, rules, wildcardBlocksAll)) blockedCitation.push(bot);
		else reachableCitation.push(bot);
	}

	const blockedTraining = TRAINING_BOTS.filter((b) =>
		isBlocked(b, rules, wildcardBlocksAll),
	);

	// Score is purely a function of citation-relevant reachability. Training
	// blocks are surfaced in copy but never move the number.
	const ratio = reachableCitation.length / CITATION_BOTS.length;
	const score = Math.round(100 * ratio);

	const trainingNote =
		blockedTraining.length > 0
			? ` You also block ${blockedTraining.length} training-only crawler(s) (${blockedTraining.join(", ")}) — a valid IP/privacy choice that does not affect citation.`
			: "";

	let finding: string;
	let detail: string;
	let fix: string;
	const codes: CheckCode[] = [];

	if (reachableCitation.length === 0) {
		finding = wildcardBlocksAll
			? "A wildcard Disallow: / blocks every crawler — you are invisible to AI search."
			: "All AI search crawlers are blocked — you are invisible to AI search.";
		detail = `No citation-relevant crawler can reach this page.${trainingNote}`;
		fix =
			"Remove the blanket block, or add User-agent-specific Allow: / rules for the search crawlers (OAI-SearchBot, PerplexityBot, Claude-SearchBot, Applebot, Amazonbot). If your goal was to opt out of training, block only the training crawlers instead.";
		codes.push({
			code: wildcardBlocksAll
				? "crawlability.wildcard_block"
				: "crawlability.all_blocked",
			data: { blockedCitation },
		});
	} else if (blockedCitation.length > 0) {
		finding = `${blockedCitation.length} AI search crawler(s) blocked: ${blockedCitation.join(", ")}.`;
		detail = `${reachableCitation.length}/${CITATION_BOTS.length} citation-relevant crawlers can reach you. Blocked: ${blockedCitation.join(", ")}.${trainingNote}`;
		fix = `Add Allow: / (or remove the Disallow) for the blocked search/live crawlers you want to be cited by: ${blockedCitation.join(", ")}.`;
		codes.push({
			code: "crawlability.some_blocked",
			data: {
				blockedCount: blockedCitation.length,
				reachableCount: reachableCitation.length,
				total: CITATION_BOTS.length,
				blocked: blockedCitation,
			},
		});
	} else {
		finding = "All AI search crawlers can reach this page.";
		detail = `${CITATION_BOTS.length}/${CITATION_BOTS.length} citation-relevant crawlers reachable.${trainingNote}`;
		fix = blockedTraining.length
			? "Maintain. Your training opt-out is correctly scoped and leaves the search crawlers allowed."
			: "Maintain. All AI search and live-fetch crawlers are free to reach you.";
		codes.push({
			code: "crawlability.reachable_all",
			data: { total: CITATION_BOTS.length, blockedTraining },
		});
	}

	// Any blocked citation crawler is a finding, however good the score: being
	// unreachable to even one of them is a concrete, actionable gap.
	return result({
		score,
		finding,
		detail,
		fix,
		codes,
		hasFindings: blockedCitation.length > 0,
	});
}

function result(x: {
	score: number;
	finding: string;
	detail: string;
	fix: string;
	codes: CheckCode[];
	hasFindings: boolean;
}): CheckResult {
	return {
		id: "crawlability",
		category: "access",
		scope: "site",
		score: x.score,
		status: statusFor(x.score, x.hasFindings),
		finding: x.finding,
		detail: x.detail,
		fix: x.fix,
		weight: 1.5,
		codes: x.codes,
	};
}

/**
 * A bot is blocked when its own rule disallows the root, or when the wildcard
 * disallows the root and the bot has no rule of its own overriding it.
 * robots.txt user-agent matching is case-insensitive (RFC 9309).
 */
function isBlocked(
	bot: string,
	rules: RobotsRule[],
	wildcardBlocksAll: boolean | undefined,
): boolean {
	const own = rules.find((r) =>
		r.agents.some((a) => a.toLowerCase() === bot.toLowerCase()),
	);
	if (own) {
		const blocksRoot = own.disallows.some((d) => d === "/");
		const allowsRoot = own.allows.some((a) => a === "/" || a === "");
		return blocksRoot && !allowsRoot;
	}
	return Boolean(wildcardBlocksAll);
}

function parseRobots(text: string): RobotsRule[] {
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.replace(/#.*$/, "").trim())
		.filter(Boolean);

	const rules: RobotsRule[] = [];
	let current: RobotsRule | null = null;
	let lastWasAgent = false;

	for (const line of lines) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim().toLowerCase();
		const value = line.slice(idx + 1).trim();

		if (key === "user-agent") {
			if (!lastWasAgent) {
				current = { agents: [], disallows: [], allows: [] };
				rules.push(current);
			}
			current?.agents.push(value);
			lastWasAgent = true;
		} else if (key === "disallow" && current) {
			current.disallows.push(value);
			lastWasAgent = false;
		} else if (key === "allow" && current) {
			current.allows.push(value);
			lastWasAgent = false;
		} else {
			lastWasAgent = false;
		}
	}

	return rules;
}
