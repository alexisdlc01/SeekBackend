import { OutlookClient } from "./outlook.client";

describe("OutlookClient.listRecent", () => {
	afterEach(() => jest.restoreAllMocks());

	it("skips Junk and Deleted Items messages", async () => {
		const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
		jest.spyOn(global, "fetch").mockImplementation(async input => {
			const url = String(input);
			if (url.includes("/mailFolders/junkemail")) return json({ id: "junk" });
			if (url.includes("/mailFolders/deleteditems")) return json({ id: "bin" });
			if (url.includes("/mailFolders/sentitems")) return json({ id: "sent" });
			return json({
				value: [
					{ id: "spam", conversationId: "c1", parentFolderId: "junk" },
					{ id: "gone", conversationId: "c2", parentFolderId: "bin" },
					{ id: "ok", conversationId: "c3", parentFolderId: "inbox" },
					{ id: "mine", conversationId: "c4", parentFolderId: "sent" }
				]
			});
		});
		const metas = await new OutlookClient().listRecent("token", new Date(0), 50);
		expect(metas.map(m => [m.providerMessageId, m.sent])).toEqual([["ok", false], ["mine", true]]);
	});
});

describe("OutlookClient.getFull senderAuthenticated", () => {
	afterEach(() => jest.restoreAllMocks());
	const meta = { providerMessageId: "m", providerThreadId: "t", from: "james@holloway-lets.co.uk", sent: false } as any;
	const PASS =
		"spf=pass (sender IP is 209.85.128.41) smtp.mailfrom=holloway-lets.co.uk; dkim=pass (signature was verified) header.d=holloway-lets.co.uk;dmarc=pass action=none header.from=holloway-lets.co.uk;compauth=pass reason=100";
	const authenticated = async (internetMessageHeaders: { name: string; value: string }[]) => {
		jest.spyOn(global, "fetch").mockImplementation(async input =>
			new Response(JSON.stringify(String(input).includes("/attachments") ? { value: [] } : { body: { content: "Hi" }, internetMessageHeaders }), { status: 200 })
		);
		return (await new OutlookClient().getFull("token", meta)).senderAuthenticated;
	};

	it("trusts the Authentication-Results Microsoft stamped on external mail it received", async () => {
		expect(
			await authenticated([
				{ name: "Authentication-Results", value: PASS },
				{ name: "Received-SPF", value: "Pass (protection.outlook.com: domain of holloway-lets.co.uk designates 209.85.128.41 as permitted sender)" },
				{ name: "ARC-Authentication-Results", value: "i=1; mx.microsoft.com 1; spf=pass smtp.mailfrom=holloway-lets.co.uk; dmarc=pass action=none header.from=holloway-lets.co.uk; dkim=pass header.d=holloway-lets.co.uk; arc=none" },
				{ name: "X-MS-Exchange-Organization-AuthSource", value: "AM2PEPF0001C70F.eurprd05.prod.outlook.com" },
				{ name: "X-MS-Exchange-Organization-AuthAs", value: "Anonymous" }
			])
		).toBe(true);
	});

	it("refuses a sender-written Authentication-Results when Microsoft did not stamp the message", async () => {
		// Intra-org path: no Microsoft stamp, only the sender's forged header (even with compauth).
		expect(await authenticated([{ name: "Authentication-Results", value: PASS }])).toBe(false);
		expect(
			await authenticated([
				{ name: "Authentication-Results", value: PASS },
				{ name: "X-MS-Exchange-Organization-AuthAs", value: "Internal" }
			])
		).toBe(false);
		// External, but the topmost header is not in Microsoft's format.
		expect(
			await authenticated([
				{ name: "Authentication-Results", value: "dmarc=pass action=none header.from=holloway-lets.co.uk" },
				{ name: "X-MS-Exchange-Organization-AuthAs", value: "Anonymous" }
			])
		).toBe(false);
	});
});
