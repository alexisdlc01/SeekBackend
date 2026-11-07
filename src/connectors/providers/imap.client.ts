import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { connect } from "node:tls";
import { parseAddress, parseAddressList } from "../housing-filter";
import { MailFull, ProviderError } from "./mail-provider";

export interface ImapCredentials {
	host: string;
	port: number;
	username: string;
	password: string;
}

const TIMEOUT_MS = 15_000;
// A hostile server must not trickle forever or fill memory. Headers of SYNC_LIMIT (100) mails fit in well under 1 MB.
const MAX_SESSION_BYTES = 10 * 1024 * 1024;
const SESSION_DEADLINE_MS = 60_000;
// Every non-global-unicast range (RFC 6890): refused in production so the IMAP form cannot probe the server's network.
const PRIVATE_RANGES = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
	["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
] as const) {
	PRIVATE_RANGES.addSubnet(network, prefix, "ipv4");
}
// ::/96 covers ::, ::1 and IPv4-compatible; NAT64, 6to4 and Teredo can embed an IPv4 address.
// No ::ffff:0:0/96 rule: BlockList checks IPv4-mapped addresses against the IPv4 rules, and that rule would match every IPv4.
for (const [network, prefix] of [
	["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16],
	["fc00::", 7], ["fe80::", 10], ["ff00::", 8]
] as const) {
	PRIVATE_RANGES.addSubnet(network, prefix, "ipv6");
}

export function isPrivateAddress(address: string) {
	return PRIVATE_RANGES.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

// Only implicit TLS is implemented (tls.connect, no STARTTLS), so 993 is the only supported port.
export const IMAP_PORTS = [993];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RFC 3501 quoted string. CR and LF are refused by the DTO. */
export function imapQuote(value: string) {
	return `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`;
}

/** Decodes RFC 2047 encoded words (=?utf-8?B?...?=) in a header value. */
export function decodeHeader(value: string) {
	return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, charset: string, encoding: string, text: string) => {
		const bytes =
			encoding.toUpperCase() === "B"
				? Buffer.from(text, "base64")
				: Buffer.from(
						text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
						"latin1"
					);
		return bytes.toString(/utf-?8/i.test(charset) ? "utf8" : "latin1");
	});
}

function parseHeaders(raw: string): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const line of raw.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
		const colon = line.indexOf(":");
		if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = decodeHeader(line.slice(colon + 1).trim());
	}
	return headers;
}

/**
 * Parses `UID FETCH (UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (...)])` output.
 * `text` is the latin1 view of the bytes, so literal lengths match indexes.
 */
export function parseFetchHeaders(text: string): MailFull[] {
	const mails: MailFull[] = [];
	const start = /\* \d+ FETCH \(/g;
	let match: RegExpExecArray | null;
	while ((match = start.exec(text))) {
		const literal = /\{(\d+)\}\r\n/.exec(text.slice(match.index));
		if (!literal) break;
		const bodyStart = match.index + literal.index + literal[0].length;
		const length = Number(literal[1]);
		const raw = Buffer.from(text.slice(bodyStart, bodyStart + length), "latin1").toString("utf8");
		const lineEnd = text.indexOf("\r\n", bodyStart + length);
		const items = text.slice(match.index, lineEnd < 0 ? undefined : lineEnd);
		start.lastIndex = bodyStart + length;
		const uid = /UID (\d+)/.exec(items)?.[1];
		if (!uid) continue;
		const internalDate = /INTERNALDATE "([^"]+)"/.exec(items)?.[1];
		const headers = parseHeaders(raw);
		const from = parseAddress(headers.from);
		const receivedAt = new Date(headers.date ?? internalDate ?? Date.now());
		mails.push({
			providerMessageId: uid,
			providerThreadId: headers["message-id"] ?? `imap-${uid}`,
			internetMessageId: headers["message-id"] ?? null,
			from: from.email,
			fromName: from.name,
			to: parseAddressList(headers.to),
			subject: headers.subject ?? "",
			snippet: "",
			receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
			// shortcut: headers only (no body, no attachments); add a MIME parser when IMAP sync needs them.
			body: "",
			attachments: []
		});
	}
	return mails;
}

