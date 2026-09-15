# Handover

Everything the Ummatically website runs on, and how to pass it to the client.

Work through it in order. Steps 3–6 must happen in sequence — each one depends
on the last. Budget an hour, plus waiting time on the domain transfer.

---

## 1. What exists

Six separate accounts keep this site running. All six have to end up in the
client's hands, or the site stays dependent on you forever.

| What | Where it lives | Why it matters |
|---|---|---|
| Domain `ummatically.co.uk` | Hostinger | The address. Renews yearly — if it lapses, the site goes dark |
| Hosting | Netlify, project `ummatically` | Serves the site, issues the HTTPS certificate |
| Source code | GitHub `sha1sheikh/ummatically` | Netlify rebuilds automatically on every push here |
| Bookings spreadsheet | Google Sheets | Every booking, payment and attendee |
| Booking backend | Google Apps Script, *Ummatically Bookings* | Takes bookings, sends emails, talks to Stripe |
| Payments | Stripe, *Muslims of Ihsan* | Takes the money |

**Nameservers are at Netlify** (`dns1–4.p05.nsone.net`), so DNS is managed in
Netlify, not Hostinger. Hostinger only holds the registration now.

---

## 2. Fix these first

Do these **before** transferring anything. Two are live problems.

### 2a. `SITE_URL` still points at the old address — must fix

The backend builds Stripe's return links and the links inside booking emails
from a setting called `SITE_URL`. It was set before the domain existed, so it
still points at the old GitHub/Netlify address.

Left alone, **customers who pay get sent to the old address instead of
`ummatically.co.uk`**, and email links go to the wrong place.

1. Open the Apps Script project → **⚙ Project Settings** → **Script Properties**
2. Edit `SITE_URL` to exactly `https://ummatically.co.uk/` (with the trailing slash)
3. **Deploy → Manage deployments → ✏️ edit → Version: New version → Deploy**

Changing the property alone is not enough. It only takes effect on redeploy.

### 2b. Capacity is blank on every taster day

All ten `womens-taster-day-2026-*` rows in the **Events** tab have no capacity,
so nothing stops a date being oversold. Fill the **Capacity** column in.

### 2c. One customer is still unresolved

`UMM-2609-PP2P` — joseph abdel-salam, `info@bueninternational.co.uk`, £75,
booked 10 September against the old July event. Their Stripe session expired.
Either take payment or refund and cancel, so you don't hand over a live
problem.

### 2d. Confirm Stripe is in live mode, not test

In the Apps Script **Script Properties**, check `STRIPE_SECRET_KEY`:

- starts `sk_live_` → real payments ✅
- starts `sk_test_` → **no real money is being taken** ❌

Also confirm the payment link on the women's taster day
(`buy.stripe.com/28E8wPe9NgoU02b7Qv2Nq00`) belongs to the live account and not
the sandbox.

### 2e. Re-run `setUp`

The spreadsheet was last built by an older version of the code (`2026-09-13.11`
against current `2026-09-13.14`). Open the Apps Script project, select `setUp`
from the function dropdown, and **Run**. It's safe — it never deletes bookings.

---

## 3. Stripe

Money first. Everything else is recoverable; a payment account in the wrong
name is a mess.

1. Log in to Stripe and confirm the **Muslims of Ihsan** account is registered
   to the client's business details and **the client's bank account** — not
   yours
2. If it's in your name, the client must open their own Stripe account.
   Stripe cannot transfer an account between owners; a new one has to be made,
   a new secret key generated, and a new payment link created
3. Add the client as an **Administrator**: Stripe → **Settings → Team → Add member**
4. Once they've accepted and can log in, remove yourself

> ⚠️ **Never send the Stripe secret key by email or WhatsApp.** It can charge
> cards and issue refunds. See step 8 for how to hand credentials over safely.

---

## 4. The spreadsheet

1. Open the bookings spreadsheet → **Share**
2. Click the dropdown next to the client's address → **Transfer ownership**
3. They accept by email
4. Keep yourself on as **Editor** for now — you'll need access for step 5

---

## 5. The booking backend — the important one

**Read this section before starting it.** It's the step that most often gets
missed, and the consequences are invisible until something breaks.

Right now the Apps Script project sits in **your** Google Drive and runs as
**your** Google account. That means:

- Booking confirmation emails reach customers **from your personal Gmail address**
- The three background jobs (payment sweep every 15 minutes, directory rebuild
  hourly, website sync nightly) run under **your** account
- If you ever lose that account, **the entire booking system stops**

Transferring the file is not enough. A deployment keeps running as whoever
deployed it, and triggers belong to whoever installed them. The client has to
create their own.

**In the client's Google account:**

