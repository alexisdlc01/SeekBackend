import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";
import { ConnectionStatus, EmailProvider } from "../email-connection.schema";
import { EmailCategory } from "../../inbox/email-category.enum";

export class ProviderAvailabilityDto {
	@ApiProperty({ enum: EmailProvider })
	provider: EmailProvider;

	@ApiProperty({ example: "Gmail" })
	label: string;

	@ApiProperty()
	available: boolean;

	@ApiPropertyOptional({ description: "Why the provider cannot be connected on this server." })
	reason?: string;
}

export class MatchedContactDto {
	@ApiProperty({ example: "James Holloway" })
	name: string;

	@ApiProperty({ example: "james@holloway-lets.co.uk" })
	email: string;

	@ApiProperty({ enum: EmailCategory })
	category: EmailCategory;

	@ApiProperty()
	emailCount: number;
}

export class ConnectionMatchDto {
	@ApiProperty({ example: "James Holloway" })
	name: string;

	@ApiProperty({ example: "james@holloway-lets.co.uk" })
	email: string;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	lastMessageAt: Date | null;
}

export class EmailConnectionViewDto {
	@ApiProperty()
	id: string;

	@ApiProperty({ enum: EmailProvider })
	provider: EmailProvider;

	@ApiProperty({ example: "Gmail" })
	label: string;

	@ApiProperty({ example: "maya.rahman@gmail.com" })
	emailAddress: string;

	@ApiProperty({ enum: ConnectionStatus })
	status: ConnectionStatus;

	@ApiProperty({ description: "Replies can be sent from this mailbox. False for IMAP (read-only)." })
	canSend: boolean;

	@ApiProperty({ description: "Only housing emails are synced (your connector settings scope is housing)." })
	housingOnly: boolean;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	lastSyncAt: Date | null;

	@ApiProperty({ type: String, nullable: true })
	lastError: string | null;

	@ApiProperty({ description: "Housing emails stored from this mailbox." })
	emailCount: number;

	@ApiProperty({ description: "Distinct senders and recipients matched." })
	contactCount: number;

	@ApiProperty({ type: [MatchedContactDto] })
	matchedContacts: MatchedContactDto[];
}

export class ConnectorSettingsDto {
	@ApiProperty({ enum: ["housing"], description: "Connected mailboxes only ever import housing-related emails." })
	scope: "housing";

	@ApiProperty({ description: "File leases, certificates and bills found in attachments automatically." })
	autoFileAttachments: boolean;

	@ApiProperty({ description: "Students: add landlord and character references found in emails to the Seek Passport." })
	addReferencesToProfile: boolean;

	@ApiProperty({ description: "Read utility bills from emails so they can be split." })
	readUtilityBills: boolean;

	@ApiProperty({ description: "File signed tenancy agreements in the tenancy, where every tenant sees them." })
	copySignedContracts: boolean;

	@ApiProperty({ description: "Let Seek AI suggest replies in the inbox (the user always presses send)." })
	aiDraftReplies: boolean;
}

export class UpdateConnectorSettingsDto {
	@ApiPropertyOptional({ enum: ["housing"] })
	@IsOptional()
	@IsIn(["housing"])
	scope?: "housing";

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	autoFileAttachments?: boolean;

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	addReferencesToProfile?: boolean;

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	readUtilityBills?: boolean;

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	copySignedContracts?: boolean;

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	aiDraftReplies?: boolean;
}

export class ConnectImapDto {
	@ApiProperty({ example: "imap.mail.me.com" })
	@IsString()
	@MaxLength(255)
	@Matches(/^[A-Za-z0-9.-]+$/, { message: "host must be a host name, like imap.example.com." })
	host: string;

	@ApiProperty({ example: 993, description: "IMAP over TLS port (usually 993)." })
	@IsInt()
	@Min(1)
	@Max(65535)
	port: number;

	@ApiProperty({ example: "maya.rahman@icloud.com", description: "Usually your email address." })
	@IsString()
	@MaxLength(320)
	@Matches(/^[^\r\n"]+$/, { message: "username has invalid characters." })
	username: string;

	@ApiProperty({ description: "An app password from your email provider, not your normal password. Stored encrypted." })
	@IsString()
	@MaxLength(256)
	@Matches(/^[^\r\n]+$/, { message: "appPassword has invalid characters." })
	appPassword: string;
}

export class ConnectorsOverviewDto {
	@ApiProperty({ type: [ProviderAvailabilityDto] })
	providers: ProviderAvailabilityDto[];

	@ApiProperty({ type: ConnectorSettingsDto })
	settings: ConnectorSettingsDto;

	@ApiProperty({ type: [EmailConnectionViewDto] })
	connections: EmailConnectionViewDto[];
}

export class AuthUrlQueryDto {
	@ApiPropertyOptional({ enum: ["web", "mobile"], default: "web", description: "Where to send the user back after consent." })
	@IsOptional()
	@IsIn(["web", "mobile"])
	client?: "web" | "mobile";

	@ApiPropertyOptional({ example: "/connectors", description: "Web path to return to (must start with /)." })
	@IsOptional()
	@IsString()
	@MaxLength(200)
	returnTo?: string;
}

export class ConfirmConnectorDto {
	@ApiProperty({ description: "The nonce from the seekapp://connectors?status=pending redirect." })
	@IsString()
	@Matches(/^[A-Za-z0-9_-]{43}$/)
	nonce: string;
}

export class AuthUrlDto {
	@ApiProperty({ enum: [EmailProvider.GMAIL, EmailProvider.OUTLOOK] })
	provider: EmailProvider;

	@ApiProperty({ description: "Open this URL to grant read and send access to the mailbox." })
	url: string;
}

export class SyncResultDto {
	@ApiProperty({ description: "Emails looked at." })
	scanned: number;

	@ApiProperty({ description: "Housing emails stored." })
	imported: number;

	@ApiProperty({ description: "Emails dropped because they are not about housing." })
	skipped: number;

	@ApiProperty({ description: "Attachments filed into tenancy documents or bills." })
	filed: number;

	@ApiProperty({ type: EmailConnectionViewDto })
	connection: EmailConnectionViewDto;
}

export class ImapConnectResultDto extends SyncResultDto {
	@ApiProperty({
		enum: ["imap", "demo"],
		description: "demo: the IMAP sign-in failed outside production, so the demo mailbox was connected instead."
	})
	mode: "imap" | "demo";

	@ApiPropertyOptional({ description: "Why the demo mailbox was used." })
	notice?: string;
}

export class DisconnectResultDto {
	@ApiProperty()
	id: string;

	@ApiProperty({ enum: [ConnectionStatus.DISCONNECTED] })
	status: ConnectionStatus;

	@ApiProperty({ description: "Stored emails deleted with the connection." })
	removedEmails: number;
}
