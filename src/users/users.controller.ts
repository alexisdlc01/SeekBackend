import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { CreateUserDto } from "./dto/create-user.dto";
import { UsersService } from "./users.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { Serialize } from "../interceptors/serialize.interceptor";
import { UserDto } from "./dto/user.dto";
import { Roles } from "../auth/decorators/role.decorator";
import { Role } from "../auth/role.enum";
import { RoleGuard } from "../auth/guards/role.guard";

@Controller("users")
@Serialize(UserDto)
export class UsersController {
	constructor(private readonly usersService: UsersService) {}

	@Post()
	async create(@Body() body: CreateUserDto) {
		await this.usersService.create(body);
	}

	@Get()
	@Roles(Role.SUPERUSER)
	@UseGuards(JwtAuthGuard, RoleGuard)
	async getAllUsers() {
		return this.usersService.getAllUsers();
	}
}
