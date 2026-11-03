# Mail App API and webhooks

Connect your own apps to Mail App. Read, search and send email with a simple JSON API, and get told the moment new email arrives. The API runs on your own Mail App, in your own Cloudflare account, so your mail never passes through anyone else.

## Get started

The API comes with Mail App. It lives on your own install, at your own web address:

```
https://mail.yourdomain.co.uk/api/ext/v1
```

1. Sign in to Mail App as an admin and open **Admin › API & webhooks**. You'll see your API address there, ready to copy.
2. If it says the API isn't switched on yet, follow [The API and download links](../README.md#the-api-and-download-links) in the README. It lets the API's address past Cloudflare sign-in (just that address; the rest of Mail App stays behind sign-in) and switches the API on.
3. Choose **New API key**, tick what the key can do and which mailboxes it can use, and copy the key. It's shown once.
4. Send the key with each request, in an `Authorization` header:

```sh
curl https://mail.yourdomain.co.uk/api/ext/v1/mailboxes \
  -H "Authorization: Bearer mailapp_ab12cd34_••••••••••••••••••••••••••••••••"
```

Every request and answer is JSON. Times are in UTC, written like `2026-10-15T09:30:00.000Z`.

## API keys and permissions

Make a separate key for each app, so you can delete one without stopping the others. Each key:

- only reaches the mailboxes you ticked when you made it. Any other mailbox looks as if it doesn't exist;
- only does what you allowed, from the three permissions below;
- is stored as a fingerprint (a SHA-256 hash) plus its first few characters, so you can tell your keys apart but nobody, not even an admin, can see the whole key again after it's made. Lost a key? Delete it and make a new one.

| Permission | What it allows |
| --- | --- |
| **Read** | List mailboxes, list, read and search email, read whole conversations, see folders and labels, and download attachments. |
| **Send** | Send new emails, replies and forwards from the key's mailboxes (and their extra addresses). |
| **Organise** | Mark email as read or unread, star it, move it to a folder, and add or remove labels. |

The API never deletes email, changes settings, or manages people, mailboxes or domains. Those stay in the app, behind sign-in.

## Every request

Write mailbox addresses in the path with `@` as `%40`, for example `/mailboxes/sales%40yourdomain.co.uk/emails`.

| Request | Needs | What it does |
| --- | --- | --- |
| `GET /mailboxes` | Read | The mailboxes this key can use. |
| `GET /mailboxes/{mailbox}/folders` | Read | Folders, with how many unread emails each has. The built-in ones are `inbox`, `sent`, `draft`, `archive`, `spam` and `trash` (shown as Bin). |
| `GET /mailboxes/{mailbox}/emails?folder=inbox&page=1&limit=25` | Read | A page of emails in a folder, newest first, with `totalCount`. Add `&threaded=true` for one row per conversation. |
| `GET /mailboxes/{mailbox}/emails/{id}` | Read | One email in full, with its body and attachments list. |
| `GET /mailboxes/{mailbox}/threads/{thread_id}` | Read | Every email in a conversation, oldest first. |
| `GET /mailboxes/{mailbox}/search?query=invoice` | Read | Search. Also takes `from`, `to`, `subject`, `folder`, `label`, `date_start`, `date_end`, `is_read`, `is_starred`, `has_attachment`, `page` and `limit`. |
| `GET /mailboxes/{mailbox}/labels` | Read | The mailbox's labels. |
| `GET /mailboxes/{mailbox}/emails/{id}/attachments/{attachment_id}` | Read | Downloads an attachment (the file itself, not JSON). |
| `POST /mailboxes/{mailbox}/emails` | Send | Sends a new email. See the example below. |
| `POST /mailboxes/{mailbox}/emails/{id}/reply` | Send | Replies to an email, keeping it in the same conversation. Same body as sending. |
| `POST /mailboxes/{mailbox}/emails/{id}/forward` | Send | Forwards an email. Same body as sending. |
| `PUT /mailboxes/{mailbox}/emails/{id}` | Organise | Marks as read or starred: `{"read": true, "starred": false}`. |
| `POST /mailboxes/{mailbox}/emails/{id}/move` | Organise | Moves to a folder: `{"folderId": "archive"}`. |
| `PUT /mailboxes/{mailbox}/emails/{id}/labels` | Organise | Adds and removes labels on the whole conversation: `{"add": ["label-id"], "remove": []}`. |

## Examples

### Read the newest emails in an inbox

```sh
curl "https://mail.yourdomain.co.uk/api/ext/v1/mailboxes/sales%40yourdomain.co.uk/emails?folder=inbox&limit=10" \
  -H "Authorization: Bearer $MAIL_API_KEY"
```

```json
{
  "emails": [
    {
      "id": "f332437e-582c-4e8f-b514-db180c5e2a91",
      "thread_id": "f332437e-582c-4e8f-b514-db180c5e2a91",
      "subject": "Order 1234 question",
      "sender": "jo@example.org",
      "sender_name": "Jo Bloggs",
      "recipient": "sales@yourdomain.co.uk",
      "date": "2026-10-15T09:30:00.000Z",
      "read": false,
      "starred": false
    }
  ],
  "totalCount": 1
}
```

### Send an email

