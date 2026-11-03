// Mail App addition (not part of upstream Agentic Inbox).
// Admin > Branding (admins only): the company's own logo, name, colour and support address on Mail App,
// with a preview. How it's kept and applied is in shared/branding.ts. Saving reloads the page, so the
// new look reaches every part of the app at once. Wording in app/copy/branding.en-GB.json.

import { Button, Input, Loader, Text, useKumoToastManager } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, CheckIcon, ImageIcon, InfoIcon, PaletteIcon, TrashIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type ChangeEvent, type CSSProperties, type FormEvent, useEffect, useRef, useState } from "react";
import { COLOUR_PRESETS, DEFAULT_COLOUR, DEFAULT_NAME, MAX_BRAND_NAME, MAX_LOGO_BYTES, brandColours, cleanColour, logoUrl, type Branding } from "shared/branding";
import AdminShell, { PageHeading } from "~/components/AdminShell";
import adminCopy from "~/copy/admin.en-GB.json";
import copy from "~/copy/branding.en-GB.json";
import peopleCopy from "~/copy/people.en-GB.json";
import { fill } from "~/lib/attachments";
import { pageTitle } from "~/lib/brand";
import { useMe } from "~/queries/people";
import api, { ApiError } from "~/services/api";

const KEY = ["branding"];
const LOGO_TYPES = ["image/png", "image/svg+xml", "image/webp"];

export function meta({ matches }: { matches: readonly unknown[] }) {
	return [{ title: pageTitle(matches, adminCopy.nav.branding) }];
}

/** A logo's size in pixels, read in the browser (0 × 0 if it can't be). */
function measure(file: File): Promise<{ width: number; height: number }> {
	return new Promise((resolve) => {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
		img.onerror = () => { resolve({ width: 0, height: 0 }); URL.revokeObjectURL(url); };
		img.src = url;
	});
}

const reloadSoon = () => setTimeout(() => window.location.reload(), 900);

