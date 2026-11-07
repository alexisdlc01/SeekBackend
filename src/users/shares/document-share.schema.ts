import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";

/** How long a landlord can open an applicant's documents after they apply. */
export const SHARE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * A time-limited grant letting one landlord open one student's Seek Passport
 * files for one application. Created when the application is sent; the
 * student can revoke it at any time.
 */
@Schema({ timestamps: true })
export class DocumentShare {
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@Prop({ type: SchemaTypes.ObjectId, ref: "User", required: true, index: true })
	owner: Types.ObjectId;

	@Prop({ type: SchemaTypes.ObjectId, ref: "User", required: true, index: true })
	viewer: Types.ObjectId;

	@Prop({ type: SchemaTypes.ObjectId, ref: "Listing" })
	listing?: Types.ObjectId;

	@Prop({ type: SchemaTypes.ObjectId, ref: "Application" })
	application?: Types.ObjectId;

	@Prop({ required: true })
	expiresAt: Date;

	@Prop({ type: Date, default: null })
	revokedAt?: Date | null;

	createdAt?: Date;
}

export const DocumentShareSchema = SchemaFactory.createForClass(DocumentShare);

DocumentShareSchema.index(
	{ owner: 1, application: 1 },
	{ unique: true, partialFilterExpression: { application: { $exists: true } } }
);
DocumentShareSchema.index({ viewer: 1, owner: 1, expiresAt: 1 });
