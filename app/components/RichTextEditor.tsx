// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: a fuller toolbar (paragraph style, font, size, colour, highlight,
// alignment, indent, tables, pictures in the message, emoji, clear formatting), shown in full only
// after "More". Everything is saved as inline styles so Gmail and Outlook show it as written.

import { Button, DropdownMenu, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArrowClockwiseIcon,
	ArrowCounterClockwiseIcon,
	CaretDownIcon,
	EraserIcon,
	HighlighterIcon,
	ImageIcon,
	LinkBreakIcon,
	LinkSimpleIcon,
	ListBulletsIcon,
	ListNumbersIcon,
	MinusIcon,
	QuotesIcon,
	SmileyIcon,
	TableIcon,
	TextAaIcon,
	TextAlignCenterIcon,
	TextAlignJustifyIcon,
	TextAlignLeftIcon,
	TextAlignRightIcon,
	TextBIcon,
	TextIndentIcon,
	TextItalicIcon,
	TextOutdentIcon,
	TextStrikethroughIcon,
	TextUnderlineIcon,
} from "@phosphor-icons/react";
import type { Editor } from "@tiptap/core";
import Highlight from "@tiptap/extension-highlight";
import TiptapImage from "@tiptap/extension-image";
import LinkExtension from "@tiptap/extension-link";
import { TableKit } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import { Color, FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Indent } from "~/lib/editor-indent";
import { isPicture, pictureDataUrl } from "~/lib/inline-picture";

interface RichTextEditorProps {
	value: string;
	onChange: (value: string) => void;
}

const STYLES = [
	{ label: "Normal text", level: 0 },
	{ label: "Heading 1", level: 1 },
	{ label: "Heading 2", level: 2 },
	{ label: "Heading 3", level: 3 },
] as const;

// Fonts every computer and phone has, with fallbacks.
const FONTS = [
	{ label: "Sans serif", value: "" },
	{ label: "Serif", value: "Georgia, 'Times New Roman', serif" },
	{ label: "Fixed width", value: "'Courier New', Courier, monospace" },
	{ label: "Wide", value: "Verdana, Geneva, sans-serif" },
	{ label: "Narrow", value: "'Arial Narrow', Arial, sans-serif" },
	{ label: "Trebuchet", value: "'Trebuchet MS', Helvetica, sans-serif" },
];

const SIZES = [
	{ label: "Small", value: "12px" },
	{ label: "Normal", value: "" },
	{ label: "Large", value: "18px" },
	{ label: "Huge", value: "28px" },
];

const COLOURS = [
	"#000000", "#444444", "#888888", "#cccccc", "#ffffff",
	"#c0392b", "#e67e22", "#f1c40f", "#27ae60", "#16a085",
	"#2980b9", "#1f3a93", "#8e44ad", "#d35400", "#7f8c8d",
];

const HIGHLIGHTS = ["#fff59d", "#c8e6c9", "#b3e5fc", "#f8bbd0", "#ffe0b2", "#e1bee7"];

const EMOJI = [
	"😀", "😃", "😄", "😁", "😆", "😅", "😂", "🙂", "😉", "😊", "😍", "🥰",
	"😘", "😎", "🤔", "😐", "🙄", "😬", "😢", "😭", "😮", "😴", "🤗", "🙃",
	"👍", "👎", "👏", "🙌", "🙏", "👋", "💪", "🤝", "👌", "✌️", "🤞", "👀",
	"❤️", "💙", "💚", "💛", "🧡", "💜", "🎉", "🎂", "🎁", "🔥", "⭐", "✨",
	"✅", "❌", "⚠️", "❓", "💡", "📎", "📅", "📌", "☕", "🍻", "🌞", "🌧️",
];

const ALIGNS = [
	{ value: "left", label: "Left", icon: TextAlignLeftIcon },
	{ value: "center", label: "Centre", icon: TextAlignCenterIcon },
	{ value: "right", label: "Right", icon: TextAlignRightIcon },
	{ value: "justify", label: "Justify", icon: TextAlignJustifyIcon },
] as const;

