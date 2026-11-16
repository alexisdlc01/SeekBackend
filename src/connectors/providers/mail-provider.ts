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
	/** True when the provider files it as sent from this mailbox (Gmail SENT label, Outlook Sent Items); never deduced from From. */
	sent?: boolean;
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
	/** True only when the receiving provider authenticated the From domain (see fromAuthenticated). Missing = not authenticated. */
	senderAuthenticated?: boolean;
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

/** True when a message is already stored, so its details need not be fetched again. */
export type KnownCheck = (providerMessageId: string) => Promise<boolean>;

export interface MailProviderClient {
	readonly scopes: string;
	authUrl(params: { clientId: string; redirectUri: string; state: string }): string;
	exchangeCode(params: { clientId: string; clientSecret: string; redirectUri: string; code: string }): Promise<TokenSet>;
	refresh(params: { clientId: string; clientSecret: string; refreshToken: string }): Promise<TokenSet>;
	mailboxAddress(accessToken: string): Promise<string>;
	/** Newest first, at most `limit` messages that `isKnown` does not already recognise; pages through the whole window. With `before`, only messages received at or before it. */
	listRecent(accessToken: string, since: Date, limit: number, isKnown?: KnownCheck, before?: Date): Promise<MailMeta[]>;
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

/**
 * True when an Authentication-Results header shows the From domain passed DMARC, or a DKIM signature of the From domain itself passed.
 * Pass the topmost Authentication-Results: the receiving provider prepends its own, so any the sender wrote sit below it.
 * Missing or unparseable header = false (fail closed).
 */
export function fromAuthenticated(authenticationResults: string | undefined, fromEmail: string) {
	const domain = fromEmail.trim().toLowerCase().split("@")[1];
	if (!authenticationResults || !domain) return false;
	// Quoted strings (e.g. a quoted local-part in smtp.mailfrom) may hold ";", "(" or "dmarc=pass": empty them first.
	let text = authenticationResults.replace(/"(?:[^"\\]|\\.)*"/g, '""');
	// Comments like "(google.com: domain of ... designates ...)" may hold anything: drop them, innermost first.
	while (/\([^()]*\)/.test(text)) text = text.replace(/\([^()]*\)/g, " ");
	return text.split(";").some(part => {
		const result = /^\s*(dmarc|dkim)\s*=\s*(\w+)/i.exec(part);
		if (!result || result[2].toLowerCase() !== "pass") return false;
		const prop = (name: string) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*"?([^\\s";]+)`, "i").exec(part)?.[1].toLowerCase();
		// No SPF: without DMARC its sending infrastructure is shared (an include of M365 lets anyone on it pass).
		if (result[1].toLowerCase() === "dmarc") return prop("header\\.from") === domain;
		// Microsoft writes header.d=, Gmail header.i=@domain.
		return prop("header\\.d") === domain || prop("header\\.i")?.split("@").pop() === domain;
	});
}
