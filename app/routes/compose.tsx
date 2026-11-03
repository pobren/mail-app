// Mail App, 2026: /compose opens a new email in the mailbox you last used. It's where the app's
// "New email" shortcut goes, and where email links on websites land when Mail App is your mail app
// (/compose?mailto=mailto:someone@example.com).

import { Loader } from "@cloudflare/kumo";
import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMailboxes } from "~/queries/mailboxes";
import { LAST_MAILBOX_KEY } from "~/lib/app-mode";
import { pageTitle } from "~/lib/brand";

export function meta({ matches }: { matches: readonly unknown[] }) {
	return [{ title: pageTitle(matches, "New email") }];
}

export default function ComposeRoute() {
	const [params] = useSearchParams();
	const navigate = useNavigate();
	const { data: mailboxes, isFetched } = useMailboxes();

	useEffect(() => {
		if (!isFetched) return;
		const list = mailboxes ?? [];
		if (list.length === 0) { navigate("/", { replace: true }); return; }
		let last: string | null = null;
		try { last = localStorage.getItem(LAST_MAILBOX_KEY); } catch { /* private window */ }
		const mailbox = list.find((m) => m.id === last) ?? list[0];
		const compose = new URLSearchParams({ compose: params.get("mailto") ?? "" });
		navigate(`/mailbox/${encodeURIComponent(mailbox.id)}/emails/inbox?${compose}`, { replace: true });
	}, [isFetched, mailboxes, params, navigate]);

	return (
		<div className="flex items-center justify-center h-screen">
			<Loader size="lg" />
		</div>
	);
}
