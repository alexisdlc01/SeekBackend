import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import { Role } from "../auth/role.enum";
import { Listing } from "../listings/listings.schema";
import { DocumentType } from "./types/document-type";

@Schema({ _id: false })
export class UserDocument {
	@Prop({ enum: DocumentType, required: true })
	type: DocumentType;

	@Prop({ required: true })
	url: string;
}

export const UserDocumentSchema = SchemaFactory.createForClass(UserDocument);

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
	lastSeen?: Date;

	@Prop()
	emailVerificationToken?: string;

	@Prop()
	otpVerificationCode?: string;

	@Prop()
	emailVerificationTokenExpires?: Date;

	@Prop({ default: false })
	isGoogle: boolean;

	@Prop()
	resetPasswordToken?: string;

	@Prop()
	resetPasswordExpires?: Date;

	@Prop({ type: [UserDocumentSchema], default: [] })
	documents: UserDocument[];
}

export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.virtual("listings", {
	ref: Listing.name,
	localField: "_id",
	foreignField: "landlord",
	justOne: false
});

UserSchema.virtual("applications", {
	ref: "Application",
	localField: "_id",
	foreignField: "applicants",
	justOne: false
});
