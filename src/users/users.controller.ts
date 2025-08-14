import { Body, Controller, Get, Post } from "@nestjs/common";
import { CreateUserDto } from "./dto/create-user.dto";
import { UsersService } from "./users.service";
import { Serialize } from "../interceptors/serialize.interceptor";
import { UserDto } from "./dto/user.dto";
import { Superuser } from "../auth/decorators/role-auth.decorator";

@Controller("users")
@Serialize(UserDto)
export class UsersController {
	constructor(private readonly usersService: UsersService) {}

	@Post()
	async create(@Body() body: CreateUserDto) {
		await this.usersService.create(body);
	}

	@Get()
	@Superuser()
	async getAllUsers() {
		return this.usersService.getAllUsers();
	}
}
