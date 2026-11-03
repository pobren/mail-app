// Mail App addition (not part of upstream Agentic Inbox).
// The Files page: private storage for documents and photos, in folders, kept in the install's own R2
// bucket. Drag files in (or press Upload), open them, send them by email, share them as download links,
// and get them back from the Bin for 30 days. ?folder= is the folder shown, ?bin=1 the Bin, ?q= a search.
import { Button, DropdownMenu, Loader, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArrowCounterClockwiseIcon, ArrowLeftIcon, CaretRightIcon, CheckCircleIcon, CloudArrowUpIcon, DotsThreeVerticalIcon, DownloadSimpleIcon,
	EnvelopeSimpleIcon, EyeIcon, FolderPlusIcon, FolderSimpleIcon, LinkSimpleIcon, MagnifyingGlassIcon, PencilSimpleIcon, TrashIcon,
	UploadSimpleIcon, WarningCircleIcon, XIcon,
} from "@phosphor-icons/react";
import { type DragEvent, useCallback, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import {
	FREE_GB, MAX_FILE_BYTES, PRICE_PER_GB, binExpiry, formatFileSize, monthlyCost, sortItems, type FileItem, type FileSort, type FileUsage,
} from "shared/files";
import { formatExpiry } from "shared/links";
import { FilePreview, FileTypeIcon, MoveDialog, NameDialog, ShareDialog } from "~/components/files/FileDialogs";
import copy from "~/copy/files.en-GB.json";
import { useIsWide } from "~/hooks/useIsWide";
import { useUIStore } from "~/hooks/useUIStore";
import { fill } from "~/lib/attachments";
import { UploadCancelled, fileUrl, storedFile, uploadFile } from "~/lib/file-upload";
import type { SharedLink } from "~/lib/links";
import { useFileBin, useFileChange, useFileSearch, useFiles } from "~/queries/files";
import api from "~/services/api";

interface Upload {
	key: string;
	name: string;
	size: number;
	sent: number;
	status: "uploading" | "done" | "error" | "cancelled";
	error?: string;
	cancel: () => void;
}

const showDate = (iso: string) => {
	const d = new Date(iso);
	const today = new Date();
	if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
	return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
};

/** Does this drag carry files from the computer (rather than rows of the list)? */
const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
const ROW_TYPE = "application/x-mail-app-files";

export default function FilesRoute() {
	const { mailboxId = "" } = useParams<{ mailboxId: string }>();
	const [params, setParams] = useSearchParams();
	const folderId = params.get("folder");
	const inBin = params.get("bin") === "1";
	const query = params.get("q") ?? "";
	const searching = !inBin && query.trim().length > 0;
	const toast = useKumoToastManager();
	const navigate = useNavigate();
	const wide = useIsWide();
	const { startCompose } = useUIStore();

	const listing = useFiles(mailboxId, folderId);
	const bin = useFileBin(mailboxId, inBin);
	const search = useFileSearch(mailboxId, searching ? query : "");
	const [sort, setSort] = useState<{ by: FileSort; asc: boolean }>({ by: "name", asc: true });
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [naming, setNaming] = useState<{ item: FileItem | null } | null>(null);
	const [moving, setMoving] = useState<FileItem[] | null>(null);
	const [sharing, setSharing] = useState<FileItem | null>(null);
	const [previewId, setPreviewId] = useState<string | null>(null);
	const [uploads, setUploads] = useState<Upload[]>([]);
	const [dropping, setDropping] = useState(false);
	const [dropTarget, setDropTarget] = useState<string | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	// Counts drag enters and leaves over the page's parts, so the drop sign goes when the files leave the page.
	const dragDepth = useRef(0);

	const change = useFileChange(mailboxId, (fn: () => Promise<unknown>) => fn());
	const folder = listing.data?.folder ?? null;
	const usage: FileUsage | undefined = inBin ? bin.data?.usage : listing.data?.usage;

	const rawItems: (FileItem & { folderName?: string | null })[] = inBin ? (bin.data?.items ?? []) : searching ? (search.data ?? []) : (listing.data?.items ?? []);
	const items = useMemo(() => (inBin ? rawItems : sortItems(rawItems, sort.by, sort.asc)), [rawItems, sort, inBin]);
	const files = items.filter((i) => i.kind === "file");
	const loading = inBin ? bin.isLoading : searching ? search.isLoading : listing.isLoading;
	const chosen = items.filter((i) => selected.has(i.id));

	const go = useCallback((next: { folder?: string | null; bin?: boolean; q?: string }) => {
		setSelected(new Set());
		const p = new URLSearchParams();
		if (next.bin) p.set("bin", "1");
		else if (next.q) p.set("q", next.q);
		else if (next.folder) p.set("folder", next.folder);
		setParams(p);
	}, [setParams]);

	const run = (fn: () => Promise<unknown>, done?: string) =>
		change.mutateAsync(fn).then(() => { if (done) toast.add({ title: done }); setSelected(new Set()); }).catch((e) => {
			toast.add({ title: (e as { body?: { error?: string } }).body?.error || copy.failed, variant: "error" });
			throw e;
		});

	// ── Uploading ──────────────────────────────────────────────────

	const patchUpload = (key: string, p: Partial<Upload>) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...p } : u)));

	const startUploads = (list: File[], into: string | null) => {
		for (const file of list) {
			if (file.size > MAX_FILE_BYTES) { toast.add({ title: fill(copy.tooBig, { name: file.name }), variant: "error" }); continue; }
			const key = `${Date.now()}-${Math.random()}`;
			const handle = uploadFile(mailboxId, file, into, (sent) => patchUpload(key, { sent }));
			setUploads((u) => [...u, { key, name: file.name, size: file.size, sent: 0, status: "uploading", cancel: handle.cancel }]);
			handle.promise
				.then(() => { patchUpload(key, { status: "done", sent: file.size }); change.mutate(async () => undefined); })
				.catch((e) => patchUpload(key, e instanceof UploadCancelled ? { status: "cancelled" } : { status: "error", error: (e as Error).message }));
		}
	};

	const takeDropped = (e: DragEvent, into: string | null) => {
		const dropped = Array.from(e.dataTransfer.items ?? [])
			.filter((it) => it.kind === "file")
			.map((it) => ({ entry: it.webkitGetAsEntry?.(), file: it.getAsFile() }));
		if (dropped.some((d) => d.entry?.isDirectory)) toast.add({ title: copy.folderSkipped });
		startUploads(dropped.filter((d) => d.file && !d.entry?.isDirectory).map((d) => d.file!), into);
	};

	// ── Acting on items ────────────────────────────────────────────

	const open = (item: FileItem) => {
		if (item.kind === "folder") go({ folder: item.id });
		else setPreviewId(item.id);
	};

	const sendByEmail = async (item: FileItem) => {
		try {
			const file = await storedFile(mailboxId, item);
			if (wide) startCompose({ mode: "new", originalEmail: null, files: [file] });
			else navigate(`/mailbox/${mailboxId}/emails/inbox`, { state: { composeFiles: [file] } });
		} catch {
			toast.add({ title: copy.failed, variant: "error" });
		}
	};

	const emailLink = (item: FileItem, link: SharedLink) => {
		const text = fill(copy.shareEmailText, { name: item.name, url: link.url, date: formatExpiry(new Date(link.expires)) });
		const subject = fill(copy.shareEmailSubject, { name: item.name });
		setSharing(null);
		if (wide) startCompose({ mode: "new", originalEmail: null, subject, text });
		else navigate(`/mailbox/${mailboxId}/emails/inbox`, { state: { composeSubject: subject, composeText: text } });
	};

	const toBin = (list: FileItem[]) => run(() => api.binFiles(mailboxId, list.map((i) => i.id)), list.length === 1 ? copy.binned : fill(copy.binnedMany, { count: list.length }));
	const restore = (list: FileItem[]) => run(() => api.restoreFiles(mailboxId, list.map((i) => i.id)), copy.restored);
	const deleteForever = (list: FileItem[]) => {
		if (!window.confirm(list.length === 1 ? fill(copy.confirmDelete, { name: list[0].name }) : fill(copy.confirmDeleteMany, { count: list.length }))) return;
		run(() => api.deleteFilesForever(mailboxId, list.map((i) => i.id)), copy.deleted).catch(() => {});
	};
	const emptyBin = () => { if (window.confirm(copy.confirmEmpty)) run(() => api.emptyFileBin(mailboxId), copy.deleted).catch(() => {}); };
	const moveTo = (ids: string[], parentId: string | null) => run(() => api.moveFiles(mailboxId, ids, parentId), copy.moved);

	// Rows can be dragged onto a folder (or a folder in the path above) to move them there.
	const dragRow = (e: DragEvent, item: FileItem) => {
		const ids = selected.has(item.id) ? [...selected] : [item.id];
		e.dataTransfer.setData(ROW_TYPE, JSON.stringify(ids));
		e.dataTransfer.effectAllowed = "move";
	};
	const dropOnFolder = (e: DragEvent, target: string | null) => {
		e.preventDefault();
		e.stopPropagation();
		setDropTarget(null);
		dragDepth.current = 0;
		setDropping(false);
		if (carriesFiles(e)) { takeDropped(e, target); return; }
		try {
			const ids = (JSON.parse(e.dataTransfer.getData(ROW_TYPE) || "[]") as string[]).filter((id) => id !== target);
			if (ids.length) moveTo(ids, target).catch(() => {});
		} catch { /* not ours */ }
	};
	const folderDropProps = (target: string | null, key: string) => ({
		onDragOver: (e: DragEvent) => {
			if (!carriesFiles(e) && !Array.from(e.dataTransfer.types).includes(ROW_TYPE)) return;
			e.preventDefault();
			e.stopPropagation();
			setDropTarget(key);
		},
		onDragLeave: () => setDropTarget((t) => (t === key ? null : t)),
		onDrop: (e: DragEvent) => dropOnFolder(e, target),
	});

	const toggle = (id: string) => setSelected((s) => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next; });
	const sortBy = (by: FileSort) => setSort((s) => ({ by, asc: s.by === by ? !s.asc : by === "name" }));

	const preview = previewId ? files.find((f) => f.id === previewId) ?? null : null;
	const previewAt = preview ? files.indexOf(preview) : -1;

	const menu = (item: FileItem) => (
		<DropdownMenu>
			<DropdownMenu.Trigger>
				<Button variant="ghost" shape="square" size="sm" icon={<DotsThreeVerticalIcon size={18} weight="bold" />} aria-label={fill(copy.actionsFor, { name: item.name })} onClick={(e) => e.stopPropagation()} />
			</DropdownMenu.Trigger>
			<DropdownMenu.Content>
				{inBin ? (
					<>
						<DropdownMenu.Item icon={ArrowCounterClockwiseIcon} onClick={() => restore([item])}>{copy.restore}</DropdownMenu.Item>
						<DropdownMenu.Item icon={TrashIcon} onClick={() => deleteForever([item])}>{copy.deleteForever}</DropdownMenu.Item>
					</>
				) : (
					<>
						<DropdownMenu.Item icon={item.kind === "folder" ? FolderSimpleIcon : EyeIcon} onClick={() => open(item)}>{copy.open}</DropdownMenu.Item>
						{item.kind === "file" && (
							<>
								<DropdownMenu.Item icon={DownloadSimpleIcon} onClick={() => { window.location.href = fileUrl(mailboxId, item.id, true); }}>{copy.download}</DropdownMenu.Item>
								<DropdownMenu.Item icon={EnvelopeSimpleIcon} onClick={() => sendByEmail(item)}>{copy.sendByEmail}</DropdownMenu.Item>
								<DropdownMenu.Item icon={LinkSimpleIcon} onClick={() => setSharing(item)}>{copy.shareLink}</DropdownMenu.Item>
							</>
						)}
						<DropdownMenu.Separator />
						<DropdownMenu.Item icon={PencilSimpleIcon} onClick={() => setNaming({ item })}>{copy.rename}</DropdownMenu.Item>
						<DropdownMenu.Item icon={FolderSimpleIcon} onClick={() => setMoving([item])}>{copy.move}</DropdownMenu.Item>
						<DropdownMenu.Item icon={TrashIcon} onClick={() => toBin([item]).catch(() => {})}>{copy.moveToBin}</DropdownMenu.Item>
					</>
				)}
			</DropdownMenu.Content>
		</DropdownMenu>
	);

	const crumbs = [{ id: null as string | null, name: copy.title }, ...(listing.data?.path ?? []), ...(folder ? [{ id: folder.id, name: folder.name }] : [])];
	const title = inBin ? copy.bin : searching ? fill(copy.searchResults, { query }) : (folder?.name ?? copy.title);

	return (
		<div
			className="relative flex h-full min-h-0 flex-col"
			onDragEnter={(e) => { if (!inBin && carriesFiles(e)) { dragDepth.current += 1; setDropping(true); } }}
			onDragOver={(e) => { if (!inBin && carriesFiles(e)) e.preventDefault(); }}
			onDragLeave={(e) => { if (!carriesFiles(e)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDropping(false); }}
			onDrop={(e) => { dragDepth.current = 0; setDropping(false); if (!inBin && carriesFiles(e)) { e.preventDefault(); takeDropped(e, searching ? null : folderId); } }}
		>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-8 md:py-6">
				<div className="mx-auto max-w-5xl">
					{/* Title and buttons */}
					<div className="mb-1 flex flex-wrap items-center justify-between gap-3">
						<div className="flex min-w-0 items-center gap-2">
							{(inBin || searching) && (
								<Button variant="ghost" shape="square" size="sm" icon={<ArrowLeftIcon size={18} />} aria-label={copy.backToFiles} onClick={() => go({ folder: inBin ? null : folderId })} />
							)}
							<h1 className="truncate text-2xl font-semibold text-kumo-default">{title}</h1>
						</div>
						{inBin ? (
							items.length > 0 && <Button variant="secondary" size="sm" icon={<TrashIcon size={14} />} onClick={emptyBin}>{copy.emptyBin}</Button>
						) : (
							<div className="flex gap-2">
								<Tooltip content={copy.bin} side="bottom" asChild>
									<Button variant="ghost" shape="square" size="sm" icon={<TrashIcon size={18} />} aria-label={copy.bin} onClick={() => go({ bin: true })} />
								</Tooltip>
								<Button variant="secondary" size="sm" icon={<FolderPlusIcon size={16} />} onClick={() => setNaming({ item: null })}>
									<span className="hidden sm:inline">{copy.newFolder}</span>
								</Button>
								<Button variant="primary" size="sm" icon={<UploadSimpleIcon size={16} />} onClick={() => fileInput.current?.click()}>{copy.upload}</Button>
								<input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) startUploads(Array.from(e.target.files), searching ? null : folderId); e.target.value = ""; }} />
							</div>
						)}
					</div>

					{inBin ? <p className="mb-4 text-sm text-kumo-subtle">{copy.binIntro}</p> : !folderId && !searching && <p className="mb-4 max-w-2xl text-sm text-kumo-subtle">{copy.intro}</p>}

					{/* Where we are: each step can take dropped files or rows */}
					{!inBin && !searching && folderId && (
						<nav aria-label="Folders" className="mb-3 flex flex-wrap items-center gap-1 text-sm">
							{crumbs.map((c, i) => (
								<span key={c.id ?? "top"} className="flex items-center gap-1">
									{i > 0 && <CaretRightIcon size={12} className="text-kumo-subtle" />}
									{i === crumbs.length - 1 ? (
										<span className="font-medium text-kumo-default">{c.name}</span>
									) : (
										<button type="button" onClick={() => go({ folder: c.id })} {...folderDropProps(c.id, `crumb:${c.id}`)}
											className={`rounded px-1.5 py-0.5 text-kumo-strong hover:bg-kumo-tint ${dropTarget === `crumb:${c.id}` ? "bg-kumo-tint ring-2 ring-kumo-brand" : ""}`}>
											{c.name}
										</button>
									)}
								</span>
							))}
						</nav>
					)}

					{!inBin && (
						<div className="relative mb-3">
							<MagnifyingGlassIcon size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kumo-subtle" />
							<input
								type="search"
								defaultValue={query}
								key={searching ? "search" : folderId ?? "top"}
								onChange={(e) => {
									const q = e.target.value;
									setSelected(new Set());
									setParams((p) => { const n = new URLSearchParams(p); if (q.trim()) n.set("q", q); else n.delete("q"); return n; }, { replace: true });
								}}
								placeholder={copy.search}
								aria-label={copy.search}
								className="w-full rounded-lg border border-kumo-line bg-kumo-base py-2 pl-9 pr-3 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring"
							/>
						</div>
					)}

					{/* With items picked: act on them all */}
					{chosen.length > 0 && (
						<div className="sticky top-0 z-10 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm">
							<span className="font-medium">{fill(copy.selected, { count: chosen.length })}</span>
							<span className="flex-1" />
							{inBin ? (
								<>
									<Button size="sm" variant="secondary" icon={<ArrowCounterClockwiseIcon size={14} />} onClick={() => restore(chosen).catch(() => {})}>{copy.restore}</Button>
									<Button size="sm" variant="secondary" icon={<TrashIcon size={14} />} onClick={() => deleteForever(chosen)}>{copy.deleteForever}</Button>
								</>
							) : (
								<>
									<Button size="sm" variant="secondary" icon={<FolderSimpleIcon size={14} />} onClick={() => setMoving(chosen)}>{copy.move}</Button>
									<Button size="sm" variant="secondary" icon={<TrashIcon size={14} />} onClick={() => toBin(chosen).catch(() => {})}>{copy.moveToBin}</Button>
								</>
							)}
							<Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>{copy.clearSelection}</Button>
						</div>
					)}

					{/* The list */}
					{loading ? (
						<div className="flex justify-center py-16"><Loader size="lg" /></div>
					) : listing.isError && !inBin && !searching ? (
						<div className="py-12 text-center text-sm text-kumo-subtle">
							<p className="mb-3">{(listing.error as { body?: { error?: string } })?.body?.error || copy.failed}</p>
							<Button variant="secondary" size="sm" onClick={() => go({ folder: null })}>{copy.backToFiles}</Button>
						</div>
					) : items.length === 0 ? (
						inBin ? <p className="py-12 text-center text-sm text-kumo-subtle">{copy.binEmpty}</p>
						: searching ? <p className="py-12 text-center text-sm text-kumo-subtle">{copy.noMatch}</p>
						: (
							<button type="button" onClick={() => fileInput.current?.click()}
								className="flex w-full flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-kumo-line px-6 py-16 text-center hover:bg-kumo-tint">
								<CloudArrowUpIcon size={56} className="text-kumo-brand" />
								<span className="text-xl font-semibold text-kumo-default">{copy.emptyTitle}</span>
								<span className="max-w-sm text-sm text-kumo-subtle">{wide ? copy.emptyFolder : copy.emptyFolderPhone}</span>
							</button>
						)
					) : (
						<div className="overflow-hidden rounded-lg border border-kumo-line bg-kumo-base">
							<div className="flex items-center gap-3 border-b border-kumo-line px-3 py-2 text-xs font-medium text-kumo-subtle">
								<input type="checkbox" aria-label={copy.selectAll} checked={chosen.length === items.length}
									onChange={(e) => setSelected(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())} />
								<SortHeader label={copy.name} on={sort.by === "name"} asc={sort.asc} onClick={() => sortBy("name")} className="flex-1" disabled={inBin} />
								<span className="hidden w-40 md:block">{inBin ? copy.deletedColumn : searching ? copy.folder : <SortHeader label={copy.modified} on={sort.by === "updated"} asc={sort.asc} onClick={() => sortBy("updated")} />}</span>
								<span className="hidden w-20 text-right sm:block"><SortHeader label={copy.size} on={sort.by === "size"} asc={sort.asc} onClick={() => sortBy("size")} disabled={inBin} /></span>
								<span className="w-8" />
							</div>
							<ul className="divide-y divide-kumo-line">
								{items.map((item) => {
									const dropKey = `row:${item.id}`;
									const isFolder = item.kind === "folder";
									return (
										<li key={item.id}
											draggable={!inBin}
											onDragStart={(e) => dragRow(e, item)}
											{...(isFolder && !inBin ? folderDropProps(item.id, dropKey) : {})}
											onDoubleClick={() => !inBin && open(item)}
											className={`group flex items-center gap-3 px-3 py-2.5 ${selected.has(item.id) ? "bg-kumo-tint" : "hover:bg-kumo-tint/60"} ${dropTarget === dropKey ? "ring-2 ring-inset ring-kumo-brand" : ""}`}>
											<input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} aria-label={fill(copy.select, { name: item.name })} />
											<button type="button" disabled={inBin} onClick={() => open(item)} className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default">
												<FileTypeIcon item={item} />
												<span className="min-w-0">
													<span className="block truncate text-sm font-medium text-kumo-default">{item.name}</span>
													<span className="block truncate text-xs text-kumo-subtle md:hidden">
														{inBin && item.binnedAt ? fill(copy.goesOn, { date: showDate(binExpiry(item.binnedAt).toISOString()) })
															: searching ? (item.folderName ? fill(copy.inFolder, { folder: item.folderName }) : copy.topLevel)
															: `${showDate(item.updatedAt)}${isFolder ? "" : ` · ${formatFileSize(item.size)}`}`}
													</span>
												</span>
											</button>
											<span className="hidden w-40 truncate text-sm text-kumo-subtle md:block" title={item.createdByName ? fill(copy.addedBy, { name: item.createdByName }) : undefined}>
												{inBin && item.binnedAt ? showDate(item.binnedAt)
													: searching ? (item.folderName ?? copy.filesTop)
													: showDate(item.updatedAt)}
											</span>
											<span className="hidden w-20 text-right text-sm text-kumo-subtle sm:block">{isFolder && !inBin ? "" : formatFileSize(item.size)}</span>
											<span className="w-8">{menu(item)}</span>
										</li>
									);
								})}
							</ul>
						</div>
					)}

					{usage && <UsageLine usage={usage} />}
				</div>
			</div>

			{/* Dragging files over the page */}
			{dropping && !inBin && (
				<div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-2xl border-4 border-dashed border-kumo-brand bg-kumo-base/85">
					<div className="flex flex-col items-center gap-3 text-center">
						<CloudArrowUpIcon size={64} className="text-kumo-brand" />
						<span className="text-2xl font-semibold text-kumo-default">{fill(copy.dropHere, { folder: searching ? copy.title : (folder?.name ?? copy.title) })}</span>
					</div>
				</div>
			)}

			<UploadPanel uploads={uploads} onClear={() => setUploads((u) => u.filter((x) => x.status === "uploading"))} />

			{naming && (
				<NameDialog
					open
					title={naming.item ? copy.rename : copy.newFolder}
					initial={naming.item?.name ?? ""}
					submitLabel={naming.item ? copy.save : copy.create}
					onOpenChange={(o) => { if (!o) setNaming(null); }}
					onSubmit={(name) => naming.item
						? change.mutateAsync(() => api.renameFile(mailboxId, naming.item!.id, name)).then(() => toast.add({ title: copy.renamed }))
						: change.mutateAsync(() => api.createFileFolder(mailboxId, searching ? null : folderId, name)).then(() => toast.add({ title: copy.created }))}
				/>
			)}
			{moving && (
				<MoveDialog mailboxId={mailboxId} items={moving} startIn={searching ? null : folderId}
					onOpenChange={(o) => { if (!o) setMoving(null); }}
					onMove={(parentId) => moveTo(moving.map((i) => i.id), parentId)} />
			)}
			{sharing && (
				<ShareDialog mailboxId={mailboxId} item={sharing} onOpenChange={(o) => { if (!o) setSharing(null); }} onEmail={(link) => emailLink(sharing, link)} />
			)}
			{preview && (
				<FilePreview mailboxId={mailboxId} item={preview} onClose={() => setPreviewId(null)}
					onPrev={previewAt > 0 ? () => setPreviewId(files[previewAt - 1].id) : undefined}
					onNext={previewAt < files.length - 1 ? () => setPreviewId(files[previewAt + 1].id) : undefined} />
			)}
		</div>
	);
}

