import {
	KnownCheck,
	MailFull,
	MailMeta,
	MailProviderClient,
	OutgoingMail,
	TokenSet,
	expiryFrom,
	fetchJson,
	formBody,
	fromAuthenticated
} from "./mail-provider";

const GRAPH = "https://graph.microsoft.com/v1.0/me";
const LOGIN = "https://login.microsoftonline.com/common/oauth2/v2.0";

interface GraphAddress { emailAddress?: { name?: string; address?: string } }
interface GraphMessage {
	id: string;
	conversationId: string;
	internetMessageId?: string;
	subject?: string;
	bodyPreview?: string;
	receivedDateTime?: string;
	from?: GraphAddress;
	toRecipients?: GraphAddress[];
	ccRecipients?: GraphAddress[];
	parentFolderId?: string;
	body?: { contentType?: string; content?: string };
	internetMessageHeaders?: { name?: string; value?: string }[];
}

/** Outlook / Microsoft 365 through Microsoft Graph (Mail.Read + Mail.Send). */
export class OutlookClient implements MailProviderClient {
	readonly scopes = "offline_access User.Read Mail.Read Mail.Send";

	authUrl({ clientId, redirectUri, state }: { clientId: string; redirectUri: string; state: string }) {
		const params = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			response_mode: "query",
			scope: this.scopes,
			state
		});
		return `${LOGIN}/authorize?${params.toString()}`;
	}

	exchangeCode(params: { clientId: string; clientSecret: string; redirectUri: string; code: string }) {
		return this.token({
			client_id: params.clientId,
			client_secret: params.clientSecret,
			redirect_uri: params.redirectUri,
			code: params.code,
			grant_type: "authorization_code",
			scope: this.scopes
		});
	}

	async refresh(params: { clientId: string; clientSecret: string; refreshToken: string }) {
		const tokens = await this.token({
			client_id: params.clientId,
			client_secret: params.clientSecret,
			refresh_token: params.refreshToken,
			grant_type: "refresh_token",
			scope: this.scopes
		});
		return { ...tokens, refreshToken: tokens.refreshToken ?? params.refreshToken };
	}

	async mailboxAddress(accessToken: string) {
		const me = await fetchJson<{ mail?: string; userPrincipalName?: string }>(
			`${GRAPH}?$select=mail,userPrincipalName`,
			{ headers: this.headers(accessToken) }
		);
		return (me.mail || me.userPrincipalName || "").toLowerCase();
	}

	async listRecent(accessToken: string, since: Date, limit: number, isKnown?: KnownCheck, before?: Date): Promise<MailMeta[]> {
		const params = new URLSearchParams({
			$top: String(Math.min(limit, 100)),
			$select: "id,conversationId,internetMessageId,subject,bodyPreview,receivedDateTime,from,toRecipients,ccRecipients,parentFolderId",
			$filter: `receivedDateTime ge ${since.toISOString()}${before ? ` and receivedDateTime le ${before.toISOString()}` : ""} and isDraft eq false`,
			$orderby: "receivedDateTime desc"
		});
		// /me/messages spans every folder; Gmail's query drops spam and trash, so do the same here.
		const [junk, deleted, sentItems] = await Promise.all(["junkemail", "deleteditems", "sentitems"].map(folder => this.folderId(accessToken, folder)));
		const excluded = new Set([junk, deleted]);
		const messages: GraphMessage[] = [];
		let url: string | undefined = `${GRAPH}/messages?${params.toString()}`;
		while (url && messages.length < limit) {
			const page: { value?: GraphMessage[]; "@odata.nextLink"?: string } = await fetchJson(url, {
				headers: this.headers(accessToken)
			});
			for (const message of page.value ?? []) {
				if (message.parentFolderId && excluded.has(message.parentFolderId)) continue;
				if (messages.length < limit && !(await isKnown?.(message.id))) messages.push(message);
			}
			url = page["@odata.nextLink"];
		}
		return messages.map(message => ({ ...this.toMeta(message), sent: message.parentFolderId === sentItems }));
	}

	async getFull(accessToken: string, meta: MailMeta): Promise<MailFull> {
		const id = encodeURIComponent(meta.providerMessageId);
		const message = await fetchJson<GraphMessage>(`${GRAPH}/messages/${id}?$select=body,internetMessageHeaders,parentFolderId`, {
			headers: { ...this.headers(accessToken), Prefer: 'outlook.body-content-type="text", IdType="ImmutableId"' }
		});
		// Sync already knows it from listRecent: look the folder up only for a re-read (fileAttachment).
		const sent = meta.sent ?? message.parentFolderId === (await this.folderId(accessToken, "sentitems"));
		const attachments = await fetchJson<{
			value?: { "@odata.type"?: string; name?: string; contentType?: string; size?: number; contentBytes?: string }[];
		}>(`${GRAPH}/messages/${id}/attachments`, { headers: this.headers(accessToken) });
		// Topmost Authentication-Results: the one Microsoft added on receipt.
		const results = message.internetMessageHeaders?.find(item => item.name?.toLowerCase() === "authentication-results")?.value;
		return {
			...meta,
			senderAuthenticated: fromAuthenticated(results, meta.from),
			sent,
			body: (message.body?.content ?? "").trim(),
			attachments: (attachments.value ?? [])
				.filter(item => item["@odata.type"] === "#microsoft.graph.fileAttachment" && item.name)
				.map(item => ({
					name: item.name as string,
					mimeType: item.contentType ?? "application/octet-stream",
					size: item.size ?? 0,
					load: async () => (item.contentBytes ? Buffer.from(item.contentBytes, "base64") : null)
				}))
		};
	}

	async send(accessToken: string, mail: OutgoingMail) {
		// createReply + send keeps the message in the same conversation, and the
		// immutable id lets the next sync recognise it instead of importing a copy.
		const draft = await fetchJson<GraphMessage>(
			`${GRAPH}/messages/${encodeURIComponent(mail.replyToProviderMessageId)}/createReply`,
			{
				method: "POST",
				headers: { ...this.headers(accessToken), "content-type": "application/json" },
				body: JSON.stringify({ comment: mail.text })
			}
		);
		await fetchJson(`${GRAPH}/messages/${encodeURIComponent(draft.id)}/send`, {
			method: "POST",
			headers: this.headers(accessToken)
		});
		return { providerMessageId: draft.id, providerThreadId: draft.conversationId ?? mail.providerThreadId };
	}

	async revoke() {
		// Microsoft has no per-token revoke endpoint for this flow; deleting the
		// stored tokens is what disconnects the mailbox.
	}

	private async folderId(accessToken: string, wellKnownName: string) {
		return (await fetchJson<{ id: string }>(`${GRAPH}/mailFolders/${wellKnownName}?$select=id`, { headers: this.headers(accessToken) })).id;
	}

	private headers(accessToken: string) {
		return { authorization: `Bearer ${accessToken}`, Prefer: 'IdType="ImmutableId"' };
	}

	private async token(values: Record<string, string>): Promise<TokenSet> {
		const data = await fetchJson<{ access_token: string; refresh_token?: string; expires_in?: number }>(`${LOGIN}/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: formBody(values)
		});
		return {
			accessToken: data.access_token,
			refreshToken: data.refresh_token ?? null,
			expiresAt: expiryFrom(data.expires_in)
		};
	}

	private toMeta(message: GraphMessage): MailMeta {
		const address = (item?: GraphAddress) => (item?.emailAddress?.address ?? "").toLowerCase();
		return {
			providerMessageId: message.id,
			providerThreadId: message.conversationId,
			internetMessageId: message.internetMessageId ?? null,
			from: address(message.from),
			fromName: message.from?.emailAddress?.name ?? "",
			to: [...(message.toRecipients ?? []), ...(message.ccRecipients ?? [])].map(address).filter(Boolean),
			subject: message.subject ?? "",
			snippet: message.bodyPreview ?? "",
			receivedAt: message.receivedDateTime ? new Date(message.receivedDateTime) : new Date()
		};
	}
}
