import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import { Role } from "../auth/role.enum";
import { Listing } from "../listings/listings.schema";
import { DocumentStatus, DocumentType } from "./types/document-type";
import { RegistrationKind, RegistrationStatus } from "./types/landlord-registration";
import { TeamScope } from "./types/team-scope";

@Schema({ _id: false })
export class UserDocument {
	@Prop({ enum: DocumentType, required: true })
	type: DocumentType;

	@Prop({ required: true })
	url: string;

	@Prop({ required: false })
	key: string;

	@Prop({ enum: DocumentStatus, default: DocumentStatus.PENDING })
	status: DocumentStatus;

	@Prop()
	label?: string;

	/** Why the automatic review rejected it, shown to the student. */
	@Prop()
	rejectionReason?: string;

	@Prop({ type: Date, default: null })
	expiresAt?: Date | null;

	@Prop({ default: Date.now })
	uploadedAt?: Date;

	/** Automatic review tries on this upload; after MAX_REVIEW_ATTEMPTS it is rejected with a fixed reason. */
	@Prop({ default: 0 })
	reviewAttempts?: number;

	@Prop({ type: Date, default: null })
	lastReviewAt?: Date | null;
}

export const UserDocumentSchema = SchemaFactory.createForClass(UserDocument);

/** A guarantor or referee Seek emailed for the student (POST /users/me/passport/references). */
@Schema({ _id: false })
export class ReferenceRequest {
	@Prop({ enum: DocumentType, required: true })
	type: DocumentType;

	@Prop({ required: true, trim: true })
	name: string;

	@Prop({ required: true, trim: true, lowercase: true })
	email: string;

	@Prop({ type: Date, required: true })
	requestedAt: Date;
}

export const ReferenceRequestSchema = SchemaFactory.createForClass(ReferenceRequest);

@Schema({ _id: false })
export class LandlordRegistration {
	@Prop({ enum: RegistrationKind, required: true })
	kind: RegistrationKind;

	@Prop({ required: true, trim: true })
	number: string;

	// Legacy: Seek does not check numbers against the registers, so this stays false; see status.
	@Prop({ default: false })
	verified: boolean;

	/** Format check only, set on every save: DECLARED (looks right) or INVALID_FORMAT. Never "verified". */
	@Prop({ enum: RegistrationStatus, default: RegistrationStatus.DECLARED })
	status: RegistrationStatus;
}

// shortcut: structural regexes, not register lookups; tighten a kind when its official format is confirmed.
const REGISTRATION_FORMATS: Partial<Record<RegistrationKind, RegExp>> = {
	// Landlord Registration Scotland, e.g. 123456/789/12345.
	[RegistrationKind.LANDLORD_REGISTRATION_SCOTLAND]: /^\d{5,6}\/\d{3}\/\d{5}$/,
	[RegistrationKind.OTHER]: /^.{2,60}$/
};
/** Council licences, Rent Smart Wales, NI, PRS database: letters/digits with separators and at least 3 digits. */
const GENERIC_FORMAT = /^(?=(?:\D*\d){3})[A-Z0-9][A-Z0-9 /._-]{2,59}$/i;

export function registrationStatus(kind: RegistrationKind, number: string): RegistrationStatus {
	const format = REGISTRATION_FORMATS[kind] ?? GENERIC_FORMAT;
	return format.test(number.trim()) ? RegistrationStatus.DECLARED : RegistrationStatus.INVALID_FORMAT;
}

/** Sets each registration's status in an update (users.service saves them with findByIdAndUpdate). */
export function withRegistrationStatus(update: { $set?: Record<string, unknown> } | null | undefined): void {
	const registrations = update?.$set?.registrations;
	if (!Array.isArray(registrations)) return;
	for (const registration of registrations as LandlordRegistration[]) {
		registration.status = registrationStatus(registration.kind, registration.number ?? "");
	}
}

export const LandlordRegistrationSchema =
	SchemaFactory.createForClass(LandlordRegistration);

@Schema({ _id: false })
export class NotificationPrefs {
	@Prop({ default: 3 })
	rentReminderDaysBefore: number;

	@Prop({ default: true })
	receiptEveryPayment: boolean;

	@Prop({ default: true })
	landlordEveryPayment: boolean;

	@Prop({ default: true })
	newQualifiedHousehold: boolean;

	@Prop({ default: true })
	complianceDue: boolean;

	@Prop({ default: false })
	weeklySummary: boolean;
}

export const NotificationPrefsSchema =
	SchemaFactory.createForClass(NotificationPrefs);

/** When Seek nudges this landlord's tenants about rent. */
@Schema({ _id: false })
export class RentReminderSchedule {
	@Prop({ default: true })
	beforeDue: boolean;

	@Prop({ default: true })
	onDueDay: boolean;

	@Prop({ default: true })
	lateAfterThreeDays: boolean;
}

