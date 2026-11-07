## What the backend needs

- MongoDB for application data.
- Redis for presence/websocket support.
- Environment variables for JWT, frontend URL, Google, Mailgun, S3 and Stripe integrations.

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

Set `SEED_PASSWORD` in `.env` first: the seed refuses to run without it.

`db:reset` deletes and recreates the known development collections, then seeds users, listings, conversations, messages, applications, flags, tenancies, contracts, rent plans, payments, bills, repairs, notifications and document shares.

Use `npm run db:seed` when you want to upsert the seed records without deleting existing local records.

Use `npm run db:indexes` when you only want to recreate indexes.

## Test authentication locally

The backend no longer supports an authentication bypass. Use one of the seeded
accounts below to exercise the real login, refresh, role-authorization, and
logout paths. Public listing list, filter, and detail endpoints remain available
without signing in.

## Seed accounts

All seed users use the password set in `SEED_PASSWORD` in your `.env`. The
script never prints it.

Available accounts:

- `admin@seek.local` with `SUPERUSER`
- `landlord@st-andrews.ac.uk` with `LANDLORD_AGENCY`
- `agency@seek.local` with `LANDLORD_AGENCY`
- `james@seek.local` (James Holloway, Holloway Lets) with `LANDLORD_AGENCY`
- `priya.shah@seek.local` (Priya Shah, agent on James's team: viewings and inbox, never payouts) with `LANDLORD_AGENCY`
- `maya.student@st-andrews.ac.uk` (Maya Rahman) with `STUDENT`
- `tom.ellis@st-andrews.ac.uk`, `leah.okafor@st-andrews.ac.uk`, `sami.haddad@st-andrews.ac.uk` with `STUDENT`
- `leo.applicant@st-andrews.ac.uk` (Leo) and `priya.nair@st-andrews.ac.uk` with `STUDENT`

## Seeded scenarios (Bristol)

Dates are relative to the day you run the seed.

- **14 Cotham Grove** (England): active tenancy for Maya, Tom, Leah and Sami,
  1 Sept 2026 to 30 June 2027, £695.00 each per month, deposit protected with
  DPS. Monthly payments: past months paid, Sami's latest month late, future
  months scheduled. Autopay on for Maya, Tom and Leah. Energy, water and
  broadband included in rent; a TV licence bill is due and split four ways.
  Signed 2026-27 agreement, draft 2027-28 agreement, one scheduled boiler repair
  and one open damp repair.
- **Flat 2, 8 Redland Road**: tenancy for Leo and Priya started 26 days ago,
  deposit not yet protected (shows as a compliance item for James).
- **22 Kingsdown Parade** (EICR due in 21 days): two sent applications for
  2027-28. Kingsdown asks for no guarantor. Maya's household of four is first
  and qualified (every required passport item verified, viewing booked); Leo
  and Priya applied later and are not qualified (a household of two for a
  four-bed house), so approving or offering to them returns 409. Each
  applicant's documents are shared with James for 14 days from sending. James
  offers three viewing slots (two households each); Maya's booking uses the
  middle one.
- **9 Gloucester Road** (draft two-bed): Leo and Priya are the first qualified
  household and hold an offer made 13 days ago (15-day window, so it lapses in
  2 days), with a £140 holding deposit each (Priya paid, Leo due).
- Every listing has screening criteria (guarantor rule, references, maximum
  household), a holding deposit under one week's rent per room and, unless it
  is a draft, three upcoming viewing slots.
- James's Redland tenancy has a signed Seek England agreement with a move-in
  inventory.
- **5 Cathays Terrace, Cardiff** (Wales) and the Scottish listings allow
  six-monthly and yearly rent plans; English listings allow monthly only. Leo
  and Priya's Cathays tenancy ended 5 days ago: Seek's Welsh standard
  occupation contract (signed, with inventory) and £135.00 of proposed deposit
  deductions that Priya accepted and Leo still has to answer. Seeded Seek
  document links are signed with `JWT_ACCESS_TOKEN_SECRET`; re-run `db:reset`
  after changing it.
- Payments run in simulated mode while `STRIPE_SECRET_KEY` is empty.
- **Demo mailboxes** (provider `DEMO`, connected): Maya as
  `maya.rahman@gmail.com` and James as `james@holloway-lets.co.uk`. Maya's
  inbox has James's boiler reply with `Gas-safety-2026.pdf`, the signed
  agreement, the DPS certificate (DPS-7781-2209, £801), the Octopus Energy
  statement for last month (£214.00, filed as a bill) and the University of
  Bristol council tax exemption; James's has Maya's boiler reply and the DPS
  landlord certificate. Attachments are already filed in the Cotham tenancy
  documents (source `EMAIL`). The household group chat has Maya's boiler
  message (Cotham) and Tom's passport message (Kingsdown). Pressing "Sync"
  re-imports nothing: ids match `src/connectors/demo-mailbox.ts`.

## Collections recreated

- `users`
- `listings`
- `applications`
- `conversations`
- `messages`
- `flags`
- `tenancies`
- `contracts`
- `rentplans`
- `payments`
- `bills`
- `repairs`
- `notifications`
- `documentshares`
- `emailconnections`
- `emailmessages`

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
- `tenancies.landlord`, `tenancies.tenants`, unique `tenancies.application`
- unique `rentplans.tenancy + tenant`
- `payments.tenant + dueDate`, `payments.landlord + dueDate`, `payments.status + dueDate`
- `notifications.user + createdAt`, unique `notifications.user + dedupeKey`
- unique `documentshares.owner + application`, `documentshares.viewer + owner + expiresAt`
- unique `emailconnections.user + provider + emailAddress`
- unique `emailmessages.connection + providerMessageId`, `emailmessages.user + receivedAt`

## Connect the apps

For the web app, set `VITE_BASE_URL=http://localhost:3000` for the direct axios code paths. The generated client base URL is configured in `seek-web/src/main.tsx`; point it at `http://localhost:3000/api` or `http://localhost:3000` if you want every generated-client call to use the local backend.

For the mobile app, set `EXPO_PUBLIC_API_URL` to the backend URL. On the iOS simulator, `http://localhost:3000` normally reaches your Mac. On a physical phone, use your Mac LAN IP, for example `http://192.168.1.11:3000`.

## Production replacement

To replace the lost AWS database with a new hosted MongoDB:

1. Create a new MongoDB cluster, for example MongoDB Atlas or a self-managed MongoDB instance.
2. Set `MONGODB_URI` in the backend production environment to the new connection string.
3. Provision Redis and set `REDIS_URL`.
4. Set real JWT secrets and real third-party credentials for S3, Mailgun, Google OAuth, Google Geocoding and Stripe (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; the webhook URL is `POST /payments/webhook`). Without a Stripe key, payments answer 503 in production.
5. Deploy the backend and run `npm run db:indexes` once against the new database.
6. Only run `npm run db:seed` in production if you intentionally want the local sample records there.

## Fully wipe local Docker data

If you need to remove the local MongoDB and Redis volumes completely:

```bash
docker compose down -v
```

Then run the local rebuild steps again.
