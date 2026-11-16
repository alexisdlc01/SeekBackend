import { OutlookClient } from "./outlook.client";

describe("OutlookClient.listRecent", () => {
	afterEach(() => jest.restoreAllMocks());

	it("skips Junk and Deleted Items messages", async () => {
		const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
		jest.spyOn(global, "fetch").mockImplementation(async input => {
			const url = String(input);
			if (url.includes("/mailFolders/junkemail")) return json({ id: "junk" });
			if (url.includes("/mailFolders/deleteditems")) return json({ id: "bin" });
			return json({
				value: [
					{ id: "spam", conversationId: "c1", parentFolderId: "junk" },
					{ id: "gone", conversationId: "c2", parentFolderId: "bin" },
					{ id: "ok", conversationId: "c3", parentFolderId: "inbox" }
				]
			});
		});
		const metas = await new OutlookClient().listRecent("token", new Date(0), 50);
		expect(metas.map(m => m.providerMessageId)).toEqual(["ok"]);
	});
});
