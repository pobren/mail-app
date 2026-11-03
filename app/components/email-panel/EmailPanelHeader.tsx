// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: label chips under the subject.

interface EmailPanelHeaderProps {
	subject: string;
	messageCount: number;
	showThreadCount: boolean;
	/** Mail App: the conversation's label chips. */
	labels?: React.ReactNode;
}

export default function EmailPanelHeader({
	subject,
	messageCount,
	showThreadCount,
	labels,
}: EmailPanelHeaderProps) {
	return (
		<div className="px-4 py-3 border-b border-kumo-line shrink-0 md:px-6">
			<h2 className="text-base font-semibold text-kumo-default">{subject}</h2>
			{labels && <div className="flex flex-wrap items-center gap-1.5 mt-1.5">{labels}</div>}
			{showThreadCount && (
				<span className="text-xs text-kumo-subtle mt-0.5 block">
					{messageCount} messages in this thread
				</span>
			)}
		</div>
	);
}
