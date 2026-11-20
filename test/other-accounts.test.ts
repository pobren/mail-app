import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { Duplex } from "node:stream";
import {
	cleanFile, nextCheckAt, notPossible, presetFor, privateHost, readNewAccount, searchDate, sendAsAddresses,
	CHECK_EVERY_MS, SLOW_CHECK_MS,
} from "../shared/other-accounts.ts";
import { Imap } from "../workers/lib/mail-protocols/imap.ts";
import { Pop3 } from "../workers/lib/mail-protocols/pop3.ts";
import { Smtp, dotStuff } from "../workers/lib/mail-protocols/smtp.ts";

describe("other accounts: adding one", () => {
	it("fills in a provider's servers", () => {
		const r = readNewAccount({ address: " Me@Gmail.com ", password: "abcd efgh", provider: "gmail", protocol: "imap" });
		assert.ok("account" in r);
		assert.equal(r.account.address, "me@gmail.com");
		assert.equal(r.account.incoming.host, "imap.gmail.com");
		assert.equal(r.account.outgoing?.host, "smtp.gmail.com");
		assert.equal(r.account.username, "me@gmail.com");
		assert.equal(r.account.label, "Gmail");
	});
	it("brings mail in only when there's no outgoing server", () => {
		const r = readNewAccount({ address: "me@gmail.com", password: "x", provider: "gmail", protocol: "pop3", outgoing: null });
		assert.ok("account" in r);
		assert.equal(r.account.incoming.host, "pop.gmail.com");
		assert.equal(r.account.outgoing, undefined);
	});
	it("refuses iCloud over POP3, port 25, local networks and Outlook.com", () => {
		assert.ok("error" in readNewAccount({ address: "me@icloud.com", password: "x", provider: "icloud", protocol: "pop3" }));
		const base = { address: "me@isp.net", password: "x", provider: "other", protocol: "imap" as const, incoming: { host: "mail.isp.net", port: 993, security: "tls" as const } };
		assert.match((readNewAccount({ ...base, outgoing: { host: "mail.isp.net", port: 25, security: "starttls" } }) as { error: string }).error, /Port 25/);
		assert.match((readNewAccount({ ...base, incoming: { host: "192.168.1.10", port: 993, security: "tls" }, outgoing: null }) as { error: string }).error, /local network/);
		assert.match((readNewAccount({ ...base, address: "me@hotmail.com" }) as { error: string }).error, /Microsoft/);
		assert.ok("error" in readNewAccount({ ...base, password: "" }));
		assert.ok("error" in readNewAccount({ ...base, address: "not an address" }));
	});
	it("knows providers and private hosts", () => {
		assert.equal(presetFor("a@yahoo.co.uk")?.id, "yahoo");
		assert.equal(presetFor("a@example.com"), undefined);
		assert.match(notPossible("a@proton.me") ?? "", /Proton/);
		for (const h of ["localhost", "10.1.2.3", "127.0.0.1", "172.20.0.1", "169.254.1.1", "printer.local"]) assert.ok(privateHost(h), h);
		for (const h of ["imap.gmail.com", "8.8.8.8", "172.32.0.1"]) assert.ok(!privateHost(h), h);
	});
});

describe("other accounts: the stored list", () => {
	it("drops anything malformed and lists send-as addresses", () => {
		const file = cleanFile({ accounts: [
			{ id: "1", mailbox: "a@x.com", address: "a@gmail.com", secret: "v1r:x", incoming: { host: "imap.gmail.com", port: 993, security: "tls" }, outgoing: { host: "smtp.gmail.com", port: 465, security: "tls" } },
			{ id: "2", mailbox: "a@x.com", address: "b@isp.net", secret: "v1r:y", incoming: { host: "pop.isp.net", port: 995, security: "tls" } },
			{ id: "3", mailbox: "a@x.com", address: "broken" },
			"nonsense",
		] });
		assert.equal(file.accounts.length, 2);
		assert.deepEqual(sendAsAddresses(file, "A@x.com"), ["a@gmail.com"]);
		assert.deepEqual(sendAsAddresses({ ...file, off: true }, "a@x.com"), []);
	});
	it("slows down after repeated failures", () => {
		assert.equal(nextCheckAt(1000, 0), 1000 + CHECK_EVERY_MS);
		assert.equal(nextCheckAt(1000, 3), 1000 + SLOW_CHECK_MS);
		assert.equal(searchDate(new Date(Date.UTC(2026, 9, 21))), "21-Oct-2026");
	});
});

describe("SMTP dot-stuffing", () => {
	it("doubles leading dots and ends with CRLF.CRLF", () => {
		const out = new TextDecoder().decode(dotStuff(new TextEncoder().encode(".a\r\nb\r\n.\r\nc")));
		assert.equal(out, "..a\r\nb\r\n..\r\nc\r\n.\r\n");
	});
});

// A pretend server: answers each line the client sends from a script, in order.
async function talk(greeting: string, answer: (line: string) => string | null): Promise<{ conn: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; close(): void }; lines: string[]; done: () => void }> {
	const lines: string[] = [];
	const server = net.createServer((sock) => {
		sock.write(greeting);
		let buf = "";
		let data = false;
		sock.on("data", (d) => {
			buf += d.toString("latin1");
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).replace(/\r$/, "");
				buf = buf.slice(nl + 1);
				lines.push(line);
				if (data) { if (line === ".") { data = false; sock.write("250 2.0.0 queued\r\n"); } continue; }
				if (line === "DATA") data = true;
				const reply = answer(line);
				if (reply !== null) sock.write(reply);
			}
		});
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	const port = (server.address() as net.AddressInfo).port;
	const sock = await new Promise<net.Socket>((ok) => { const s = net.connect(port, "127.0.0.1", () => ok(s)); });
	const web = Duplex.toWeb(sock) as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
	return { conn: { ...web, close: () => sock.destroy() }, lines, done: () => { sock.destroy(); server.close(); } };
}