const FULL_TOOLBAR_KEY = "mailapp.composer.fullToolbar";

const CELL_STYLE = "border: 1px solid #cccccc; padding: 6px 8px; vertical-align: top;";

function Swatch({ colour }: { colour: string }) {
	return <span className="inline-block h-4 w-4 rounded-sm border border-kumo-line" style={{ background: colour }} />;
}

function ToolButton({ label, active, disabled, icon, onClick }: { label: string; active?: boolean; disabled?: boolean; icon: ReactNode; onClick: () => void }) {
	return (
		<Tooltip content={label} side="bottom" asChild>
			<Button
				type="button"
				variant={active ? "secondary" : "ghost"}
				shape="square"
				size="sm"
				icon={icon}
				onClick={onClick}
				disabled={disabled}
				aria-label={label}
				aria-pressed={active}
			/>
		</Tooltip>
	);
}

function Divider() {
	return <div className="mx-1 h-5 w-px bg-kumo-fill" />;
}

/** A toolbar button that opens a menu. */
function ToolMenu({ label, trigger, children, wide }: { label: string; trigger: ReactNode; children: ReactNode; wide?: boolean }) {
	return (
		<DropdownMenu>
			<DropdownMenu.Trigger>
				<Button type="button" variant="ghost" size="sm" aria-label={label} title={label} className={wide ? "gap-1" : "gap-0.5 px-1.5"}>
					{trigger}
					<CaretDownIcon size={10} />
				</Button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Content>{children}</DropdownMenu.Content>
		</DropdownMenu>
	);
}