```sh
curl https://mail.yourdomain.co.uk/api/ext/v1/mailboxes/sales%40yourdomain.co.uk/emails \
  -H "Authorization: Bearer $MAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": { "email": "sales@yourdomain.co.uk", "name": "Greenleaf Sales" },
    "to": "jo@example.org",
    "subject": "Thanks for your order",
    "text": "We've got your order and will be in touch soon.",
    "html": "<p>We've got your order and will be in touch soon.</p>"
  }'
```

`to`, `cc` and `bcc` take one address or a list. `from` must be the mailbox or one of its extra addresses. To attach a file, add `"attachments": [{"filename": "invoice.pdf", "type": "application/pdf", "content": "<base64>", "disposition": "attachment"}]`. The answer is `{"id": "…", "status": "sent"}`, and the email appears in the mailbox's Sent folder like any other.

Sending to other people needs Cloudflare's Workers Paid plan ($5 a month) and your domain set up for sending, the same as sending from the app. If Cloudflare refuses an email, the answer says why in plain English.

### In JavaScript

```js
const res = await fetch(`${MAIL_API_URL}/mailboxes/${encodeURIComponent("sales@yourdomain.co.uk")}/search?query=invoice`, {
  headers: { Authorization: `Bearer ${process.env.MAIL_API_KEY}` },
});
if (!res.ok) throw new Error((await res.json()).error);
const { emails } = await res.json();
```

## Webhooks

A webhook tells another app's web address the moment something happens, so it doesn't have to keep asking. Add one in **Admin › API & webhooks › New webhook**: give its `https://` address, tick when to send it, and choose all mailboxes or just some.

| Event | When it's sent |
| --- | --- |
| `email.received` | An email arrives in a mailbox. Not for spam, or for email an inbox rule moves to the Bin. |
| `email.sent` | An email, reply or forward is sent from a mailbox, from the app or the API. |

Mail App sends a `POST` with a JSON body like this:

```json
{
  "id": "evt_c7e1c6da-0e04-4a56-94b8-9e9ca5be6b70",
  "type": "email.received",
  "created": "2026-10-15T09:30:01.000Z",
  "mailbox": "sales@yourdomain.co.uk",
  "data": {
    "email": {
      "id": "f332437e-582c-4e8f-b514-db180c5e2a91",
      "thread_id": "f332437e-582c-4e8f-b514-db180c5e2a91",
      "folder": "inbox",
      "subject": "Order 1234 question",
      "from": "jo@example.org",
      "from_name": "Jo Bloggs",
      "to": "sales@yourdomain.co.uk",
      "cc": null,
      "date": "2026-10-15T09:30:00.000Z",
      "has_attachments": false
    }
  }
}
```

The body is a summary, not the whole email, so private mail isn't copied around more than it needs to be. Use the API with the email's `id` to read the rest.

Each request also carries these headers:

|  |  |
| --- | --- |
| `Mail-App-Event` | The event, such as `email.received`, or `test` for the Send a test button. |
| `Mail-App-Delivery` | The same for every try of one event, so you can ignore repeats. |
| `Mail-App-Signature` | `t=1760520601,v1=5f2b…`: when it was sent and its signature. See below. |

Answer with any `2xx` status within 10 seconds. If your app can't be reached, takes too long, or answers `408`, `429` or `5xx`, Mail App tries again after 1 minute, 10 minutes and 1 hour. Other `4xx` answers aren't tried again. Every try shows in the webhook's **Delivery log**, and you can pause a webhook at any time.

## Checking a webhook is genuine

Each webhook has its own signing secret (starting `whsec_`), shown when you add it and in its menu. Mail App signs `<t>.<body>` with HMAC-SHA256 using that secret. To check a request, work out the same signature from the raw body and compare it with `v1`, and refuse anything more than five minutes old.

### Node.js

```js
import crypto from "node:crypto";

function isFromMailApp(rawBody, header, secret) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!parts.v1 || age > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}
```

### Python

```python
import hashlib, hmac, time

def is_from_mail_app(raw_body: bytes, header: str, secret: str) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    if "v1" not in parts or abs(time.time() - int(parts["t"])) > 300:
        return False
    signed = parts["t"].encode() + b"." + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts["v1"])
```

Use the body exactly as it arrived. Parsing the JSON and turning it back into text can change it, and then the signature won't match.

## Errors and limits

Anything that goes wrong comes back with a status and a sentence you can show to a person: `{"error": "That API key isn't valid. It may have been deleted."}`

| Status | Means |
| --- | --- |
| `400` | Something in the request isn't right, such as a `from` address the mailbox can't send as. |
| `401` | No key, or a key that isn't valid any more. |
| `403` | The key doesn't have the permission this needs. |
| `404` | Not found, a mailbox the key can't use, or a request the API doesn't have. |
| `413` | The email is too big to send. Cloudflare allows up to 5 MB per email once encoded, which is about 3.5 MB of attachments. |
| `429` | Too many emails sent too quickly. Wait a little and try again. |
| `502` | Cloudflare refused to send the email. The error says why. |
| `503` | The API isn't switched on for this install yet. See the README. |

Each install can have up to 25 API keys and 10 webhooks. Requests made from a web page in someone's browser aren't allowed, because the key would be visible to anyone using the page. Call the API from your own server, or from tools like Zapier, Make or n8n.

Questions or ideas? Ask in [GitHub Discussions](https://github.com/pobren/mail-app/discussions), or open an [issue](https://github.com/pobren/mail-app/issues) for a bug.
