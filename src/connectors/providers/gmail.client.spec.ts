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
