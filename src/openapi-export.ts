/**
 * Writes the full OpenAPI document to openapi.json at the repo root and copies
 * it to ../seek-web/openapi.json and ../seek-mobile/swagger.json for the client
 * generators. Runs without production secrets: any
 * variable missing from the environment and from .env gets a placeholder.
 * MongoDB and Redis may be running or not; nothing is read or written.
 *
 *   npm run openapi:export
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import "reflect-metadata";

const ROOT = resolve(__dirname, "..");

const PLACEHOLDERS: Record<string, string> = {
	NODE_ENV: "development",
	MONGODB_URI: "mongodb://127.0.0.1:27017/seek",
	REDIS_URL: "redis://127.0.0.1:6379",
	FRONTEND_URL: "http://localhost:5173",
	JWT_ACCESS_TOKEN_SECRET: "openapi-export-placeholder",
	JWT_REFRESH_TOKEN_SECRET: "openapi-export-placeholder",
	GOOGLE_CLIENT_ID: "openapi-export-placeholder",
	GOOGLE_CLIENT_SECRET: "openapi-export-placeholder",
	GOOGLE_CALLBACK_URL: "http://localhost:3000/auth/google/callback",
	MAILGUN_API_KEY: "openapi-export-placeholder",
	MAILGUN_DOMAIN: "example.com",
	AWS_S3_REGION: "eu-west-2",
	AWS_ACCESS_KEY_ID: "openapi-export-placeholder",
	AWS_SECRET_ACCESS_KEY: "openapi-export-placeholder",
	AWS_PUBLIC_BUCKET: "openapi-export-placeholder",
	AWS_PRIVATE_BUCKET: "openapi-export-placeholder"
};

/** Names set (non-empty) in .env. Values are never read into the output. */
function namesInDotEnv(): Set<string> {
	const file = resolve(ROOT, ".env");
	if (!existsSync(file)) return new Set();
	return new Set(
		readFileSync(file, "utf8")
			.split(/\r?\n/)
			.map(line => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S.*)?$/.exec(line))
			.filter((match): match is RegExpExecArray => Boolean(match?.[2]))
			.map(match => match[1])
	);
}

async function main() {
	const fromDotEnv = namesInDotEnv();
	for (const [name, value] of Object.entries(PLACEHOLDERS)) {
		if (!process.env[name] && !fromDotEnv.has(name)) process.env[name] = value;
	}

	// Loaded after the placeholders so ConfigModule sees them.
	const { NestFactory } = await import("@nestjs/core");
	const { AppModule } = await import("./app.module");
	const { buildSwaggerDocument } = await import("./swagger");

	const app = await NestFactory.create(AppModule, { logger: ["error"], abortOnError: false });
	const document = buildSwaggerDocument(app);
	const target = resolve(ROOT, "openapi.json");
	const json = `${JSON.stringify(document, null, 2)}\n`;
	writeFileSync(target, json);
	await app.close();
	console.log(`Wrote ${Object.keys(document.paths).length} paths to ${target}`);
	// The client generators read their own copy: hey-api (seek-web) and orval (seek-mobile).
	for (const copy of ["../seek-web/openapi.json", "../seek-mobile/swagger.json"].map(path => resolve(ROOT, path))) {
		if (!existsSync(dirname(copy))) continue;
		writeFileSync(copy, json);
		console.log(`Copied to ${copy}`);
	}
	process.exit(0);
}

main().catch(error => {
	console.error(`OpenAPI export failed: ${(error as Error).message}`);
	process.exit(1);
});
