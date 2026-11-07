import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { ApiProperty } from "@nestjs/swagger";
import { SchemaTypes, Types } from "mongoose";

/** A reusable agreement the landlord uploads once and attaches to many tenancies. */
@Schema({ timestamps: true })
export class ContractTemplate {
	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, ref: "User", required: true, index: true })
	landlord: Types.ObjectId;

	@ApiProperty()
	@Prop({ required: true, trim: true })
	title: string;

	@ApiProperty()
	@Prop({ required: true })
	url: string;

	@ApiProperty({ required: false, description: "Private upload key from /upload/presign." })
	@Prop()
	key?: string;

	@ApiProperty({ type: String, format: "date-time" })
	createdAt?: Date;
}

export const ContractTemplateSchema = SchemaFactory.createForClass(ContractTemplate);
