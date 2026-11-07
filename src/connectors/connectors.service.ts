import {
	BadGatewayException,
	BadRequestException,
	ForbiddenException,
	Inject,
	Injectable,
	Logger,
	NotFoundException,
	ServiceUnavailableException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { JwtService } from "@nestjs/jwt";
import { Model, Types } from "mongoose";
import { randomBytes, randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { User } from "../users/users.schema";
import { Role } from "../auth/role.enum";
import { DocumentStatus, DocumentType } from "../users/types/document-type";
import { Tenancy } from "../tenancies/tenancy.schema";
import { DocumentSource, TenancyDocumentType, TenancyStatus } from "../tenancies/tenancy.enums";
import { TenanciesService } from "../tenancies/tenancies.service";
import { Application } from "../application/application.schema";
import { ApplicationStage } from "../application/enums/application-stage.enum";
import { Listing } from "../listings/listings.schema";
import { Bill, BillCategory, BillSource, BillStatus } from "../bills/bill.schema";
import { UploadService } from "../upload/upload.service";
import { EmailMessage } from "../inbox/email-message.schema";
import { EmailCategory } from "../inbox/email-category.enum";
import { ConnectionStatus, EmailConnection, EmailProvider } from "./email-connection.schema";
import {
	Classification,
	HousingContact,
	billCategoryFor,
	classifyEmail,
	documentTypeFor,
	looksLikeBill,
	parseAmountPence,
	referenceTypeFor,
	threadKeyFor
} from "./housing-filter";
import { DEMO_FILE_BASE, DemoContext, UNIVERSITY_DOMAINS, demoMailbox } from "./demo-mailbox";
import { decryptToken, deriveDevelopmentKey, encryptToken, parseEncryptionKey } from "./token-crypto";
import { MailAttachment, MailFull, MailMeta, MailProviderClient, replySubject } from "./providers/mail-provider";
import { GmailClient } from "./providers/gmail.client";
import { OutlookClient } from "./providers/outlook.client";
import { ImapCredentials, listRecentImap, verifyImapLogin } from "./providers/imap.client";
import type { ConnectImapDto, UpdateConnectorSettingsDto } from "./dto/connectors.dto";
import { findUniversity, UNIVERSITIES } from "../ai/search-parser";

type OAuthProvider = EmailProvider.GMAIL | EmailProvider.OUTLOOK;
type ClientKind = "web" | "mobile";
type ConnectionLean = EmailConnection & { _id: Types.ObjectId };
type UserLean = Pick<User, "_id" | "name" | "email" | "role" | "universityDetails"> & {
	connectorSettings?: User["connectorSettings"];
};
const SETTING_KEYS = ["autoFileAttachments", "addReferencesToProfile", "readUtilityBills", "copySignedContracts", "aiDraftReplies"] as const;
type SettingKey = (typeof SETTING_KEYS)[number];
type ConnectorToggles = Record<SettingKey, boolean>;
type ConnectorSettingsView = { scope: "housing" } & ConnectorToggles;

/** Every toggle defaults to on; only an explicit false turns one off. */
function togglesFrom(saved?: Partial<Record<SettingKey, boolean>> | null): ConnectorToggles {
	return Object.fromEntries(SETTING_KEYS.map(key => [key, saved?.[key] !== false])) as ConnectorToggles;
}

/** Mobile OAuth result waiting for the signed-in app to claim it (Redis, 10 min). */
interface PendingConnection {
	sub: string;
	provider: OAuthProvider;
	emailAddress: string;
	accessTokenEnc: string;
	refreshTokenEnc?: string;
	expiresAt: Date | string | null;
}
const PENDING_TTL_SECONDS = 600;
const pendingKey = (nonce: string) => `connectors:pending:${nonce}`;

interface OAuthState {
	sub: string;
	provider: OAuthProvider;
	client: ClientKind;
	returnTo: string | null;
	purpose: "email-connector";
}

export interface ContactBook {
	byEmail: Map<string, HousingContact>;
	/** One contact per Seek user, with their preferred (connected) address. */
	byUser: Map<string, HousingContact>;
}

export interface SyncResult {
	scanned: number;
	imported: number;
	skipped: number;
	filed: number;
}

const PROVIDER_LABELS: Record<EmailProvider, string> = {
	[EmailProvider.GMAIL]: "Gmail",
	[EmailProvider.OUTLOOK]: "Outlook",
	[EmailProvider.DEMO]: "Demo mailbox",
	[EmailProvider.IMAP]: "IMAP mailbox"
};

const FILE_TYPES: Record<string, string> = {
	"application/pdf": "pdf",
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg"
};
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const FIRST_SYNC_DAYS = 60;
const SYNC_LIMIT = 100;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function documentTitle(fileName: string) {
	const base = fileName.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[-_]+/g, " ").trim();
	return base.charAt(0).toUpperCase() + base.slice(1);
}

function folderFor(type: TenancyDocumentType) {
	if (type === TenancyDocumentType.TENANCY_AGREEMENT) return "Contract";
	if (type === TenancyDocumentType.DEPOSIT_CERTIFICATE) return "Deposit";
	return "Documents";
}

/** "Your October statement" → that month, the most recent one not after the email. */
function billPeriod(subject: string, receivedAt: Date): { start: Date; end: Date } | null {
	const month = MONTHS.findIndex(name => new RegExp(`\\b${name}\\b`, "i").test(subject));
	if (month < 0) return null;
	let year = receivedAt.getUTCFullYear();
	if (month > receivedAt.getUTCMonth()) year -= 1;
	return {
		start: new Date(Date.UTC(year, month, 1)),
		end: new Date(Date.UTC(year, month + 1, 0, 23, 59, 59))
	};
}

@Injectable()
export class ConnectorsService {
	private readonly logger = new Logger(ConnectorsService.name);
	private readonly jwt = new JwtService({});
	private readonly clients: Record<OAuthProvider, MailProviderClient> = {
		[EmailProvider.GMAIL]: new GmailClient(),
		[EmailProvider.OUTLOOK]: new OutlookClient()
	};

	constructor(
		private readonly config: ConfigService,
		@InjectModel(EmailConnection.name) private readonly connectionModel: Model<EmailConnection>,
		@InjectModel(EmailMessage.name) private readonly messageModel: Model<EmailMessage>,
		@InjectModel(Tenancy.name) private readonly tenancyModel: Model<Tenancy>,
		@InjectModel(Application.name) private readonly applicationModel: Model<Application>,
		@InjectModel(User.name) private readonly userModel: Model<User>,
		@InjectModel(Listing.name) private readonly listingModel: Model<Listing>,
		@InjectModel(Bill.name) private readonly billModel: Model<Bill>,
		private readonly tenancies: TenanciesService,
		private readonly uploads: UploadService,
		@Inject("REDIS_CLIENT") private readonly redis: Redis
	) {}

	// ---------------------------------------------------------------- setup

	private get isProduction() {
		return this.config.get<string>("NODE_ENV") === "production";
	}

	/** AES key for stored tokens. Outside production a key is derived from the JWT secret. */
	private encryptionKey(): Buffer | null {
		const key = parseEncryptionKey(this.config.get<string>("CONNECTOR_ENCRYPTION_KEY"));
		if (key) return key;
		if (this.isProduction) return null;
		return deriveDevelopmentKey(this.config.getOrThrow<string>("JWT_ACCESS_TOKEN_SECRET"));
	}

	private credentials(provider: OAuthProvider) {
		const prefix = provider === EmailProvider.GMAIL ? "GMAIL" : "MS";
		const clientId = this.config.get<string>(`${prefix}_CLIENT_ID`)?.trim();
		const clientSecret = this.config.get<string>(`${prefix}_CLIENT_SECRET`)?.trim();
		return clientId && clientSecret ? { clientId, clientSecret } : null;
	}

	private unavailableReason(provider: EmailProvider): string | null {
		if (provider === EmailProvider.DEMO) {
			return this.isProduction ? "The demo mailbox is only available outside production." : null;
		}
		if (provider === EmailProvider.IMAP) {
			return this.encryptionKey() ? null : "Mailbox connections need CONNECTOR_ENCRYPTION_KEY on this server.";
		}
		// Outlook is demo-only outside production: it connects the demo mailbox, whatever MS_* holds.
		if (provider === EmailProvider.OUTLOOK && !this.isProduction) return null;
		if (!this.credentials(provider)) {
			const prefix = provider === EmailProvider.GMAIL ? "GMAIL" : "MS";
			return `${PROVIDER_LABELS[provider]} is not set up on this server (${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET).`;
		}
		if (!this.encryptionKey()) return "Mailbox connections need CONNECTOR_ENCRYPTION_KEY on this server.";
		return null;
	}

	providers() {
		return [EmailProvider.GMAIL, EmailProvider.OUTLOOK, EmailProvider.DEMO]
			.map(provider => {
				const reason = this.unavailableReason(provider);
				const label = provider === EmailProvider.OUTLOOK && !this.isProduction ? "Outlook (demo)" : PROVIDER_LABELS[provider];
				return { provider, label, available: !reason, ...(reason ? { reason } : {}) };
			})
			// The demo option is not shown at all in production.
			.filter(item => !(item.provider === EmailProvider.DEMO && this.isProduction));
	}

	private callbackUrl(provider: OAuthProvider) {
		const base = (
			this.config.get<string>("CONNECTORS_CALLBACK_BASE_URL")?.trim() ||
			`http://localhost:${this.config.get<string>("PORT") ?? 3000}`
		).replace(/\/$/, "");
		return `${base}/connectors/${provider.toLowerCase()}/callback`;
	}

	parseOAuthProvider(raw: string): OAuthProvider {
		// Canonical names are lowercase (gmail, outlook); any casing is accepted.
		const value = raw?.trim().toUpperCase();
		if (value === EmailProvider.GMAIL || value === EmailProvider.OUTLOOK) return value;
		throw new BadRequestException("Provider must be gmail or outlook.");
	}

	// ---------------------------------------------------------------- read

	async overview(user: Pick<User, "_id">) {
		const settings = await this.settings(user);
		const connections = await this.connectionModel
			.find({ user: user._id, status: { $ne: ConnectionStatus.DISCONNECTED } })
			.sort({ createdAt: 1 })
			.lean()
			.exec();
		return {
			providers: this.providers(),
			settings,
			connections: await Promise.all(
				connections.map(connection => this.view(connection as ConnectionLean))
			)
		};
	}

	/** The owner's connector toggles (all on by default). Scope is always housing only. */
	async settings(user: Pick<User, "_id">): Promise<ConnectorSettingsView> {
		const found = await this.userModel.findById(user._id).select("connectorSettings").lean().exec();
		return { scope: "housing", ...togglesFrom(found?.connectorSettings) };
	}

	async updateSettings(user: Pick<User, "_id">, dto: UpdateConnectorSettingsDto) {
		const $set: Record<string, boolean> = {};
		for (const key of SETTING_KEYS) {
			if (dto[key] !== undefined) $set[`connectorSettings.${key}`] = dto[key];
		}
		if (Object.keys($set).length) await this.userModel.updateOne({ _id: user._id }, { $set });
		return this.settings(user);
	}

	private async view(connection: ConnectionLean) {
		const counterparts = await this.messageModel.aggregate<{
			_id: string;
			name: string;
			category: EmailCategory;
			count: number;
		}>([
			{ $match: { connection: connection._id } },
			{ $sort: { receivedAt: -1 } },
			{
				$group: {
					_id: "$counterpartEmail",
					name: { $first: "$counterpartName" },
					category: { $first: "$category" },
					count: { $sum: 1 }
				}
			},
			{ $sort: { count: -1 } }
		]);
		return {
			id: connection._id.toString(),
			provider: connection.provider,
			label: PROVIDER_LABELS[connection.provider],
			emailAddress: connection.emailAddress,
			status: connection.status,
			housingOnly: true,
			lastSyncAt: connection.lastSyncAt ?? null,
			lastError: connection.lastError ?? null,
			emailCount: counterparts.reduce((sum, item) => sum + item.count, 0),
			contactCount: counterparts.length,
			matchedContacts: counterparts.map(item => ({
				name: item.name || item._id,
				email: item._id,
				category: item.category,
				emailCount: item.count
			}))
		};
	}

	// ---------------------------------------------------------------- OAuth

	async authUrl(user: Pick<User, "_id"> & Partial<UserLean>, rawProvider: string, client: ClientKind = "web", returnTo?: string) {
		const provider = this.parseOAuthProvider(rawProvider);
		const reason = this.unavailableReason(provider);
		if (reason) throw new ServiceUnavailableException(reason);
		const safeReturnTo = returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : null;
		if (provider === EmailProvider.OUTLOOK && !this.isProduction) {
			// No Microsoft consent: connect the demo mailbox and send the app straight to its "connected" screen.
			await this.connectDemo(user as UserLean);
			const demoState = { sub: user._id.toString(), provider, client, returnTo: safeReturnTo, purpose: "email-connector" } satisfies OAuthState;
			return { provider, url: this.redirectFor(demoState, provider, "connected") };
		}
		const credentials = this.credentials(provider)!;
		const state = this.jwt.sign(
			{
				sub: user._id.toString(),
				provider,
				client,
				returnTo: safeReturnTo,
				purpose: "email-connector"
			} satisfies OAuthState,
			{ secret: this.config.getOrThrow<string>("JWT_ACCESS_TOKEN_SECRET"), expiresIn: "10m" }
		);
		return {
			provider,
			url: this.clients[provider].authUrl({
				clientId: credentials.clientId,
				redirectUri: this.callbackUrl(provider),
				state
			})
		};
	}

	/** Finishes the OAuth flow and returns where to send the browser. */
	async handleCallback(
		rawProvider: string,
		query: { code?: string; state?: string; error?: string },
		authCookie?: string
	) {
		let state: OAuthState | null = null;
		try {
			const decoded = this.jwt.verify<OAuthState>(query.state ?? "", {
				secret: this.config.getOrThrow<string>("JWT_ACCESS_TOKEN_SECRET")
			});
			if (decoded.purpose === "email-connector") state = decoded;
		} catch {
			state = null;
		}

		const provider = (() => {
			try {
				return this.parseOAuthProvider(rawProvider);
			} catch {
				return null;
			}
		})();
		if (!state || !provider || state.provider !== provider) {
			return this.redirectFor(state, rawProvider, "error", "invalid_state");
		}
		// OAuth CSRF: on the web, the browser that consented must be signed in as the user who asked for the link.
		if (state.client !== "mobile" && this.cookieUserId(authCookie) !== state.sub) {
			return this.redirectFor(state, provider, "error", "invalid_state");
		}
		if (query.error || !query.code) {
			return this.redirectFor(state, provider, "error", query.error ? "denied" : "missing_code");
		}

		const credentials = this.credentials(provider);
		const key = this.encryptionKey();
		if (!credentials || !key) return this.redirectFor(state, provider, "error", "unavailable");

		try {
			const client = this.clients[provider];
			const tokens = await client.exchangeCode({
				...credentials,
				redirectUri: this.callbackUrl(provider),
				code: query.code
			});
			const emailAddress = await client.mailboxAddress(tokens.accessToken);
			if (!emailAddress) throw new Error("Mailbox address missing.");
			const pending: PendingConnection = {
				sub: state.sub,
				provider,
				emailAddress,
				accessTokenEnc: encryptToken(tokens.accessToken, key),
				...(tokens.refreshToken ? { refreshTokenEnc: encryptToken(tokens.refreshToken, key) } : {}),
				expiresAt: tokens.expiresAt
			};
			if (state.client === "mobile") {
				// No cookie in the system browser: the nonce only reaches the device that consented,
				// and POST /connectors/:provider/confirm activates it for the signed-in owner of the link.
				const nonce = randomBytes(32).toString("base64url");
				await this.redis.set(pendingKey(nonce), JSON.stringify(pending), "EX", PENDING_TTL_SECONDS);
				return this.redirectFor(state, provider, "pending", undefined, nonce);
			}
			await this.activateConnection(pending);
			return this.redirectFor(state, provider, "connected");
		} catch (error) {
			this.logger.warn(`${provider} OAuth callback failed: ${(error as Error).message}`);
			return this.redirectFor(state, provider, "error", "exchange_failed");
		}
	}

	/** Mobile step 2: the signed-in app claims the mailbox its consent produced. */
	async confirmPending(user: Pick<User, "_id">, rawProvider: string, nonce: string) {
		const provider = this.parseOAuthProvider(rawProvider);
		const raw = await this.redis.get(pendingKey(nonce));
		if (raw) await this.redis.del(pendingKey(nonce));
		const pending = raw ? (JSON.parse(raw) as PendingConnection) : null;
		if (!pending || pending.provider !== provider || pending.sub !== user._id.toString()) {
			throw new BadRequestException("This mailbox link has expired or was started from another account. Connect again.");
		}
		return this.view(await this.activateConnection(pending));
	}

	private async activateConnection(pending: PendingConnection) {
		const { sub, provider, emailAddress, accessTokenEnc, refreshTokenEnc, expiresAt } = pending;
		const connection = (await this.connectionModel
			.findOneAndUpdate(
				{ user: new Types.ObjectId(sub), provider, emailAddress },
				{
					$set: {
						status: ConnectionStatus.CONNECTED,
						housingOnly: true,
						accessTokenEnc,
						...(refreshTokenEnc ? { refreshTokenEnc } : {}),
						expiresAt: expiresAt ? new Date(expiresAt) : null,
						lastError: null
					}
				},
				{ upsert: true, new: true, setDefaultsOnInsert: true }
			)
			.lean()
			.exec()) as ConnectionLean;
		// First sync runs in the background so the response is immediate.
		void this.syncConnection(connection).catch(error =>
			this.logger.warn(`Initial ${provider} sync failed: ${(error as Error).message}`)
		);
		return connection;
	}

	/** User id from the web Authentication cookie; expiry is ignored because only the signature proves who the browser is. */
	private cookieUserId(token?: string): string | null {
		if (!token) return null;
		try {
			return (
				this.jwt.verify<{ userId?: string }>(token, {
					secret: this.config.getOrThrow<string>("JWT_ACCESS_TOKEN_SECRET"),
					ignoreExpiration: true
				}).userId ?? null
			);
		} catch {
			return null;
		}
	}

	private redirectFor(
		state: OAuthState | null,
		provider: string,
		status: "connected" | "pending" | "error",
		reason?: string,
		nonce?: string
	) {
		const params = new URLSearchParams({
			connector: provider.toLowerCase(),
			status,
			...(reason ? { reason } : {}),
			...(nonce ? { nonce } : {})
		});
		if (state?.client === "mobile") {
			const base = this.config.get<string>("MOBILE_CONNECTORS_REDIRECT_URL")?.trim() || "seekapp://connectors";
			return `${base}${base.includes("?") ? "&" : "?"}${params.toString()}`;
		}
		const frontend = (this.config.get<string>("FRONTEND_URL") ?? "http://localhost:5173")
			.split(",")[0]
			.trim()
			.replace(/\/$/, "");
		return `${frontend}${state?.returnTo ?? "/connectors"}?${params.toString()}`;
	}

	// ---------------------------------------------------------------- demo / sync / disconnect

	async connectDemo(user: UserLean) {
		if (this.isProduction) throw new NotFoundException("The demo mailbox is not available.");
		const existing = await this.connectionModel
			.findOne({ user: user._id, provider: EmailProvider.DEMO })
			.sort({ updatedAt: -1 })
			.lean()
			.exec();
		const emailAddress = existing?.emailAddress ?? user.email;
		const connection = await this.connectionModel
			.findOneAndUpdate(
				{ user: user._id, provider: EmailProvider.DEMO, emailAddress },
				{ $set: { status: ConnectionStatus.CONNECTED, housingOnly: true, lastError: null } },
				{ upsert: true, new: true, setDefaultsOnInsert: true }
			)
			.lean()
			.exec();
		const result = await this.syncConnection(connection as ConnectionLean);
		return { ...result, connection: await this.connectionView(user, connection._id.toString()) };
	}

	async sync(user: Pick<User, "_id">, id: string) {
		const connection = await this.ownedConnection(user, id);
		const result = await this.syncConnection(connection);
		return { ...result, connection: await this.connectionView(user, id) };
	}

	private async connectionView(user: Pick<User, "_id">, id: string) {
		return this.view(await this.ownedConnection(user, id));
	}

	/**
	 * Connects any IMAP mailbox with an app password, sealed with AES-256-GCM
	 * (token-crypto.ts). Outside production, a server that cannot be reached
	 * falls back to the demo mailbox so the flow can be tried locally.
	 */
	async connectImap(user: UserLean, dto: ConnectImapDto) {
		const key = this.encryptionKey();
		if (!key) throw new ServiceUnavailableException("Mailbox connections need CONNECTOR_ENCRYPTION_KEY on this server.");
		const credentials: ImapCredentials = {
			host: dto.host.trim().toLowerCase(),
			port: dto.port,
			username: dto.username.trim(),
			password: dto.appPassword
		};
		try {
			await verifyImapLogin(credentials, !this.isProduction);
		} catch (error) {
			this.logger.warn(`IMAP sign-in to ${credentials.host}:${credentials.port} failed: ${(error as Error).message}`);
			if (this.isProduction) {
				throw new BadRequestException("Could not sign in to that IMAP server. Check the host, port, username and app password.");
			}
			return {
				...(await this.connectDemo(user)),
				mode: "demo" as const,
				notice: "Could not sign in to that IMAP server, so the demo mailbox was connected instead (development only)."
			};
		}
		const login = credentials.username.toLowerCase();
		const emailAddress = login.includes("@") ? login : `${login}@${credentials.host}`;
		const connection = await this.connectionModel
			.findOneAndUpdate(
				{ user: user._id, provider: EmailProvider.IMAP, emailAddress },
				{
					$set: {
						status: ConnectionStatus.CONNECTED,
						imapHost: credentials.host,
						imapPort: credentials.port,
						imapUsername: credentials.username,
						accessTokenEnc: encryptToken(credentials.password, key),
						lastError: null
					}
				},
				{ upsert: true, new: true, setDefaultsOnInsert: true }
			)
			.lean()
			.exec();
		const result = await this.syncConnection(connection as ConnectionLean);
		return { ...result, connection: await this.connectionView(user, connection._id.toString()), mode: "imap" as const };
	}

	private imapCredentials(connection: ConnectionLean): ImapCredentials {
		const key = this.encryptionKey();
		if (!key || !connection.accessTokenEnc || !connection.imapHost || !connection.imapPort || !connection.imapUsername) {
			throw new ServiceUnavailableException("Reconnect this mailbox.");
		}
		return {
			host: connection.imapHost,
			port: connection.imapPort,
			username: connection.imapUsername,
			password: decryptToken(connection.accessTokenEnc, key)
		};
	}

	async disconnect(user: Pick<User, "_id">, id: string) {
		const connection = await this.ownedConnection(user, id);
		if (connection.provider === EmailProvider.GMAIL || connection.provider === EmailProvider.OUTLOOK) {
			const key = this.encryptionKey();
			const sealed = connection.refreshTokenEnc ?? connection.accessTokenEnc;
			if (key && sealed) {
				try {
					await this.clients[connection.provider as OAuthProvider].revoke(decryptToken(sealed, key));
				} catch (error) {
					this.logger.warn(`Token revoke failed: ${(error as Error).name}`);
				}
			}
		}
		await this.connectionModel.updateOne(
			{ _id: connection._id },
			{
				$set: {
					status: ConnectionStatus.DISCONNECTED,
					accessTokenEnc: null,
					refreshTokenEnc: null,
					expiresAt: null
				}
			}
		);
		const removed = await this.messageModel.deleteMany({ connection: connection._id });
		return { id, status: ConnectionStatus.DISCONNECTED, removedEmails: removed.deletedCount ?? 0 };
	}

	async ownedConnection(user: Pick<User, "_id">, id: string): Promise<ConnectionLean> {
		if (!Types.ObjectId.isValid(id)) throw new BadRequestException("Invalid connection id.");
		const connection = await this.connectionModel.findById(id).lean().exec();
		if (!connection || connection.status === ConnectionStatus.DISCONNECTED) {
			throw new NotFoundException("Mailbox connection not found.");
		}
		if (connection.user.toString() !== user._id.toString()) {
			throw new ForbiddenException("This mailbox belongs to someone else.");
		}
		return connection as ConnectionLean;
	}

	async syncConnection(connection: ConnectionLean): Promise<SyncResult> {
		const user = await this.userModel
			.findById(connection.user)
			.select("name email role universityDetails connectorSettings")
			.lean()
			.exec();
		if (!user) throw new NotFoundException("User not found.");
		const contacts = await this.contactBook(user as UserLean);
		const result: SyncResult = { scanned: 0, imported: 0, skipped: 0, filed: 0 };
		// Housing emails only, whatever a legacy record says (connectorSettings.housingOnly is ignored).
		const toggles = togglesFrom((user as UserLean).connectorSettings);

		try {
			let accessToken: string | null = null;
			let messages: (MailMeta | MailFull)[];
			if (connection.provider === EmailProvider.DEMO) {
				messages = demoMailbox(await this.demoContext(user as UserLean, connection, contacts));
			} else {
				const since = connection.lastSyncAt
					? new Date(connection.lastSyncAt.getTime() - 24 * 3_600_000)
					: new Date(Date.now() - FIRST_SYNC_DAYS * 24 * 3_600_000);
				if (connection.provider === EmailProvider.IMAP) {
					messages = await listRecentImap(this.imapCredentials(connection), since, SYNC_LIMIT, !this.isProduction);
				} else {
					accessToken = await this.accessToken(connection);
					messages = await this.clients[connection.provider as OAuthProvider].listRecent(accessToken, since, SYNC_LIMIT);
				}
			}

			for (const meta of messages) {
				result.scanned += 1;
				const known = await this.messageModel.exists({
					connection: connection._id,
					providerMessageId: meta.providerMessageId
				});
				if (known) continue;
				const outgoing = meta.from === connection.emailAddress;
				const classification = classifyEmail(
					{ from: meta.from, fromName: meta.fromName, to: meta.to, subject: meta.subject, outgoing },
					contacts.byEmail
				);
				if (!classification.housing) {
					result.skipped += 1;
					continue;
				}
				const full =
					"body" in meta
						? meta
						: await this.clients[connection.provider as OAuthProvider].getFull(accessToken!, meta);
				const filed = await this.store(connection, user as UserLean, full, classification, outgoing, toggles);
				if (filed !== null) {
					result.imported += 1;
					result.filed += filed;
				}
			}

			await this.connectionModel.updateOne(
				{ _id: connection._id },
				{ $set: { lastSyncAt: new Date(), status: ConnectionStatus.CONNECTED, lastError: null } }
			);
			return result;
		} catch (error) {
			const message =
				error instanceof ServiceUnavailableException
					? error.message
					: `Could not sync ${PROVIDER_LABELS[connection.provider]}. Try again, or reconnect the mailbox.`;
			this.logger.warn(`Sync failed for connection ${connection._id.toString()}: ${(error as Error).message}`);
			await this.connectionModel.updateOne(
				{ _id: connection._id },
				{ $set: { status: ConnectionStatus.ERROR, lastError: message } }
			);
			throw error instanceof ServiceUnavailableException ? error : new BadGatewayException(message);
		}
	}

	/** A valid access token, refreshed when it is about to expire. */
	private async accessToken(connection: ConnectionLean): Promise<string> {
		const provider = connection.provider as OAuthProvider;
		const key = this.encryptionKey();
		const credentials = this.credentials(provider);
		if (!key || !credentials) {
			throw new ServiceUnavailableException(this.unavailableReason(provider) ?? "Mailbox is not available.");
		}
		if (!connection.accessTokenEnc) throw new ServiceUnavailableException("Reconnect this mailbox.");
		const expiresSoon = connection.expiresAt && connection.expiresAt.getTime() < Date.now() + 60_000;
		if (!expiresSoon) return decryptToken(connection.accessTokenEnc, key);
		if (!connection.refreshTokenEnc) throw new ServiceUnavailableException("Reconnect this mailbox.");

		const tokens = await this.clients[provider].refresh({
			...credentials,
			refreshToken: decryptToken(connection.refreshTokenEnc, key)
		});
		await this.connectionModel.updateOne(
			{ _id: connection._id },
			{
				$set: {
					accessTokenEnc: encryptToken(tokens.accessToken, key),
					...(tokens.refreshToken ? { refreshTokenEnc: encryptToken(tokens.refreshToken, key) } : {}),
					expiresAt: tokens.expiresAt
				}
			}
		);
		return tokens.accessToken;
	}

	// ---------------------------------------------------------------- contacts

	/**
	 * The people a mailbox owner deals with on Seek: landlord and housemates
	 * for students; tenants and applicants for landlords. Each is matched on
	 * their account email and on every mailbox they connected.
	 */
	async contactBook(user: UserLean): Promise<ContactBook> {
		const userId = user._id.toString();
		const uid = new Types.ObjectId(userId);
		const pending: Omit<HousingContact, "email" | "name">[] = [];
		const add = (contact: Omit<HousingContact, "email" | "name">) => {
			if (contact.userId === userId) return;
			if (pending.some(existing => existing.userId === contact.userId)) return;
			pending.push(contact);
		};

		const isLandlord = user.role === Role.LANDLORD_AGENCY;
		const tenancies = await this.tenancyModel
			.find(isLandlord ? { landlord: uid } : { tenants: uid })
			.sort({ status: 1, startDate: -1 })
			.lean()
			.exec();
		const applications = await this.applicationModel
			.find(
				isLandlord
					? { landlord: uid, stage: { $in: [ApplicationStage.SENT, ApplicationStage.ACCEPTED] } }
					: { $or: [{ applicants: uid }, { owner: uid }] }
			)
			.sort({ createdAt: -1 })
			.lean()
			.exec();
		const conversationOf = new Map(applications.map(app => [app._id.toString(), app.conversation?.toString() ?? null]));
		const tenancyOfApplication = new Map(
			tenancies.filter(t => t.application).map(t => [t.application!.toString(), t._id.toString()])
		);

		for (const tenancy of tenancies) {
			const conversationId = tenancy.application ? conversationOf.get(tenancy.application.toString()) ?? null : null;
			const tenancyId = tenancy._id.toString();
			if (isLandlord) {
				tenancy.tenants.forEach(tenant => add({ role: "TENANT", userId: tenant.toString(), tenancyId, conversationId }));
			} else {
				add({ role: "LANDLORD", userId: tenancy.landlord.toString(), tenancyId, conversationId });
				tenancy.tenants.forEach(tenant => add({ role: "HOUSEHOLD", userId: tenant.toString(), tenancyId, conversationId }));
			}
		}
		for (const app of applications) {
			const tenancyId = tenancyOfApplication.get(app._id.toString()) ?? null;
			const conversationId = app.conversation?.toString() ?? null;
			if (isLandlord) {
				(app.applicants ?? []).forEach(applicant =>
					add({ role: "APPLICANT", userId: applicant.toString(), tenancyId, conversationId })
				);
			} else {
				if (app.landlord) add({ role: "LANDLORD", userId: app.landlord.toString(), tenancyId, conversationId });
				(app.applicants ?? []).forEach(applicant =>
					add({ role: "HOUSEHOLD", userId: applicant.toString(), tenancyId, conversationId })
				);
			}
		}

		const ids = pending.map(contact => new Types.ObjectId(contact.userId));
		const [people, mailboxes] = await Promise.all([
			this.userModel.find({ _id: { $in: ids } }).select("name email").lean().exec(),
			this.connectionModel
				.find({ user: { $in: ids }, status: { $ne: ConnectionStatus.DISCONNECTED } })
				.select("user emailAddress")
				.sort({ createdAt: 1 })
				.lean()
				.exec()
		]);
		const book: ContactBook = { byEmail: new Map(), byUser: new Map() };
		for (const contact of pending) {
			const person = people.find(p => p._id.toString() === contact.userId);
			if (!person) continue;
			const addresses = [
				...mailboxes.filter(m => m.user.toString() === contact.userId).map(m => m.emailAddress),
				person.email
			]
				.filter(Boolean)
				.map(address => address.toLowerCase());
			const full = { ...contact, name: person.name || addresses[0], email: addresses[0] };
			book.byUser.set(contact.userId, full);
			for (const address of addresses) {
				if (!book.byEmail.has(address)) book.byEmail.set(address, { ...full, email: address });
			}
		}
		return book;
	}

	private async demoContext(user: UserLean, connection: ConnectionLean, contacts: ContactBook): Promise<DemoContext> {
		const firstName = (user.name ?? "").split(/\s+/)[0] || "there";
		const ctx: DemoContext = { mailbox: connection.emailAddress, firstName, now: new Date() };
		const people = [...contacts.byUser.values()];
		const userId = new Types.ObjectId(user._id.toString());

		if (user.role === Role.LANDLORD_AGENCY) {
			ctx.isLandlord = true;
			// Prefer a tenancy whose deposit is protected so the demo shows the certificate.
			const tenancy = await this.tenancyModel
				.findOne({ landlord: userId, status: TenancyStatus.ACTIVE })
				.sort({ depositProtectedAt: -1, startDate: -1 })
				.populate<{ listing: Listing }>({ path: "listing", select: "propertyTitle streetAddress billsIncluded" })
				.lean()
				.exec();
			if (tenancy) {
				const tenant = people.find(p => p.role === "TENANT" && p.tenancyId === tenancy._id.toString());
				if (tenant) ctx.tenant = { name: tenant.name, email: tenant.email };
				ctx.home = {
					title: tenancy.listing?.propertyTitle || tenancy.listing?.streetAddress || "your property",
					depositPence: tenancy.depositAmount ?? 0,
					depositReference: tenancy.depositReference ?? null,
					depositScheme: tenancy.depositScheme ?? null,
					billsIncluded: Boolean(tenancy.listing?.billsIncluded)
				};
			}
			const applicant = people.find(p => p.role === "APPLICANT");
			if (applicant) ctx.applicant = { name: applicant.name, email: applicant.email };
			return ctx;
		}

		const tenancy = await this.tenancyModel
			.findOne({ tenants: userId, status: TenancyStatus.ACTIVE })
			.sort({ startDate: -1 })
			.populate<{ listing: Listing }>({ path: "listing", select: "propertyTitle streetAddress cityTown billsIncluded" })
			.lean()
			.exec();
		if (tenancy) {
			const landlord = contacts.byUser.get(tenancy.landlord.toString());
			if (landlord) ctx.landlord = { name: landlord.name, email: landlord.email };
			ctx.householdEmails = people
				.filter(p => p.role === "HOUSEHOLD" && p.tenancyId === tenancy._id.toString())
				.map(p => p.email);
			ctx.home = {
				title: tenancy.listing?.propertyTitle || tenancy.listing?.streetAddress || "your home",
				depositPence: tenancy.depositAmount ?? 0,
				depositReference: tenancy.depositReference ?? null,
				depositScheme: tenancy.depositScheme ?? null,
				billsIncluded: Boolean(tenancy.listing?.billsIncluded)
			};
		}
		const university =
			findUniversity(user.universityDetails ?? "") ??
			UNIVERSITIES.find(u => u.city.toLowerCase() === (tenancy?.listing?.cityTown ?? "").toLowerCase());
		if (university && UNIVERSITY_DOMAINS[university.name]) {
			ctx.universityDomain = UNIVERSITY_DOMAINS[university.name];
			ctx.universityName = university.name;
		}
		return ctx;
	}

	// ---------------------------------------------------------------- storing and filing

	/** Stores one housing email. Returns how many attachments were filed, or null if it was already there. */
	private async store(
		connection: ConnectionLean,
		user: UserLean,
		mail: MailFull,
		classification: Classification,
		outgoing: boolean,
		toggles: ConnectorToggles = togglesFrom()
	): Promise<number | null> {
		const target = await this.tenancyFor(user, classification, mail);
		const counterpartEmail = outgoing ? (mail.to[0] ?? "") : mail.from;
		let created;
		try {
			created = await this.messageModel.create({
				user: user._id,
				connection: connection._id,
				providerThreadId: mail.providerThreadId,
				providerMessageId: mail.providerMessageId,
				internetMessageId: mail.internetMessageId,
				threadKey: threadKeyFor(connection._id.toString(), mail.providerThreadId),
				from: mail.from,
				fromName: mail.fromName,
				to: mail.to,
				counterpartEmail,
				counterpartName: classification.counterpartName || mail.fromName || counterpartEmail,
				subject: mail.subject,
				snippet: mail.snippet || mail.body.slice(0, 140),
				body: mail.body,
				receivedAt: mail.receivedAt,
				category: classification.category,
				attachments: mail.attachments.map(attachment => ({
					name: attachment.name,
					mimeType: attachment.mimeType,
					size: attachment.size
				})),
				tenancy: target?.tenancy._id ?? null,
				conversation: classification.contact?.conversationId
					? new Types.ObjectId(classification.contact.conversationId)
					: null,
				outgoing,
				read: outgoing
			});
		} catch (error) {
			if ((error as { code?: number }).code === 11000) return null;
			throw error;
		}

		if (outgoing) return 0;
		let filed = 0;
		const attachments = created.toObject().attachments;
		for (const [index, attachment] of mail.attachments.entries()) {
			const found = documentTypeFor(attachment.name, mail.subject);
			const type =
				found && target && toggles.autoFileAttachments && (found !== TenancyDocumentType.TENANCY_AGREEMENT || toggles.copySignedContracts)
					? found
					: null;
			const isBill =
				// A landlord's mailbox holds the landlord's own bills, never the tenants' shares.
				user.role !== Role.LANDLORD_AGENCY &&
				!found && !!target && toggles.readUtilityBills && classification.category === EmailCategory.BILLS && looksLikeBill(attachment.name, mail.subject);
			const reference = !found && toggles.addReferencesToProfile && user.role !== Role.LANDLORD_AGENCY ? referenceTypeFor(attachment.name, mail.subject) : null;
			if (!type && !isBill && !reference) continue;
			const file = await this.storeFile(connection, user, attachment);
			if (!file) continue;
			attachments[index] = { ...attachments[index], url: file.url, key: file.key };
			if (reference) {
				await this.addReference(user, reference, attachment.name, file);
				attachments[index].filedAs = "Seek Passport › References";
				filed += 1;
			} else if (type && target) {
				await this.fileDocument(target.tenancy, type, attachment.name, file);
				attachments[index].filedAs = `${target.label} › ${folderFor(type)}`;
				filed += 1;
			} else if (target && (await this.fileBill(target, classification, mail))) {
				attachments[index].filedAs = `${target.label} › Bills`;
				filed += 1;
			}
		}
		await this.messageModel.updateOne({ _id: created._id }, { $set: { attachments } });
		return filed;
	}

	/** The tenancy an email belongs to, and the label its files are shown under. */
	private async tenancyFor(user: UserLean, classification: Classification, mail: MailFull) {
		type Target = { tenancy: Tenancy & { _id: Types.ObjectId }; listing: Listing | null; label: string };
		const isLandlord = user.role === Role.LANDLORD_AGENCY;
		const withListing = async (tenancy: (Tenancy & { _id: Types.ObjectId }) | null): Promise<Target | null> => {
			if (!tenancy) return null;
			const listing = await this.listingModel
				.findById(tenancy.listing)
				.select("propertyTitle streetAddress billsIncluded")
				.lean()
				.exec();
			const title = listing?.propertyTitle || listing?.streetAddress || "Tenancy";
			return { tenancy, listing: listing as Listing | null, label: isLandlord ? title : "My home" };
		};

		if (classification.contact?.tenancyId) {
			const tenancy = await this.tenancyModel.findById(classification.contact.tenancyId).lean().exec();
			if (tenancy) return withListing(tenancy as Tenancy & { _id: Types.ObjectId });
		}
		const uid = new Types.ObjectId(user._id.toString());
		if (!isLandlord) {
			const tenancy = await this.tenancyModel
				.findOne({ tenants: uid, status: TenancyStatus.ACTIVE })
				.sort({ startDate: -1 })
				.lean()
				.exec();
			return withListing(tenancy as (Tenancy & { _id: Types.ObjectId }) | null);
		}
		// Landlords: only file when the email names one of their properties.
		const text = `${mail.subject}\n${mail.body}`.toLowerCase();
		const tenancies = await this.tenancyModel.find({ landlord: uid, status: TenancyStatus.ACTIVE }).lean().exec();
		const listings = await this.listingModel
			.find({ _id: { $in: tenancies.map(t => t.listing) } })
			.select("propertyTitle streetAddress")
			.lean()
			.exec();
		const match = listings.find(listing =>
			[listing.propertyTitle, listing.streetAddress].some(name => name && text.includes(name.toLowerCase()))
		);
		const tenancy = match ? tenancies.find(t => t.listing.toString() === match._id.toString()) : null;
		return withListing((tenancy ?? null) as (Tenancy & { _id: Types.ObjectId }) | null);
	}

	private async storeFile(connection: ConnectionLean, user: UserLean, attachment: MailAttachment) {
		if (connection.provider === EmailProvider.DEMO) {
			return { url: `${DEMO_FILE_BASE}/${encodeURIComponent(attachment.name)}`, key: null as string | null };
		}
		const extension = FILE_TYPES[attachment.mimeType.toLowerCase()];
		if (!extension || attachment.size > MAX_ATTACHMENT_BYTES) return null;
		try {
			const bytes = await attachment.load();
			if (!bytes || bytes.length > MAX_ATTACHMENT_BYTES) return null;
			const stored = await this.uploads.putPrivateObject(user._id.toString(), bytes, attachment.mimeType, extension);
			return { url: stored.url, key: stored.key as string | null };
		} catch (error) {
			this.logger.warn(`Could not store attachment: ${(error as Error).name}`);
			return null;
		}
	}

	private async fileDocument(
		tenancy: Tenancy & { _id: Types.ObjectId },
		type: TenancyDocumentType,
		fileName: string,
		file: { url: string; key: string | null }
	) {
		const title = documentTitle(fileName);
		const already = (tenancy.documents ?? []).some(doc => doc.type === type && doc.title === title);
		if (already) return;
		await this.tenancies.appendDocument(tenancy._id, {
			type,
			title,
			url: file.url,
			...(file.key ? { key: file.key } : {}),
			source: DocumentSource.EMAIL
		});
	}

	/** Adds a reference to the student's documents, waiting for Seek to verify it; never replaces one they already have. */
	private async addReference(user: UserLean, type: DocumentType, fileName: string, file: { url: string; key: string | null }) {
		await this.userModel.updateOne(
			{ _id: user._id, "documents.type": { $ne: type } },
			{
				$push: {
					documents: {
						type,
						url: file.url,
						...(file.key ? { key: file.key } : {}),
						status: DocumentStatus.PENDING,
						label: documentTitle(fileName),
						uploadedAt: new Date()
					}
				}
			}
		);
	}

	private async fileBill(
		target: { tenancy: Tenancy & { _id: Types.ObjectId }; listing: Listing | null },
		classification: Classification,
		mail: MailFull
	) {
		const amount = parseAmountPence(mail.body);
		if (!amount) return false;
		const category = billCategoryFor(mail.from, mail.subject);
		const provider = classification.counterpartName || mail.fromName || mail.from;
		const period = billPeriod(mail.subject, mail.receivedAt);
		const duplicate = await this.billModel.exists({
			tenancy: target.tenancy._id,
			provider,
			amount,
			...(period ? { periodStart: period.start } : { createdAt: { $gte: new Date(Date.now() - 45 * 24 * 3_600_000) } })
		});
		if (duplicate) return true;
		const coveredByRent =
			Boolean(target.listing?.billsIncluded) &&
			[BillCategory.ENERGY, BillCategory.WATER, BillCategory.BROADBAND].includes(category);
		await this.billModel.create({
			tenancy: target.tenancy._id,
			provider,
			category,
			amount,
			periodStart: period?.start ?? null,
			periodEnd: period?.end ?? null,
			dueDate: null,
			includedInRent: coveredByRent,
			splitBetween: target.tenancy.tenants,
			status: coveredByRent ? BillStatus.PAID : BillStatus.DUE,
			paidAt: coveredByRent ? mail.receivedAt : null,
			source: BillSource.EMAIL
		});
		return true;
	}

	// ---------------------------------------------------------------- sending

	/**
	 * Replies to an email from the user's own address and stores the sent copy
	 * so it shows in the thread straight away. The demo mailbox only stores it.
	 */
	async sendReply(user: Pick<User, "_id" | "name">, replyTo: EmailMessage & { _id: Types.ObjectId }, text: string) {
		const connection = await this.ownedConnection(user, replyTo.connection.toString());
		if (connection.status !== ConnectionStatus.CONNECTED) {
			throw new ServiceUnavailableException("Reconnect this mailbox to reply by email.");
		}
		if (connection.provider === EmailProvider.IMAP) {
			throw new ServiceUnavailableException("Replies can't be sent from an IMAP mailbox yet. Reply from your email app.");
		}
		const to = replyTo.outgoing ? replyTo.to : [replyTo.from];
		let sent = { providerMessageId: `demo-sent-${randomUUID()}`, providerThreadId: replyTo.providerThreadId };
		if (connection.provider !== EmailProvider.DEMO) {
			try {
				const accessToken = await this.accessToken(connection);
				sent = await this.clients[connection.provider as OAuthProvider].send(accessToken, {
					from: connection.emailAddress,
					to,
					subject: replyTo.subject,
					text,
					providerThreadId: replyTo.providerThreadId,
					replyToProviderMessageId: replyTo.providerMessageId,
					replyToInternetMessageId: replyTo.internetMessageId
				});
			} catch (error) {
				if (error instanceof ServiceUnavailableException) throw error;
				this.logger.warn(`Sending via ${connection.provider} failed: ${(error as Error).message}`);
				throw new BadGatewayException(`Could not send through ${PROVIDER_LABELS[connection.provider]}. Try again.`);
			}
		}
		return this.messageModel.create({
			user: user._id,
			connection: connection._id,
			providerThreadId: replyTo.providerThreadId,
			providerMessageId: sent.providerMessageId,
			internetMessageId: null,
			threadKey: replyTo.threadKey,
			from: connection.emailAddress,
			fromName: user.name ?? "",
			to,
			counterpartEmail: replyTo.counterpartEmail,
			counterpartName: replyTo.counterpartName,
			subject: replySubject(replyTo.subject),
			snippet: text.replace(/\s+/g, " ").slice(0, 140),
			body: text,
			receivedAt: new Date(),
			category: replyTo.category,
			attachments: [],
			tenancy: replyTo.tenancy,
			conversation: replyTo.conversation,
			outgoing: true,
			read: true
		});
	}
}
