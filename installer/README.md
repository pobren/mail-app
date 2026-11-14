# @mrpwob/mail-app

Install and update [Mail App](https://github.com/pobren/mail-app) on your own Cloudflare account from the command line.

Mail App is free email that runs on your own Cloudflare account: inbox, calendar, contacts, shared inboxes and a spam filter. This command sets everything up for you, using a Cloudflare API token you create.

```sh
npx @mrpwob/mail-app setup            # install Mail App
npx @mrpwob/mail-app@latest update    # update an install to the latest version
npx @mrpwob/mail-app add-domain       # get email for another domain too
npx @mrpwob/mail-app help             # options, and the token permissions
```

## Your Cloudflare API token

Create one at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens): select **Create Token**, then **Create Custom Token**. `npx @mrpwob/mail-app help` lists the permissions it needs.

Set it as `CLOUDFLARE_API_TOKEN`, or paste it when the command asks. Your token is only ever sent to Cloudflare's API. Mail App's own files come inside this package, and nothing is sent anywhere else.

## What it does

- Creates storage (R2), then installs Mail App as a Worker called `mail-app`.
- Gives Mail App its web address (`mail.yourdomain.com` by default).
- Switches on Email Routing for your domain, with a catch-all to Mail App. If your domain gets its email somewhere else, it asks before moving anything.
- Adds the email records (SPF, DKIM, DMARC) and switches on sending.
- `add-domain` does the email steps for another domain on the same Cloudflare account, then adds it to Mail App's list so you can make mailboxes for it.
- Protects the web address with Cloudflare Access sign-in, using codes sent to your email, and sets up passkeys, download links and the API.

You can run each command again safely. It checks what already exists first.

## Requirements

You need Node.js 20 or later and a Cloudflare account. Sending to other people needs Cloudflare's Workers Paid plan ($5 a month).

## Help

Found a bug or stuck on an install? Please [open an issue](https://github.com/pobren/mail-app/issues) or ask in [Discussions](https://github.com/pobren/mail-app/discussions).

## Licence

Business Source License 1.1. Source available, free for personal and small business use on up to 10 of your own domains. Going over 10 domains, running it for clients or offering it as a hosted service needs a commercial licence: get in touch at [paulobrien.dev/contact](https://paulobrien.dev/contact/). Mail App is built on [Agentic Inbox](https://github.com/cloudflare/agentic-inbox) by Cloudflare. It is independent software and isn't made, endorsed or supported by Cloudflare.
