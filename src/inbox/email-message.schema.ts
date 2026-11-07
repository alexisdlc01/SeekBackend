import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import { EmailCategory } from "./email-category.enum";

@Schema({ _id: false })
export class EmailAttachment {
	@Prop({ required: true })
	name: string;

	/** Empty when the file could not be stored (it stays in the mailbox). */
	@Prop({ default: "" })
	url: string;

	@Prop({ type: String, default: null })
	key: string | null;

	@Prop({ type: String, default: null })
	mimeType: string | null;

	@Prop({ type: Number, default: null })
	size: number | null;

	/** Where Seek filed it, e.g. "My home › Documents". Null when not filed. */
	@Prop({ type: String, default: null })
	filedAs: string | null;
}

export const EmailAttachmentSchema = SchemaFactory.createForClass(EmailAttachment);

/**
 * A housing-related email copied from a connected mailbox. Each copy belongs
 * to one user: the same email in a landlord's and a tenant's mailbox is
 * stored twice, once per mailbox.
 */
@Schema({ timestamps: true })
export class EmailMessage {
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@Prop({ type: SchemaTypes.ObjectId, ref: "User", required: true, index: true })
	user: Types.ObjectId;

	@Prop({ type: SchemaTypes.ObjectId, ref: "EmailConnection", required: true })
	connection: Types.ObjectId;

	@Prop({ required: true })
	providerThreadId: string;

	@Prop({ required: true })
	providerMessageId: string;

	/** RFC 822 Message-ID, used for In-Reply-To when replying. */
	@Prop({ type: String, default: null })
	internetMessageId: string | null;

	/** Stable inbox thread id: hash of connection + provider thread. */
	@Prop({ required: true, index: true })
	threadKey: string;

	/** Sender address. */
	@Prop({ required: true, lowercase: true, trim: true })
	from: string;

	@Prop({ default: "" })
	fromName: string;

	@Prop({ type: [String], default: [] })
	to: string[];

	/** The other side of the conversation: sender, or first recipient when outgoing. */
	@Prop({ default: "", lowercase: true, trim: true })
	counterpartEmail: string;

	/** Display name for the other side (Seek contact, deposit scheme, supplier...). */
	@Prop({ default: "" })
	counterpartName: string;

	@Prop({ default: "" })
	subject: string;

	@Prop({ default: "" })
	snippet: string;

	@Prop({ default: "" })
	body: string;

	@Prop({ required: true, index: true })
	receivedAt: Date;

	@Prop({ enum: EmailCategory, default: EmailCategory.OTHER })
	category: EmailCategory;

	@Prop({ type: [EmailAttachmentSchema], default: [] })
	attachments: EmailAttachment[];

	@Prop({ type: SchemaTypes.ObjectId, ref: "Tenancy", default: null })
	tenancy: Types.ObjectId | null;

	/** Seek conversation this email is shown in, when it is with a Seek contact. */
	@Prop({ type: SchemaTypes.ObjectId, ref: "Conversation", default: null })
	conversation: Types.ObjectId | null;

	/** Sent from the user's own address. */
	@Prop({ default: false })
	outgoing: boolean;

	@Prop({ default: false })
	read: boolean;
}

export const EmailMessageSchema = SchemaFactory.createForClass(EmailMessage);

EmailMessageSchema.index({ connection: 1, providerMessageId: 1 }, { unique: true });
EmailMessageSchema.index({ user: 1, receivedAt: -1 });
EmailMessageSchema.index({ user: 1, conversation: 1 });
