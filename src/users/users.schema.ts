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

	@Prop({ required: false })
	key: string;
}

export const UserDocumentSchema = SchemaFactory.createForClass(UserDocument);

@Schema({ _id: false })
export class RefreshSession {
	@Prop({ required: true })
	sessionId: string;

	@Prop({ required: true })
	tokenHash: string;

	@Prop({ required: true })
	expiresAt: Date;

	@Prop({ default: Date.now })
	createdAt: Date;

	@Prop({ default: Date.now })
	lastUsedAt: Date;
}

export const RefreshSessionSchema = SchemaFactory.createForClass(RefreshSession);

@Schema({ timestamps: true })
export class User {
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@Prop({ unique: true, required: true, trim: true, lowercase: true })
	email: string;

	@Prop()
	name: string;

	@Prop({ unique: true, sparse: true, trim: true, lowercase: true })
	username?: string;

	@Prop({ trim: true })
	phone?: string;

	@Prop()
	dateOfBirth?: Date;

	@Prop({ trim: true })
	universityDetails?: string;

	@Prop()
	profilePicUrl?: string;

	@Prop({ type: [RefreshSessionSchema], default: [] })
	refreshSessions: RefreshSession[];

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

	@Prop({ default: 0 })
	emailVerificationAttempts: number;

	@Prop()
	emailVerificationLastSentAt?: Date;

	@Prop()
	emailVerificationWindowStartedAt?: Date;

	@Prop({ default: 0 })
	emailVerificationSendCount: number;

	@Prop({ default: false })
	isGoogle: boolean;

	@Prop()
	resetPasswordToken?: string;

	@Prop()
	resetPasswordExpires?: Date;

	@Prop()
	resetPasswordLastSentAt?: Date;

	@Prop()
	resetPasswordWindowStartedAt?: Date;

	@Prop({ default: 0 })
	resetPasswordSendCount: number;

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
