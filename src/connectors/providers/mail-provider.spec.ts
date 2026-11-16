import { GmailClient } from "./gmail.client";
import { fromAuthenticated } from "./mail-provider";
import { OutlookClient } from "./outlook.client";

const GMAIL_PASS =
	"mx.google.com; dkim=pass header.i=@holloway-lets.co.uk header.s=s1 header.b=AbC; spf=pass (google.com: domain of x@holloway-lets.co.uk designates 1.2.3.4 as permitted sender) smtp.mailfrom=x@holloway-lets.co.uk; dmarc=pass (p=QUARANTINE sp=NONE dis=NONE) header.from=holloway-lets.co.uk";
const MICROSOFT_PASS =
	"spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=holloway-lets.co.uk; dkim=pass (signature was verified) header.d=holloway-lets.co.uk;dmarc=pass action=none header.from=holloway-lets.co.uk;compauth=pass reason=100";
const SPOOFED =
	"mx.google.com; spf=pass (google.com: domain of tenant@evil.example designates 5.6.7.8 as permitted sender) smtp.mailfrom=tenant@evil.example; dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=holloway-lets.co.uk";

describe("fromAuthenticated", () => {
	const from = "james@holloway-lets.co.uk";

	it("passes on the provider's dmarc=pass for the From domain (Gmail and Microsoft formats)", () => {
		expect(fromAuthenticated(GMAIL_PASS, from)).toBe(true);
		expect(fromAuthenticated(MICROSOFT_PASS, "James@Holloway-Lets.co.uk")).toBe(true);
	});

	it("passes on a DKIM signature of the From domain when the domain has no DMARC record", () => {
		expect(fromAuthenticated("mx.google.com; dkim=pass header.i=@holloway-lets.co.uk header.s=s1; dmarc=none header.from=holloway-lets.co.uk", from)).toBe(true);
	});

	it("fails on dmarc=fail, a pass for another domain, a missing or an unparseable header", () => {
		expect(fromAuthenticated(SPOOFED, from)).toBe(false);
		expect(fromAuthenticated("mx.google.com; dkim=pass header.i=@evil.example; dmarc=pass header.from=evil.example", from)).toBe(false);
		expect(fromAuthenticated("mx.google.com; dmarc=pass (header.from=holloway-lets.co.uk)", from)).toBe(false);
		expect(fromAuthenticated(undefined, from)).toBe(false);
		expect(fromAuthenticated("", from)).toBe(false);
		expect(fromAuthenticated("garbage", from)).toBe(false);
		expect(fromAuthenticated(GMAIL_PASS, "not-an-address")).toBe(false);
	});

	it("never trusts SPF alone, even aligned (shared sending infrastructure)", () => {
		expect(fromAuthenticated("mx.google.com; spf=pass smtp.mailfrom=agent@holloway-lets.co.uk; dmarc=none header.from=holloway-lets.co.uk", from)).toBe(false);
		expect(fromAuthenticated("mx.google.com; spf=pass smtp.mailfrom=bounce@mailer.example; dmarc=none header.from=holloway-lets.co.uk", from)).toBe(false);
	});

	it("ignores results smuggled inside a quoted local-part, with ';' or ')'", () => {
		expect(fromAuthenticated('mx.google.com; spf=fail smtp.mailfrom="a;dmarc=pass header.from=holloway-lets.co.uk"@evil.com; dmarc=fail header.from=holloway-lets.co.uk', from)).toBe(false);
		expect(
			fromAuthenticated(
				'mx.google.com; spf=softfail (domain of "x)y;dmarc=pass header.from=holloway-lets.co.uk"@evil.com is not designated) smtp.mailfrom="x)y;dmarc=pass header.from=holloway-lets.co.uk"@evil.com; dmarc=fail header.from=holloway-lets.co.uk',
				from
			)
		).toBe(false);
	});

	it("refuses a DKIM pass for a subdomain only", () => {
		expect(fromAuthenticated("mx.google.com; dkim=pass header.i=@mail.holloway-lets.co.uk header.s=s1; dmarc=none header.from=holloway-lets.co.uk", from)).toBe(false);
	});

	it("reads a header folded over CRLF lines", () => {
		const folded = "mx.google.com;\r\n       dkim=pass header.i=@holloway-lets.co.uk header.s=s1 header.b=AbC;\r\n       dmarc=pass (p=NONE sp=NONE\r\n dis=NONE) header.from=holloway-lets.co.uk";
		expect(fromAuthenticated(folded, from)).toBe(true);
	});
});

