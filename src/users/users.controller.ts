import {
	Body,
	Controller,
	Get,
	Param,
	Post,
	Put,
	Query,
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

@Controller("users")
@Serialize(UserDto)
export class UsersController {
	constructor(private readonly usersService: UsersService) {}

	@Get(":id")
	@Superuser()
	async getUser(@Param("id") id: string) {
		return await this.usersService.getUser({ _id: id });
	}

	@Post()
	async create(@Body() body: CreateUserDto) {
		await this.usersService.create(body);
	}

	@Put("setProfilePic")
	@UseGuards(JwtAuthGuard)
	async setProfilePic(
		@Body() body: { url: string },
		@CurrentUser() user: User
	) {
		return await this.usersService.setProfilePic(body.url, user);
	}

	@Put("setUsername")
	@UseGuards(JwtAuthGuard)
	async setUsername(
		@Body() body: { name: string },
		@CurrentUser() user: User
	) {
		return await this.usersService.setUsername(body.name, user);
	}

	@Get()
	@Superuser()
	async getAllUsers() {
		return this.usersService.getAllUsers();
	}
}