export const RentReminderScheduleSchema =
	SchemaFactory.createForClass(RentReminderSchedule);

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

/** Someone a landlord invited to help run their account (never payouts). */
@Schema()
export class TeamMember {
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@Prop({ required: true, trim: true, lowercase: true })
	email: string;

	@Prop({ type: [String], enum: TeamScope, default: [] })
	scopes: TeamScope[];

	/** The invitee's Seek account, when one exists for the email. */
	@Prop({ type: SchemaTypes.ObjectId, ref: "User", default: null })
	user: Types.ObjectId | null;

	@Prop({ default: Date.now })
	invitedAt: Date;
}

export const TeamMemberSchema = SchemaFactory.createForClass(TeamMember);

/** What the connected mailboxes import (PATCH /connectors/settings). */
@Schema({ _id: false })
export class ConnectorSettings {
	/** Legacy: ignored. Connectors always import housing emails only. */
	@Prop({ default: true })
	housingOnly: boolean;

	/** File leases, certificates and bills found in attachments automatically. */
	@Prop({ default: true })
	autoFileAttachments: boolean;

	/** Students: add references found in emails to the Seek Passport. */
	@Prop({ default: true })
	addReferencesToProfile: boolean;

	/** Read utility bills from emails so they can be split. */
	@Prop({ default: true })
	readUtilityBills: boolean;

	/** File signed tenancy agreements in the tenancy. */
	@Prop({ default: true })
	copySignedContracts: boolean;

	/** Suggest replies in the inbox. */
	@Prop({ default: true })
	aiDraftReplies: boolean;
}

export const ConnectorSettingsSchema = SchemaFactory.createForClass(ConnectorSettings);

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

	/** University address the student proved with a code (POST /users/me/student-email/verify). */
	@Prop({ trim: true, lowercase: true, unique: true, sparse: true })
	universityEmail?: string;

	// select: true keeps the badge in every inclusive projection, e.g. the landlord's applicant populate.
	@Prop({ select: true })
	university?: string;

	@Prop({ type: Date, select: true })
	studentVerifiedAt?: Date;

	@Prop({ select: false })
	studentEmailPending?: string;

	@Prop({ select: false })
	studentEmailCodeHash?: string;

	@Prop({ type: Date, select: false })
	studentEmailCodeExpires?: Date;

	@Prop({ select: false, default: 0 })
	studentEmailAttempts?: number;

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

	/**
	 * A requested new address, held here until the owner proves control of it.
	 * It is never promoted to `email` without a matching confirmation token, so
	 * a verified account can only ever hold an address it has proven.
	 */
	@Prop({ trim: true, lowercase: true })
	pendingEmail?: string;

	@Prop()
	pendingEmailToken?: string;

	@Prop()
	pendingEmailExpires?: Date;

	@Prop()
	pendingEmailLastSentAt?: Date;

	@Prop()
	pendingEmailWindowStartedAt?: Date;

	@Prop({ default: 0 })
	pendingEmailSendCount: number;

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

	// Referee addresses stay private: only the passport owner reads them.
	@Prop({ type: [ReferenceRequestSchema], default: [], select: false })
	referenceRequests?: ReferenceRequest[];

	@Prop({ trim: true })
	companyName?: string;

	@Prop({ type: [LandlordRegistrationSchema], default: [] })
	registrations: LandlordRegistration[];

	@Prop({ type: NotificationPrefsSchema, default: () => ({}) })
	notificationPrefs: NotificationPrefs;

	@Prop({ type: RentReminderScheduleSchema, default: () => ({}) })
	rentReminderSchedule: RentReminderSchedule;

	@Prop({ type: ConnectorSettingsSchema, default: () => ({}) })
	connectorSettings: ConnectorSettings;

	@Prop({ type: [TeamMemberSchema], default: [] })
	team: TeamMember[];

	/** Set when reports suspend the account (FlagsService.suspend); JwtStrategy then answers 403. */
	@Prop({ type: Date, default: null })
	suspendedAt?: Date | null;

	@Prop()
	suspensionReason?: string;

	/** Set by DELETE /users/me. The email is replaced so the address can sign up again. */
	@Prop({ type: Date, default: null })
	deletedAt?: Date | null;

	// Stripe Connect account that receives rent payouts (landlords only).
	@Prop({ trim: true })
	stripeAccountId?: string;

	// Stripe customer that holds a tenant's saved card for autopay.
	@Prop({ trim: true })
	stripeCustomerId?: string;

	/** Bank account the landlord's payouts go to, refreshed from Stripe on connect status. */
	@Prop({ type: Object })
	payoutBank?: { last4: string | null; bankName: string | null; verified: boolean };
}

export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.index({ "team.user": 1 }, { sparse: true });

UserSchema.pre(["findOneAndUpdate", "updateOne"], function () {
	withRegistrationStatus(this.getUpdate() as { $set?: Record<string, unknown> });
});

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
