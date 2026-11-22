import { GmailClient } from "./gmail.client";

describe("GmailClient.send", () => {
	afterEach(() => jest.restoreAllMocks());

	it("strips CR/LF copied from the incoming email so no header (Bcc) can be injected", async () => {
		const fetch = jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "m", threadId: "t" }), { status: 200 }));
		await new GmailClient().send("token", {
			from: "maya@gmail.com",
			to: ["james@lets.co.uk\r\nBcc: attacker@evil.example"],
			subject: "Rent",
			text: "Hi",
			providerThreadId: "t",
			replyToProviderMessageId: "p",
			replyToInternetMessageId: "<a1@x>\r\nBcc: attacker@evil.example"
		});
		const raw = Buffer.from(JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string).raw, "base64url").toString("utf8");
		const headers = raw.split("\r\n\r\n")[0].split("\r\n");
		expect(headers.some(line => /^bcc:/i.test(line))).toBe(false);
		expect(headers).toContain("To: james@lets.co.uk Bcc: attacker@evil.example");
	});
});

describe("GmailClient.listRecent", () => {
	afterEach(() => jest.restoreAllMocks());

	it("follows nextPageToken so messages beyond the first page are listed", async () => {
		const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
		const fetch = jest.spyOn(global, "fetch").mockImplementation(async input => {
			const url = String(input);
			if (url.includes("/messages?")) {
				return url.includes("pageToken=p2") ? json({ messages: [{ id: "old" }] }) : json({ messages: [{ id: "new" }], nextPageToken: "p2" });
			}
			const id = url.split("/messages/")[1].split("?")[0];
			return json({ id, threadId: "t", payload: { headers: [{ name: "Subject", value: id }] } });
		});
		const metas = await new GmailClient().listRecent("token", new Date(0), 500);
		expect(metas.map(m => m.providerMessageId)).toEqual(["new", "old"]);
		expect(fetch.mock.calls.filter(([u]) => String(u).includes("/messages?"))).toHaveLength(2);
	});

	it("lists a window larger than one page and fetches headers only for ids not already stored", async () => {
		const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
		const ids = Array.from({ length: 900 }, (_, i) => `m${i}`);
		const fetch = jest.spyOn(global, "fetch").mockImplementation(async input => {
			const url = String(input);
			if (url.includes("/messages?")) {
				return url.includes("pageToken=p2")
					? json({ messages: ids.slice(500).map(id => ({ id })) })
					: json({ messages: ids.slice(0, 500).map(id => ({ id })), nextPageToken: "p2" });
			}
			return json({ id: url.split("/messages/")[1].split("?")[0], threadId: "t" });
		});
		const known = new Set(ids.slice(0, 10));
		const metas = await new GmailClient().listRecent("token", new Date(0), 1000, async id => known.has(id));
		expect(metas).toHaveLength(890);
		expect(metas[0].providerMessageId).toBe("m10");
		expect(fetch.mock.calls.filter(([u]) => String(u).includes("format=metadata"))).toHaveLength(890);
		// limit stops the header fetches, so the caller can tell the window was bigger than one sync.
		expect(await new GmailClient().listRecent("token", new Date(0), 5)).toHaveLength(5);
	});

	it("excludes drafts from the query and skips a message still labelled DRAFT", async () => {
		const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
		const fetch = jest.spyOn(global, "fetch").mockImplementation(async input => {
			const url = String(input);
			if (url.includes("/messages?")) return json({ messages: [{ id: "draft" }, { id: "mail" }] });
			const id = url.split("/messages/")[1].split("?")[0];
			return json({ id, threadId: "t", labelIds: id === "draft" ? ["DRAFT"] : ["INBOX"] });
		});
		const metas = await new GmailClient().listRecent("token", new Date(0), 500);
		expect(metas.map(m => m.providerMessageId)).toEqual(["mail"]);
		expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("q")).toContain("-in:drafts");
	});
});
