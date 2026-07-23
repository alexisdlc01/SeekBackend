## What the backend needs

- MongoDB for application data.
- Redis for presence/websocket support.
- Environment variables for JWT, frontend URL, Google, Mailgun, and S3 integrations.

The backend has no migration framework. Mongoose creates collections and validates documents from code; `scripts/recreate-db.js` creates the indexes and inserts representative seed records.

## Local rebuild

From the backend repo:

```bash
cd SeekBackend
cp .env.example .env
npm install
docker compose up -d mongo redis
npm run db:reset
npm run start:dev
```

`db:reset` deletes and recreates the known development collections, then seeds users, listings, conversations, messages, applications, and flags.

Use `npm run db:seed` when you want to upsert the seed records without deleting existing local records.

Use `npm run db:indexes` when you only want to recreate indexes.

## Temporarily bypass auth locally

For local app browsing without logging in, set this in `SeekBackend/.env`:

```bash
DEV_AUTH_BYPASS=true
DEV_AUTH_BYPASS_USER_ID=665000000000000000000002
```

Then restart the backend. The bypass only works when `NODE_ENV` is not `production`. It makes protected endpoints behave as if `student@seek.local` is the current user.

## Seed accounts

All seed users use this password:

```text
Password123!
```

Available accounts:

- `admin@seek.local` with `SUPERUSER`
- `landlord@st-andrews.ac.uk` with `LANDLORD_AGENCY`
- `agency@seek.local` with `LANDLORD_AGENCY`
- `student@seek.local` with `STUDENT`
- `applicant@seek.local` with `STUDENT`

## Collections recreated

- `users`
- `listings`
- `applications`
- `conversations`
- `messages`
- `flags`

Indexes recreated:

- unique `users.email`
- `listings.landlord`
- `listings.location` as `2dsphere`
- draft listing TTL on `listings.createdAt`
- `applications.applicants`
- `conversations.users`
- `conversations.createdAt`
- `messages.conversation + createdAt`
- `messages.sender + createdAt`

## Connect the apps

For the web app, set `VITE_BASE_URL=http://localhost:3000` for the direct axios code paths. The generated client base URL is configured in `seek-web/src/main.tsx`; point it at `http://localhost:3000/api` or `http://localhost:3000` if you want every generated-client call to use the local backend.

For the mobile app, set `EXPO_PUBLIC_API_URL` to the backend URL. On the iOS simulator, `http://localhost:3000` normally reaches your Mac. On a physical phone, use your Mac LAN IP, for example `http://192.168.1.11:3000`.

## Production replacement

To replace the lost AWS database with a new hosted MongoDB:

1. Create a new MongoDB cluster, for example MongoDB Atlas or a self-managed MongoDB instance.
2. Set `MONGODB_URI` in the backend production environment to the new connection string.
3. Provision Redis and set `REDIS_URL`.
4. Set real JWT secrets and real third-party credentials for S3, Mailgun, Google OAuth, and Google Geocoding.
5. Deploy the backend and run `npm run db:indexes` once against the new database.
6. Only run `npm run db:seed` in production if you intentionally want the local sample records there.

## Fully wipe local Docker data

If you need to remove the local MongoDB and Redis volumes completely:

```bash
docker compose down -v
```

Then run the local rebuild steps again.