1. Go to [script.google.com](https://script.google.com) → **New project**, name it
   **Ummatically Bookings**
2. Paste in the whole of `apps-script/Code.gs` from the repository
3. **⚙ Project Settings** → tick **Show "appsscript.json" manifest file**, then
   replace that file with `apps-script/appsscript.json` from the repository
4. **Script Properties** — add:
   - `SITE_URL` = `https://ummatically.co.uk/`
   - `STRIPE_SECRET_KEY` = the live key from Stripe
5. Run `setUp`, accepting the permission prompts (Google will warn it's an
   unverified app — that's normal for your own script; choose **Advanced →
   Go to Ummatically Bookings**)
6. Run `installTriggers`
7. **Deploy → New deployment → Web app**, with:
   - Execute as: **Me**
   - Who has access: **Anyone**
8. Copy the `/exec` URL it gives you — **this is new and different from the old one**

**Then, in your Google account:** open the old project and
**Deploy → Manage deployments → Archive**, and delete its triggers
(⏰ **Triggers** in the left sidebar). If you skip this, both copies keep
running and customers get duplicate emails.

---

## 6. Point the site at the new backend

The website still holds the old `/exec` URL, so it must be updated before the
new backend does anything.

1. In `index.html`, find `window.UMMATICALLY_BOOKING` (around line 2065)
2. Replace the `endpoint:` value with the new `/exec` URL from step 5
3. Commit and push — Netlify redeploys within about a minute

**Now test it properly, end to end, before going further:**

- Open `https://ummatically.co.uk`, click **Book Now**, submit a real booking
- Confirm a row appears on **Pending payment** in the spreadsheet
- Confirm the confirmation email arrives **from the client's address**, not yours
- Pay through Stripe, then confirm the booking moves to the event's own tab and
  is marked **Paid**
- Delete the test row afterwards

Do not continue until this passes. Everything after here is harder to undo.

---

## 7. Code, hosting and domain

### GitHub

**Settings → General → Danger Zone → Transfer ownership.** The client needs a
GitHub account first (free). Netlify's connection survives the transfer, but
re-check it afterwards.

### Netlify

Netlify can't transfer a site between personal accounts directly. Either:

- **Simplest:** the client makes a Netlify account, you add them to the team
  (**Team settings → Members**), then remove yourself; or
- **Cleanest:** the client creates their own Netlify site from the transferred
  GitHub repo, then you move the domain across and delete your old site

Whichever you pick, **Netlify holds the DNS**, so move the domain within Netlify
at the same time — otherwise the site goes down.

### Domain

In Hostinger: **Domains → ummatically.co.uk → Transfer**. The client needs a
Hostinger account (or any registrar). You'll need the auth/EPP code from the
domain's settings.

`.uk` transfers usually complete within a day. **Don't touch the nameservers** —
they must stay on `dns1–4.p05.nsone.net` throughout, or the site goes offline.

Alternatively, leave the domain where it is and just transfer the Hostinger
login. Less tidy, but zero risk of downtime. Renews yearly — make sure the
client knows the date and that auto-renew is on.

---

## 8. Handing over the credentials

Don't send passwords or the Stripe key over email, WhatsApp or a text file.

Use a password manager's secure share (Bitwarden Send, 1Password, or Proton
Pass all do this free) and set it to expire after viewing. Or sit with the
client and have them type in their own new passwords while you watch.

Have the client **change every password and turn on two-factor authentication**
on all six accounts once they're in. That's the real handover — not the sharing,
the changing.

---

## 9. Cleaning up

Once the test in step 6 has passed and the client confirms they're in:

- [ ] Remove yourself from Stripe
- [ ] Archive your old Apps Script deployment and delete its triggers
- [ ] Remove yourself from the spreadsheet (or stay as Viewer if they want support)
- [ ] Remove yourself from Netlify and GitHub
- [ ] Take your email out of `DEFAULT_OWNERS` in `Code.gs` so booking alerts
      stop coming to you — then push, and redeploy the script
- [ ] Confirm the old GitHub Pages copy at `sha1sheikh.github.io/ummatically`
      is retired, so there's no stale duplicate of the site

---

## 10. What the client needs to know

Give them this alongside `SETUP.md`, which covers day-to-day running in detail.

**The website.** One page. To change wording, prices, dates or photos, edit
`index.html` in GitHub and it goes live in about a minute. No build step, no
software to install.

**Bookings.** Someone books → it lands on **Pending payment** → they pay via
Stripe → it moves to that event's own tab marked **Paid** and the confirmation
sends. Unpaid bookings never hold a place. Every attendee appears on the
**People** tab, and **All bookings** gathers everything in one view.

**Adding or changing an event.** Edit the event's card in `index.html` and push.
The nightly sync picks up the change, or run `syncEventsFromSite` by hand to do
it immediately. `SETUP.md` covers events with several dates, and events people
pay for offline.

**Capacity.** Set it in the **Events** tab. Blank means unlimited — which is how
places get oversold.

**What it costs.** Netlify and Google are free at this size. Hostinger charges
yearly for the domain. Stripe takes a cut per transaction — current rates are in
the Stripe dashboard.

**The waiver.** `waiver.html` and `waiver.pdf` must stay identical. The PDF is
generated from the HTML, and it's attached to every booking email. If the waiver
wording changes, both files need regenerating.

**Personal data.** The booking form collects names, phone numbers, emergency
contacts and health information. That's UK GDPR territory: keep the spreadsheet
restricted to people who need it, don't copy it around, and keep `privacy.html`
accurate.

---

## 11. Still open

- **Capacity unset** on all ten taster day dates (§2b)
- **`UMM-2609-PP2P`** unresolved (§2c)
- **Stripe payment link quantity** — the women's taster day link is priced per
  place, so anyone booking more than one is told to set the quantity by hand.
  Enabling "adjustable quantity" on the link in Stripe removes that step
- **Three stale rows** in the Events tab: `mens-summer-retreat-jul-2026`
  (**keep** — holds a real paid booking), `ikhwan-missions-retreat-jul-2026`
  (safe to delete), `womens-taster-day-jul-2026` (test data)