/** A minimal IMAP4rev1 session over TLS: tagged commands, buffered replies. */
async function openSession(host: string, port: number, allowPrivate: boolean) {
	if (!allowPrivate && !IMAP_PORTS.includes(port)) throw new ProviderError("The IMAP port must be 993 (IMAP over TLS).");
	const { address } = await lookup(host);
	if (!allowPrivate && isPrivateAddress(address)) throw new ProviderError("The IMAP host must be a public mail server.");
	// Connect to the address we checked (no second DNS answer), verify the certificate against the host name.
	const socket = connect({ host: address, port, servername: isIP(host) ? undefined : host });
	socket.setTimeout(TIMEOUT_MS);
	let buffer = "";
	let failure: Error | null = null;
	let wake: (() => void) | null = null;
	let received = 0;
	const fail = (error: Error) => {
		failure ??= error;
		wake?.();
	};
	socket.on("data", (chunk: Buffer) => {
		received += chunk.length;
		if (received > MAX_SESSION_BYTES) {
			fail(new ProviderError("The mail server sent too much data."));
			socket.destroy();
			return;
		}
		buffer += chunk.toString("latin1");
		wake?.();
	});
	const deadline = setTimeout(() => {
		fail(new ProviderError("IMAP session took too long."));
		socket.destroy();
	}, SESSION_DEADLINE_MS);
	socket.on("error", error => fail(new ProviderError(`IMAP connection failed (${error.name}).`)));
	socket.on("timeout", () => {
		fail(new ProviderError("IMAP server did not answer in time."));
		socket.destroy();
	});
	socket.on("close", () => {
		clearTimeout(deadline);
		fail(new ProviderError("IMAP connection closed."));
	});

	const until = async (end: (text: string) => number) => {
		for (;;) {
			const index = end(buffer);
			if (index >= 0) {
				const out = buffer.slice(0, index);
				buffer = buffer.slice(index);
				return out;
			}
			if (failure) throw failure;
			await new Promise<void>(resolve => (wake = resolve));
			wake = null;
		}
	};

	const greeting = await until(text => (text.includes("\r\n") ? text.indexOf("\r\n") + 2 : -1));
	if (!greeting.startsWith("* OK")) throw new ProviderError("IMAP server refused the connection.");

	let counter = 0;
	return {
		async command(command: string) {
			const tag = `S${++counter}`;
			socket.write(`${tag} ${command}\r\n`);
			const done = new RegExp(`(?:^|\\r\\n)${tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`);
			const reply = await until(text => {
				const found = done.exec(text);
				return found ? found.index + found[0].length : -1;
			});
			if (done.exec(reply)?.[1] !== "OK") throw new ProviderError(`IMAP ${command.split(" ")[0]} was refused.`);
			return reply;
		},
		close() {
			socket.end();
			socket.destroy();
		}
	};
}

function imapDate(date: Date) {
	return `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

/** Signs in and out: proves the host, port, username and app password work. */
export async function verifyImapLogin(credentials: ImapCredentials, allowPrivate = false) {
	const session = await openSession(credentials.host, credentials.port, allowPrivate);
	try {
		await session.command(`LOGIN ${imapQuote(credentials.username)} ${imapQuote(credentials.password)}`);
		await session.command("LOGOUT").catch(() => undefined);
	} finally {
		session.close();
	}
}

/** Headers of the newest INBOX messages received since `since`. */
export async function listRecentImap(
	credentials: ImapCredentials,
	since: Date,
	limit: number,
	allowPrivate = false
): Promise<MailFull[]> {
	const session = await openSession(credentials.host, credentials.port, allowPrivate);
	try {
		await session.command(`LOGIN ${imapQuote(credentials.username)} ${imapQuote(credentials.password)}`);
		await session.command("SELECT INBOX");
		const search = await session.command(`UID SEARCH SINCE ${imapDate(since)}`);
		const uids = (/\* SEARCH([\d ]*)/.exec(search)?.[1] ?? "").trim().split(/\s+/).filter(Boolean).slice(-limit);
		if (!uids.length) return [];
		const fetched = await session.command(
			`UID FETCH ${uids.join(",")} (UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)])`
		);
		await session.command("LOGOUT").catch(() => undefined);
		return parseFetchHeaders(fetched);
	} finally {
		session.close();
	}
}
