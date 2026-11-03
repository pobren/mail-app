// Mail App addition (not part of upstream Agentic Inbox).
// More automatic spam checks for shared/spam-checks.ts. Most are ported from Apache SpamAssassin's rules
// (Apache License 2.0, https://spamassassin.apache.org), rewritten for JavaScript, with SpamAssassin's own
// scores rounded to whole points:
// - advance-fee fraud phrases, rules/20_advance_fee.cf (ADVANCE_FEE_2, _3, _4)
// - drug spam, rules/20_drugs.cf (DRUG_ED_*, ONLINE_PHARMACY, NO_PRESCRIPTION, VIA_GAP_GRA, DRUG_DOSAGE)
// - "fill in this form" scams, rulesrc/sandbox/jhardin/20_fillform.cf (FILL_THIS_FORM)
// - header checks: MISSING_DATE, MISSING_MID, DATE_IN_FUTURE_96_XX, REPLYTO_WITHOUT_TO_CC,
//   FREEMAIL_FORGED_REPLYTO (rules/20_head_tests.cf, 20_freemail.cf) and EMPTY_MESSAGE
// - link shorteners, rules/25_url_shortener.cf
// The risky attachment check is our own. Everything here runs inside the install: nothing is looked up.

// -- Advance-fee fraud ("Nigerian prince", lottery and inheritance scams) --------------------------

