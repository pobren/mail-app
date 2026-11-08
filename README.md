<div align="center">
  <img src="public/favicon.svg" width="64" height="64" alt="">
  <h1>Mail App</h1>
  <p><strong>Free, open-source business email that runs on your own Cloudflare account.</strong><br>
  Inbox, calendar, contacts, shared inboxes and a spam filter, at your own domain.</p>
  <p><a href="https://paulobrien.dev/mail/">Website</a> · <a href="#install">Install</a> · <a href="https://github.com/pobren/mail-app/releases">Releases</a> · <a href="https://github.com/pobren/mail-app/issues">Report a bug</a> · <a href="https://github.com/pobren/mail-app/discussions">Ask a question</a></p>
</div>

Mail App gives you private email at your own domain. It installs into your own Cloudflare account, so your mail, contacts and files stay there, and nothing depends on anyone else to keep running. Every feature is in the free app. There's nothing to unlock.

- **Email:** conversations, labels, folders, search, rules, scheduled send, snooze, templates, signatures, auto-replies and forwarding.
- **Teams:** up to 50 people, each signing in as themselves, with shared mailboxes like sales@ and extra addresses.
- **Spam filter:** dozens of checks that run inside your account, and it learns from what you mark. An optional AI check uses Cloudflare Workers AI in your own account.
- **Calendar, contacts, notes and files**, with invites that work with Google, Outlook and Apple.
- **Backups** every night in standard .mbox format, plus import from Gmail, Apple Mail and Thunderbird.
- **An API and webhooks** for your own apps ([docs/api.md](docs/api.md)).
- **Installs as an app** on your computer and phone, with notifications.

## What you need

- A Cloudflare account (the free plan is fine for receiving).
- A domain on that account, with its email handled by Cloudflare Email Routing.
- To send email to other people: Cloudflare's Workers Paid plan ($5 a month). Receiving is free.

## Install

There are three ways. All of them install into your own Cloudflare account, and updating later keeps your mail and settings.

### 1. The installer (recommended)

The installer does every step for you: storage, the Worker, its web address, Email Routing, the email records, sign-in protection, passkeys, download links and the API. You need [Node.js](https://nodejs.org) 20 or later and a Cloudflare API token.

```sh
npx @mrpwob/mail-app setup
```

`npx @mrpwob/mail-app help` lists the token permissions. Make the token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) (Create Token, then Create Custom Token). It's only ever sent to Cloudflare.

### 2. Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/pobren/mail-app)

The button copies Mail App to your GitHub account and deploys it to your Cloudflare account, with its storage. When it asks for **DOMAINS**, enter your domain. Leave the two Access settings as they are for now. Then:

1. Open **Workers & Pages › mail-app › Settings › Domains & Routes** and add a custom domain, such as `mail.example.com`.
2. On the same page, switch on **Cloudflare Access** for that address. Copy the **POLICY_AUD** and **TEAM_DOMAIN** values it shows into the Worker's **Variables and Secrets** (as secrets).
3. Open your domain's **Email › Email Routing**, switch it on, and set the **Catch-all** to *Send to a Worker*, `mail-app`.
4. Open `https://mail.example.com`. You're the first admin.

The installer does all of this for you, and also sets up passkeys, download links and the API, so it's the easier way.

### 3. From the code, with Wrangler

```sh
git clone https://github.com/pobren/mail-app.git
cd mail-app
npm install
npx wrangler login
```

