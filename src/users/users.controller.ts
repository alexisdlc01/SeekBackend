import {
	Body,
	Controller,
	Get,
	Param,
	Post,
	Put,
	UseGuards
} from "@nestjs/common";
import { CreateUserDto } from "./dto/create-user.dto";
import { UsersService } from "./users.service";
import { Serialize } from "../interceptors/serialize.interceptor";
import { UserDto } from "./dto/user.dto";
import { Superuser } from "../auth/decorators/role-auth.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "./users.schema";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SetProfilePicDto } from "./dto/set-profile-pic.dto";
import { SetUsernameDto } from "./dto/set-username.dto";
import {
	ApiCreateUserDocs,
	ApiGetAllUsersDocs,
	ApiGetUserDocs,
	ApiSetProfilePicDocs,
	ApiSetUsernameDocs
} from "./swagger/users-swagger.decorator";

@Controller("users")
@Serialize(UserDto)
export class UsersController {
	constructor(private readonly usersService: UsersService) {}

	@Get(":id")
	@Superuser()
	@ApiGetUserDocs()
	async getUser(@Param("id") id: string) {
		return await this.usersService.getUser({ _id: id });
	}

	@Post()
	@ApiCreateUserDocs()
	async create(@Body() body: CreateUserDto) {
		await this.usersService.create(body);
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

	@Get()
	@Superuser()
	@ApiGetAllUsersDocs()
	async getAllUsers() {
		return this.usersService.getAllUsers();
	}
}
