// Mail App 2.3: whether an email can be shown dark (app/components/EmailIframe.tsx).

/** An email that sets no colours of its own (most personal mail) can be shown dark too. One that
 *  sets its own colours or backgrounds (newsletters, receipts) stays as its sender designed it. */
export function setsOwnColours(html: string): boolean {
	if (/\b(bgcolor|background)\s*=|<font[^>]*\bcolor\s*=/i.test(html)) return true;
	// A colour or background inside a style="…" attribute (not border-color and the like).
	return /style\s*=\s*(["'])(?:(?!\1).)*?(?<=[;\s"'])(?:color|background(?:-color|-image)?)\s*:/is.test(html);
}
