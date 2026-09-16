import {
	Body,
	Controller,
	Get,
	Param,
	Patch,
	Post,
	Put,
	UseGuards
} from "@nestjs/common";
import { CreateUserDto } from "./dto/create-user.dto";
import UsersService from "./users.service";
import { Student, Superuser } from "../auth/decorators/role-auth.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "./users.schema";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SetProfilePicDto } from "./dto/set-profile-pic.dto";
import { SetUsernameDto } from "./dto/set-username.dto";
import {
	ApiAddDocumentDocs,
	ApiCreateUserDocs,
	ApiGetAllUsersDocs,
	ApiGetDocumentTypes,
	ApiGetUserDocs,
	ApiSetProfilePicDocs,
	ApiSetUsernameDocs,
	ApiUpdateCurrentUserDocs
} from "./swagger/users-swagger.decorator";
import { AddDocumentDto } from "./dto/add-document.dto";
import { UpdateUserProfileDto } from "./dto/update-user-profile.dto";

@Controller("users")
export class UsersController {
	constructor(private readonly usersService: UsersService) { }

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
			body
		);
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
			body.key
		);
	}

	@Get(":id")
	@Superuser()
	@ApiGetUserDocs()
	async getUser(@Param("id") id: string) {
		return await this.usersService.getUserById(id);
	}
}
