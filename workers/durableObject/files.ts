// Mail App, 2026: Files, the mailbox's private storage. This keeps the names and folders in the mailbox's
// own database; the files themselves are in R2 (see workers/routes/files.ts), so everything here is quick.
// Items in a folder that's in the Bin go with it: they stay inside, and come back when it's restored.

import { BIN_DAYS, sortItems, uniqueName, type FileItem, type FileKind, type FileListing, type FileUsage, type FolderPath } from "../../shared/files";

export interface FileViewer {
	email: string;
	name: string;
}

/** What R2 must forget after items are deleted for good: the file, and an unfinished upload if there was one. */
export interface RemovedFile {
	id: string;
	uploadId: string | null;
}

type Row = Record<string, SqlStorageValue>;

function toItem(row: Row): FileItem {
	return {
		id: String(row.id),
		parentId: row.parent_id ? String(row.parent_id) : null,
		kind: String(row.kind) as FileKind,
		name: String(row.name),
		size: Number(row.size) || 0,
		type: String(row.type ?? ""),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		createdByName: row.created_by_name ? String(row.created_by_name) : null,
		binnedAt: row.binned_at ? String(row.binned_at) : null,
	};
}

/** Uploads that started this long ago and never finished are given up on. */
const STALE_UPLOAD_MS = 2 * 86_400_000;

export class Files {
	constructor(private readonly ctx: DurableObjectState) {}

	private get sql(): SqlStorage {
		return this.ctx.storage.sql;
	}

	private row(id: string): Row | undefined {
		return [...this.sql.exec(`SELECT * FROM files WHERE id = ?1`, id)][0];
	}

	/** A finished file or folder. */
	get(id: string): FileItem | null {
		const row = this.row(id);
		return row && !row.upload_id ? toItem(row) : null;
	}

	/** Is this item, or a folder it's in, in the Bin? */
	private inBin(item: FileItem): boolean {
		let at: FileItem | null = item;
		for (let hops = 0; at && hops < 100; hops++) {
			if (at.binnedAt) return true;
			at = at.parentId ? this.get(at.parentId) : null;
		}
		return false;
	}

	/** A folder that can be shown or added to: it exists and isn't in the Bin. Null is the top level. */
	private liveFolder(id: string | null): FileItem | null | "missing" {
		if (!id) return null;
		const folder = this.get(id);
		if (!folder || folder.kind !== "folder" || this.inBin(folder)) return "missing";
		return folder;
	}

	private namesIn(parentId: string | null, except?: string): string[] {
		const rows = parentId
			? this.sql.exec(`SELECT id, name FROM files WHERE parent_id = ?1 AND binned_at IS NULL`, parentId)
			: this.sql.exec(`SELECT id, name FROM files WHERE parent_id IS NULL AND binned_at IS NULL`);
		return [...rows].filter((r) => String(r.id) !== except).map((r) => String(r.name));
	}

	private pathTo(folder: FileItem | null): FolderPath[] {
		const path: FolderPath[] = [];
		let at = folder?.parentId ? this.get(folder.parentId) : null;
		for (let hops = 0; at && hops < 100; hops++) {
			path.unshift({ id: at.id, name: at.name });
			at = at.parentId ? this.get(at.parentId) : null;
		}
		return path;
	}

	/** What's in a folder (null: the top level). Null when the folder has gone or is in the Bin. */
	list(parentId: string | null): FileListing | null {
		const folder = this.liveFolder(parentId);
		if (folder === "missing") return null;
		const rows = parentId
			? this.sql.exec(`SELECT * FROM files WHERE parent_id = ?1 AND binned_at IS NULL AND upload_id IS NULL`, parentId)
			: this.sql.exec(`SELECT * FROM files WHERE parent_id IS NULL AND binned_at IS NULL AND upload_id IS NULL`);
		return { folder, path: this.pathTo(folder), items: sortItems([...rows].map(toItem), "name", true) };
	}

	/** Everything in the Bin, newest first. Items inside a folder in the Bin are counted with the folder. */
	bin(): FileItem[] {
		const items = [...this.sql.exec(`SELECT * FROM files WHERE binned_at IS NOT NULL AND upload_id IS NULL ORDER BY binned_at DESC`)].map(toItem);
		return items.map((item) => (item.kind === "folder" ? { ...item, size: this.sizeOf(item.id) } : item));
	}