function SortHeader({ label, on, asc, onClick, className = "", disabled }: { label: string; on: boolean; asc: boolean; onClick: () => void; className?: string; disabled?: boolean }) {
	if (disabled) return <span className={className}>{label}</span>;
	return (
		<button type="button" onClick={onClick} className={`text-left hover:text-kumo-default ${on ? "text-kumo-default" : ""} ${className}`}>
			{label}{on ? (asc ? " ↑" : " ↓") : ""}
		</button>
	);
}

/** How much room the files take, and what Cloudflare charges for it. */
function UsageLine({ usage }: { usage: FileUsage }) {
	const cost = monthlyCost(usage.bytes);
	const share = Math.min(1, usage.bytes / (FREE_GB * 1024 ** 3));
	return (
		<div className="mt-6 space-y-1.5 text-sm text-kumo-subtle">
			<div className="flex items-center gap-3">
				<div className="h-2 w-24 shrink-0 overflow-hidden rounded-full bg-kumo-fill sm:w-40" aria-hidden="true">
					<div className="h-full rounded-full bg-kumo-brand" style={{ width: `${Math.max(usage.bytes ? 2 : 0, Math.round(share * 100))}%` }} />
				</div>
				<span className="font-medium text-kumo-default">
					{usage.binBytes ? fill(copy.usageBin, { used: formatFileSize(usage.bytes), bin: formatFileSize(usage.binBytes) }) : fill(copy.usage, { used: formatFileSize(usage.bytes) })}
				</span>
			</div>
			<p className="text-xs">
				{fill(copy.usageNote, { free: FREE_GB, price: PRICE_PER_GB.toFixed(3) })}
				{cost >= 0.01 ? ` ${fill(copy.usageCost, { cost: cost.toFixed(2) })}` : ""}
			</p>
		</div>
	);
}

