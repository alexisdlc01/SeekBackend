import { EventEmitter } from "node:events";
import { connect } from "node:tls";
import { isPrivateAddress, verifyImapLogin } from "./imap.client";
import { ProviderError } from "./mail-provider";

jest.mock("node:tls", () => ({ connect: jest.fn() }));

/** A socket that never answers unless the test pushes data. */
class FakeSocket extends EventEmitter {
	setTimeout() {}
	write() {
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
