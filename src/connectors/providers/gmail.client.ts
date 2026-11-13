import { parseAddress, parseAddressList } from "../housing-filter";
import {
	MailFull,
	MailMeta,
	MailProviderClient,
	OutgoingMail,
	TokenSet,
	expiryFrom,
	fetchJson,
	formBody,
	replySubject
} from "./mail-provider";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GmailHeader { name: string; value: string }
interface GmailPart {
	mimeType?: string;
	filename?: string;
	headers?: GmailHeader[];
	body?: { data?: string; size?: number; attachmentId?: string };
	parts?: GmailPart[];
}
interface GmailMessage {
	id: string;
	threadId: string;
	snippet?: string;
	internalDate?: string;
	payload?: GmailPart;
}

function decode(data: string | undefined) {
	return data ? Buffer.from(data, "base64url") : Buffer.alloc(0);
}

function header(message: GmailMessage, name: string) {
	return message.payload?.headers?.find(item => item.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function walk(part: GmailPart | undefined, visit: (part: GmailPart) => void) {
	if (!part) return;
	visit(part);
	part.parts?.forEach(child => walk(child, visit));
}

function stripHtml(html: string) {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.trim();
}

function encodeHeader(value: string) {
	return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Gmail through the REST API (scopes gmail.readonly + gmail.send). */
export class GmailClient implements MailProviderClient {
	readonly scopes = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

	authUrl({ clientId, redirectUri, state }: { clientId: string; redirectUri: string; state: string }) {
		const params = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: this.scopes,
			access_type: "offline",
			prompt: "consent",
			include_granted_scopes: "true",
			state
		});
		return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
	}

	async exchangeCode(params: { clientId: string; clientSecret: string; redirectUri: string; code: string }): Promise<TokenSet> {
		return this.token({
			code: params.code,
			client_id: params.clientId,
			client_secret: params.clientSecret,
			redirect_uri: params.redirectUri,
			grant_type: "authorization_code"
		});
	}

	async refresh(params: { clientId: string; clientSecret: string; refreshToken: string }): Promise<TokenSet> {
		const tokens = await this.token({
			client_id: params.clientId,
			client_secret: params.clientSecret,
			refresh_token: params.refreshToken,
			grant_type: "refresh_token"
		});
		return { ...tokens, refreshToken: tokens.refreshToken ?? params.refreshToken };
	}

	async mailboxAddress(accessToken: string) {
		const profile = await fetchJson<{ emailAddress?: string }>(`${API}/profile`, { headers: this.auth(accessToken) });
		return (profile.emailAddress ?? "").toLowerCase();
	}

	async listRecent(accessToken: string, since: Date, limit: number): Promise<MailMeta[]> {
		const params = new URLSearchParams({
			maxResults: String(Math.min(limit, 500)),
			q: `after:${Math.floor(since.getTime() / 1000)} -in:chats -in:spam -in:trash`
		});
		const list = await fetchJson<{ messages?: { id: string }[] }>(`${API}/messages?${params.toString()}`, {
			headers: this.auth(accessToken)
		});
		const metas: MailMeta[] = [];
		for (const { id } of list.messages ?? []) {
			// Headers only: bodies are fetched later, and only for housing mail.
			const query = ["From", "To", "Cc", "Subject", "Message-ID"].map(name => `metadataHeaders=${name}`).join("&");
			const message = await fetchJson<GmailMessage>(`${API}/messages/${id}?format=metadata&${query}`, {
				headers: this.auth(accessToken)
			});
			metas.push(this.toMeta(message));
		}
		return metas;
	}

	async getFull(accessToken: string, meta: MailMeta): Promise<MailFull> {
		const message = await fetchJson<GmailMessage>(`${API}/messages/${meta.providerMessageId}?format=full`, {
			headers: this.auth(accessToken)
		});
		let plain = "";
		let html = "";
		const attachments: MailFull["attachments"] = [];
		walk(message.payload, part => {
			if (part.filename && part.body?.attachmentId) {
				const attachmentId = part.body.attachmentId;
				attachments.push({
					name: part.filename,
					mimeType: part.mimeType ?? "application/octet-stream",
					size: part.body.size ?? 0,
					load: async () => {
						const data = await fetchJson<{ data?: string }>(
							`${API}/messages/${meta.providerMessageId}/attachments/${attachmentId}`,
							{ headers: this.auth(accessToken) }
						);
						return data.data ? decode(data.data) : null;
					}
				});
			} else if (part.mimeType === "text/plain" && !plain) {
				plain = decode(part.body?.data).toString("utf8");
			} else if (part.mimeType === "text/html" && !html) {
				html = decode(part.body?.data).toString("utf8");
			}
		});
		return { ...meta, body: (plain || stripHtml(html)).trim(), attachments };
	}

	async send(accessToken: string, mail: OutgoingMail) {
		// To and In-Reply-To come from the incoming email: a CR/LF there would inject headers (e.g. Bcc).
		const clean = (value: string) => value.replace(/[\r\n]+/g, " ");
		const lines = [
			`From: ${clean(mail.from)}`,
			`To: ${mail.to.map(clean).join(", ")}`,
			`Subject: ${encodeHeader(replySubject(mail.subject))}`,
			...(mail.replyToInternetMessageId
				? [`In-Reply-To: ${clean(mail.replyToInternetMessageId)}`, `References: ${clean(mail.replyToInternetMessageId)}`]
				: []),
			"MIME-Version: 1.0",
			'Content-Type: text/plain; charset="UTF-8"',
			"Content-Transfer-Encoding: base64",
			"",
			Buffer.from(mail.text, "utf8").toString("base64")
		];
		const sent = await fetchJson<{ id: string; threadId: string }>(`${API}/messages/send`, {
			method: "POST",
			headers: { ...this.auth(accessToken), "content-type": "application/json" },
			body: JSON.stringify({
				raw: Buffer.from(lines.join("\r\n"), "utf8").toString("base64url"),
				threadId: mail.providerThreadId
			})
		});
		return { providerMessageId: sent.id, providerThreadId: sent.threadId ?? mail.providerThreadId };
	}

	async revoke(token: string) {
		await fetch("https://oauth2.googleapis.com/revoke", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: formBody({ token }),
			signal: AbortSignal.timeout(10_000)
		});
	}

	private auth(accessToken: string) {
		return { authorization: `Bearer ${accessToken}` };
	}

	private async token(values: Record<string, string>): Promise<TokenSet> {
		const data = await fetchJson<{ access_token: string; refresh_token?: string; expires_in?: number }>(
			"https://oauth2.googleapis.com/token",
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: formBody(values)
			}
		);
		return {
			accessToken: data.access_token,
			refreshToken: data.refresh_token ?? null,
			expiresAt: expiryFrom(data.expires_in)
		};
	}

	private toMeta(message: GmailMessage): MailMeta {
		const from = parseAddress(header(message, "From"));
		return {
			providerMessageId: message.id,
			providerThreadId: message.threadId,
			internetMessageId: header(message, "Message-ID") || null,
			from: from.email,
			fromName: from.name,
			to: [...parseAddressList(header(message, "To")), ...parseAddressList(header(message, "Cc"))],
			subject: header(message, "Subject"),
			snippet: message.snippet ?? "",
			receivedAt: message.internalDate ? new Date(Number(message.internalDate)) : new Date()
		};
	}
}