/** Uploads in progress, in a card at the bottom corner. */
function UploadPanel({ uploads, onClear }: { uploads: Upload[]; onClear: () => void }) {
	if (!uploads.length) return null;
	const going = uploads.filter((u) => u.status === "uploading");
	return (
		<div className="absolute bottom-3 right-3 z-30 w-[min(22rem,calc(100%-1.5rem))] overflow-hidden rounded-xl border border-kumo-line bg-kumo-base shadow-lg" aria-live="polite">
			<div className="flex items-center justify-between border-b border-kumo-line px-3 py-2 text-sm font-semibold">
				<span>{going.length ? (going.length === 1 ? copy.uploadingOne : fill(copy.uploading, { count: going.length })) : copy.uploadsDone}</span>
				{!going.length && <button type="button" onClick={onClear} aria-label={copy.close} className="rounded p-1 hover:bg-kumo-tint"><XIcon size={14} /></button>}
			</div>
			<ul className="max-h-60 divide-y divide-kumo-line overflow-y-auto">
				{uploads.map((u) => (
					<li key={u.key} className="px-3 py-2 text-sm">
						<div className="flex items-center gap-2">
							{u.status === "done" ? <CheckCircleIcon size={16} weight="fill" className="shrink-0 text-[#2f8a5b]" />
								: u.status === "error" ? <WarningCircleIcon size={16} className="shrink-0 text-kumo-danger" />
								: null}
							<span className="min-w-0 flex-1 truncate">{u.name}</span>
							<span className="shrink-0 text-xs text-kumo-subtle">
								{u.status === "uploading" ? `${Math.floor((u.sent / Math.max(1, u.size)) * 100)}%` : u.status === "done" ? copy.uploaded : u.status === "cancelled" ? copy.cancelled : ""}
							</span>
							{u.status === "uploading" && (
								<button type="button" onClick={u.cancel} aria-label={fill(copy.cancelUpload, { name: u.name })} className="rounded p-0.5 text-kumo-subtle hover:bg-kumo-tint"><XIcon size={14} /></button>
							)}
						</div>
						{u.status === "uploading" && (
							<div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-kumo-fill"><div className="h-full rounded-full bg-kumo-brand transition-[width]" style={{ width: `${(u.sent / Math.max(1, u.size)) * 100}%` }} /></div>
						)}
						{u.status === "error" && <p className="mt-1 text-xs text-kumo-danger">{u.error}</p>}
					</li>
				))}
			</ul>
		</div>
	);
}
