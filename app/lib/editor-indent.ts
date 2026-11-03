// Mail App addition (not part of upstream Agentic Inbox).
// Indent and outdent for paragraphs and headings in the composer. TipTap has no free indent
// extension, so this stores the level as an inline margin-left, which every mail app keeps.
// In a list the buttons nest and un-nest the item instead. Ctrl+] and Ctrl+[ as in Gmail; Tab is
// left alone so it still moves to the next box.
import { Extension } from "@tiptap/core";

const STEP_PX = 40;
const MAX_LEVEL = 8;
const TYPES = ["paragraph", "heading"];

declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		indent: {
			indent: () => ReturnType;
			outdent: () => ReturnType;
		};
	}
}

export const Indent = Extension.create({
	name: "indent",

	addGlobalAttributes() {
		return [{
			types: TYPES,
			attributes: {
				indent: {
					default: 0,
					parseHTML: (el) => Math.min(MAX_LEVEL, Math.round((parseInt(el.style.marginLeft, 10) || 0) / STEP_PX)),
					renderHTML: (attrs) => (attrs.indent ? { style: `margin-left: ${attrs.indent * STEP_PX}px` } : {}),
				},
			},
		}];
	},

	addCommands() {
		const change = (by: number) => () => ({ editor, chain, tr, state, dispatch }: any) => {
			if (editor.isActive("listItem")) {
				return by > 0 ? chain().sinkListItem("listItem").run() : chain().liftListItem("listItem").run();
			}
			let changed = false;
			state.doc.nodesBetween(state.selection.from, state.selection.to, (node: any, pos: number) => {
				if (!TYPES.includes(node.type.name)) return;
				const level = Math.max(0, Math.min(MAX_LEVEL, (node.attrs.indent || 0) + by));
				if (level === node.attrs.indent) return false;
				tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: level });
				changed = true;
				return false;
			});
			if (changed && dispatch) dispatch(tr);
			return changed;
		};
		return { indent: change(1), outdent: change(-1) };
	},

	addKeyboardShortcuts() {
		return {
			"Mod-]": () => this.editor.commands.indent(),
			"Mod-[": () => this.editor.commands.outdent(),
		};
	},
});
