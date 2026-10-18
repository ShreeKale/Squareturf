# SquareTurf — Multi-tenant turf SaaS MVP

Node.js + Express + EJS + MongoDB + Tailwind CDN. Provides owner registration/login, Basic-plan trial, tenant subdomain resolution, dynamic public turf pages, manual booking management and a super-admin view.

## Requirements
- Node.js 18+
- MongoDB running locally or a MongoDB Atlas connection string

## Setup
1. Copy `.env.example` to `.env` and set a strong `SESSION_SECRET`, `MONGO_URI`, `BASE_DOMAIN`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`.
2. `npm install`
3. `npm run dev` (or `npm start`)
4. Visit `http://localhost:5000`.

The admin account is created on first startup using `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Change the example password before running and never deploy with the default secret/password.

## Local subdomains
For local testing, add a host entry for each tenant slug in your OS hosts file, pointing to `127.0.0.1`, e.g. `127.0.0.1 royalturf.localhost` may work in some browsers, or use a local wildcard DNS tool. Set `BASE_DOMAIN=localhost` and visit `http://<slug>.localhost:5000` if your resolver supports it. Alternatively use a local reverse proxy/DNS setup.

## Production domain
Set `BASE_DOMAIN=squareturf.com`, configure wildcard DNS `*.squareturf.com` to your hosting ingress, and configure HTTPS including the wildcard hostname. Keep platform/admin/API subdomains reserved. If using a proxy, configure Express `trust proxy` correctly and preserve the original Host header.

## Basic plan MVP limits
The UI presents Basic as ₹499/month with one turf/ground, one owner, ten photos, subdomain, and manual bookings. The current MVP seeds plan metadata, but **does not yet enforce every plan limit or charge subscription payments**. Trial/subscription status fields are present as a starting point. Add verified payment webhooks, renewal jobs, entitlement middleware, email/phone verification, CSRF protection, audit logging, backups and production monitoring before taking live customers.

## Important limitations
- Booking form is a manual enquiry, not an instant confirmed reservation. Validate timezone/date and slot duration rules before production.
- This MVP stores bookings in MongoDB and checks overlaps, but production-grade concurrent booking protection should use transactions or an atomic slot-reservation model.
- The public form currently shows a simple server response; replace it with polished success/error pages.
- Tailwind is loaded via CDN for quick development. Build Tailwind locally for production.
- Uploads use URL fields; connect a secure image upload service for real owners.
- Add a custom-domain verification workflow before supporting customer-owned domains.
