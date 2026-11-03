// Mail App addition (not part of upstream Agentic Inbox).
// Learning from Spam and Not spam. Each mailbox counts the words, links and senders in mail it has been
// told is spam or genuine (workers/durableObject/spam-learning.ts keeps the counts), and new mail from
// strangers is scored against them. The maths is the Bayesian method SpamAssassin, SpamBayes and Rspamd
// use: Gary Robinson's word probabilities joined with Fisher's chi-squared test. Nothing leaves the mailbox.

/** Neither side counts until the mailbox has learnt at least this many of each. */
export const MIN_LEARNT = 30;
/** Words looked at per email, so a huge email doesn't slow delivery down. */
export const MAX_TOKENS = 400;
/** The most telling words used for a verdict. */
const INTERESTING = 40;
/** Robinson's s and x: how much an unseen word leans, and which way (0.5 = neither). */
const STRENGTH = 1;
const UNKNOWN = 0.5;

export interface LearnInput {
	sender: string;
	subject: string;
	/** Plain text, or HTML (tags are stripped). */
	body: string;
}

const STOP = new Set([
	"the", "and", "for", "you", "your", "are", "with", "this", "that", "from", "have", "has", "was", "were", "will", "can", "our",
	"not", "but", "all", "any", "out", "get", "her", "his", "its", "she", "him", "they", "them", "what", "when", "who", "how",
	"there", "their", "about", "into", "than", "then", "would", "could", "should", "been", "also", "just", "more", "some", "only",
]);

const stripHtml = (s: string) => s
	.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
	.replace(/<[^>]+>/g, " ")
	.replace(/&nbsp;/gi, " ")
	.replace(/&amp;/gi, "&")
	.replace(/&#?\w+;/g, " ");

/**
 * The tokens for one email: its words (subject words marked "s:"), the sites it links to ("u:") and
 * the sender's address and domain ("f:"). Each once, at most MAX_TOKENS.
 */
export function tokensFor(input: LearnInput): string[] {
	const out = new Set<string>();
	const add = (t: string) => { if (out.size < MAX_TOKENS) out.add(t); };
	const sender = input.sender.trim().toLowerCase();
	if (sender.includes("@")) {
		add(`f:${sender}`);
		add(`f:@${sender.split("@")[1]}`);
	}
	for (const m of input.body.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) add(`u:${m[1].toLowerCase().replace(/^www\./, "")}`);
	const words = (text: string) => text.toLowerCase().replace(/['’]/g, "").match(/[\p{L}\p{N}$£€%!]{3,20}/gu) ?? [];
	for (const w of words(input.subject)) if (!STOP.has(w)) add(`s:${w}`);
	for (const w of words(stripHtml(input.body).replace(/https?:\/\/\S+/g, " "))) if (!STOP.has(w)) add(w);
	return [...out];
}

export interface TokenCounts {
	/** Emails learnt as spam and as genuine. */
	spam: number;
	ham: number;
	/** For each token the mailbox has seen: in how many spam and genuine emails. */
	tokens: Map<string, { spam: number; ham: number }>;
}

/** Chi-squared probability, as in SpamBayes (chi2Q with an even number of degrees of freedom). */
function chi2Q(x2: number, v: number): number {
	const m = x2 / 2;
	let sum = Math.exp(-m);
	let term = sum;
	for (let i = 1; i < v / 2; i++) {
		term *= m / i;
		sum += term;
	}
	return Math.min(sum, 1);
}

/**
 * How likely an email is spam, from 0 (genuine) to 1 (spam), or null when the mailbox hasn't learnt
 * enough yet or nothing in the email has been seen before.
 */
export function spamProbability(tokens: string[], counts: TokenCounts): number | null {
	if (counts.spam < MIN_LEARNT || counts.ham < MIN_LEARNT) return null;
	const probs: number[] = [];
	for (const t of tokens) {
		const c = counts.tokens.get(t);
		if (!c || c.spam + c.ham === 0) continue;
		const spamRatio = c.spam / counts.spam;
		const hamRatio = c.ham / counts.ham;
		const p = spamRatio / (spamRatio + hamRatio);
		const n = c.spam + c.ham;
		const f = (STRENGTH * UNKNOWN + n * p) / (STRENGTH + n);
		if (Math.abs(f - 0.5) >= 0.1) probs.push(Math.min(Math.max(f, 0.01), 0.99));
	}
	if (!probs.length) return null;
	const used = probs.sort((a, b) => Math.abs(b - 0.5) - Math.abs(a - 0.5)).slice(0, INTERESTING);
	let lnS = 0;
	let lnH = 0;
	for (const p of used) { lnS += Math.log(1 - p); lnH += Math.log(p); }
	const S = 1 - chi2Q(-2 * lnS, 2 * used.length);
	const H = 1 - chi2Q(-2 * lnH, 2 * used.length);
	return (1 + S - H) / 2;
}

/** What a probability adds to the spam score: "learnt-spam" points, "learnt-genuine" taking points off, or nothing. */
export function learntFinding(p: number | null): { check: "learnt-spam" | "learnt-genuine"; points: number } | null {
	if (p == null) return null;
	if (p >= 0.999) return { check: "learnt-spam", points: 5 };
	if (p >= 0.99) return { check: "learnt-spam", points: 4 };
	if (p >= 0.9) return { check: "learnt-spam", points: 2 };
	if (p <= 0.01) return { check: "learnt-genuine", points: -2 };
	return null;
}