describe("getFull senderAuthenticated", () => {
	afterEach(() => jest.restoreAllMocks());
	const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
	const meta = { providerMessageId: "m", providerThreadId: "t", from: "james@holloway-lets.co.uk" } as any;

	it("Gmail: trusts only the topmost Authentication-Results, not a 'pass' the sender wrote below it", async () => {
		const headers = [
			{ name: "Authentication-Results", value: SPOOFED },
			{ name: "Authentication-Results", value: GMAIL_PASS }
		];
		jest.spyOn(global, "fetch").mockResolvedValue(json({ id: "m", threadId: "t", payload: { headers } }));
		expect((await new GmailClient().getFull("token", meta)).senderAuthenticated).toBe(false);
		jest.spyOn(global, "fetch").mockResolvedValue(json({ id: "m", threadId: "t", payload: { headers: headers.reverse() } }));
		expect((await new GmailClient().getFull("token", meta)).senderAuthenticated).toBe(true);
	});

	it("Gmail: refuses a topmost header Gmail did not write, and reads the SENT label", async () => {
		const headers = [{ name: "Authentication-Results", value: "relay.example; dmarc=pass header.from=holloway-lets.co.uk" }];
		jest.spyOn(global, "fetch").mockResolvedValue(json({ id: "m", threadId: "t", labelIds: ["SENT"], payload: { headers } }));
		const full = await new GmailClient().getFull("token", meta);
		expect(full.senderAuthenticated).toBe(false);
		expect(full.sent).toBe(true);
		jest.spyOn(global, "fetch").mockImplementation(async input =>
			String(input).includes("/messages?") ? json({ messages: [{ id: "m" }] }) : json({ id: "m", threadId: "t", labelIds: ["INBOX"] })
		);
		expect((await new GmailClient().listRecent("token", new Date(0), 5))[0].sent).toBe(false);
	});

	it("Outlook: asks Graph for the headers and reads the topmost Authentication-Results", async () => {
		const fetch = jest.spyOn(global, "fetch").mockImplementation(async input =>
			String(input).includes("/attachments")
				? json({ value: [] })
				: json({
						body: { content: "Hi" },
						internetMessageHeaders: [
							{ name: "Authentication-Results", value: MICROSOFT_PASS },
							{ name: "X-MS-Exchange-Organization-AuthAs", value: "Anonymous" }
						]
					})
		);
		expect((await new OutlookClient().getFull("token", meta)).senderAuthenticated).toBe(true);
		expect(String(fetch.mock.calls[0][0])).toContain("internetMessageHeaders");
		jest.spyOn(global, "fetch").mockImplementation(async input => {
			const url = String(input);
			if (url.includes("/mailFolders/sentitems")) return json({ id: "sent-folder" });
			return json(url.includes("/attachments") ? { value: [] } : { body: { content: "Hi" }, parentFolderId: "sent-folder" });
		});
		expect((await new OutlookClient().getFull("token", meta)).sent).toBe(true);
		jest.spyOn(global, "fetch").mockImplementation(async input => json(String(input).includes("/attachments") ? { value: [] } : { body: { content: "Hi" } }));
		expect((await new OutlookClient().getFull("token", meta)).senderAuthenticated).toBe(false);
	});
});