describe("protocol clients against a pretend server", () => {
	it("IMAP: finds new UIDs and fetches a whole message read-only", async () => {
		const msg = "Subject: Hi\r\n\r\nHello\r\n";
		const t = await talk("* OK ready\r\n", (l) => {
			const [tag, ...rest] = l.split(" ");
			const cmd = rest.join(" ");
			if (cmd.startsWith("LOGIN")) return `${tag} OK [CAPABILITY IMAP4rev1] Logged in\r\n`;
			if (cmd.startsWith("EXAMINE")) return `* 2 EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT 12] ok\r\n${tag} OK [READ-ONLY] done\r\n`;
			if (cmd.startsWith("UID SEARCH UID 10:")) return `* SEARCH 9 10 11\r\n${tag} OK done\r\n`;
			if (cmd.startsWith("UID FETCH 11 (UID FLAGS BODY.PEEK[])")) return `* 2 FETCH (UID 11 FLAGS () BODY[] {${msg.length}}\r\n${msg})\r\n${tag} OK done\r\n`;
			if (cmd.startsWith("LOGOUT")) return `* BYE\r\n${tag} OK bye\r\n`;
			return `${tag} BAD what\r\n`;
		});
		const imap = new Imap(t.conn);
		await imap.hello();
		await imap.login("me@isp.net", "pa\"ss");
		assert.deepEqual(await imap.examine("INBOX"), { exists: 2, uidValidity: 7, uidNext: 12 });
		assert.deepEqual(await imap.uids(10, 4294967295), [10, 11]);
		const [m] = await imap.fetch("11", "(UID FLAGS BODY.PEEK[])");
		assert.equal(new TextDecoder().decode(m.body), msg);
		assert.ok(t.lines.some((l) => l.includes('LOGIN "me@isp.net" "pa\\"ss"')));
		await imap.logout();
		t.done();
	});

	it("POP3: lists with UIDL and takes the dots off", async () => {
		const t = await talk("+OK POP3 ready\r\n", (l) => {
			if (l.startsWith("USER") || l.startsWith("PASS")) return "+OK\r\n";
			if (l === "LIST") return "+OK 2 messages\r\n1 120\r\n2 300\r\n.\r\n";
			if (l === "UIDL") return "+OK\r\n1 aaa\r\n2 bbb\r\n.\r\n";
			if (l === "RETR 2") return "+OK\r\nSubject: x\r\n\r\n..dotted\r\nend\r\n.\r\n";
			if (l === "QUIT") return "+OK bye\r\n";
			return "-ERR what\r\n";
		});
		const pop = new Pop3(t.conn);
		await pop.hello();
		await pop.login("me", "pw");
		assert.deepEqual(await pop.list(), [{ n: 1, uidl: "aaa", size: 120 }, { n: 2, uidl: "bbb", size: 300 }]);
		assert.equal(new TextDecoder().decode(await pop.retr(2, 10_000)), "Subject: x\r\n\r\n.dotted\r\nend\r\n");
		assert.ok(!t.lines.some((l) => l.startsWith("DELE")), "never deletes");
		await pop.quit();
		t.done();
	});

	it("POP3: a refused password reads plainly", async () => {
		const t = await talk("+OK\r\n", (l) => (l.startsWith("USER") ? "+OK\r\n" : "-ERR [AUTH] Application-specific password required\r\n"));
		const pop = new Pop3(t.conn);
		await pop.hello();
		await assert.rejects(pop.login("me", "pw"), /app password/);
		t.done();
	});

	it("SMTP: signs in with AUTH PLAIN and sends to every recipient", async () => {
		const t = await talk("220 mx ready\r\n", (l) => {
			if (l.startsWith("EHLO")) return "250-mx\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n";
			if (l.startsWith("AUTH PLAIN")) return "235 ok\r\n";
			if (l.startsWith("MAIL FROM") || l.startsWith("RCPT TO")) return l.includes("bad@") ? "550 5.1.1 no such user\r\n" : "250 ok\r\n";
			if (l === "DATA") return "354 go\r\n";
			if (l === "QUIT") return "221 bye\r\n";
			return null;
		});
		const smtp = new Smtp(t.conn);
		await smtp.hello("example.com");
		await smtp.login("me@isp.net", "pw");
		const plain = Buffer.from(t.lines.find((l) => l.startsWith("AUTH PLAIN"))!.slice(11), "base64").toString();
		assert.equal(plain, "\0me@isp.net\0pw");
		await smtp.sendMail("me@isp.net", ["a@x.com", "b@x.com"], new TextEncoder().encode("Subject: s\r\n\r\n.hi\r\n"));
		assert.ok(t.lines.includes("RCPT TO:<b@x.com>"));
		assert.ok(t.lines.includes("..hi"));
		await assert.rejects(smtp.sendMail("me@isp.net", ["bad@x.com"], new TextEncoder().encode("x\r\n")), /bad@x.com was refused/);
		await smtp.quit();
		t.done();
	});
});
