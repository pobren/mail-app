// Mail App addition (not part of upstream Agentic Inbox).
// AI starts switched off. Nothing is sent to an AI model until the person turns it on in Settings.

/** The models people can choose from in Settings. All run on Workers AI in the owner's own Cloudflare account. */
export const AI_MODELS = [
	{ id: "@cf/zai-org/glm-4.7-flash", name: "GLM-4.7 Flash", maker: "Zhipu AI", note: "High speed, low latency and highly cost-efficient. Fully supported on Cloudflare's free tier." },
	{ id: "@cf/google/gemma-4-26b-a4b-it", name: "Gemma 4 26B", maker: "Google", note: "Balanced open weights, delivering dependable general responses within Cloudflare's free tier." },
	{ id: "@cf/moonshotai/kimi-k2.6", name: "Kimi K2.6", maker: "Moonshot AI", note: "Recommended for nuanced business writing and long-context reasoning. Requires Cloudflare's Workers Paid tier (higher compute cost)." },
] as const;

export const DEFAULT_AI_MODEL: string = AI_MODELS[0].id;

/** The assistant's side-panel chat keeps this many messages, oldest dropped first. */
export const AI_CHAT_KEEP = 100;

export const WORKERS_AI_PRICING_URL = "https://developers.cloudflare.com/workers-ai/platform/pricing/";
export const WORKERS_AI_DATA_URL = "https://developers.cloudflare.com/workers-ai/platform/data-usage/";

export function isAiEnabled(settings: { aiEnabled?: unknown } | null | undefined): boolean {
	return settings?.aiEnabled === true;
}

/** The mailbox's chosen model, or the default when none (or an unknown one) is set. */
export function aiModelFor(settings: { aiModel?: unknown } | null | undefined): string {
	const chosen = settings?.aiModel;
	return AI_MODELS.some((m) => m.id === chosen) ? (chosen as string) : DEFAULT_AI_MODEL;
}