// SpamAssassin's __FRAUD_* phrases. A message using more than two of them is very likely a scam.
const ADVANCE_FEE: RegExp[] = [
	/^(?:re:|\[.{1,10}\])?\s*(?:very )?urgent\s+(?:(?:and|&)\s+)?(?:confidential|assistance|business|attention|reply|response|help)\b/i,
	/(?:\bdollars?\b|\busd(?:ollars)?(?:[0-9]|\b)|\bus\$|\$[0-9,.]{6,}|\$[0-9].{0,8}[mb]illion|\$[0-9.,]{2,10} ?m|\beuros?\b|u[.]?s[.]? [0-9.]+ m)/i,
	/(?:claim|concerning) (?:the|this) money/i,
	/(?:finance|holding|securit(?:ies|y)) (?:company|firm|storage house)/i,
	/(?:government|bank) of nigeria/i,
	/(?:who was a|as a|an? honest|you being a|to any) foreigner/i,
	/\b(?:(?:respond|reply) (?:urgently|immediately)|(?:urgent|immediate|earliest) (?:reply|response))\b/i,
	/\b(?:ass?ass?inat(?:ed|ion)|murder(?:e?d)?|kill(?:ed|ing)\b[^.]{0,99}\b(?:war veterans|rebels?))\b/i,
	/\b(?:central bank of|trust bank|apex bank|amalgamated bank)\b/i,
	/\b(?:business partner(?:s|ship)?|silent partner(?:s|ship)?)\b/i,
	/\b(?:charles taylor|abacha|sese[- ]?seko|kabila)\b/i,
	/\b(?:compliments? of the|dear friend|dear sir|yours faithfully|season'?s greetings)\b/i,
	/\b(?:confidential|private|alternate|alternative) (?:(?:e-? *)?mail)\b/i,
	/\b(?:disburse?(?:ment)?|incurr?(?:ed)?|remunerr?at(?:ed?|ion)|remm?itt?(?:ed|ance|ing)?)\b/i,
	/\b(?:in|to|visit) your country\b/i,
	/\b(?:my name is|i am) (?:mrs?|engr|barrister|dr|prince(?:ss)?)[. ]/i,
	/\b(?:no risks?|risk-? *free|free of risks?|100% safe)\b/i,
	/\b(?:of|the) late president\b/i,
	/\b(?:reply|respond)\b[^.]{0,50}\b(?:to|through)\b[^.]{0,50}@\b/i,
	/\b(?:wife|son|brother|daughter) of the late\b/i,
	/\bU\.?S\.?(?:D\.?)?\s*(?:\$\s*)?(?:\d+,\d+,\d+|\d+\.\d+\.\d+|\d+(?:\.\d+)?\s*milli?on)/i,
	/\baffidavits?\b/i,
	/\battached to ticket number\b/i,
	/\bforeign account\b/i,
	/\bfurnish you with\b/i,
	/\bgive\s+you .{0,15}(?:fund|money|total|sum|contact|percent)\b/i,
	/\bhonest cooperation\b/i,
	/\blegitimate business(?:es)?\b/i,
	/\blocate(?: .{1,20})? extended relative/i,
	/\bmilli?on (?:.{1,25} thousand\s*)?(?:(?:united states|u\.?s\.?) dollars|u\.?s\.?d?)\b/i,
	/\boperat(?:e|ing)\b[^.]{0,99}\b(?:for(?:ei|ie)gn|off-? ?shore|over-? ?seas?) (?:bank )?accounts?\b/i,
	/\bover-? *(?:invoiced?|cost(?:s|ing)?)\b/i,
	/\bprivate lawyer\b/i,
	/\bsecur(?:e|ing) (?:the )?(?:funds?|monies)\b/i,
	/\bthe desk of\b/i,
	/\btransaction\b.{1,30}\b(?:magnitude|diplomatic|strict|absolute|secret|confiden(?:tial|ce)|guarantee)/i,
	/\byour\b[^.]{0,99}\b(?:contact (?:details|information)|private (?:e?[- ]?mail|telephone|tel|phone|fax))\b/i,
	/as the beneficiary/i,
	/award notification/i,
	/computer ballot system/i,
	/fiduciary agent/i,
	/foreign (?:business partner|customer)/i,
	/foreign (?:offshore )?(?:bank|account)/i,
	/god gives .{1,10}second chance/i,
	/i am contacting you/i,
	/lott(?:o|ery) (?:co,?ordinator|international)/i,
	/magnanimity/i,
	/modalit(?:y|ies)/i,
	/nigerian? (?:national|government)/i,
	/the total sum/i,
	/vital documents/i,
];

/** Points for advance-fee fraud: SpamAssassin's ADVANCE_FEE_2, _3 and _4 (more than 2, 3 or 4 phrases). */
export function advanceFeePoints(subjectAndText: string): number {
	const hits = ADVANCE_FEE.filter((re) => re.test(subjectAndText)).length;
	return hits > 4 ? 4 : hits > 3 ? 3 : hits > 2 ? 2 : 0;
}

// -- Drug spam ------------------------------------------------------------------------------------

const DRUGS: RegExp[] = [
	/\b(?:CIALIS|LEVITRA|VIAGRA)/,
	/\bsildenafil\b/i,
	/\bgeneric viagra\b/i,
	/\bviagra .{0,25}(?:express|online|overnight)/i,
	/\bonline pharmacy|\b(?:drugs|medications) online/i,
	/n[o0].{1,10}p(?:er|re)scr[i1]pt[i1][o0]n.{1,10}(?:n[e3][e3]d[e3]d|requ[1i]re|n[e3]c[e3]ssary)/i,
	/\bvia.gra\b/i,
	/\bV(?:agira|igara|iaggra|iaegra)\b/i,
	/\bC(?:alis|ilias|ilais)\b/,
	/[\d.]+ *[$£]? *(?:[\\/]|per) *d.?o.?s.?e\b/i,
];

/** Points for drug spam: 2 for one sign, 3 for two or more. */
export function drugPoints(subjectAndText: string): number {
	const hits = DRUGS.filter((re) => re.test(subjectAndText)).length;
	return hits >= 2 ? 3 : hits === 1 ? 2 : 0;
}

// -- "Fill in this form" -------------------------------------------------------------------------

// A line that's a form label for personal details, such as "Full name:", "2. Date of birth:" or
// "Your bank account number: ____". A simpler form of SpamAssassin's FILL_THIS_FORM tags.
const FORM_LINE = new RegExp(
	String.raw`^\s*(?:\(?\d{1,2}[).:]\s*|[*#-]\s*)?(?:your\s+)?(?:full\s+|first\s+|last\s+|legal\s+|current\s+|home\s+|mobile\s+|private\s+|direct\s+|contact\s+)?` +
	String.raw`(?:names?|surname|age|sex|gender|occupation|profession|marital status|nationality|country|city|state|address|home address|postal address|zip code|post ?code|` +
	String.raw`date of birth|telephone|phone(?: number)?|mobile(?: number)?|fax|e-?mail|next of kin|bank name|bank account(?: number)?|account number|id card|passport(?: number)?|` +
	String.raw`driver'?s licen[cs]e|social security(?: number)?|monthly income|loan amount|amount needed|duration)` +
	String.raw`\s*(?:\([^)]{1,30}\))?\s*[:.]?\s*(?:[_.\-=*]{2,}\s*)?$`,
	"im",
);

/** True when the message asks for personal details as a list of form lines (four or more). */
export function asksForDetails(text: string): boolean {
	let lines = 0;
	for (const line of text.split(/\r?\n/)) {
		if (line.length <= 60 && FORM_LINE.test(line) && ++lines >= 4) return true;
	}
	return false;
}

// -- Link shorteners (SpamAssassin's 25_url_shortener.cf) ----------------------------------------

// Left out: short links big companies use for their own mail (t.co, lnkd.in, youtu.be, amzn.to,
// eepurl.com for Mailchimp, wp.me, flic.kr, dlvr.it), which aren't a sign of anything.
const SHORTENERS = new Set([
	"0rz.tw", "2.ly", "4url.cc", "adf.ly", "alturl.com", "b.link", "bit.do", "bit.ly", "bitly.com", "bitly.ws", "bl.ink", "buff.ly",
	"chilp.it", "clck.ru", "cli.re", "cutt.ly", "cutt.us", "da.gd", "doiop.com", "goo.gl", "goolnk.com", "gplinks.in", "grabify.link",
	"gtly.link", "hurl.it", "hyperurl.co", "inx.lv", "is.gd", "j.mp", "kurl.no", "lnkiy.in", "lnk.sk", "ouo.io", "ow.ly", "qrcd.org",
	"rb.gy", "rebrand.ly", "s.id", "shorl.com", "short.gy", "shorturl.asia", "shorturl.at", "shorturl.com", "shrink.in", "smarturl.it",
	"snip.ly", "spoo.me", "t.ly", "tiny.cc", "tiny.one", "tiny.pl", "tinyl.io", "tinylink.in", "tinyurl.com", "u.to", "url.ie",
	"urlz.at", "urlzs.com", "v.gd", "x.co", "zurl.ws",
]);

export function isShortener(host: string): boolean {
	const h = host.toLowerCase().replace(/^www\./, "");
	return SHORTENERS.has(h);
}

// -- Free email services (a short list from SpamAssassin's 20_freemail_domains.cf) -----------------

const FREEMAIL = new Set([
	"gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.fr", "ymail.com", "rocketmail.com", "outlook.com", "hotmail.com",
	"hotmail.co.uk", "hotmail.fr", "live.com", "live.co.uk", "msn.com", "aol.com", "aol.co.uk", "icloud.com", "me.com", "mac.com",
	"proton.me", "protonmail.com", "gmx.com", "gmx.net", "gmx.de", "web.de", "mail.com", "mail.ru", "inbox.ru", "list.ru", "bk.ru",
	"yandex.com", "yandex.ru", "zoho.com", "tutanota.com", "tuta.io", "qq.com", "163.com", "126.com", "sina.com", "rediffmail.com",
	"libero.it", "virgilio.it", "orange.fr", "laposte.net", "wp.pl", "o2.pl", "interia.pl", "seznam.cz", "btinternet.com",
	"sky.com", "talktalk.net", "virginmedia.com", "ntlworld.com", "naver.com", "hanmail.net", "consultant.com", "post.com",
	"usa.com", "dr.com", "engineer.com", "accountant.com", "financier.com", "lawyer.com", "europe.com", "asia.com",
]);

export function isFreemail(domain: string): boolean {
	return FREEMAIL.has(domain.toLowerCase());
}

// -- Risky attachments (our own) -----------------------------------------------------------------

// Programs, scripts, disk images and shortcuts: nobody sends these by email for a good reason.
// Web pages (.html) are how many fake sign-in pages arrive. Office files with macros can run code.
const RISKY_ENDINGS = new Set([
	"exe", "scr", "com", "pif", "bat", "cmd", "msi", "msc", "cpl", "hta", "jar", "js", "jse", "vbs", "vbe", "wsf", "wsh", "ps1",
	"lnk", "reg", "iso", "img", "vhd", "vhdx", "html", "htm", "shtml", "xhtml", "docm", "xlsm", "pptm", "dotm", "xlam", "one",
]);

/** The first risky attachment's name, or null. Also catches double endings such as "invoice.pdf.exe". */
export function riskyAttachment(filenames: string[] | undefined): string | null {
	for (const name of filenames ?? []) {
		const ending = name.trim().toLowerCase().replace(/[\s.]+$/, "").split(".").pop() ?? "";
		if (name.includes(".") && RISKY_ENDINGS.has(ending)) return name.trim().slice(0, 80);
	}
	return null;
}

// -- Header checks -------------------------------------------------------------------------------

export interface HeaderLike { key: string; value: string }

const header = (headers: HeaderLike[] | undefined, name: string) =>
	headers?.find((h) => h.key.toLowerCase() === name)?.value?.trim() ?? "";

/**
 * Points for a badly made message, as real mail programs never leave these out: no Date (MISSING_DATE),
 * no Message-ID (MISSING_MID), or dated more than four days ahead (DATE_IN_FUTURE_96_XX). Up to 3.
 * Only counted when the headers are known.
 */
export function oddHeaderPoints(headers: HeaderLike[] | undefined, now = Date.now()): number {
	if (!headers?.length) return 0;
	let points = 0;
	const date = header(headers, "date");
	if (!date) points += 2;
	else {
		const when = Date.parse(date);
		if (Number.isFinite(when) && when - now > 96 * 3_600_000) points += 2;
	}
	if (!header(headers, "message-id")) points += 1;
	return Math.min(points, 3);
}

/** Reply-To is set but there's no To or Cc at all, so you can't see who else got it (REPLYTO_WITHOUT_TO_CC). */
export function hiddenRecipients(headers: HeaderLike[] | undefined): boolean {
	if (!headers?.length) return false;
	return !!header(headers, "reply-to") && !header(headers, "to") && !header(headers, "cc");
}
