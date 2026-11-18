// Mail App, 2026: small helpers for turning email HTML into plain text (snippets, rules, the text
// part of messages we send, mbox exports). The output is always text, never HTML put back on a page.
// Each replacement runs again until nothing changes, so a tag hidden inside another tag
// (such as "<scr<script>ipt>") can't survive by being put back together once the outer one goes.

/** Run one replacement over and over until the text stops changing. */
export function replaceUntilStable(text: string, pattern: RegExp, replacement: string): string {
	let out = text;
	let previous: string;
	do {
		previous = out;
		out = out.replace(pattern, replacement);
	} while (out !== previous);
	return out;
}

/** Remove whole style, script and head blocks, contents and all. Closing tags may carry spaces or junk ("</script >"). */
export function removeHiddenBlocks(html: string, replacement = ""): string {
	return replaceUntilStable(
		html,
		/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1\b[^>]*>/gi,
		replacement,
	);
}

/** Remove every tag, leaving the text between them. */
export function removeTags(html: string, replacement = ""): string {
	return replaceUntilStable(html, /<[^>]*>/g, replacement);
}