1. In `wrangler.jsonc`, set `DOMAINS` to your domain.
2. Create the storage: `npx wrangler r2 bucket create mail-app`
3. Deploy: `npm run deploy`
4. In the Cloudflare dashboard, open **Workers & Pages › mail-app › Settings › Domains & Routes** and add a custom domain, such as `mail.example.com`.
5. Open your domain's **Email › Email Routing**, switch it on, and under **Routing rules** set the **Catch-all** to *Send to a Worker*, `mail-app`.
6. Protect it with Cloudflare Access. See [Cloudflare Access](#cloudflare-access) below. Mail App refuses to open until this is done.
7. Open `https://mail.example.com`. You're the first admin.

## Cloudflare Access

Mail App relies on [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/) (free for up to 50 people) to check who's signing in. The installer sets this up for you. To do it by hand:

1. In **Zero Trust › Access › Applications**, add a **Self-hosted** application for your web address, such as `mail.example.com`.
2. Give it a policy that **Allows** the email addresses that may sign in (yours to start with). One-time PIN is the simplest sign-in method.
3. Copy the application's **Audience (AUD) tag**, then set these on the Worker:

```sh
npx wrangler secret put POLICY_AUD     # the Audience (AUD) tag
npx wrangler secret put TEAM_DOMAIN    # https://<your-team>.cloudflareaccess.com
npx wrangler secret put OWNER_EMAIL    # the address you sign in with
```

When you invite people in Mail App, add them to the Access policy too. To have Mail App do this itself, set `CF_ACCOUNT_ID`, `ACCESS_POLICY_ID` and `ACCESS_API_TOKEN` (a token that can edit Access only), or use the installer.

### The API and download links

These parts of Mail App open without signing in, so they need their own Access application with a **Bypass** policy for **Everyone**, plus a setting on the Worker:

| Path | What it's for | Setting |
| --- | --- | --- |
| `mail.example.com/f/` | Download links for big files you send | `PUBLIC_LINKS` = `on` |
| `mail.example.com/api/ext/` | The API (each request still needs an API key) | `PUBLIC_API` = `on` |

Passkey sign-in needs more set-up in Access, so it's easiest with the installer.

## Sending email

Sending to other people needs Cloudflare's Workers Paid plan ($5 a month) and your domain switched on for sending in **Email › Email Sending**, which adds the SPF and DKIM records. Mail App's **Setup** page checks your records and says what to fix. Receiving works on the free plan.

## Adding domains

Mail App can get email for more than one domain. Add the domain to your Cloudflare account, then open Mail App's **Domains** page and press **Add domains**. You sign in with Cloudflare in a small window (on paulobrien.dev), tick the domains and it sets each one up on your account: Email Routing with a catch-all to Mail App, its email records and sending. Nothing about you or your mail is kept there, and the permission is handed back to Cloudflare when you finish.

Or from a terminal:

```sh
npx @mrpwob/mail-app@latest add-domain example.org
```

It switches on Email Routing for the domain with a catch-all to Mail App, adds its email records, switches on sending and adds it to Mail App's list. Leave out the domain to pick from a list.

To do it by hand instead, switch on Email Routing for the domain with a catch-all to `mail-app`, then add it on Mail App's **Domains** page.

## Updating

Admins see a notice in Mail App when a new release is out. Your mail and settings are kept when you update.

- **Installer:** `npx @mrpwob/mail-app@latest update`
- **From the code:** `git pull`, then `npm install` and `npm run deploy`

What's new in each version is on the [releases page](https://github.com/pobren/mail-app/releases).

## Install it as an app

Mail App works as an app on your computer and phone, in its own window and with notifications for new mail.

- **Chrome or Edge:** choose the install icon at the right of the address bar, or **Install** in the browser menu.
- **Safari on a Mac:** choose **File › Add to Dock**.
- **iPhone and iPad:** tap **Share**, then **Add to Home Screen**. Open it from there to switch on notifications.
- **Android:** open the browser menu and choose **Add to home screen** or **Install app**.

## For developers

```sh
npm install
npm run dev:local
```

`dev:local` runs the app without a Cloudflare login. Mailboxes, folders, drafts, search and settings all work; sending isn't delivered and the AI assistant needs a login. To simulate inbound mail, create a mailbox first, then:

```sh
curl -X POST 'http://localhost:5173/cdn-cgi/handler/email?from=jane@example.org&to=you@example.com' \
  --data-binary @message.eml
```

`npm test` runs the tests and `npm run typecheck` checks the types. `npm run package` builds the npm installer into `npm/`.

Built with React Router, Hono, Cloudflare Workers, Durable Objects (SQLite), R2, Email Routing and Workers AI.

## Help

- **Found a bug?** Please [open an issue](https://github.com/pobren/mail-app/issues), with what you did and what happened.
- **A question about installing or using it?** Ask in [Discussions](https://github.com/pobren/mail-app/discussions), so everyone can find the answer.

Help is only given on GitHub. Mail App is a free project, so answers come when there's time.

## Licence and credits

Mail App is open source under the [GNU Affero General Public License v3.0](LICENSE) (AGPL 3.0). Versions up to and including 2.0.2 were released under the Apache License 2.0 and stay under it.

What that means in plain English:

- **Free for you.** Use it, change it and run it for yourself, your family or your business, on your own Cloudflare account. No licence key, no trial.
- **Share your changes.** If you change Mail App and let other people use your changed version over the internet, you must give them your changed source code under the same licence.
- **Hosting or selling it?** If you want to host Mail App for others, sell it as a service or build it into a paid product without sharing your changes, you need a commercial licence. [Get in touch](https://paulobrien.dev/contact/) and choose *Let's work together*.

This summary isn't legal advice. The [LICENSE](LICENSE) file is what counts.

Mail App is based on [Agentic Inbox](https://github.com/cloudflare/agentic-inbox) by Cloudflare, under the [Apache License 2.0](LICENSE-APACHE); thank you to its authors. Files that came from Agentic Inbox keep their Apache 2.0 notice. See [NOTICE](NOTICE).

Mail App is independent. It isn't made, endorsed or supported by Cloudflare.
