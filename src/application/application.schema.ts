import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import { ApplicationStage } from "./enums/application-stage.enum";

@Schema()
export class Application {
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@Prop({ type: SchemaTypes.ObjectId, ref: "Listing" })
	listing: Types.ObjectId;

	@Prop({ type: SchemaTypes.ObjectId, ref: "Conversation" })
	conversation: Types.ObjectId;

	@Prop({ type: SchemaTypes.ObjectId, ref: "User" })
	landlord: Types.ObjectId;

	@Prop({ type: [{ type: SchemaTypes.ObjectId, ref: "User" }] })
	applicants: Types.ObjectId[];

	@Prop({ type: SchemaTypes.ObjectId })
	owner: Types.ObjectId;

	// New applications carry a stable key so concurrent/retried requests for the
	// same listing and owner resolve to one application. Sparse indexing keeps
	// existing records deployable while they are gradually reconciled.
	@Prop({ type: String })
	applicationKey?: string;

	// An invite is a capability: joining requires this secret, not merely the
	// application id, which is a route parameter and therefore not secret.
	// Stored as a digest and rotated whenever a new invite is shared.
	@Prop({ type: String })
	inviteTokenHash?: string;

	@Prop()
	inviteTokenExpires?: Date;

	@Prop({ default: Date.now, index: true })
	createdAt: Date;

	@Prop({ enum: ApplicationStage, default: ApplicationStage.NOT_SENT })
	stage: string;

	/** When the household sent the application to the landlord. */
	@Prop({ type: Date, default: null })
	sentAt?: Date | null;

	@Prop({ type: Date, default: null })
	viewingAt?: Date | null;

	/** When the landlord made an offer. */
	@Prop({ type: Date, default: null })
	offeredAt?: Date | null;

	/** The household must accept by this date: 15 days after the offer. */
	@Prop({ type: Date, default: null })
	offerExpiresAt?: Date | null;

	/** When this household's last offer lapsed unanswered; it then waits behind households that never had one. */
	@Prop({ type: Date, default: null })
	offerExpiredAt?: Date | null;

	/** Holding deposit per room in whole pounds, copied from the listing when the offer is made. */
	@Prop({ type: Number, default: null })
	holdingDeposit?: number | null;

	@Prop({ type: String, default: null })
	rejectReason?: string | null;
}

export const ApplicationSchema = SchemaFactory.createForClass(Application);

ApplicationSchema.index({ applicants: 1 });
ApplicationSchema.index({ applicationKey: 1 }, { unique: true, sparse: true });
