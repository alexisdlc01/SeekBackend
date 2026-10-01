import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";
import { UsersModule } from "./users/users.module";
import { AuthModule } from "./auth/auth.module";
import { SharedModule } from "./shared/shared.module";
import { UploadModule } from "./upload/upload.module";
import { ListingsModule } from "./listings/listing.module";
import { ConversationModule } from "./conversation/conversation.module";
import { MessageModule } from "./message/message.module";
import { EventsModule } from "./events/events.module";
import { ContactModule } from "./contact/contact.module";
import { ApplicationModule } from "./application/application.module";
import { RedisModule } from "./redis/redis.module";
import { FlagsModule } from './flags/flags.module';
import * as morgan from "morgan";
import { APP_GUARD } from "@nestjs/core";
import { BrowserOriginGuard } from "./auth/guards/browser-origin.guard";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		// One place owns rate limiting. Both throttlers carry a permissive
		// baseline that applies to every route; auth endpoints tighten the
		// "auth" bucket with @Throttle. Note ttl is milliseconds in v6.
		ThrottlerModule.forRoot({
			throttlers: [
				{ name: "default", ttl: 60_000, limit: 120 },
				{ name: "auth", ttl: 60_000, limit: 120 }
			]
		}),
		MongooseModule.forRootAsync({
			useFactory: (config: ConfigService) => ({
				uri: config.getOrThrow("MONGODB_URI")
			}),
			inject: [ConfigService]
		}),
		UsersModule,
		AuthModule,
		SharedModule,
		UploadModule,
		ListingsModule,
		ConversationModule,
		MessageModule,
		EventsModule,
		ContactModule,
		ApplicationModule,
		RedisModule,
		FlagsModule
	],
	controllers: [AppController],
	providers: [
		AppService,
		{
			provide: APP_GUARD,
			useClass: ThrottlerGuard
		},
		{
			provide: APP_GUARD,
			useClass: BrowserOriginGuard
		}
	]
})
export class AppModule implements NestModule {
	configure(consumer: MiddlewareConsumer) {
		const morganFormat = process.env.MORGAN_FORMAT || "dev";
		if (process.env.NODE_ENV === "development") {
			consumer.apply(morgan(morganFormat)).forRoutes("*");
		}
	}
}
