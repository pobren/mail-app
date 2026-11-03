// Mail App addition (not part of upstream Agentic Inbox).
// Inbox rules: "when a message arrives that matches these, move it to a folder, label it, mark it
// read or star it". Kept in the mailbox's settings file in R2 and run on each new message after the
// spam check. Matching is plain "contains", ignoring capitals, so people don't need to learn patterns.

export const RULE_FIELDS = ["from", "to", "subject", "body", "attachment"] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

export interface RuleCondition {
	field: RuleField;
	/** The words to look for. Not used for "attachment". */
	value?: string;
}

export interface RuleActions {
	/** Folder id to move the message to. */
	folder?: string;
	/** Label ids to add. */
	labels?: string[];
	markRead?: boolean;
	star?: boolean;
}

export interface InboxRule {
	id: string;
	name?: string;
	enabled: boolean;
	/** "all": every condition must match. "any": one is enough. */
	match: "all" | "any";
	conditions: RuleCondition[];
	actions: RuleActions;
}

export const MAX_RULES = 50;
export const MAX_CONDITIONS = 10;
export const MAX_RULE_VALUE = 200;
export const MAX_RULE_NAME = 80;

/** What a rule looks at in a message. */
export interface RuleMessage {
	sender: string;
	senderName?: string | null;
	/** Everyone it was sent to (To and CC), and the address it came in on. */
	recipients: string[];
	subject: string;
	/** HTML or plain text; tags are ignored. */
	body: string;
	hasAttachment: boolean;
}

/** The combined result of every rule that matched. */
export interface RuleOutcome {
	folder?: string;
	labels: string[];
	markRead: boolean;
	star: boolean;
	/** Ids of the rules that matched, in order. */
	matched: string[];
}

const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();

/** Plain text of an email body, with tags and the most common entities removed, for "message contains". */
export function bodyText(body: string): string {
	return body
		.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&quot;/gi, '"')
		.replace(/\s+/g, " ");
}

export function conditionMatches(c: RuleCondition, m: RuleMessage, text?: string): boolean {
	if (c.field === "attachment") return m.hasAttachment;
	const want = lower(c.value).trim();
	if (!want) return false;
	switch (c.field) {
		case "from": return lower(m.sender).includes(want) || lower(m.senderName).includes(want);
		case "to": return m.recipients.some((r) => lower(r).includes(want));
		case "subject": return lower(m.subject).includes(want);
		case "body": return lower(text ?? bodyText(m.body)).includes(want);
	}
	return false;
}

export function ruleMatches(rule: InboxRule, m: RuleMessage, text?: string): boolean {
	if (!rule.enabled || rule.conditions.length === 0) return false;
	// Only work out the plain text once, and only when a rule needs it.
	const needsText = rule.conditions.some((c) => c.field === "body");
	const plain = needsText ? (text ?? bodyText(m.body)) : undefined;
	return rule.match === "any"
		? rule.conditions.some((c) => conditionMatches(c, m, plain))
		: rule.conditions.every((c) => conditionMatches(c, m, plain));
}

/**
 * Runs every rule, top first. Labels, "mark as read" and "star" add up across all matching rules.
 * When more than one rule moves the message, the first one wins.
 */
export function applyRules(rules: InboxRule[] | undefined, m: RuleMessage): RuleOutcome {
	const out: RuleOutcome = { labels: [], markRead: false, star: false, matched: [] };
	if (!rules?.length) return out;
	const text = rules.some((r) => r.enabled && r.conditions.some((c) => c.field === "body")) ? bodyText(m.body) : undefined;
	for (const rule of rules) {
		if (!ruleMatches(rule, m, text)) continue;
		out.matched.push(rule.id);
		const a = rule.actions;
		if (a.folder && !out.folder) out.folder = a.folder;
		for (const l of a.labels ?? []) if (!out.labels.includes(l)) out.labels.push(l);
		if (a.markRead) out.markRead = true;
		if (a.star) out.star = true;
	}
	return out;
}

export function hasAnyAction(a: RuleActions): boolean {
	return !!a.folder || (a.labels?.length ?? 0) > 0 || !!a.markRead || !!a.star;
}

/**
 * Tidies rules from the settings file or the browser: drops unknown fields, trims words, and
 * leaves out rules that couldn't do anything. Never throws.
 */
export function cleanRules(input: unknown): InboxRule[] {
	if (!Array.isArray(input)) return [];
	const out: InboxRule[] = [];
	const seen = new Set<string>();
	for (const raw of input.slice(0, MAX_RULES)) {
		if (!raw || typeof raw !== "object") continue;
		const r = raw as Record<string, unknown>;
		const id = typeof r.id === "string" && /^[\w-]{1,64}$/.test(r.id) && !seen.has(r.id) ? r.id : newRuleId();
		const conditions: RuleCondition[] = [];
		for (const c of Array.isArray(r.conditions) ? r.conditions.slice(0, MAX_CONDITIONS) : []) {
			if (!c || typeof c !== "object") continue;
			const field = (c as RuleCondition).field;
			if (!RULE_FIELDS.includes(field)) continue;
			if (field === "attachment") { conditions.push({ field }); continue; }
			const value = String((c as RuleCondition).value ?? "").trim().slice(0, MAX_RULE_VALUE);
			if (value) conditions.push({ field, value });
		}
		const a = (r.actions && typeof r.actions === "object" ? r.actions : {}) as Record<string, unknown>;
		const actions: RuleActions = {};
		if (typeof a.folder === "string" && a.folder.trim() && a.folder.length <= 100) actions.folder = a.folder.trim();
		const labels = Array.isArray(a.labels) ? [...new Set(a.labels.filter((l): l is string => typeof l === "string" && l.length > 0 && l.length <= 100))].slice(0, 20) : [];
		if (labels.length) actions.labels = labels;
		if (a.markRead === true) actions.markRead = true;
		if (a.star === true) actions.star = true;
		if (conditions.length === 0 || !hasAnyAction(actions)) continue;
		const name = typeof r.name === "string" ? r.name.trim().slice(0, MAX_RULE_NAME) : "";
		seen.add(id);
		out.push({ id, ...(name ? { name } : {}), enabled: r.enabled !== false, match: r.match === "any" ? "any" : "all", conditions, actions });
	}
	return out;
}

export function newRuleId(): string {
	return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
