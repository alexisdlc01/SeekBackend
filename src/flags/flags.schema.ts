import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import { FlagCategory } from "./enums/category";
import { FlagStatus } from "./enums/flag-status";
import { ApiProperty } from "@nestjs/swagger";

@Schema({ timestamps: true })
export class Flag {
	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@ApiProperty({ enum: FlagStatus })
	@Prop({
		enum: FlagStatus,
		required: true,
		default: FlagStatus.UNDER_REVIEW
	})
	status: string;

	@ApiProperty({ enum: FlagCategory })
	@Prop({ enum: FlagCategory })
	category: string;

	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, required: true, ref: "User" })
	reportedUser: Types.ObjectId;

	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, required: true, ref: "User" })
	createdBy: Types.ObjectId;

	@ApiProperty()
	@Prop({ required: true })
	text: string;

	@ApiProperty({ required: false })
	@Prop()
	resolutionDate: Date;
}

export const FlagSchema = SchemaFactory.createForClass(Flag);