	/** Files and folders whose names contain the words, outside the Bin, with the folder each is in. */
	search(query: string): (FileItem & { folderName: string | null })[] {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
		if (!words.length) return [];
		const like = words.map((_, i) => `LOWER(name) LIKE ?${i + 1} ESCAPE '\\'`).join(" AND ");
		const args = words.map((w) => `%${w.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
		const rows = [...this.sql.exec(`SELECT * FROM files WHERE upload_id IS NULL AND binned_at IS NULL AND ${like} LIMIT 500`, ...args)];
		return rows
			.map(toItem)
			.filter((item) => !this.inBin(item))
			.slice(0, 200)
			.map((item) => ({ ...item, folderName: item.parentId ? (this.get(item.parentId)?.name ?? null) : null }));
	}

	/** Space used: finished files (the Bin's included, as they still take room) and how much of it is in the Bin. */
	usage(): FileUsage {
		const all = [...this.sql.exec(`SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS files FROM files WHERE kind = 'file'`)][0];
		const binned = this.bin().reduce((sum, item) => sum + item.size, 0);
		return { bytes: Number(all?.bytes) || 0, files: Number(all?.files) || 0, binBytes: binned };
	}

	/** Bytes in a folder and everything inside it. */
	private sizeOf(folderId: string): number {
		return this.descendants(folderId).reduce((sum, r) => sum + (Number(r.size) || 0), 0);
	}

	/** Every row inside a folder, at any depth. */
	private descendants(folderId: string): Row[] {
		const out: Row[] = [];
		const queue = [folderId];
		while (queue.length && out.length < 100_000) {
			const id = queue.shift()!;
			for (const row of this.sql.exec(`SELECT * FROM files WHERE parent_id = ?1`, id)) {
				out.push(row);
				if (row.kind === "folder") queue.push(String(row.id));
			}
		}
		return out;
	}

	createFolder(parentId: string | null, name: string, viewer: FileViewer): FileItem | "missing" {
		if (this.liveFolder(parentId) === "missing") return "missing";
		const now = new Date().toISOString();
		const id = crypto.randomUUID();
		const final = uniqueName(name, this.namesIn(parentId), "folder");
		this.sql.exec(
			`INSERT INTO files (id, parent_id, kind, name, size, type, created_at, updated_at, created_by, created_by_name) VALUES (?1, ?2, 'folder', ?3, 0, '', ?4, ?4, ?5, ?6)`,
			id, parentId, final, now, viewer.email || null, viewer.name || null,
		);
		return this.get(id)!;
	}

	/** A folder at the top level with this name, made if there isn't one (for saved email attachments). */
	topFolder(name: string, viewer: FileViewer): FileItem {
		const found = [...this.sql.exec(`SELECT * FROM files WHERE parent_id IS NULL AND kind = 'folder' AND binned_at IS NULL AND LOWER(name) = LOWER(?1) LIMIT 1`, name)][0];
		if (found) return toItem(found);
		return this.createFolder(null, name, viewer) as FileItem;
	}

	/**
	 * Notes a new file. With an uploadId it's still going up in parts and stays hidden until finishUpload;
	 * without, it's already in R2. The name is changed if it's taken.
	 */
	addFile(input: { id: string; parentId: string | null; name: string; size: number; type: string; uploadId: string | null }, viewer: FileViewer): FileItem | "missing" {
		if (this.liveFolder(input.parentId) === "missing") return "missing";
		const now = new Date().toISOString();
		const name = uniqueName(input.name, this.namesIn(input.parentId));
		this.sql.exec(
			`INSERT INTO files (id, parent_id, kind, name, size, type, created_at, updated_at, created_by, created_by_name, upload_id) VALUES (?1, ?2, 'file', ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9)`,
			input.id, input.parentId, name, input.size, input.type, now, viewer.email || null, viewer.name || null, input.uploadId,
		);
		return toItem(this.row(input.id)!);
	}

	/** An upload still going up: its R2 upload id and size, so parts can be checked. */
	pendingUpload(id: string): { uploadId: string; size: number; name: string } | null {
		const row = this.row(id);
		return row?.upload_id ? { uploadId: String(row.upload_id), size: Number(row.size) || 0, name: String(row.name) } : null;
	}

	/** The last part is in: the file shows. Its name is checked again, as another with the same name may have arrived meanwhile. */
	finishUpload(id: string): FileItem | null {
		const row = this.row(id);
		if (!row?.upload_id) return null;
		const parentId = row.parent_id ? String(row.parent_id) : null;
		const parentGone = this.liveFolder(parentId) === "missing";
		const at = parentGone ? null : parentId;
		const name = uniqueName(String(row.name), this.namesIn(at, id));
		this.sql.exec(`UPDATE files SET upload_id = NULL, parent_id = ?2, name = ?3, updated_at = ?4 WHERE id = ?1`, id, at, name, new Date().toISOString());
		return this.get(id);
	}

	/** Forgets an upload that was cancelled or failed. */
	dropUpload(id: string): RemovedFile | null {
		const row = this.row(id);
		if (!row?.upload_id) return null;
		this.sql.exec(`DELETE FROM files WHERE id = ?1`, id);
		return { id, uploadId: String(row.upload_id) };
	}

	rename(id: string, name: string): FileItem | null {
		const item = this.get(id);
		if (!item || this.inBin(item)) return null;
		const final = uniqueName(name, this.namesIn(item.parentId, id), item.kind);
		this.sql.exec(`UPDATE files SET name = ?2, updated_at = ?3 WHERE id = ?1`, id, final, new Date().toISOString());
		return this.get(id);
	}

	/** Moves items into a folder (null: the top level). A folder can't go inside itself. */
	move(ids: string[], parentId: string | null): { moved: number } | "missing" | "into-itself" {
		if (this.liveFolder(parentId) === "missing") return "missing";
		if (parentId) {
			const above = new Set([parentId, ...this.pathTo(this.get(parentId)).map((p) => p.id)]);
			if (ids.some((id) => above.has(id))) return "into-itself";
		}
		let moved = 0;
		for (const id of ids) {
			const item = this.get(id);
			if (!item || item.parentId === parentId || this.inBin(item)) continue;
			const name = uniqueName(item.name, this.namesIn(parentId), item.kind);
			this.sql.exec(`UPDATE files SET parent_id = ?2, name = ?3, updated_at = ?4 WHERE id = ?1`, id, parentId, name, new Date().toISOString());
			moved++;
		}
		return { moved };
	}

	toBin(ids: string[]): number {
		const now = new Date().toISOString();
		let n = 0;
		for (const id of ids) {
			const item = this.get(id);
			if (!item || this.inBin(item)) continue;
			this.sql.exec(`UPDATE files SET binned_at = ?2 WHERE id = ?1`, id, now);
			n++;
		}
		return n;
	}

	/** Takes items out of the Bin, back where they were; to the top level if that folder has gone. */
	restore(ids: string[]): number {
		let n = 0;
		for (const id of ids) {
			const item = this.get(id);
			if (!item?.binnedAt) continue;
			const at = this.liveFolder(item.parentId) === "missing" ? null : item.parentId;
			const name = uniqueName(item.name, this.namesIn(at, id), item.kind);
			this.sql.exec(`UPDATE files SET binned_at = NULL, parent_id = ?2, name = ?3 WHERE id = ?1`, id, at, name);
			n++;
		}
		return n;
	}

	/** Deletes items in the Bin for good, with everything inside them. Returns what R2 must delete. */
	deleteForever(ids: string[]): RemovedFile[] {
		const removed: RemovedFile[] = [];
		for (const id of ids) {
			const row = this.row(id);
			if (!row?.binned_at) continue;
			for (const r of [row, ...(row.kind === "folder" ? this.descendants(id) : [])]) {
				this.sql.exec(`DELETE FROM files WHERE id = ?1`, String(r.id));
				if (r.kind === "file") removed.push({ id: String(r.id), uploadId: r.upload_id ? String(r.upload_id) : null });
			}
		}
		return removed;
	}

	emptyBin(): RemovedFile[] {
		return this.deleteForever([...this.sql.exec(`SELECT id FROM files WHERE binned_at IS NOT NULL`)].map((r) => String(r.id)));
	}

	/** Housekeeping when Files opens: the Bin's old items, and uploads that never finished. */
	tidy(now = Date.now()): RemovedFile[] {
		const binCutoff = new Date(now - BIN_DAYS * 86_400_000).toISOString();
		const old = [...this.sql.exec(`SELECT id FROM files WHERE binned_at IS NOT NULL AND binned_at < ?1`, binCutoff)].map((r) => String(r.id));
		const removed = this.deleteForever(old);
		const uploadCutoff = new Date(now - STALE_UPLOAD_MS).toISOString();
		for (const r of [...this.sql.exec(`SELECT id, upload_id FROM files WHERE upload_id IS NOT NULL AND created_at < ?1`, uploadCutoff)]) {
			this.sql.exec(`DELETE FROM files WHERE id = ?1`, String(r.id));
			removed.push({ id: String(r.id), uploadId: String(r.upload_id) });
		}
		return removed;
	}
}
