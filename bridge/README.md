# Mail App Bridge for Outlook

Use your Mail App mailbox in classic Outlook on Windows, alongside Mail App in your browser. The bridge is a small app that sits in the system tray. Outlook connects to it with normal IMAP or POP3 and SMTP settings, and the bridge keeps everything in step with Mail App through its API.

- **IMAP (recommended):** Outlook and Mail App stay the same both ways. Read and unread, flags (stars in Mail App), folders, moves and deletes all match.
- **POP3:** Outlook downloads your Inbox. By default mail stays in Mail App even when Outlook deletes it.
- **Sending:** mail you send from Outlook goes out through Mail App, so it shows in Sent in both.

The bridge only listens on your own computer (127.0.0.1), and talks to Mail App over HTTPS. Your mail never passes through anyone else.

> **Classic Outlook only.** The new Outlook for Windows syncs IMAP accounts through Microsoft's servers, so it can't reach a bridge on your own computer. Classic Outlook (Outlook 2016, 2019, 2021, 2024 and Microsoft 365's desktop Outlook) works.

## What you need

- Windows 10 or 11, and classic Outlook.
- A Mail App release that includes the bridge's API calls (2.4 or newer), with the API switched on (see [The API and download links](../README.md#the-api-and-download-links)).

## Set it up

1. **Make an API key.** In Mail App, open **Admin › API & webhooks › New API key**. Call it "Outlook bridge", tick **Read**, **Send**, **Organise** and **Delete**, and tick your mailbox. Copy the key; it's shown once.
   *Delete only lets the bridge empty mail that's already in the Bin or Spam, the same as emptying the Bin in Mail App.*
2. **Install the bridge.** Download `Mail-App-Bridge-Setup-<version>.exe` from the newest **Mail App Bridge** [release](https://github.com/pobren/mail-app/releases) and run it. It installs just for you, so it doesn't need an administrator. Its settings page opens in your browser.
3. **Connect it.** On the settings page, enter your Mail App web address (such as `mail.yourdomain.co.uk`) and the API key, and choose **Save and connect**. Each mailbox the key can use appears under **Your mailboxes**; give it a minute to get your folders ready.
4. **Add the account to Outlook.** In Outlook choose **File › Add account**, enter your mailbox's email address, open **Advanced options**, tick **Let me set up my account manually**, and choose **IMAP** (or **POP**). Use the settings shown on the bridge's settings page:

| Setting | IMAP | POP3 |
| --- | --- | --- |
| Incoming server | `127.0.0.1` | `127.0.0.1` |
| Incoming port | `1143` | `1110` |
| Outgoing (SMTP) server | `127.0.0.1` | `127.0.0.1` |
| Outgoing port | `1025` | `1025` |
| Encryption | None | None |
| User name | Your mailbox's email address | Your mailbox's email address |
| Password | The bridge password from the settings page | The bridge password from the settings page |

The bridge password isn't your Mail App sign-in. It's made by the bridge, only works on this computer, and you can make a new one at any time on the settings page.

5. **Pick the Bin.** In IMAP accounts, Outlook may make its own "Deleted Items". To use Mail App's Bin instead, open **File › Account settings › Account settings**, choose the account, **Change › More settings › Deleted items**, and pick **Bin**.

## How things map

| In Outlook | In Mail App |
| --- | --- |
| Read and unread | Read and unread |
| Flag | Star |
| Move to a folder | Moves it |
| Delete | Moves it to the Bin |
| Delete from the Bin (or Spam), or empty it | Deletes it for good |
| Drafts | Saved in Drafts; old versions are tidied away |
| New folder, rename a folder | The same in Mail App |
| Delete a folder | Not from Outlook, so nothing is lost by mistake. Delete folders in Mail App. |
| Labels | Not shown in Outlook. They're kept in Mail App. |

Snoozed and scheduled mail stay in Mail App, and show in Outlook again when they come back to a folder.

## Options

- **Keep mail in Mail App when Outlook deletes it over POP3** (on by default). Outlook's own "Leave a copy of messages on the server" works too.
- **Mark mail as read in Mail App once Outlook downloads it over POP3** (on by default).
- **Start the bridge when I sign in to Windows** (on by default). Outlook can only get and send mail while the bridge is running.

## Questions

**How quickly does new mail show up?** The bridge asks Mail App what changed every 20 seconds, and straight away whenever Outlook checks for mail.

**More than one mailbox?** Each mailbox the API key can use is its own account in Outlook, with the same bridge password. Make the key with **All mailboxes, including new ones** and mailboxes you add in Mail App later appear in the bridge within five minutes. Then add them to Outlook as another account.

**Where does the bridge keep things?** Settings are in `%APPDATA%\Mail App Bridge`, with the API key and bridge password locked to your Windows user. Each mailbox's folder list and a copy of each email Outlook has asked for are in `%LOCALAPPDATA%\Mail App Bridge`, with a log in `bridge.log`.

**Port in use?** If another program uses one of the ports, the settings page says which. Close that program and restart the bridge from the tray icon.

**Older mail.** Mail App keeps the original of every email that arrives from the release that added the bridge. Mail from before that is rebuilt from what Mail App stored, so Outlook shows the same text and attachments, but some original headers may be missing.

Questions or ideas? Ask in [GitHub Discussions](https://github.com/pobren/mail-app/discussions), or open an [issue](https://github.com/pobren/mail-app/issues) for a bug.

## For developers

The bridge is written in Go (`bridge/`). It uses [go-imap](https://github.com/emersion/go-imap), [go-smtp](https://github.com/emersion/go-smtp) and [go-message](https://github.com/emersion/go-message), all MIT licensed.

```sh
cd bridge
go test ./...
go run ./cmd/mailapp-bridge --headless   # settings page at http://127.0.0.1:47825
```

`test/imap_test.py` and `test/pop_smtp_test.py` check it end to end against a local Mail App (`npm run dev:local`). The Windows app and installer are built by `.github/workflows/bridge.yml`; a tag like `bridge-v0.1.0`, or running that workflow by hand on main, puts them on a release.

The API calls the bridge uses (changes, index, raw, append) are in [docs/api.md](../docs/api.md#keeping-another-app-in-step).
