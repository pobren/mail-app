// Mail App, 2026: the mailbox's side of learning from Spam and Not spam (see shared/spam-learning.ts).
// Keeps, for each word, link and sender seen, how many spam and genuine emails it was in, and which
// emails have been learnt and as what, so moving one back changes its counts rather than adding twice.
// The first time it's asked, it learns from the Spam folder and from Inbox and Archive mail from people
// you know, so it's useful from the start.

import { Folders } from "../../shared/folders";
import { tokensFor, spamProbability, type TokenCounts } from "../../shared/spam-learning";

/** Emails learnt from each side when it starts. */
const STARTER = 300;
/** Above this many tokens, ones seen only once are cleared out. */
const MAX_ROWS = 150_000;

export class SpamLearning {
	constructor(private readonly ctx: DurableObjectState) {}

	private get sql(): SqlStorage {
		return this.ctx.storage.sql;
	}

	/** How likely these tokens are spam (0 to 1), or null until enough has been learnt. */
	probability(tokens: string[]): number | null {
		this.start();
		return spamProbability(tokens, this.counts(tokens));
	}

	/** Learn an email already in the mailbox as spam (true) or genuine (false). */
	learnEmail(emailId: string, asSpam: boolean) {
		const row = [...this.sql.exec(`SELECT sender, subject, body FROM emails WHERE id = ?1`, emailId)][0];
		if (!row) return;
		this.learn(emailId, asSpam, tokensFor({ sender: String(row.sender ?? ""), subject: String(row.subject ?? ""), body: String(row.body ?? "") }));
	}

	/** Emails moved between folders by the person: into Spam is spam, out of Spam into the Inbox or Archive is genuine. */
	moved(emailIds: string[], from: string, to: string) {
		if (from === to) return;
		const asSpam = to === Folders.SPAM ? true : from === Folders.SPAM && (to === Folders.INBOX || to === Folders.ARCHIVE) ? false : null;
		if (asSpam === null) return;
		for (const id of emailIds) this.learnEmail(id, asSpam);
	}

	learn(emailId: string, asSpam: boolean, tokens: string[]) {
		const sql = this.sql;
		const before = [...sql.exec(`SELECT as_spam FROM spam_learnt WHERE email_id = ?1`, emailId)][0];
		if (before && Boolean(before.as_spam) === asSpam) return;
		this.ctx.storage.transactionSync(() => {
			if (before) {
				const old = Boolean(before.as_spam) ? "spam" : "ham";
				for (const t of tokens) sql.exec(`UPDATE spam_tokens SET ${old} = MAX(${old} - 1, 0) WHERE token = ?1`, t);
			}
			const col = asSpam ? "spam" : "ham";
			for (const t of tokens) {
				sql.exec(`INSERT INTO spam_tokens (token, ${col}) VALUES (?1, 1) ON CONFLICT(token) DO UPDATE SET ${col} = ${col} + 1`, t);
			}
			sql.exec(`INSERT INTO spam_learnt (email_id, as_spam) VALUES (?1, ?2) ON CONFLICT(email_id) DO UPDATE SET as_spam = ?2`, emailId, asSpam ? 1 : 0);
		});
		this.tidy();
	}

	/** How many emails it has learnt from each side, for Settings. */
	summary(): { spam: number; ham: number } {
		this.start();
		const { spam, ham } = this.totals();
		return { spam, ham };
	}

	private totals() {
		const row = [...this.sql.exec(`SELECT COALESCE(SUM(as_spam), 0) AS spam, COUNT(*) - COALESCE(SUM(as_spam), 0) AS ham FROM spam_learnt`)][0];
		return { spam: Number(row?.spam ?? 0), ham: Number(row?.ham ?? 0) };
	}

	private counts(tokens: string[]): TokenCounts {
		const { spam, ham } = this.totals();
		const map = new Map<string, { spam: number; ham: number }>();
		for (let i = 0; i < tokens.length; i += 90) {
			const chunk = tokens.slice(i, i + 90);
			const marks = chunk.map((_, j) => `?${j + 1}`).join(", ");
			for (const r of this.sql.exec(`SELECT token, spam, ham FROM spam_tokens WHERE token IN (${marks})`, ...chunk)) {
				map.set(String(r.token), { spam: Number(r.spam) || 0, ham: Number(r.ham) || 0 });
			}
		}
		return { spam, ham, tokens: map };
	}

	/** Once per mailbox: learn from the Spam folder, and from mail from people you know or have replied to. */
	private start() {
		const sql = this.sql;
		if ([...sql.exec(`SELECT 1 FROM spam_meta WHERE key = 'started'`)].length) return;
		sql.exec(`INSERT OR IGNORE INTO spam_meta (key, value) VALUES ('started', ?1)`, new Date().toISOString());
		const spam = [...sql.exec(`SELECT id FROM emails WHERE folder_id = ?1 ORDER BY date DESC LIMIT ${STARTER}`, Folders.SPAM)];
		const genuine = [...sql.exec(
			`SELECT e.id FROM emails e WHERE e.folder_id IN (?1, ?2) AND (
				LOWER(e.sender) IN (SELECT email FROM contacts WHERE hidden = 0)
				OR (e.thread_id IS NOT NULL AND EXISTS (SELECT 1 FROM emails s WHERE s.folder_id = ?3 AND s.thread_id = e.thread_id)))
			 ORDER BY e.date DESC LIMIT ${STARTER}`,
			Folders.INBOX, Folders.ARCHIVE, Folders.SENT,
		)];
		for (const r of spam) this.learnEmail(String(r.id), true);
		for (const r of genuine) this.learnEmail(String(r.id), false);
	}

	private tidy() {
		const rows = Number(([...this.sql.exec(`SELECT COUNT(*) AS n FROM spam_tokens`)][0] as { n?: number } | undefined)?.n ?? 0);
		if (rows > MAX_ROWS) this.sql.exec(`DELETE FROM spam_tokens WHERE spam + ham <= 1`);
	}
}
