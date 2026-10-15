# Scoffers

*the Saunders Coffers* — household jars and what's-left budgeting for Liz and Adam.

## What's here (Phase 1)

- Email/password login for the two household members only
- **Jars** for Joint Savings (…0810), each in one of three modes:
  - **Goal**: amount + date, with on-track status. Money spent from the jar counts toward the goal.
  - **Fill & spend**: a fixed amount each deposit, shows what's ready. Never "off track."
  - **Stash**: just a balance. Loose Change is the catch-all.
- Add, withdraw, and move money between jars, with history and who did it
- **Admin**: edit jars and allotments (warns if they don't total the $1,380 deposit), enter the Wells Fargo balance by hand, record a deposit by hand
- Installable on iPhone: open the site in Safari → Share → **Add to Home Screen**

Coming next: Wells Fargo via Plaid (Phase 2), What's Left for the checking account (Phase 3).

## Stack

- `server.js`: small Node/Express server for SiteGround. Serves `public/`. Plaid routes land here in Phase 2.
- `public/`: the app (plain HTML/CSS/JS, no build step).
- Supabase project `scoffers` for the database and login. Schema history is in `supabase/migrations/`.

## Run locally

```
npm install
npm start        # http://localhost:3000
```

## Deploy on SiteGround

1. Site Tools → **Node.js** → add a project, connect GitHub, and pick `Sunliz7037/scoffers` (branch `main`).
2. Start command: `npm start`. Node 20 or newer.
3. Point it at a domain or subdomain (for example `scoffers.yourdomain.com`), with SSL on.

No secrets are needed in Phase 1. The Supabase publishable key in `public/config.js` is meant to be public; row-level security keeps the data private.

In Phase 2, Plaid keys go into SiteGround's environment settings, **never** into this repo.
