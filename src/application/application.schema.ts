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

	@Prop({ default: Date.now, index: true })
	createdAt: Date;

	@Prop({ enum: ApplicationStage, default: ApplicationStage.NOT_SENT })
	stage: string;
}

export const ApplicationSchema = SchemaFactory.createForClass(Application);

ApplicationSchema.index({ applicants: 1 });

