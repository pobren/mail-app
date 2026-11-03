// Mail App addition (not part of upstream Agentic Inbox).
// Files' dialogs: naming a folder or file, moving items, sharing a file as a download link, choosing
// files to attach to an email, and the full-screen preview.
import { Button, Dialog, Input, Loader, Text } from "@cloudflare/kumo";
import {
	CaretRightIcon, CheckIcon, CopyIcon, DownloadSimpleIcon, EnvelopeSimpleIcon, FileAudioIcon, FileIcon, FileImageIcon, FilePdfIcon,
	FileTextIcon, FileVideoIcon, FileZipIcon, FolderIcon, FolderSimpleIcon, XIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { formatFileSize, previewKind, MAX_TEXT_PREVIEW, type FileItem } from "shared/files";
import { MAX_LINK_BYTES, formatExpiry } from "shared/links";
import copy from "~/copy/files.en-GB.json";
import { fill } from "~/lib/attachments";
import { fileUrl, storedFile } from "~/lib/file-upload";
import { type SharedLink, uploadLink } from "~/lib/links";
import { useFiles } from "~/queries/files";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";

/** An icon that says what kind of file it is. */
export function FileTypeIcon({ item, size = 22 }: { item: Pick<FileItem, "kind" | "type" | "name">; size?: number }) {
	if (item.kind === "folder") return <FolderIcon size={size} weight="fill" className="shrink-0 text-[#e0a526]" />;
	const t = item.type;
	const n = item.name.toLowerCase();
	const cls = "shrink-0";
	if (t.startsWith("image/")) return <FileImageIcon size={size} className={`${cls} text-[#2f8a5b]`} />;
	if (t === "application/pdf") return <FilePdfIcon size={size} className={`${cls} text-[#c8102e]`} />;
	if (t.startsWith("video/")) return <FileVideoIcon size={size} className={`${cls} text-[#7b4fc9]`} />;
	if (t.startsWith("audio/")) return <FileAudioIcon size={size} className={`${cls} text-[#d0632b]`} />;
	if (/zip|compressed|tar|gzip/.test(t) || /\.(zip|7z|rar|gz)$/.test(n)) return <FileZipIcon size={size} className={`${cls} text-kumo-subtle`} />;
	if (t.startsWith("text/") || /word|document|sheet|presentation|rtf/.test(t)) return <FileTextIcon size={size} className={`${cls} text-[#2b6fd0]`} />;
	return <FileIcon size={size} className={`${cls} text-kumo-subtle`} />;
}

/** Asks for a name: a new folder, or renaming something. */
export function NameDialog({ open, title, initial, submitLabel, onOpenChange, onSubmit }: {
	open: boolean;
	title: string;
	initial: string;
	submitLabel: string;
	onOpenChange: (open: boolean) => void;
	onSubmit: (name: string) => Promise<unknown>;
}) {
	const [name, setName] = useState(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => { if (open) { setName(initial); setError(null); } }, [open, initial]);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (!name.trim()) return;
		setBusy(true);
		setError(null);
		try {
			await onSubmit(name.trim());
			onOpenChange(false);
		} catch (err) {
			setError((err as { body?: { error?: string } }).body?.error || copy.failed);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="mb-4 text-base font-semibold">{title}</Dialog.Title>
				<form onSubmit={submit} className="space-y-4">
					<Input
						label={copy.name}
						value={name}
						maxLength={200}
						autoFocus
						onFocus={(e) => {
							// Select the name without its extension, as a computer's file manager does.
							const dot = e.currentTarget.value.lastIndexOf(".");
							e.currentTarget.setSelectionRange(0, dot > 0 ? dot : e.currentTarget.value.length);
						}}
						onChange={(e) => setName(e.target.value)}
					/>
					{error && <Text variant="error" size="sm">{error}</Text>}
					<div className="flex justify-end gap-2">
						<Dialog.Close render={(props) => <Button {...props} variant="secondary">{copy.cancel}</Button>} />
						<Button type="submit" variant="primary" disabled={!name.trim()} loading={busy}>{submitLabel}</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

/** Folder breadcrumbs inside a dialog, for moving around while choosing. */
function DialogPath({ path, folder, onOpen }: { path: { id: string; name: string }[]; folder: FileItem | null; onOpen: (id: string | null) => void }) {
	const crumbs = [{ id: null as string | null, name: copy.filesTop }, ...path, ...(folder ? [{ id: folder.id, name: folder.name }] : [])];
	return (
		<nav className="mb-2 flex flex-wrap items-center gap-1 text-sm">
			{crumbs.map((c, i) => (
				<span key={c.id ?? "top"} className="flex items-center gap-1">
					{i > 0 && <CaretRightIcon size={12} className="text-kumo-subtle" />}
					{i === crumbs.length - 1 ? (
						<span className="font-medium text-kumo-default">{c.name}</span>
					) : (
						<button type="button" className="text-kumo-strong hover:underline" onClick={() => onOpen(c.id)}>{c.name}</button>
					)}
				</span>
			))}
		</nav>
	);
}

/** Choosing where items go. Folders being moved can't be opened (a folder can't go inside itself). */
export function MoveDialog({ mailboxId, items, startIn, onOpenChange, onMove }: {
	mailboxId: string;
	items: FileItem[];
	startIn: string | null;
	onOpenChange: (open: boolean) => void;
	onMove: (parentId: string | null) => Promise<unknown>;
}) {
	const [at, setAt] = useState<string | null>(startIn);
	const [busy, setBusy] = useState(false);
	const { data, isLoading } = useFiles(mailboxId, at);
	const moving = new Set(items.map((i) => i.id));
	const folders = (data?.items ?? []).filter((i) => i.kind === "folder");
	const title = items.length === 1 ? fill(copy.moveTitleOne, { name: items[0].name }) : fill(copy.moveTitle, { count: items.length });
	const here = items.every((i) => i.parentId === at);

	return (
		<Dialog.Root open onOpenChange={onOpenChange}>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="mb-3 text-base font-semibold">{title}</Dialog.Title>
				{data && <DialogPath path={data.path} folder={data.folder} onOpen={setAt} />}
				<ul className="mb-4 max-h-72 min-h-32 overflow-y-auto rounded-lg border border-kumo-line">
					{isLoading ? (
						<li className="flex justify-center py-6"><Loader /></li>
					) : folders.length === 0 ? (
						<li className="px-3 py-6 text-center text-sm text-kumo-subtle">{copy.moveNone}</li>
					) : folders.map((f) => (
						<li key={f.id}>
							<button type="button" disabled={moving.has(f.id)} onClick={() => setAt(f.id)}
								className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-kumo-tint disabled:opacity-40">
								<FolderSimpleIcon size={18} className="text-[#e0a526]" weight="fill" />
								<span className="flex-1 truncate">{f.name}</span>
								<CaretRightIcon size={14} className="text-kumo-subtle" />
							</button>
						</li>
					))}
				</ul>
				<div className="flex justify-end gap-2">
					<Dialog.Close render={(props) => <Button {...props} variant="secondary">{copy.cancel}</Button>} />
					<Button variant="primary" disabled={here || !data} loading={busy}
						onClick={async () => { setBusy(true); try { await onMove(at); onOpenChange(false); } finally { setBusy(false); } }}>
						{copy.moveHere}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

/** Choosing stored files to attach to an email. */
export function PickFilesDialog({ mailboxId, onOpenChange, onPick }: {
	mailboxId: string;
	onOpenChange: (open: boolean) => void;
	onPick: (files: File[]) => void;
}) {
	const [at, setAt] = useState<string | null>(null);
	const [chosen, setChosen] = useState<Map<string, FileItem>>(new Map());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { data, isLoading } = useFiles(mailboxId, at);
	const toggle = (item: FileItem) => setChosen((m) => { const next = new Map(m); if (next.has(item.id)) next.delete(item.id); else next.set(item.id, item); return next; });

	const attach = async () => {
		setBusy(true);
		setError(null);
		try {
			onPick(await Promise.all([...chosen.values()].map((item) => storedFile(mailboxId, item))));
			onOpenChange(false);
		} catch {
			setError(copy.failed);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog.Root open onOpenChange={onOpenChange}>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="mb-3 text-base font-semibold">{copy.pickTitle}</Dialog.Title>
				{data && <DialogPath path={data.path} folder={data.folder} onOpen={setAt} />}
				<ul className="mb-4 max-h-80 min-h-32 overflow-y-auto rounded-lg border border-kumo-line">
					{isLoading ? (
						<li className="flex justify-center py-6"><Loader /></li>
					) : !data?.items.length ? (
						<li className="px-3 py-6 text-center text-sm text-kumo-subtle">{copy.pickNone}</li>
					) : data.items.map((item) => (
						<li key={item.id}>
							{item.kind === "folder" ? (
								<button type="button" onClick={() => setAt(item.id)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-kumo-tint">
									<span className="w-4" />
									<FileTypeIcon item={item} size={18} />
									<span className="flex-1 truncate">{item.name}</span>
									<CaretRightIcon size={14} className="text-kumo-subtle" />
								</button>
							) : (
								<label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-kumo-tint">
									<input type="checkbox" checked={chosen.has(item.id)} onChange={() => toggle(item)} />
									<FileTypeIcon item={item} size={18} />
									<span className="flex-1 truncate">{item.name}</span>
									<span className="shrink-0 text-xs text-kumo-subtle">{formatFileSize(item.size)}</span>
								</label>
							)}
						</li>
					))}
				</ul>
				{error && <Text variant="error" size="sm">{error}</Text>}
				<div className="flex justify-end gap-2">
					<Dialog.Close render={(props) => <Button {...props} variant="secondary">{copy.cancel}</Button>} />
					<Button variant="primary" disabled={chosen.size === 0} loading={busy} onClick={attach}>
						{chosen.size > 1 ? fill(copy.pickAttachCount, { count: chosen.size }) : copy.pickAttach}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

/** Shares one stored file as an encrypted download link, the same kind big attachments use. */
export function ShareDialog({ mailboxId, item, onOpenChange, onEmail }: {
	mailboxId: string;
	item: FileItem;
	onOpenChange: (open: boolean) => void;
	onEmail: (link: SharedLink) => void;
}) {
	const { data: config } = useQuery({ queryKey: queryKeys.config, queryFn: () => api.getConfig(), staleTime: Infinity });
	const [protect, setProtect] = useState(false);
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [link, setLink] = useState<SharedLink | null>(null);
	const [copied, setCopied] = useState(false);
	const tooBig = item.size > MAX_LINK_BYTES;
	const off = config && !config.downloadLinks;

	const make = async () => {
		setBusy(true);
		setError(null);
		try {
			const file = await storedFile(mailboxId, item);
			const bytes = new Uint8Array(await file.arrayBuffer());
			setLink(await uploadLink(mailboxId, { bytes, filename: item.name, type: item.type }, protect ? password : undefined));
		} catch (e) {
			setError((e as Error).message || copy.failed);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog.Root open onOpenChange={onOpenChange}>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="mb-3 text-base font-semibold">{copy.shareLink}</Dialog.Title>
				<div className="space-y-4 text-sm">
					{tooBig ? <p>{fill(copy.shareTooBig, { name: item.name })}</p>
						: off ? <p>{copy.shareOff}</p>
						: link ? (
							<>
								<p>{fill(copy.shareReady, { date: formatExpiry(new Date(link.expires)) })}</p>
								<input readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} aria-label={copy.shareLink}
									className="w-full rounded-md border border-kumo-line bg-kumo-recessed px-2 py-1.5 font-mono text-xs" />
								<div className="flex flex-wrap gap-2">
									<Button variant="primary" size="sm" icon={copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
										onClick={() => navigator.clipboard.writeText(link.url).then(() => setCopied(true)).catch(() => {})}>
										{copied ? copy.copied : copy.copy}
									</Button>
									<Button variant="secondary" size="sm" icon={<EnvelopeSimpleIcon size={14} />} onClick={() => onEmail(link)}>{copy.emailLink}</Button>
								</div>
							</>
						) : (
							<>
								<p>{fill(copy.shareIntro, { name: item.name })}</p>
								<label className="flex items-center gap-2">
									<input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} />
									{copy.sharePassword}
								</label>
								{protect && (
									<div className="space-y-1">
										<input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}
											aria-label={copy.sharePassword} className="w-full rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5" />
										<p className="text-xs text-kumo-subtle">{copy.sharePasswordHint}</p>
									</div>
								)}
								{error && <Text variant="error" size="sm">{error}</Text>}
							</>
						)}
				</div>
				<div className="mt-5 flex justify-end gap-2">
					<Dialog.Close render={(props) => <Button {...props} variant="secondary">{link || tooBig || off ? copy.close : copy.cancel}</Button>} />
					{!link && !tooBig && !off && (
						<Button variant="primary" loading={busy} disabled={protect && password.length < 8} onClick={make}>
							{busy ? copy.shareMaking : copy.shareMake}
						</Button>
					)}
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

/** A text file's first megabyte, shown as plain text. */
function TextPreview({ url }: { url: string }) {
	const [text, setText] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		fetch(url).then((r) => r.text()).then((t) => { if (live) setText(t.slice(0, MAX_TEXT_PREVIEW)); }).catch(() => { if (live) setText(copy.failed); });
		return () => { live = false; };
	}, [url]);
	if (text === null) return <Loader size="lg" />;
	return <pre className="h-full w-full max-w-4xl overflow-auto whitespace-pre-wrap rounded-lg bg-kumo-base p-6 text-sm text-kumo-default">{text}</pre>;
}

/** The whole screen given over to one file, with Download, and arrow keys for the next and previous. */
export function FilePreview({ mailboxId, item, onClose, onPrev, onNext }: {
	mailboxId: string;
	item: FileItem;
	onClose: () => void;
	onPrev?: () => void;
	onNext?: () => void;
}) {
	const url = fileUrl(mailboxId, item.id);
	const kind = previewKind(item.type, item.name, item.size);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
			else if (e.key === "ArrowLeft" && onPrev) onPrev();
			else if (e.key === "ArrowRight" && onNext) onNext();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, onPrev, onNext]);

	return (
		<div className="fixed inset-0 z-50 flex flex-col bg-[#111] text-white" role="dialog" aria-modal="true" aria-label={item.name}>
			<div className="flex items-center gap-3 px-4 py-3">
				<button type="button" onClick={onClose} aria-label={copy.close} className="rounded-full p-2 hover:bg-white/10"><XIcon size={22} /></button>
				<div className="min-w-0 flex-1">
					<div className="truncate text-base font-semibold">{item.name}</div>
					<div className="text-xs text-white/70">{formatFileSize(item.size)}</div>
				</div>
				<a href={fileUrl(mailboxId, item.id, true)} className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm font-medium text-white no-underline hover:bg-white/20">
					<DownloadSimpleIcon size={18} />{copy.download}
				</a>
			</div>
			<div className="relative flex min-h-0 flex-1 items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
				{onPrev && <button type="button" onClick={onPrev} aria-label="Previous" className="absolute left-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-white/10 p-3 text-2xl hover:bg-white/20 md:block">‹</button>}
				{kind === "image" && <img src={url} alt={item.name} className="max-h-full max-w-full object-contain" />}
				{kind === "video" && <video src={url} controls autoPlay className="max-h-full max-w-full" />}
				{kind === "audio" && <audio src={url} controls autoPlay className="w-full max-w-md" />}
				{kind === "pdf" && <iframe src={url} title={item.name} className="h-full w-full max-w-5xl rounded bg-white" />}
				{kind === "text" && <TextPreview url={url} />}
				{!kind && (
					<div className="max-w-sm text-center">
						<FileTypeIcon item={item} size={64} />
						<p className="mt-4 text-base">{copy.noPreview}</p>
					</div>
				)}
				{onNext && <button type="button" onClick={onNext} aria-label="Next" className="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-white/10 p-3 text-2xl hover:bg-white/20 md:block">›</button>}
			</div>
		</div>
	);
}
