// Mail App, 2026: auto-empty the Bin and Spam (see workers/durableObject/auto-empty.ts). 0 means never.

export const AUTO_EMPTY_CHOICES = [0, 7, 14, 30, 60, 90] as const;

export interface AutoEmptySettings {
	/** Days an email stays in the Bin before it's deleted for good. 0: never. */
	trashDays: number;
	/** Days an email stays in Spam before it's deleted for good. 0: never. */
	spamDays: number;
}
