import { Module } from "@nestjs/common";
import { ContactController } from "./contact.controller";
import { ContactService } from "./contact.service";
import { AuthModule } from "../auth/auth.module";

@Module({
	controllers: [ContactController],
	providers: [ContactService],
	imports: [AuthModule]
})
export class ContactModule {}
