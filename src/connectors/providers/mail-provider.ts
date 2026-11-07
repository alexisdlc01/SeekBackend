/** Headers of one provider message: enough to decide if it is housing-related. */
export interface MailMeta {
	providerMessageId: string;
	providerThreadId: string;
	internetMessageId: string | null;
	from: string;
	fromName: string;
	to: string[];
	subject: string;
	snippet: string;
	receivedAt: Date;
}

export interface MailAttachment {
	name: string;
	mimeType: string;
	size: number;
	/** Loads the bytes on demand, so only filed attachments are downloaded. */
	load: () => Promise<Buffer | null>;
}

export interface MailFull extends MailMeta {
	body: string;
	attachments: MailAttachment[];
}

export interface TokenSet {
	accessToken: string;
	refreshToken: string | null;
	expiresAt: Date | null;
}

export interface OutgoingMail {
	from: string;
	to: string[];
	subject: string;
	text: string;
	providerThreadId: string;
	/** The message being answered. */
	replyToProviderMessageId: string;
	replyToInternetMessageId: string | null;
}

export interface MailProviderClient {
	readonly scopes: string;
	authUrl(params: { clientId: string; redirectUri: string; state: string }): string;
	exchangeCode(params: { clientId: string; clientSecret: string; redirectUri: string; code: string }): Promise<TokenSet>;
	refresh(params: { clientId: string; clientSecret: string; refreshToken: string }): Promise<TokenSet>;
	mailboxAddress(accessToken: string): Promise<string>;
	listRecent(accessToken: string, since: Date, limit: number): Promise<MailMeta[]>;
	getFull(accessToken: string, meta: MailMeta): Promise<MailFull>;
	send(accessToken: string, mail: OutgoingMail): Promise<{ providerMessageId: string; providerThreadId: string }>;
	revoke(token: string): Promise<void>;
}

export class ProviderError extends Error {
	constructor(message: string, readonly status?: number) {
		super(message);
		this.name = "ProviderError";
	}
}

const TIMEOUT_MS = 20_000;

/** fetch + JSON with a timeout; never puts tokens in the error message. */
export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!response.ok) {
		throw new ProviderError(`Mail provider answered ${response.status}.`, response.status);
	}
	if (response.status === 202 || response.status === 204) return {} as T;
	const text = await response.text();
	return (text ? JSON.parse(text) : {}) as T;
}

export function formBody(values: Record<string, string>) {
	return new URLSearchParams(values).toString();
}

export function expiryFrom(expiresInSeconds: unknown): Date | null {
	const seconds = Number(expiresInSeconds);
	return Number.isFinite(seconds) && seconds > 0 ? new Date(Date.now() + seconds * 1000) : null;
}

export function replySubject(subject: string) {
	const clean = subject.trim() || "Your message";
	return /^re:/i.test(clean) ? clean : `Re: ${clean}`;
}
