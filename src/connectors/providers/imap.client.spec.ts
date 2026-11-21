import { EventEmitter } from "node:events";
import { connect } from "node:tls";
import { isPrivateAddress, listRecentImap, parseFetchHeaders, verifyImapLogin } from "./imap.client";
import { ProviderError } from "./mail-provider";

jest.mock("node:tls", () => ({ connect: jest.fn() }));

/** A socket that never answers unless the test pushes data. */
class FakeSocket extends EventEmitter {
	setTimeout() {}
	write(_line?: string) {
		return true;
	}
	end() {}
	destroy() {
		this.emit("close");
	}
}

const local = { host: "127.0.0.1", port: 993, username: "u", password: "p" };

describe("imap.client SSRF guards", () => {
	it.each(["198.18.0.1", "100.64.0.1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "ff02::1", "224.0.0.1"])("blocks %s", address => {
		expect(isPrivateAddress(address)).toBe(true);
	});

	it.each(["8.8.8.8", "2606:4700::1111"])("allows %s", address => {
		expect(isPrivateAddress(address)).toBe(false);
	});

	it("rejects a non-IMAPS port before any DNS lookup", async () => {
		const credentials = { host: "imap.example.com", port: 22, username: "u", password: "p" };
		await expect(verifyImapLogin(credentials)).rejects.toThrow(ProviderError);
		await expect(verifyImapLogin(credentials)).rejects.toThrow("The IMAP port must be 993 (IMAP over TLS).");
	});
});

describe("imap.client resource limits", () => {
	afterEach(() => jest.useRealTimers());

	it("drops a server that sends more than 10 MB", async () => {
		const socket = new FakeSocket();
		jest.mocked(connect).mockImplementation(() => {
			setImmediate(() => socket.emit("data", Buffer.alloc(10 * 1024 * 1024 + 1)));
			return socket as never;
		});
		await expect(verifyImapLogin(local, true)).rejects.toThrow("The mail server sent too much data.");
	});

	it("drops a session that lasts more than 60 s, even while data keeps trickling", async () => {
		jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
		const socket = new FakeSocket();
		jest.mocked(connect).mockReset().mockReturnValue(socket as never);
		const login = verifyImapLogin(local, true);
		const settled = expect(login).rejects.toThrow("IMAP session took too long.");
		while (!jest.mocked(connect).mock.calls.length) await new Promise(setImmediate);
		socket.emit("data", Buffer.from("* "));
		jest.advanceTimersByTime(59_999);
		socket.emit("data", Buffer.from("x"));
		jest.advanceTimersByTime(1);
		await settled;
	});
});

describe("listRecentImap", () => {
	it("reads every UID in the window in batches, skipping stored ones, newest first up to the limit", async () => {
		const uids = Array.from({ length: 250 }, (_, i) => i + 1);
		const fetches: string[] = [];
		class ServerSocket extends FakeSocket {
			constructor() {
				super();
				setImmediate(() => this.emit("data", Buffer.from("* OK ready\r\n")));
			}
			write(line: string) {
				const [tag, ...rest] = line.trim().split(" ");
				const command = rest.join(" ");
				let body = "";
				if (command.startsWith("UID SEARCH")) body = `* SEARCH ${uids.join(" ")}\r\n`;
				if (command.startsWith("UID FETCH")) {
					fetches.push(command);
					for (const uid of command.split(" ")[2].split(",")) {
						const raw = `Subject: s${uid}\r\n\r\n`;
						body += `* ${uid} FETCH (UID ${uid} INTERNALDATE "01-Nov-2026 10:00:00 +0000" BODY[HEADER.FIELDS (FROM)] {${raw.length}}\r\n${raw})\r\n`;
					}
				}
				setImmediate(() => this.emit("data", Buffer.from(`${body}${tag} OK done\r\n`)));
				return true;
			}
		}
		jest.mocked(connect).mockReset().mockImplementation(() => new ServerSocket() as never);
		const mails = await listRecentImap(local, new Date(0), 200, true, async uid => uid === "250");
		expect(mails).toHaveLength(200);
		expect(mails[0].providerMessageId).toBe("249");
		expect(fetches).toHaveLength(2); // 100 UIDs per FETCH, not slice(-100)
	});
});

describe("imap.client threading", () => {
	const fetched = (headers: string) => `* 1 FETCH (UID 7 INTERNALDATE "01-Nov-2026 10:00:00 +0000" BODY[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)] {${headers.length}}\r\n${headers})\r\n`;

	it("threads a reply on the first References id, else In-Reply-To, else its own Message-ID", () => {
		const own = "Message-ID: <c@x>\r\nSubject: Re: rent\r\n";
		expect(parseFetchHeaders(fetched(`${own}In-Reply-To: <b@x>\r\nReferences: <a@x>\r\n <b@x>\r\n\r\n`))[0].providerThreadId).toBe("<a@x>");
		expect(parseFetchHeaders(fetched(`${own}In-Reply-To: <b@x>\r\n\r\n`))[0].providerThreadId).toBe("<b@x>");
		expect(parseFetchHeaders(fetched(`${own}\r\n`))[0]).toMatchObject({ providerThreadId: "<c@x>", internetMessageId: "<c@x>" });
	});
});
