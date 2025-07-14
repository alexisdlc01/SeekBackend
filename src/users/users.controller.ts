import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { CreateUserDto } from "./dtos/create-user.dto";
import { UsersService } from "./users.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "./users.schema";
import { Serialize } from "../interceptors/serialize.interceptor";
import { UserDto } from "./dtos/user.dto";
import { Roles } from "../auth/decorators/role.decorator";
import { Role } from "../auth/role.enum";
import { RoleGuard } from "../auth/guards/role.guard";


@Controller("users")
@Serialize(UserDto)
export class UsersController {
	constructor(private readonly usersService: UsersService) {}

	@Post()
	async createUser(@Body() body: CreateUserDto) {
		await this.usersService.create(body);
	}

	@Get()
	@Roles(Role.SUPERUSER)
	@UseGuards(JwtAuthGuard, RoleGuard)
	async getUsers() {
		return this.usersService.getAllUsers();
	}
}
