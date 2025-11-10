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
import { SetProfilePicDto } from "./dto/set-profile-pic.dto";
import { SetUsernameDto } from "./dto/set-username.dto";
import { ApiBody, ApiProperty, ApiResponse } from "@nestjs/swagger";
import { ErrorDto } from "../dto/errorDto.dto";

@Controller("users")
@Serialize(UserDto)
export class UsersController {
	constructor(private readonly usersService: UsersService) { }

	@Get(":id")
	@Superuser()
	@ApiResponse({
		status: 200,
		type: UserDto
	})
	@ApiResponse({
		status: 401,
		type: ErrorDto
	})
	@ApiResponse({
		status: 404,
		type: ErrorDto
	})
	async getUser(@Param("id") id: string) {
		return await this.usersService.getUser({ _id: id });
	}

	@Post()
	@ApiBody({ type: CreateUserDto })
	@ApiResponse({
		status: 204,
		type: UserDto
	})
	@ApiResponse({
		status: 400,
		type: ErrorDto
	})
	async create(@Body() body: CreateUserDto) {
		await this.usersService.create(body);
	}

	@Put("setProfilePic")
	@UseGuards(JwtAuthGuard)
	@ApiBody({ type: SetProfilePicDto })
	@ApiResponse({
		status: 201,
		type: UserDto
	})
	@ApiResponse({
		status: 401,
		type: ErrorDto
	})
	@ApiResponse({
		status: 400,
		type: ErrorDto
	})
	@ApiResponse({
		status: 404,
		type: ErrorDto
	})
	async setProfilePic(
		@Body() body: SetProfilePicDto,
		@CurrentUser() user: User
	) {
		return await this.usersService.setProfilePic(body.url, user);
	}

	@Put("setUsername")
	@UseGuards(JwtAuthGuard)
	@ApiBody({ type: SetUsernameDto })
	@ApiResponse({
		status: 201,
		type: UserDto
	})
	@ApiResponse({
		status: 400,
		type: ErrorDto
	})
	@ApiResponse({
		status: 401,
		type: ErrorDto
	})
	@ApiResponse({
		status: 404,
		type: ErrorDto
	})
	async setUsername(@Body() body: SetUsernameDto, @CurrentUser() user: User) {
		return await this.usersService.setUsername(body.name, user);
	}

	@Get()
	@Superuser()
	@ApiResponse({
		status: 200,
		type: Array<UserDto>
	})
	@ApiResponse({
		status: 401,
		type: ErrorDto
	})
	async getAllUsers() {
		return this.usersService.getAllUsers();
	}
}
