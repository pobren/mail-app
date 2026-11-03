// Mail App addition (not part of upstream Agentic Inbox).
// Admin > Spam filter, and the optional AI spam check it switches on (see shared/spam-ai.ts). Settings
// are in R2 at setup/spam-filter.json; each day's count of AI checks is in setup/spam-ai/<day>.json,
// so the daily limit holds across the whole install. Two emails arriving at the same moment can both
// be counted as one, so the limit can be passed by a check or two; it's a guard, not a meter.

import { SPAM_AI_MODEL, SPAM_AI_PROMPT, cleanSpamFilterSettings, readSpamAiAnswer, spamAiMessage, type SpamAiVerdict, type SpamFilterSettings } from "../../shared/spam-ai";

const KEY = "setup/spam-filter.json";
const usageKey = (day: string) => `setup/spam-ai/${day}.json`;
const today = () => new Date().toISOString().slice(0, 10);

export async function loadSpamFilter(bucket: R2Bucket): Promise<SpamFilterSettings> {
	try {
		const obj = await bucket.get(KEY);
		return cleanSpamFilterSettings(obj ? await obj.json() : null);
	} catch {
		return cleanSpamFilterSettings(null);
	}
}

export async function saveSpamFilter(bucket: R2Bucket, settings: SpamFilterSettings): Promise<void> {
	await bucket.put(KEY, JSON.stringify(settings), { httpMetadata: { contentType: "application/json" } });
}

/** AI checks so far today. */
export async function aiChecksToday(bucket: R2Bucket): Promise<number> {
	try {
		const obj = await bucket.get(usageKey(today()));
		return obj ? Number(((await obj.json()) as { n?: number }).n) || 0 : 0;
	} catch {
		return 0;
	}
}

async function countCheck(bucket: R2Bucket, before: number) {
	const day = today();
	await bucket.put(usageKey(day), JSON.stringify({ n: before + 1 }), { httpMetadata: { contentType: "application/json" } });
	// Yesterday's count isn't needed any more once a new day has begun.
	if (before === 0) await bucket.delete(usageKey(new Date(Date.now() - 86_400_000).toISOString().slice(0, 10))).catch(() => {});
}

/**
 * Asks the AI about one email, when the AI check is on and today's limit isn't used up. Returns null
 * when it didn't run or couldn't answer: the email then just has the other checks, as before.
 */
export async function aiSpamCheck(
	env: { AI?: Ai; BUCKET: R2Bucket },
	mail: Parameters<typeof spamAiMessage>[0],
): Promise<SpamAiVerdict | null> {
	if (!env.AI) return null;
	const settings = await loadSpamFilter(env.BUCKET);
	if (!settings.ai) return null;
	const used = await aiChecksToday(env.BUCKET);
	if (used >= settings.aiDailyLimit) return null;
	await countCheck(env.BUCKET, used);
	try {
		const answer = (await env.AI.run(SPAM_AI_MODEL as Parameters<Ai["run"]>[0], {
			messages: [
				{ role: "system", content: SPAM_AI_PROMPT },
				{ role: "user", content: spamAiMessage(mail) },
			],
			max_tokens: 80,
			temperature: 0,
		} as never)) as { response?: unknown };
		return readSpamAiAnswer(answer?.response);
	} catch (e) {
		console.error("AI spam check failed, skipping it for this email:", (e as Error).message);
		return null;
	}
}
