# Booking & payments — setup

The site now has its own booking form. This is how you connect it to your email,
a Google Sheet, and Stripe.

Nothing here costs money to run. Google Apps Script is free, and Stripe only
takes its fee when you actually get paid.

---

## How it fits together

```
Visitor clicks "Book Now"
        │
        ▼
  Form on the website  ──POST──►  Google Apps Script (your backend)
                                        │
                                        ├─► writes a row on the Bookings sheet
                                        ├─► emails you the booking
                                        └─► emails the attendee
                                        │
                                        ▼
                                  Stripe Checkout  ──pays──►  back to the site
                                        │
                                        ▼
                          Apps Script asks Stripe "did this really pay?"
                                        │
                                        └─► flips the row to Paid, sends the receipt
```

**One thing I did differently from what you asked.** You described the email
arriving first and *then* triggering something to fill the spreadsheet. I've had
Apps Script write the row and send the email at the same moment instead. It's the
same ingredients, but nothing has to parse an email to find the data, so a
reworded subject line or a message landing in spam can't silently lose a booking.
You still get every email exactly as you wanted.

---

## What you need

- A Google account (the one that should receive booking emails)
- A Stripe account — free to open at [stripe.com](https://stripe.com)
- About 30 minutes

---

## Step 1 — Create the spreadsheet

1. Go to [drive.google.com](https://drive.google.com).
2. **New → File upload**, and pick `bookings.xlsx` from this repository.
3. Once it uploads, double-click it, then **File → Save as Google Sheets**.
   (Apps Script can't write to an `.xlsx` file — it must be a real Google Sheet.)
4. Delete the leftover `.xlsx` from Drive so you don't confuse the two.
5. Rename the sheet to something like **Ummatically Bookings**.

The sheet has four tabs:

| Tab | What it's for |
|---|---|
| **Bookings** | Every booking lands here, newest at the bottom |
| **Events** | Capacity and price per event — the only tab you edit by hand |
| **Summary** | Live totals: paid, awaiting payment, revenue, places left |
| **Read me** | House rules and an example row |

**Copy the spreadsheet ID from the address bar.** It's the long code between
`/d/` and `/edit`:

```
https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit
                                        └────────── this bit ──────────┘
```

---

## Step 2 — Create the Apps Script project

1. Go to [script.google.com](https://script.google.com) → **New project**.
2. Rename it (top left) to **Ummatically Bookings**.
3. Delete whatever is in `Code.gs`, and paste in the whole of
   `apps-script/Code.gs` from this repository.
4. Click the **⚙ Project Settings** cog on the left and tick
   **Show "appsscript.json" manifest file in editor**.
5. Back in the editor, open `appsscript.json` and replace it with
   `apps-script/appsscript.json` from this repository.
6. Save (**Ctrl/Cmd + S**).

---

## Step 3 — Add your settings

Still in **⚙ Project Settings**, scroll to **Script Properties** →
**Add script property**. Add these:

| Property | Value |
|---|---|
| `SPREADSHEET_ID` | the ID you copied in step 1 |
| `NOTIFY_EMAIL` | where booking alerts go, e.g. `bookings@ummatically.com` |
| `SITE_URL` | your live site, e.g. `https://ummatically.com/` |

Leave Stripe alone for now — we'll add it in step 6.

> **`SITE_URL` must be the public address people actually visit.** Stripe sends
> them back there after paying. A `file:///` path or `localhost` won't work.

Now run the setup check:

1. In the editor's function dropdown (top bar), choose **`setUp`**.
2. Click **Run**.
3. Google will ask for permission. Choose your account → you'll see
   **"Google hasn't verified this app"** → click **Advanced** →
   **Go to Ummatically Bookings (unsafe)** → **Allow**.
   That warning is normal: it's *your* script, and Google shows it for anything
   not published to their public marketplace.
4. Look at the **Execution log** at the bottom. It should print your spreadsheet
   name, your notify email, and `Stripe: not configured`.

If it prints `NOT SET` for anything, fix that Script Property and run it again.

---

## Step 4 — Deploy it

1. Top right: **Deploy → New deployment**.
2. Click the **⚙** next to "Select type" and choose **Web app**.
3. Fill in:
   - **Description**: `v1`
   - **Execute as**: **Me**
   - **Who has access**: **Anyone**
4. **Deploy**, then **Authorize access** if prompted.
5. Copy the **Web app URL**. It ends in `/exec`.

> **"Anyone" does not mean anyone can see your data.** It means the web app will
> accept a request from a visitor's browser, which is exactly what a public
> booking form needs. The script runs as *you*, and only ever returns the small
> JSON answers it's written to return.

Check it works: paste the URL into a browser tab and add `?ping=1`. You should
see something like:

```json
{"ok":true,"service":"Ummatically bookings","stripe":false}
```

---

## Step 5 — Point the website at it

Open `index.html` and find this near the bottom (search for `UMMATICALLY_BOOKING`):

```js
window.UMMATICALLY_BOOKING = {
	endpoint: '',
	currency: '£'
};
```

Paste your `/exec` URL between the quotes:

```js
window.UMMATICALLY_BOOKING = {
	endpoint: 'https://script.google.com/macros/s/AKfycb...../exec',
	currency: '£'
};
```

Save, commit, and publish the site.

> Until you fill this in, every **Book Now** button quietly falls back to your old
> Google Form link — so the site never ends up with a dead button mid-setup.

**Test it now, before touching Stripe.** Open the site, click **Book Now**, fill
the form in, and submit. You should get an email, the attendee address should get
one, and a row should appear on the **Bookings** tab with status **Enquiry**.

---

## Step 6 — Connect Stripe

### 6a. Get your test key

1. Sign in at [dashboard.stripe.com](https://dashboard.stripe.com).
2. Make sure the **Test mode** toggle (top right) is **ON**.
3. Go to **Developers → API keys**.
4. Under **Secret key**, click **Reveal test key** and copy it. It starts with
   `sk_test_`.

> The secret key is the password to your money. It only ever goes in Script
> Properties — never in `index.html`, never in a commit, never in a message.

### 6b. Give it to the script

Apps Script → **⚙ Project Settings → Script Properties → Add script property**:

| Property | Value |
|---|---|
| `STRIPE_SECRET_KEY` | your `sk_test_...` key |

### 6c. Redeploy

Apps Script caches the deployed code, so a settings change alone isn't enough:

**Deploy → Manage deployments → ✏️ (edit) → Version: New version → Deploy**

Your `/exec` URL stays the same, so there's nothing to change on the website.

### 6d. Make a test payment

1. Open the site and book a place.
2. You should land on Stripe Checkout.
3. Pay with Stripe's test card:
   - Card **4242 4242 4242 4242**
   - Any future expiry, any 3-digit CVC, any postcode
4. You'll come back to the site and see **"You are booked in"** with a reference.
5. Check the sheet: the row should now say **Paid**, with a Stripe session, a
   payment ID, and a paid-at time.

Other cards worth trying: `4000 0000 0000 9995` is declined, and
`4000 0025 0000 3155` asks for 3-D Secure.

### 6e. Go live

When you're happy:

1. Stripe dashboard → switch **Test mode OFF**.
2. Complete Stripe's account activation (bank details, ID) if you haven't.
3. **Developers → API keys** → copy the **live** secret key (`sk_live_...`).
4. Replace `STRIPE_SECRET_KEY` in Script Properties with the live key.
5. **Redeploy again** (6c).
6. Make one real booking with your own card for a small amount, then refund it
   from the Stripe dashboard. It's worth the £1 to know the whole chain works.

---

## Step 7 — Catch anyone who pays and closes the tab

If someone pays but shuts the browser before being redirected back, the sheet
would sit on "Awaiting payment" forever. A timer fixes that.

1. Apps Script editor → function dropdown → **`installTriggers`** → **Run**.
2. That's it. Every 15 minutes the script asks Stripe about anything still
   pending, marks the paid ones **Paid**, and marks anything unpaid after two
   days **Expired**.

You can see it under **⏰ Triggers** in the left sidebar.

---

## Running it day to day

### Adding or changing an event

Two places have to agree, and they agree on the **Event ID**.

**In `index.html`**, each event's button carries its own details:

```html
<a class="btn btn--accent btn--block"
   href="https://forms.gle/FAQ1xaUneawNjMB89"
   data-book
   data-event-id="mens-summer-retreat-jul-2026"
   data-event-title="Men of Ihsan × Muslim Alpha Summer Retreat"
   data-event-type="brothers retreat"
   data-event-price="115"
   data-event-date="Jul 25, 2026 · 2 Days"
   data-event-location="Bromsgrove, Worcestershire">Book Now</a>
```

`data-event-price` is the price **per place**, digits only — `115`, not `£115`.

**On the Events tab**, add a row with the *same* `Event ID`, plus capacity and
price. Capacity is what stops overbooking: once Places Held reaches it, the form
turns people away and tells them to email you for the waiting list.

> An event that isn't listed on the Events tab still takes bookings — it just
> isn't capped.

### Statuses

| Status | Meaning |
|---|---|
| **Enquiry** | Recorded, no payment set up (or the event is free) |
| **Awaiting payment** | Sent to Stripe, hasn't paid yet |
| **Paid** | Money received |
| **Expired** | Unpaid after two days — set automatically |
| **Cancelled** / **Refunded** | Set by you, by hand |

Setting a row to **Cancelled**, **Expired** or **Refunded** releases its places
back to the event, so the spot can be sold again. Refunding in Stripe does *not*
update the sheet — change the status yourself.

### Turning payments off temporarily

Delete the `STRIPE_SECRET_KEY` property and redeploy. Bookings still get recorded
and emailed; they just come in as enquiries for you to invoice by hand.

---

## If something goes wrong

| What you see | What it usually is |
|---|---|
| "Book Now" opens the old Google Form | `endpoint` in `index.html` is still empty, or the site hasn't been republished |
| "We could not submit your booking" | Deployment is wrong. Re-check step 4: **Execute as: Me**, **Who has access: Anyone** |
| `Missing Script Property: …` | A setting from step 3 is missing or misspelled |
| `Sheet tab "Bookings" is missing` | Run **`setUp`** once (step 3) |
| Emails never arrive | Check spam first. Gmail allows ~100 script emails a day, Workspace ~1,500 — each booking sends 2 |
| Stripe says "No such API key" | Test key with live mode, or vice versa. Also make sure you redeployed after changing it |
| Paid on Stripe but the sheet says awaiting | The 15-minute sweep will catch it. To force it, run **`reconcilePendingBookings`** by hand |
| Changed the code, nothing changed | You must **Deploy → Manage deployments → New version** every time |

**Where to look:** Apps Script's left sidebar has **Executions**, which logs every
call with its error. Stripe's dashboard has **Developers → Logs** and **Payments**.

---

## Notes on safety and privacy

- The Stripe secret key lives only in Script Properties. Card details never touch
  your site or your sheet — Stripe handles all of it.
- The form has a hidden honeypot field that bots fill in and people don't;
  anything that fills it is silently dropped.
- Whether a payment succeeded is always confirmed by asking Stripe directly, so a
  visitor can't mark themselves paid by editing the return URL.
- The form collects medical details and emergency contacts. Keep the sheet shared
  as narrowly as you can, and delete old events' data once you no longer need it.
  If you don't have a privacy notice yet, the footer already links to one — it's
  worth writing before you take the first real booking.
