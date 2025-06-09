import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";
import { UsersModule } from './users/users.module';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		MongooseModule.forRootAsync({
			useFactory: (config: ConfigService) => ({
				uri: config.getOrThrow("MONGODB_URI")
			}),
			inject: [ConfigService]
		}),
		UsersModule
	],
	controllers: [AppController],
	providers: [AppService]
})
export class AppModule {}
