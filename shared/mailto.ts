// Mail App, 2026: reading a mailto: link, for when Mail App is your mail app and you click an email
// address on a website. "mailto:a@b.com?cc=c@d.com&subject=Hello&body=Hi" becomes its parts.

export interface MailtoFields {
	to: string;
	cc: string;
	subject: string;
	body: string;
}

const decode = (s: string) => {
	try { return decodeURIComponent(s.replace(/\+/g, "%20")); } catch { return s; }
};

export function parseMailto(link: string): MailtoFields {
	const out: MailtoFields = { to: "", cc: "", subject: "", body: "" };
	const rest = link.trim().replace(/^mailto:/i, "");
	const q = rest.indexOf("?");
	const to = [decode(q === -1 ? rest : rest.slice(0, q))];
	const cc: string[] = [];
	if (q !== -1) {
		for (const part of rest.slice(q + 1).split("&")) {
			const eq = part.indexOf("=");
			const key = decode(eq === -1 ? part : part.slice(0, eq)).toLowerCase();
			const value = eq === -1 ? "" : decode(part.slice(eq + 1));
			if (key === "to") to.push(value);
			else if (key === "cc") cc.push(value);
			else if (key === "subject") out.subject = value.slice(0, 500);
			else if (key === "body") out.body = value.slice(0, 20_000);
		}
	}
	const list = (xs: string[]) => xs.flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean).join(", ");
	out.to = list(to);
	out.cc = list(cc);
	return out;
}
