// Mail App addition (not part of upstream Agentic Inbox).
// Spotting tracking images in emails. A tracker is a picture whose only job is to tell the
// sender when, where and on what device you opened their email. We look for two things:
// pictures from known tracking services, and tiny or hidden pictures (the classic 1×1 pixel).

/** Known tracking services: host (or the end of one) and the company to name in the notice. */
const TRACKER_HOSTS: [string, string][] = [
	["list-manage.com", "Mailchimp"],
	["mailchimp.com", "Mailchimp"],
	["hubspotemail.net", "HubSpot"],
	["hubspotlinks.com", "HubSpot"],
	["hs-analytics.net", "HubSpot"],
	["sidekickopen", "HubSpot"],
	["sendgrid.net", "SendGrid"],
	["exct.net", "Salesforce"],
	["exacttarget.com", "Salesforce"],
	["klaviyomail.com", "Klaviyo"],
	["trk.klaviyo.com", "Klaviyo"],
	["ctrk.klaviyo.com", "Klaviyo"],
	["rs6.net", "Constant Contact"],
	["createsend1.com", "Campaign Monitor"],
	["cmail19.com", "Campaign Monitor"],
	["cmail20.com", "Campaign Monitor"],
	["sendibt3.com", "Brevo"],
	["sendibt2.com", "Brevo"],
	["sendibm1.com", "Brevo"],
	["mjt.lu", "Mailjet"],
	["awstrack.me", "Amazon"],
	["mandrillapp.com", "Mailchimp"],
	["customeriomail.com", "Customer.io"],
	["track.customer.io", "Customer.io"],
	["links.iterable.com", "Iterable"],
	["acemlna.com", "ActiveCampaign"],
	["acemlnb.com", "ActiveCampaign"],
	["eotrx.substackcdn.com", "Substack"],
	["google-analytics.com", "Google"],
	["doubleclick.net", "Google"],
	["facebook.com/tr", "Facebook"],
	["linkedin.com/emimp", "LinkedIn"],
	["mixpanel.com", "Mixpanel"],
	["mailtrack.io", "Mailtrack"],
	["t.yesware.com", "Yesware"],
	["mailfoogae.appspot.com", "Streak"],
	["r.superhuman.com", "Superhuman"],
	["pstmrk.it", "Postmark"],
	["intercom-mail.com", "Intercom"],
	["via.intercom.io", "Intercom"],
	["mailgun.org", "Mailgun"],
	["email.mg.", "Mailgun"],
];

export interface ImageInfo {
	src: string;
	width?: string | null;
	height?: string | null;
	style?: string | null;
}

/** The tracking company behind a picture's address, if it's a known one. */
export function trackerCompany(src: string): string | null {
	let url: URL;
	try { url = new URL(src); } catch { return null; }
	const host = url.hostname.toLowerCase();
	const hostAndPath = host + url.pathname.toLowerCase();
	for (const [pattern, company] of TRACKER_HOSTS) {
		if (pattern.includes("/")) {
			if (hostAndPath.startsWith(pattern) || hostAndPath.includes("." + pattern)) return company;
		} else if (pattern.endsWith(".")) {
			if (host.startsWith(pattern)) return company;
		} else if (host === pattern || host.endsWith("." + pattern) || (!pattern.includes(".") && host.includes(pattern))) {
			return company;
		}
	}
	return null;
}

function px(v: string | null | undefined): number | null {
	if (v == null) return null;
	const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(px)?$/i);
	return m ? Number(m[1]) : null;
}

/** True for pictures nobody is meant to see: 1×1 or 0×0, or hidden with CSS. */
export function isHiddenPixel(img: ImageInfo): boolean {
	const style = (img.style ?? "").toLowerCase().replace(/\s+/g, "");
	if (/display:none|visibility:hidden|opacity:0(?![.\d])/.test(style)) return true;
	const w = px(img.width) ?? px(style.match(/(?:^|;)width:([^;]+)/)?.[1]);
	const h = px(img.height) ?? px(style.match(/(?:^|;)height:([^;]+)/)?.[1]);
	return w != null && h != null && w <= 2 && h <= 2;
}

/** Whether a picture is a tracker, and who to name: a known company, or the site it comes from. */
export function classifyImage(img: ImageInfo): { tracker: boolean; company: string } {
	const known = trackerCompany(img.src);
	if (known) return { tracker: true, company: known };
	if (isHiddenPixel(img)) {
		let host = "";
		try { host = new URL(img.src).hostname.replace(/^www\./, ""); } catch { /* not a web address */ }
		return { tracker: true, company: host || "an unknown sender" };
	}
	return { tracker: false, company: "" };
}

/** Only pictures from the web are fetched; data: and cid: pictures are already in the email. */
export function isRemoteImage(src: string | null | undefined): boolean {
	return !!src && /^https?:\/\//i.test(src.trim());
}
