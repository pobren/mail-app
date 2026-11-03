// Mail App: the Mail App mark (the same red envelope as the favicon) with the name,
// help links with the version, and the update notice. With a company's branding (Admin > Branding) it
// shows their logo and name, their own support address, and Mail App's links and updates to admins only.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { logoUrl } from "shared/branding";
import brand from "~/copy/brand.en-GB.json";
import { useBranding, useIsBranded } from "~/lib/brand";
import { useMe } from "~/queries/people";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";

export function LogoMark({ size = 24 }: { size?: number }) {
	const logo = logoUrl(useBranding());
	if (logo) return <img src={logo} alt="" style={{ height: size, maxWidth: size * 4 }} className="shrink-0 object-contain" />;
	return (
		<svg width={size} height={size} viewBox="0 0 30 30" aria-hidden="true" className="shrink-0">
			<rect x="1" y="5" width="28" height="20" rx="4" fill="var(--brand)" />
			<path d="M5 10l10 7 10-7" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

export default function Logo({ size = 24 }: { size?: number }) {
	return (
		<span className="inline-flex items-center gap-2 font-semibold text-kumo-default">
			<LogoMark size={size} />
			{brand.name}
		</span>
	);
}

function useUpdate() {
	return useQuery({
		queryKey: queryKeys.update,
		queryFn: () => api.getUpdate(),
		staleTime: 6 * 60 * 60 * 1000,
		retry: false,
	});
}

const fill = (text: string, version: string) => text.replace("{version}", version);

/** Small "Help · Sign out · Version 1.1" help links, for the foot of the mailbox list and the sidebar. */
export function HelpLinks({ className = "" }: { className?: string }) {
	const { data } = useUpdate();
	const branding = useBranding();
	const { data: me } = useMe();
	// Once branded, the app's own help links and version are for admins only. Everyone else sees the
	// company's own support address, if it has one.
	const admin = me?.role === "admin";
	const branded = useIsBranded();
	const forApp = !branded || admin;
	const support = branding.supportEmail || "";
	return (
		<p className={`text-xs text-kumo-subtle ${className}`}>
			{(forApp || support) && <>{brand.helpTitle}:{" "}</>}
			{forApp && (<>
				<a href={brand.guidesUrl} target="_blank" rel="noreferrer" className="underline hover:text-kumo-default">
					{brand.guidesText}
				</a>
				{" · "}
			</>)}
			{support && (<>
				<a href={`mailto:${support}`} className="underline hover:text-kumo-default">
					{support}
				</a>
				{" · "}
			</>)}
			<a href={brand.signOutUrl} className="underline hover:text-kumo-default">
				{brand.signOut}
			</a>
			{forApp && data?.current && data.changesUrl && (
				<>
					{" · "}
					<a href={data.changesUrl} target="_blank" rel="noreferrer" className="underline hover:text-kumo-default">
						{fill(brand.versionText, data.current)}
					</a>
				</>
			)}
		</p>
	);
}

// Hiding the notice lasts until the next version, so a later update still shows.
const HIDE_KEY = "app-hide-update";
function hiddenVersion(): string | null {
	try { return localStorage.getItem(HIDE_KEY); } catch { return null; }
}

/** "Mail App 1.2 is ready", when GitHub has a newer release. Shows nothing otherwise, or once hidden. */
export function UpdateNotice({ className = "" }: { className?: string }) {
	const { data } = useUpdate();
	const branded = useIsBranded();
	const { data: me } = useMe();
	const [hidden, setHidden] = useState<string | null>(null);
	useEffect(() => setHidden(hiddenVersion()), []);
	if (!data?.available || !data.url) return null;
	if (branded && me?.role !== "admin") return null;
	const latest = data.latest ?? "";
	if (latest && hidden === latest) return null;
	const hide = () => {
		try { localStorage.setItem(HIDE_KEY, latest); } catch {}
		setHidden(latest);
	};
	return (
		<div className={`flex items-start gap-2 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default ${className}`}>
			<div className="min-w-0 flex-1">
				<b>{latest ? fill(brand.updateTitle, latest) : brand.updateTitleNoVersion}</b>{" "}
				<span className="text-kumo-subtle">
					{brand.updateText}
				</span>{" "}
				<a href={data.url} target="_blank" rel="noreferrer" className="font-semibold underline whitespace-nowrap" style={{ color: "var(--brand)" }}>
					{brand.updateLink}
				</a>
				{data.changesUrl && (
					<>
						{" · "}
						<a href={data.changesUrl} target="_blank" rel="noreferrer" className="underline whitespace-nowrap">
							{brand.updateChanges}
						</a>
					</>
				)}
			</div>
			{latest && (
				<button type="button" onClick={hide} aria-label={brand.updateHideLabel} title={brand.updateHideLabel} className="shrink-0 text-xs text-kumo-subtle underline hover:text-kumo-default">
					{brand.updateHide}
				</button>
			)}
		</div>
	);
}
