import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import { Role } from "../auth/role.enum";
import { Listing } from "../listings/listings.schema";

@Schema()
export class User {
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@Prop({ unique: true })
	email: string;

	@Prop()
	name: string;

	@Prop()
	profilePicUrl?: string;

	@Prop()
	refreshToken?: string;

	@Prop()
	password: string;

	@Prop({ enum: Role, default: Role.STUDENT })
	role: Role;

	@Prop({ default: false })
	isVerified: boolean;

	@Prop()
	emailVerificationToken?: string;

	@Prop()
	emailVerificationTokenExpires?: Date;

	@Prop({ default: false })
	isGoogle: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.virtual("listings", {
	ref: Listing.name,
	localField: "_id",
	foreignField: "landlord",
	justOne: false
});
