import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";

@Schema()
export class User {
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@Prop({ unique: true })
	email: string;

	@Prop()
	refreshToken?: string;

	@Prop()
	password: string;

	@Prop({ default: true })
	isStudent: boolean;

	@Prop({ default: false })
	isLandlordOrAgency: boolean;

	@Prop({ default: false })
	isSuperUser: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);
