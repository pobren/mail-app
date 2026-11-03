// Mail App addition (not part of upstream Agentic Inbox).
// Putting files into Files, with progress: small ones in one request, big ones in parts (see
// workers/routes/files.ts). Also fetching a stored file back, to attach it to an email or share it.
import { PART_BYTES, type FileItem } from "shared/files";

const base = (mailboxId: string) => `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/files`;

/** Where a file's contents are: shown in the browser, or saved with download. */
export function fileUrl(mailboxId: string, id: string, download = false): string {
	return `${base(mailboxId)}/${id}/content${download ? "?download=1" : ""}`;
}

export class UploadCancelled extends Error {
	constructor() { super("Upload cancelled"); }
}

interface Sent<T> { promise: Promise<T>; abort: () => void }

/** One request with upload progress (fetch can't report it). */
function send<T>(method: string, url: string, body: Blob, headers: Record<string, string>, onProgress: (loaded: number) => void): Sent<T> {
	const xhr = new XMLHttpRequest();
	const promise = new Promise<T>((resolve, reject) => {
		xhr.open(method, url);
		for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
		xhr.upload.onprogress = (e) => onProgress(e.loaded);
		xhr.onload = () => {
			let parsed: unknown = null;
			try { parsed = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
			if (xhr.status >= 200 && xhr.status < 300) resolve(parsed as T);
			else reject(new Error((parsed as { error?: string } | null)?.error || "This file couldn't be uploaded. Please try again."));
		};
		xhr.onerror = () => reject(new Error("The connection dropped while uploading. Please try again."));
		xhr.onabort = () => reject(new UploadCancelled());
		xhr.send(body);
	});
	return { promise, abort: () => xhr.abort() };
}

export interface UploadHandle {
	promise: Promise<FileItem>;
	cancel: () => void;
}

/** Uploads one file into a folder (null: the top level), reporting bytes sent so far. */
export function uploadFile(mailboxId: string, file: File, parentId: string | null, onProgress: (sent: number) => void): UploadHandle {
	let cancelled = false;
	let current: Sent<unknown> | null = null;
	let uploadId: string | null = null;
	const meta = { name: file.name, type: file.type, size: file.size, parentId };

	const run = async (): Promise<FileItem> => {
		if (file.size <= PART_BYTES) {
			current = send<FileItem>("POST", `${base(mailboxId)}/upload`, file, {
				"content-type": "application/octet-stream",
				"x-mail-app-file": encodeURIComponent(JSON.stringify(meta)),
			}, onProgress);
			return (await current.promise) as FileItem;
		}
		const res = await fetch(`${base(mailboxId)}/uploads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(meta) });
		const started = (await res.json().catch(() => ({}))) as { id?: string; partBytes?: number; parts?: number; error?: string };
		if (!res.ok || !started.id || !started.partBytes || !started.parts) throw new Error(started.error || "This file couldn't be uploaded. Please try again.");
		uploadId = started.id;
		const parts: { partNumber: number; etag: string }[] = [];
		for (let n = 1; n <= started.parts; n++) {
			if (cancelled) throw new UploadCancelled();
			const from = (n - 1) * started.partBytes;
			const slice = file.slice(from, Math.min(file.size, from + started.partBytes));
			// Each part gets a second go, as a long upload is likely to meet a hiccup somewhere.
			for (let attempt = 1; ; attempt++) {
				current = send<{ partNumber: number; etag: string }>("PUT", `${base(mailboxId)}/uploads/${uploadId}/parts/${n}`, slice, { "content-type": "application/octet-stream" }, (loaded) => onProgress(from + loaded));
				try {
					parts.push((await current.promise) as { partNumber: number; etag: string });
					break;
				} catch (e) {
					if (e instanceof UploadCancelled || attempt >= 2) throw e;
				}
			}
		}
		const done = await fetch(`${base(mailboxId)}/uploads/${uploadId}/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts }) });
		const item = (await done.json().catch(() => ({}))) as FileItem & { error?: string };
		if (!done.ok) throw new Error(item.error || "This file couldn't be uploaded. Please try again.");
		return item;
	};

	const promise = run().catch((e) => {
		// A big upload that stops part-way is cleared up straight away rather than left for the tidy-up.
		if (uploadId) fetch(`${base(mailboxId)}/uploads/${uploadId}`, { method: "DELETE" }).catch(() => {});
		throw e;
	});
	return {
		promise,
		cancel: () => { cancelled = true; current?.abort(); },
	};
}

/** A stored file as a File, for the composer or a download link. */
export async function storedFile(mailboxId: string, item: FileItem): Promise<File> {
	const res = await fetch(fileUrl(mailboxId, item.id, true));
	if (!res.ok) throw new Error(`Couldn't fetch ${item.name}`);
	return new File([await res.blob()], item.name, { type: item.type || "application/octet-stream" });
}
