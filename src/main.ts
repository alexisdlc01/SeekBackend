import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestExpressApplication } from "@nestjs/platform-express";
import * as cookieParser from "cookie-parser";
import helmet from "helmet";
import { json, urlencoded } from "express";
import { SwaggerModule } from "@nestjs/swagger";
import { buildSwaggerDocument } from "./swagger";
import 'reflect-metadata';

/**
 * Allowed browser origins, as a parsed list. Read through ConfigService so a
 * missing value stops the process at boot rather than silently falling back to
 * the cors package's permissive default.
 */
function allowedOrigins(config: ConfigService): string[] {
	return config
		.getOrThrow<string>("FRONTEND_URL")
		.split(",")
		.map(value => value.trim().replace(/\/$/, ""))
		.filter(Boolean);
}

async function bootstrap() {
	const app = await NestFactory.create<NestExpressApplication>(AppModule);
	const config = app.get(ConfigService);
	const isProduction = config.get("NODE_ENV") === "production";

	app.use(helmet());
	// Express must know how many proxies sit in front of it, otherwise every
	// request appears to come from the load balancer and per-IP rate limiting
	// collapses into one shared bucket.
	app.set("trust proxy", Number(config.get("TRUSTED_PROXY_HOPS") ?? 1));

	app.enableCors({
		// Dev only: Expo web / Vite run on varying localhost ports.
		origin: isProduction ? allowedOrigins(config) : [...allowedOrigins(config), /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/],
		credentials: true
	});
	app.useGlobalPipes(new ValidationPipe({
		transform: true,
		whitelist: true,
		forbidNonWhitelisted: true
	}));
	app.use(cookieParser());
	// Uploads go straight to S3 via presigned URLs, so no request body here
	// needs to be large.
	// The exact bytes are kept for webhook signature checks (Stripe).
	app.use(json({
		limit: "100kb",
		verify: (req, _res, buf) => {
			(req as typeof req & { rawBody?: Buffer }).rawBody = buf;
		}
	}));
	app.use(urlencoded({ extended: true, limit: "100kb" }));

	// The generated document is an exact map of every route, parameter and role
	// requirement, so it stays off the public surface in production.
	if (!isProduction) {
		setupSwagger(app);
	}

	await app.listen(process.env.PORT ?? 3000, "0.0.0.0");
}

function setupSwagger(app: INestApplication) {
	SwaggerModule.setup("/docs", app, buildSwaggerDocument(app));
}

bootstrap();
