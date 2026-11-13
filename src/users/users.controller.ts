import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	ParseEnumPipe,
	Param,
	Patch,
	Post,
	Put,
	UseGuards
} from "@nestjs/common";
import { CreateUserDto } from "./dto/create-user.dto";
import UsersService from "./users.service";
import { LandlordAgency, Student, Superuser } from "../auth/decorators/role-auth.decorator";
import { ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { AccountService } from "./account.service";
import { DeleteAccountResultDto, InviteTeamMemberDto, TeamInviteDto, TeamMemberDto } from "./dto/team.dto";
import { ErrorDto } from "../dto/errorDto.dto";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "./users.schema";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SetProfilePicDto } from "./dto/set-profile-pic.dto";
import { SetUsernameDto } from "./dto/set-username.dto";
import {
	ApiAddDocumentDocs,
	ApiGetPassportDocs,
	ApiListSharesDocs,
	ApiRevokeShareDocs,
	ApiSetDocumentStatusDocs,
	ApiCreateUserDocs,
	ApiGetAllUsersDocs,
	ApiGetDocumentTypes,
	ApiGetUserDocs,
	ApiListPendingDocumentsDocs,
	ApiSetProfilePicDocs,
	ApiSetUsernameDocs,
	ApiUpdateCurrentUserDocs
} from "./swagger/users-swagger.decorator";
import { AddDocumentDto } from "./dto/add-document.dto";
import { UpdateUserProfileDto } from "./dto/update-user-profile.dto";
import { DocumentSharesService } from "./shares/document-shares.service";
import { ParseObjectIdPipe } from "../shared/parse-object-id.pipe";
import { UpdateDocumentStatusDto } from "./dto/update-document-status.dto";
import { DocumentType } from "./types/document-type";
import { Throttle } from "@nestjs/throttler";
import { StudentVerificationService } from "./student-verification.service";
import { StudentEmailCodeDto, StudentEmailDto, StudentVerificationResultDto } from "./dto/student-verification.dto";
import { PassportDto, RequestReferenceDto } from "./dto/passport.dto";


@Controller("users")
export class UsersController {
	constructor(
		private readonly usersService: UsersService,
		private readonly sharesService: DocumentSharesService,
		private readonly accountService: AccountService,
		private readonly studentVerification: StudentVerificationService
	) { }

	@Post("me/student-email")
	@Student()
	@HttpCode(204)
	@Throttle({ auth: { limit: 5, ttl: 60 * 60_000, blockDuration: 60_000 } })
	@ApiOperation({ summary: "Send a 6-digit code to your university email (valid 15 minutes) to get the verified student badge." })
	@ApiNoContentResponse({ description: "Code sent." })
	@ApiResponse({ status: 400, type: ErrorDto, description: "Not an accepted university domain (only @st-andrews.ac.uk for now)." })
	async sendStudentEmailCode(@Body() body: StudentEmailDto, @CurrentUser() user: User) {
		await this.studentVerification.sendCode(user._id, body.email);
	}

	@Post("me/student-email/verify")
	@Student()
	@HttpCode(200)
	@Throttle({ auth: { limit: 10, ttl: 60_000, blockDuration: 60_000 } })
	@ApiOperation({ summary: "Check the code. 5 wrong tries and you need a new code." })
	@ApiOkResponse({ type: StudentVerificationResultDto })
	@ApiResponse({ status: 400, type: ErrorDto, description: "Wrong, expired or used-up code, or an address that can't be verified on this account." })
	async verifyStudentEmail(@Body() body: StudentEmailCodeDto, @CurrentUser() user: User): Promise<StudentVerificationResultDto> {
		return this.studentVerification.verify(user._id, body.code);
	}

	@Delete("me")
	@UseGuards(JwtAuthGuard)
	@ApiOperation({ summary: "Delete your account (soft delete: you are signed out everywhere and cannot sign in again)." })
	@ApiResponse({ status: 200, type: DeleteAccountResultDto })
	@ApiResponse({ status: 409, type: ErrorDto, description: "An active tenancy still has rent to pay or collect." })
	async deleteMe(@CurrentUser() user: User) {
		return this.accountService.deleteAccount(user._id);
	}

	@Get("me/team")
	@LandlordAgency()
	@ApiOperation({ summary: "People you invited to help run your account. They never see payouts." })
	@ApiResponse({ status: 200, type: [TeamMemberDto] })
	async listTeam(@CurrentUser() user: User) {
		return this.accountService.listTeam(user._id);
	}

	@Post("me/team/invite")
	@LandlordAgency()
	@ApiOperation({ summary: "Invite someone by email with the scopes they may help with (e.g. VIEWINGS_INBOX). No payouts scope exists." })
	@ApiResponse({ status: 201, type: TeamMemberDto })
	@ApiResponse({ status: 400, type: ErrorDto })
	async inviteTeamMember(@Body() body: InviteTeamMemberDto, @CurrentUser() user: User) {
		return this.accountService.invite(user, body);
	}

	@Get("me/team-invites")
	@LandlordAgency()
	@ApiOperation({ summary: "Team invites waiting for you (sent to your verified email). Nothing applies until you accept." })
	@ApiOkResponse({ type: [TeamInviteDto] })
	async listTeamInvites(@CurrentUser() user: User) {
		return this.accountService.listInvites(user);
	}