export default function BrandingRoute() {
	const { data: me } = useMe();
	const isAdmin = me?.role === "admin";
	const toast = useKumoToastManager();
	const { data, isLoading } = useQuery({ queryKey: KEY, queryFn: () => api.getBranding(), enabled: isAdmin });
	const [name, setName] = useState("");
	const [colour, setColour] = useState("");
	const [typed, setTyped] = useState("");
	const [support, setSupport] = useState("");
	const [logo, setLogo] = useState<Branding["logo"]>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!data) return;
		setName(data.name);
		setColour(data.colour);
		setTyped(data.colour);
		setSupport(data.supportEmail);
		setLogo(data.logo);
	}, [data]);

	const failed = (e: unknown) => toast.add({ title: e instanceof ApiError ? e.message : copy.failed, variant: "error" });

	const save = useMutation({
		mutationFn: () => api.saveBranding({ name, colour, supportEmail: support }),
		onSuccess: (next) => {
			if (support.trim() && !next.supportEmail) { toast.add({ title: copy.badEmail, variant: "error" }); return; }
			toast.add({ title: copy.saved });
			reloadSoon();
		},
		onError: failed,
	});
	const reset = useMutation({
		mutationFn: async () => {
			if (logo) await api.removeLogo();
			return api.saveBranding({ name: "", colour: "", supportEmail: "" });
		},
		onSuccess: () => { toast.add({ title: copy.resetDone }); reloadSoon(); },
		onError: failed,
	});
	const upload = useMutation({
		mutationFn: async (file: File) => api.uploadLogo(file, await measure(file)),
		onSuccess: (next) => { setLogo(next.logo); toast.add({ title: copy.logoAdded }); },
		onError: failed,
	});
	const remove = useMutation({
		mutationFn: () => api.removeLogo(),
		onSuccess: () => { setLogo(null); toast.add({ title: copy.logoRemoved }); },
		onError: failed,
	});

	const pickFile = (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (!file) return;
		if (file.size > MAX_LOGO_BYTES) { toast.add({ title: copy.logoTooBig, variant: "error" }); return; }
		if (file.type && !LOGO_TYPES.includes(file.type)) { toast.add({ title: copy.logoWrongType, variant: "error" }); return; }
		upload.mutate(file);
	};
	const choose = (c: string) => { setColour(c === DEFAULT_COLOUR ? "" : c); setTyped(c === DEFAULT_COLOUR ? "" : c); };
	const typeColour = (value: string) => {
		setTyped(value);
		const clean = cleanColour(value);
		if (clean || !value.trim()) setColour(clean === DEFAULT_COLOUR ? "" : clean);
	};
	const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };

	const shades = brandColours(colour);
	const current = colour || DEFAULT_COLOUR;
	// The preview wears the colour being chosen, before it's saved.
	const previewStyle = { "--brand": shades.brand, "--brand-ink": shades.hover, "--brand-rgb": shades.rgb } as CSSProperties;
	const previewLogo = logo ? logoUrl({ name, colour, logo, supportEmail: support }) : null;
	const loading = !me || (isAdmin && (isLoading || !data));

	return (
		<AdminShell isAdmin={isAdmin}>
			<PageHeading title={adminCopy.nav.branding} intro={copy.intro} />
			{loading ? (
				<div className="flex justify-center py-20"><Loader size="lg" /></div>
			) : !isAdmin ? (
				<Text>{peopleCopy.adminOnly}</Text>
			) : (
				<div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
					<form onSubmit={submit} className="rounded-2xl border border-kumo-line bg-kumo-base p-5 shadow-sm sm:p-6">
						<div className="space-y-6">
							<div>
								<span className="mb-1.5 block text-base font-medium text-kumo-default">{copy.logo}</span>
								<div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-kumo-line p-3">
									<span className="inline-flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-kumo-tint">
										{previewLogo ? <img src={previewLogo} alt="" className="max-h-12 max-w-12 object-contain" /> : <ImageIcon size={24} className="text-kumo-subtle" />}
									</span>
									<div className="flex flex-wrap gap-2">
										<Button type="button" variant="secondary" size="sm" icon={<UploadSimpleIcon size={16} />} loading={upload.isPending} onClick={() => fileRef.current?.click()}>
											{logo ? copy.logoChange : copy.logoAdd}
										</Button>
										{logo && (
											<Button type="button" variant="ghost" size="sm" icon={<TrashIcon size={16} />} loading={remove.isPending} onClick={() => remove.mutate()}>
												{copy.logoRemove}
											</Button>
										)}
									</div>
									<input ref={fileRef} type="file" accept=".png,.svg,.webp,image/png,image/svg+xml,image/webp" className="hidden" onChange={pickFile} />
								</div>
								<p className="mt-1 text-xs text-kumo-subtle">{copy.logoHint}</p>
							</div>

							<div>
								<Input label={copy.name} value={name} placeholder={copy.namePlaceholder} maxLength={MAX_BRAND_NAME} autoComplete="organization" onChange={(e) => setName(e.target.value)} />
								<p className="mt-1 text-xs text-kumo-subtle">{copy.nameHint}</p>
							</div>

							<div>
								<span className="mb-1.5 block text-base font-medium text-kumo-default">{copy.colour}</span>
								<div className="flex flex-wrap items-center gap-2.5" role="radiogroup" aria-label={copy.colour}>
									{COLOUR_PRESETS.map((c) => (
										<button
											key={c}
											type="button"
											role="radio"
											aria-checked={current === c}
											aria-label={fill(copy.colourPick, { colour: c })}
											title={c}
											onClick={() => choose(c)}
											className={`inline-flex size-8 items-center justify-center rounded-full text-white ring-offset-2 ring-offset-kumo-base ${current === c ? "ring-2 ring-kumo-default" : ""}`}
											style={{ background: c }}
										>
											{current === c && <CheckIcon size={15} weight="bold" />}
										</button>
									))}
									<label className="ml-1 inline-flex items-center gap-2" title={copy.colourCustom}>
										<input type="color" value={current} onChange={(e) => choose(e.target.value)} aria-label={copy.colourCustom} className="size-8 cursor-pointer rounded-full border border-kumo-line bg-transparent p-0" />
									</label>
									<input
										value={typed}
										placeholder={DEFAULT_COLOUR}
										onChange={(e) => typeColour(e.target.value)}
										aria-label={copy.colourCustom}
										maxLength={7}
										className="w-28 rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-1.5 font-mono text-sm text-kumo-default"
									/>
								</div>
								<p className="mt-1 text-xs text-kumo-subtle">{copy.colourHint}</p>
								{shades.darkened && (
									<p className="mt-2 flex items-start gap-1.5 text-sm text-kumo-default">
										<InfoIcon size={16} className="mt-0.5 shrink-0 text-kumo-subtle" />
										{copy.colourDarkened}
									</p>
								)}
							</div>

							<div>
								<Input label={copy.support} type="email" value={support} placeholder={copy.supportPlaceholder} maxLength={200} onChange={(e) => setSupport(e.target.value)} />
								<p className="mt-1 text-xs text-kumo-subtle">{copy.supportHint}</p>
							</div>
						</div>
						<div className="mt-6 flex flex-wrap gap-2">
							<Button type="submit" variant="primary" icon={<CheckIcon size={16} />} loading={save.isPending}>{copy.save}</Button>
							<Button type="button" variant="ghost" icon={<ArrowCounterClockwiseIcon size={16} />} loading={reset.isPending} onClick={() => reset.mutate()}>{copy.reset}</Button>
						</div>
					</form>

					<div className="space-y-4">
						<div className="rounded-2xl border border-kumo-line bg-kumo-base p-5 shadow-sm sm:p-6" style={previewStyle}>
							<div className="mb-3 flex items-center gap-2">
								<PaletteIcon size={18} weight="duotone" className="text-kumo-subtle" />
								<span className="text-sm font-semibold text-kumo-default">{copy.preview}</span>
							</div>
							<div className="overflow-hidden rounded-xl border border-kumo-line text-sm">
								<div className="flex items-center gap-2 border-b border-kumo-line px-3 py-3 font-semibold text-kumo-default">
									{previewLogo ? <img src={previewLogo} alt="" style={{ height: 22, maxWidth: 88 }} className="object-contain" /> : <PreviewMark />}
									<span className="truncate">{name.trim() || DEFAULT_NAME}</span>
								</div>
								<div className="flex items-center gap-2 bg-[rgba(var(--brand-rgb),0.1)] px-3 py-2 font-semibold text-[var(--brand-ink)]">
									{copy.previewInbox}
									<span className="ml-auto rounded-full bg-[var(--brand)] px-2 text-xs font-bold text-white">4</span>
								</div>
								<div className="px-3 py-2 text-kumo-default">{copy.previewSent}</div>
								<div className="px-3 py-2 text-kumo-default">{copy.previewDrafts}</div>
								<div className="border-t border-kumo-line px-3 py-3">
									<span className="inline-flex items-center rounded-lg bg-[var(--brand)] px-3 py-1.5 text-sm font-semibold text-white">{copy.previewNew}</span>
								</div>
							</div>
							<p className="mt-3 text-xs text-kumo-subtle">
								{(support.trim() || !(name.trim() || logo)) && <>{copy.previewHelp}: <span className="underline">{support.trim() || "help@example.com"}</span> · </>}
								<span className="underline">{copy.previewSignOut}</span>
							</p>
						</div>
						<div className="flex items-start gap-2.5 rounded-2xl border border-kumo-line bg-kumo-recessed p-4">
							<InfoIcon size={18} weight="duotone" className="mt-0.5 shrink-0 text-kumo-subtle" />
							<div>
								<p className="text-sm font-semibold text-kumo-default">{copy.appNoteTitle}</p>
								<p className="mt-1 text-sm text-kumo-subtle">{copy.appNote}</p>
							</div>
						</div>
					</div>
				</div>
			)}
		</AdminShell>
	);
}

/** The Mail App envelope in the colour being chosen, for the preview. */
function PreviewMark() {
	return (
		<svg width={22} height={22} viewBox="0 0 30 30" aria-hidden="true" className="shrink-0">
			<rect x="1" y="5" width="28" height="20" rx="4" fill="var(--brand)" />
			<path d="M5 10l10 7 10-7" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}