export default function RichTextEditor({
	value,
	onChange,
}: RichTextEditorProps) {
	const toastManager = useKumoToastManager();
	const pictureInput = useRef<HTMLInputElement>(null);
	const editorRef = useRef<Editor | null>(null);
	// Simple toolbar by default; "More formatting" shows everything and is remembered on this device.
	const [full, setFull] = useState(() => {
		try { return typeof window !== "undefined" && window.localStorage.getItem(FULL_TOOLBAR_KEY) === "1"; } catch { return false; }
	});
	const toggleFull = () => {
		setFull((on) => {
			try { window.localStorage.setItem(FULL_TOOLBAR_KEY, on ? "0" : "1"); } catch { /* private browsing */ }
			return !on;
		});
	};

	// Pictures go into the message itself; anything else is left for the composer to attach.
	const insertPictures = useCallback(async (files: File[], at?: number) => {
		const editor = editorRef.current;
		if (!editor) return;
		for (const file of files) {
			try {
				const src = await pictureDataUrl(file);
				if (!src) { toastManager.add({ title: `${file.name || "That picture"} is too big to put in the message. Attach it instead.`, variant: "error" }); continue; }
				const chain = editor.chain().focus();
				(at === undefined ? chain : chain.setTextSelection(at)).setImage({ src, alt: file.name || "" }).run();
			} catch {
				toastManager.add({ title: "That picture couldn't be read.", variant: "error" });
			}
		}
	}, [toastManager]);

	const editor = useEditor({
		extensions: [
			StarterKit.configure({ link: false, underline: false }),
			Underline,
			TextAlign.configure({ types: ["heading", "paragraph"] }),
			LinkExtension.configure({ openOnClick: false }),
			TiptapImage.configure({ inline: true, allowBase64: true, HTMLAttributes: { style: "max-width: 100%; height: auto;" } }),
			TextStyle,
			Color,
			FontFamily,
			FontSize,
			Highlight.configure({ multicolor: true }),
			Indent,
			TableKit.configure({
				table: { resizable: false, HTMLAttributes: { style: "border-collapse: collapse; width: 100%;" } },
				tableCell: { HTMLAttributes: { style: CELL_STYLE } },
				tableHeader: { HTMLAttributes: { style: `${CELL_STYLE} background-color: #f3f3f3; font-weight: bold; text-align: left;` } },
			}),
		],
		content: value,
		immediatelyRender: false,
		editorProps: {
			attributes: {
				class:
					"prose prose-sm max-w-none focus:outline-none min-h-[180px] p-3 text-sm [&_blockquote]:border-l-2 [&_blockquote]:border-kumo-line [&_blockquote]:pl-3 [&_blockquote]:text-kumo-subtle [&_blockquote]:bg-kumo-tint [&_blockquote]:py-1 [&_blockquote]:my-2 [&_blockquote]:text-xs [&_blockquote]:rounded-r-sm [&_table]:my-2 [&_td]:min-w-[3em] [&_th]:min-w-[3em] [&_img]:inline-block [&_.selectedCell]:bg-kumo-tint",
			},
			handlePaste: (_view, event) => {
				const files = Array.from(event.clipboardData?.files ?? []);
				if (files.length === 0 || !files.every(isPicture)) return false;
				event.preventDefault();
				void insertPictures(files);
				return true;
			},
			handleDrop: (view, event) => {
				const files = Array.from(event.dataTransfer?.files ?? []);
				if (files.length === 0 || !files.every(isPicture)) return false;
				event.preventDefault();
				const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
				void insertPictures(files, pos);
				return true;
			},
		},
		onUpdate: ({ editor }) => {
			onChange(editor.getHTML());
		},
	});
	editorRef.current = editor;

	// Re-render the toolbar as the cursor moves, so buttons show what's on. Until the first change it's read
	// straight from the editor: an email that starts with text (from an email link) has had no change yet.
	const toolbarState = (e: Editor) => ({
			heading: ([1, 2, 3] as const).find((level) => e.isActive("heading", { level })) ?? 0,
			font: (e.getAttributes("textStyle").fontFamily as string | undefined) ?? "",
			size: (e.getAttributes("textStyle").fontSize as string | undefined) ?? "",
			align: ALIGNS.find((a) => e.isActive({ textAlign: a.value }))?.value ?? "left",
			bold: e.isActive("bold"),
			italic: e.isActive("italic"),
			underline: e.isActive("underline"),
			strike: e.isActive("strike"),
			colour: (e.getAttributes("textStyle").color as string | undefined) ?? "",
			bulletList: e.isActive("bulletList"),
			orderedList: e.isActive("orderedList"),
			blockquote: e.isActive("blockquote"),
			inTable: e.isActive("table"),
			link: e.isActive("link"),
			canUndo: e.can().undo(),
			canRedo: e.can().redo(),
		});
	const watched = useEditorState({
		editor,
		selector: ({ editor: e }) => e ? toolbarState(e) : null,
	});
	const state = watched ?? (editor ? toolbarState(editor) : null);

	useEffect(() => {
		if (editor && !editor.isDestroyed && value !== editor.getHTML()) {
			editor.commands.setContent(value);
			// Place cursor at the start of the document (above quoted text)
			const rafId = requestAnimationFrame(() => {
				if (!editor.isDestroyed) {
					editor.commands.focus('start');
				}
			});
			return () => cancelAnimationFrame(rafId);
		}
	}, [value, editor]);

	const setLink = useCallback(() => {
		if (!editor) return;
		const previousUrl = editor.getAttributes("link").href;
		const url = window.prompt("URL", previousUrl);
		if (url === null) return;
		if (url === "") {
			editor.chain().focus().extendMarkRange("link").unsetLink().run();
			return;
		}
		editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
	}, [editor]);

	if (!editor || !state) return null;
	const run = () => editor.chain().focus();
	const AlignIcon = ALIGNS.find((a) => a.value === state.align)?.icon ?? TextAlignLeftIcon;

	return (
		<div className="rounded-lg border border-kumo-line overflow-hidden flex flex-col h-full">
			{/* Toolbar */}
			<div className="flex flex-wrap items-center gap-0.5 bg-kumo-recessed px-2 py-1.5 border-b border-kumo-line shrink-0">
				{full && <>
				<ToolButton label="Undo" icon={<ArrowCounterClockwiseIcon size={16} />} disabled={!state.canUndo} onClick={() => run().undo().run()} />
				<ToolButton label="Redo" icon={<ArrowClockwiseIcon size={16} />} disabled={!state.canRedo} onClick={() => run().redo().run()} />

				<Divider />

				<ToolMenu label="Paragraph style" wide trigger={<span className="text-xs w-20 text-left truncate">{STYLES.find((s) => s.level === state.heading)?.label}</span>}>
					{STYLES.map((s) => (
						<DropdownMenu.Item key={s.level} selected={state.heading === s.level}
							onClick={() => (s.level ? run().setHeading({ level: s.level }) : run().setParagraph()).run()}>
							{s.label}
						</DropdownMenu.Item>
					))}
				</ToolMenu>
				<ToolMenu label="Font" wide trigger={<span className="text-xs w-16 text-left truncate">{FONTS.find((f) => f.value === state.font)?.label ?? "Font"}</span>}>
					{FONTS.map((f) => (
						<DropdownMenu.Item key={f.label} selected={state.font === f.value}
							onClick={() => (f.value ? run().setFontFamily(f.value) : run().unsetFontFamily()).run()}>
							<span style={{ fontFamily: f.value || undefined }}>{f.label}</span>
						</DropdownMenu.Item>
					))}
				</ToolMenu>
				<ToolMenu label="Text size" trigger={<TextAaIcon size={16} />}>
					{SIZES.map((s) => (
						<DropdownMenu.Item key={s.label} selected={state.size === s.value}
							onClick={() => (s.value ? run().setFontSize(s.value) : run().unsetFontSize()).run()}>
							<span style={{ fontSize: s.value || undefined }}>{s.label}</span>
						</DropdownMenu.Item>
					))}
				</ToolMenu>

				<Divider />
				</>}

				<ToolButton label="Bold" active={state.bold} icon={<TextBIcon size={16} />} onClick={() => run().toggleBold().run()} />
				<ToolButton label="Italic" active={state.italic} icon={<TextItalicIcon size={16} />} onClick={() => run().toggleItalic().run()} />
				<ToolButton label="Underline" active={state.underline} icon={<TextUnderlineIcon size={16} />} onClick={() => run().toggleUnderline().run()} />
				{full && <>
				<ToolButton label="Strikethrough" active={state.strike} icon={<TextStrikethroughIcon size={16} />} onClick={() => run().toggleStrike().run()} />
				</>}
				<ToolMenu label="Text colour" trigger={<span className="font-semibold text-sm leading-none underline decoration-2" style={{ textDecorationColor: state.colour || "currentColor" }}>A</span>}>
					<div className="grid grid-cols-5 gap-1 p-1">
						{COLOURS.map((c) => (
							<DropdownMenu.Item key={c} aria-label={`Colour ${c}`} className="p-1 justify-center" onClick={() => run().setColor(c).run()}>
								<Swatch colour={c} />
							</DropdownMenu.Item>
						))}
					</div>
					<DropdownMenu.Separator />
					<DropdownMenu.Item onClick={() => run().unsetColor().run()}>Default colour</DropdownMenu.Item>
				</ToolMenu>
				{full && <>
				<ToolMenu label="Highlight" trigger={<HighlighterIcon size={16} />}>
					<div className="grid grid-cols-6 gap-1 p-1">
						{HIGHLIGHTS.map((c) => (
							<DropdownMenu.Item key={c} aria-label={`Highlight ${c}`} className="p-1 justify-center" onClick={() => run().setHighlight({ color: c }).run()}>
								<Swatch colour={c} />
							</DropdownMenu.Item>
						))}
					</div>
					<DropdownMenu.Separator />
					<DropdownMenu.Item onClick={() => run().unsetHighlight().run()}>No highlight</DropdownMenu.Item>
				</ToolMenu>

				<Divider />
				</>}

				{full && <>
				<ToolMenu label="Align" trigger={<AlignIcon size={16} />}>
					{ALIGNS.map((a) => (
						<DropdownMenu.Item key={a.value} icon={a.icon} selected={state.align === a.value} onClick={() => run().setTextAlign(a.value).run()}>
							{a.label}
						</DropdownMenu.Item>
					))}
				</ToolMenu>
				</>}
				<ToolButton label="Bullet list" active={state.bulletList} icon={<ListBulletsIcon size={16} />} onClick={() => run().toggleBulletList().run()} />
				<ToolButton label="Numbered list" active={state.orderedList} icon={<ListNumbersIcon size={16} />} onClick={() => run().toggleOrderedList().run()} />
				{full && <>
				<ToolButton label="Indent less" icon={<TextOutdentIcon size={16} />} onClick={() => run().outdent().run()} />
				<ToolButton label="Indent more" icon={<TextIndentIcon size={16} />} onClick={() => run().indent().run()} />
				<ToolButton label="Quote" active={state.blockquote} icon={<QuotesIcon size={16} />} onClick={() => run().toggleBlockquote().run()} />
				</>}

				<Divider />

				<ToolButton label="Link" active={state.link} icon={<LinkSimpleIcon size={16} />} onClick={setLink} />
				{state.link && <ToolButton label="Remove link" icon={<LinkBreakIcon size={16} />} onClick={() => run().unsetLink().run()} />}
				<ToolButton label="Picture in the message" icon={<ImageIcon size={16} />} onClick={() => pictureInput.current?.click()} />
				{full && <>
				<ToolMenu label="Table" trigger={<TableIcon size={16} />}>
					{state.inTable ? (
						<>
							<DropdownMenu.Item onClick={() => run().addRowAfter().run()}>Add row below</DropdownMenu.Item>
							<DropdownMenu.Item onClick={() => run().addColumnAfter().run()}>Add column to the right</DropdownMenu.Item>
							<DropdownMenu.Item onClick={() => run().toggleHeaderRow().run()}>Header row on or off</DropdownMenu.Item>
							<DropdownMenu.Separator />
							<DropdownMenu.Item onClick={() => run().deleteRow().run()}>Delete row</DropdownMenu.Item>
							<DropdownMenu.Item onClick={() => run().deleteColumn().run()}>Delete column</DropdownMenu.Item>
							<DropdownMenu.Item variant="danger" onClick={() => run().deleteTable().run()}>Delete table</DropdownMenu.Item>
						</>
					) : (
						[[2, 2], [3, 3], [4, 3], [5, 4]].map(([cols, rows]) => (
							<DropdownMenu.Item key={`${cols}x${rows}`} onClick={() => run().insertTable({ rows, cols, withHeaderRow: true }).run()}>
								Insert table, {cols} columns × {rows} rows
							</DropdownMenu.Item>
						))
					)}
				</ToolMenu>
				</>}
				<ToolMenu label="Emoji" trigger={<SmileyIcon size={16} />}>
					<div className="grid grid-cols-8 gap-0.5 p-1">
						{EMOJI.map((e) => (
							<DropdownMenu.Item key={e} className="p-1 justify-center text-lg leading-none" onClick={() => run().insertContent(e).run()}>
								{e}
							</DropdownMenu.Item>
						))}
					</div>
				</ToolMenu>
				{full && <>
				<ToolButton label="Horizontal line" icon={<MinusIcon size={16} />} onClick={() => run().setHorizontalRule().run()} />
				<ToolButton label="Clear formatting" icon={<EraserIcon size={16} />} onClick={() => run().unsetAllMarks().clearNodes().run()} />
				</>}
				<div className="ml-auto">
					<Tooltip content={full ? "Fewer formatting options" : "More formatting options"} side="bottom" asChild>
						<Button type="button" variant={full ? "secondary" : "ghost"} size="sm" onClick={toggleFull} aria-pressed={full} aria-label={full ? "Fewer formatting options" : "More formatting options"}>
							<span className="text-xs">{full ? "Less" : "More"}</span>
						</Button>
					</Tooltip>
				</div>
				<input
					ref={pictureInput}
					type="file"
					accept="image/png,image/jpeg,image/gif,image/webp"
					multiple
					hidden
					onChange={(e) => { if (e.target.files) void insertPictures(Array.from(e.target.files)); e.target.value = ""; }}
				/>
			</div>

			{/* Editor content */}
			<div className="flex-1 overflow-y-auto">
				<EditorContent editor={editor} />
			</div>
		</div>
	);
}
