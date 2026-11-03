// Mail App addition (not part of upstream Agentic Inbox).
import { isAiEnabled } from "../../shared/ai";

/** Reads the mailbox's own setting from R2. Missing or unreadable settings count as "off". */
export async function aiEnabledFor(bucket: R2Bucket, mailboxId: string): Promise<boolean> {
	try {
		const obj = await bucket.get(`mailboxes/${mailboxId.toLowerCase()}.json`);
		if (!obj) return false;
		return isAiEnabled(await obj.json());
	} catch {
		return false;
	}
}

/** Deletes the assistant's side-panel chat history for a mailbox (when its AI is switched off, or it's deleted). */
export async function forgetAiChat(env: Env, mailboxId: string): Promise<void> {
	try {
		const stub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
		await stub.fetch(new Request("https://agents/forget", { method: "POST" }));
	} catch (e) {
		console.error("AI chat history not cleared:", (e as Error).message);
	}
}
