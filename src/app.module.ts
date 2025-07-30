import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";
import { UsersModule } from "./users/users.module";
import { AuthModule } from "./auth/auth.module";
import { SharedModule } from "./shared/shared.module";
import { UploadModule } from './upload/upload.module';
import * as morgan from "morgan";

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		MongooseModule.forRootAsync({
			useFactory: (config: ConfigService) => ({
				uri: config.getOrThrow("MONGODB_URI")
			}),
			inject: [ConfigService]
		}),
		UsersModule,
		AuthModule,
		SharedModule,
		UploadModule
	],
	controllers: [AppController],
	providers: [AppService]
})
export class AppModule implements NestModule {
	configure(consumer: MiddlewareConsumer) {
		const morganFormat = process.env.MORGAN_FORMAT || "dev";
		if (process.env.NODE_ENV === "development") {
			consumer.apply(morgan(morganFormat)).forRoutes("*");
		}
	}
}
