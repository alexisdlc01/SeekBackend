import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";

/**
 * Audit trail: one entry each time a landlord opens a student's shared
 * document, so the student can see who looked at what and when.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class DocumentAccess {
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@Prop({ type: SchemaTypes.ObjectId, ref: "User", required: true, index: true })
	owner: Types.ObjectId;

	@Prop({ type: SchemaTypes.ObjectId, ref: "User", required: true, index: true })
	viewer: Types.ObjectId;

	@Prop({ required: true })
	key: string;

	@Prop({ type: SchemaTypes.ObjectId, ref: "DocumentShare" })
	share?: Types.ObjectId;

	createdAt?: Date;
}

export const DocumentAccessSchema = SchemaFactory.createForClass(DocumentAccess);
