import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";

export enum EmailProvider {
	GMAIL = "GMAIL",
	OUTLOOK = "OUTLOOK",
	/** Sample housing mailbox for local development. Never available in production. */
	DEMO = "DEMO",
	/** Any IMAP mailbox signed in with an app password (stored encrypted in accessTokenEnc). */
	IMAP = "IMAP"
}

export enum ConnectionStatus {
	CONNECTED = "CONNECTED",
	ERROR = "ERROR",
	DISCONNECTED = "DISCONNECTED"
}

/**
 * A mailbox a student or landlord connected. OAuth tokens are stored
 * encrypted (AES-256-GCM, see token-crypto.ts) and never leave the server.
 */
@Schema({ timestamps: true })
export class EmailConnection {
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@Prop({ type: SchemaTypes.ObjectId, ref: "User", required: true, index: true })
	user: Types.ObjectId;

	@Prop({ enum: EmailProvider, required: true })
	provider: EmailProvider;

	@Prop({ required: true, trim: true, lowercase: true })
	emailAddress: string;

	@Prop({ enum: ConnectionStatus, default: ConnectionStatus.CONNECTED })
	status: ConnectionStatus;

	/** Legacy copy of the owner's read scope; sync reads User.connectorSettings. */
	@Prop({ default: true })
	housingOnly: boolean;

	/** IMAP server (provider IMAP only). The app password is sealed in accessTokenEnc. */
	@Prop({ type: String, default: null })
	imapHost: string | null;

	@Prop({ type: Number, default: null })
	imapPort: number | null;

	@Prop({ type: String, default: null })
	imapUsername: string | null;

	@Prop({ type: String, default: null })
	accessTokenEnc: string | null;

	@Prop({ type: String, default: null })
	refreshTokenEnc: string | null;

	@Prop({ type: Date, default: null })
	expiresAt: Date | null;

	@Prop({ type: Date, default: null })
	lastSyncAt: Date | null;

	@Prop({ type: String, default: null })
	lastError: string | null;

	/** ERROR only: when background sync tries again. Null for errors that need the user to reconnect. */
	@Prop({ type: Date, default: null })
	retryAt: Date | null;

	createdAt?: Date;
	updatedAt?: Date;
}

export const EmailConnectionSchema = SchemaFactory.createForClass(EmailConnection);

EmailConnectionSchema.index({ user: 1, provider: 1, emailAddress: 1 }, { unique: true });
EmailConnectionSchema.index({ emailAddress: 1 });
