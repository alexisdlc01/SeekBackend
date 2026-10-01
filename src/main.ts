import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestExpressApplication } from "@nestjs/platform-express";
import * as cookieParser from "cookie-parser";
import helmet from "helmet";
import { json, urlencoded } from "express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
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
		origin: allowedOrigins(config),
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
	app.use(json({ limit: "100kb" }));
	app.use(urlencoded({ extended: true, limit: "100kb" }));

	// The generated document is an exact map of every route, parameter and role
	// requirement, so it stays off the public surface in production.
	if (!isProduction) {
		setupSwagger(app);
	}

	await app.listen(process.env.PORT ?? 3000, "0.0.0.0");
}

function setupSwagger(app: INestApplication) {
	const config = new DocumentBuilder()
		.setTitle("My API")
		.setDescription("API documentation for my NestJS app")
		.setVersion("1.0")
		.addCookieAuth("access_token", {
			type: "apiKey",
			in: "cookie",
			description: "Access token for web clients"
		})
		.addBearerAuth(
			{
				type: "http",
				scheme: "bearer",
				bearerFormat: "JWT",
				description: "Access token for mobile clients."
			},
			"mobile-token"
		)
		.build();

	const document = SwaggerModule.createDocument(app, config);
	document.paths = Object.entries(document.paths).reduce(
		(acc, [path, methods]) => {
			acc[path] = Object.entries(methods).reduce(
				(methodAcc, [method, details]) => {
					methodAcc[method] = {
						...details,
						security: details.security ?? [
							{ access_token: [] },
							{ "mobile-token": [] }
						]
					};
					return methodAcc;
				},
				{}
			);
			return acc;
		},
		{}
	);
	SwaggerModule.setup("/docs", app, document);
}

bootstrap();