	@Post("me/team-invites/:ownerId/accept")
	@LandlordAgency()
	@HttpCode(204)
	@ApiOperation({ summary: "Join the team of the landlord who invited you. You then act for them within the invited scopes." })
	@ApiNoContentResponse({ description: "You joined the team." })
	@ApiResponse({ status: 403, type: ErrorDto, description: "Your email is not verified." })
	@ApiResponse({ status: 404, type: ErrorDto, description: "No pending invite from this landlord for your email." })
	@ApiResponse({ status: 409, type: ErrorDto, description: "You are already on a team." })
	async acceptTeamInvite(@Param("ownerId", ParseObjectIdPipe) ownerId: string, @CurrentUser() user: User) {
		await this.accountService.acceptInvite(user, ownerId);
	}

	@Post("me/team/leave")
	@LandlordAgency()
	@HttpCode(204)
	@ApiOperation({ summary: "Leave the team you joined. You act as yourself again." })
	@ApiNoContentResponse({ description: "You left the team." })
	@ApiResponse({ status: 404, type: ErrorDto, description: "You are not on a team." })
	async leaveTeam(@CurrentUser() user: User) {
		await this.accountService.leaveTeam(user._id);
	}

	@Delete("me/team/:id")
	@LandlordAgency()
	@HttpCode(204)
	@ApiOperation({ summary: "Remove someone from your team." })
	@ApiResponse({ status: 404, type: ErrorDto })
	async removeTeamMember(@Param("id", ParseObjectIdPipe) id: string, @CurrentUser() user: User) {
		await this.accountService.removeTeamMember(user._id, id);
	}

	@Get("document-types")
	@Student()
	@ApiGetDocumentTypes()
	async documentTypes(@CurrentUser() user: User) {
		return await this.usersService.documentTypes(user);
	}

	@Post()
	@Superuser()
	@ApiCreateUserDocs()
	async create(@Body() body: CreateUserDto) {
		return this.usersService.create(body);
	}

	@Put("setProfilePic")
	@UseGuards(JwtAuthGuard)
	@ApiSetProfilePicDocs()
	async setProfilePic(
		@Body() body: SetProfilePicDto,
		@CurrentUser() user: User
	) {
		return await this.usersService.setProfilePic(body.url, user);
	}

	@Put("setUsername")
	@UseGuards(JwtAuthGuard)
	@ApiSetUsernameDocs()
	async setUsername(@Body() body: SetUsernameDto, @CurrentUser() user: User) {
		return await this.usersService.setUsername(body.name, user);
	}

	@Patch("me")
	@UseGuards(JwtAuthGuard)
	@ApiUpdateCurrentUserDocs()
	async updateCurrentUser(
		@Body() body: UpdateUserProfileDto,
		@CurrentUser() user: User
	) {
		return await this.usersService.updateProfile(
			user._id.toString(),
			body,
			user.role
		);
	}

	@Post("me/passport/references")
	@Student()
	@HttpCode(200)
	@Throttle({ auth: { limit: 10, ttl: 60 * 60_000, blockDuration: 60_000 } })
	@ApiOperation({ summary: "Invite a UK guarantor or ask a previous landlord, letting agent or academic for a reference. Seek emails them (replies go to you; a connected inbox files a reference into your passport) and the passport row reads PENDING with source \"request\" until a document arrives. Asking again for the same type replaces the request." })
	@ApiOkResponse({ type: PassportDto })
	@ApiResponse({ status: 400, type: ErrorDto, description: "Invalid type, name or email, or your own address." })
	@ApiResponse({ status: 503, type: ErrorDto, description: "The email could not be sent; nothing was saved." })
	async requestReference(@Body() body: RequestReferenceDto, @CurrentUser() user: User): Promise<PassportDto> {
		return this.usersService.requestReference(user, body);
	}

	@Get("me/passport")
	@Student()
	@ApiGetPassportDocs()
	async getPassport(@CurrentUser() user: User) {
		return await this.usersService.getPassport(user._id.toString());
	}

	@Get("me/shares")
	@Student()
	@ApiListSharesDocs()
	async listShares(@CurrentUser() user: User) {
		return await this.sharesService.listForOwner(user._id.toString());
	}

	@Delete("me/shares/:id")
	@Student()
	@HttpCode(204)
	@ApiRevokeShareDocs()
	async revokeShare(
		@Param("id", ParseObjectIdPipe) id: string,
		@CurrentUser() user: User
	) {
		await this.sharesService.revoke(user._id.toString(), id);
	}

	// Declared before every ":id" route so "documents" is never read as an id.
	@Get("documents/pending")
	@Superuser()
	@ApiListPendingDocumentsDocs()
	async listPendingDocuments() {
		return this.usersService.listPendingDocuments();
	}

	@Patch(":id/documents/:type/status")
	@Superuser()
	@ApiSetDocumentStatusDocs()
	async setDocumentStatus(
		@Param("id", ParseObjectIdPipe) id: string,
		@Param("type", new ParseEnumPipe(DocumentType)) type: DocumentType,
		@Body() body: UpdateDocumentStatusDto
	) {
		return await this.usersService.setDocumentStatus(id, type, body.status);
	}

	@Get()
	@Superuser()
	@ApiGetAllUsersDocs()
	async getAllUsers() {
		return this.usersService.getAllUsers();
	}

	@Post("addDocument")
	@Student()
	@ApiAddDocumentDocs()
	async addDocument(@Body() body: AddDocumentDto, @CurrentUser() user: User) {
		await this.usersService.addDocument(
			user._id.toString(),
			body.documentType,
			body.url,
			body.key,
			{ label: body.label, expiresAt: body.expiresAt }
		);
	}

	@Get(":id")
	@Superuser()
	@ApiGetUserDocs()
	async getUser(@Param("id") id: string) {
		return await this.usersService.getUserById(id);
	}
}
