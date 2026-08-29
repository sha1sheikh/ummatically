# Booking & payments — setup

The site now has its own booking form. This is how you connect it to your email,
your Google Sheet, and Stripe.

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
                                        ├─► holds the booking on "Pending payment"
                                        └─► emails the attendee a "finish up" note
                                        │
                                        ▼
                                  Stripe Checkout  ──pays──►  back to the site
                                        │
                                        ▼
                          Apps Script asks Stripe "did this really pay?"
                                        │
                                        ├─► moves the booking to its event's tab
                                        ├─► emails BOTH organisers
                                        └─► emails the attendee their confirmation
```

**Nothing reaches an event's tab until the money arrives.** An event's tab is a
list of people who are actually coming. An unfinished booking waits on the
**Pending payment** tab, and you are emailed when the payment lands, not before.

Bookings are written straight to the sheet rather than parsed back out of an
email — same ingredients, but a reworded subject line or a message landing in
spam can't silently lose one.

---

## What you need

- The Google account that owns the spreadsheet (`shawon.sheikh247@gmail.com`)
- A Stripe account — free to open at [stripe.com](https://stripe.com)
- About 30 minutes

---

## Step 1 — Your spreadsheet

**It already exists.** I created it in your Google Drive:

**[Ummatically Bookings](https://docs.google.com/spreadsheets/d/1fYhsyCe3vG76-2qtCUP9ZS_TNwexZDnhGesC2ggh93Y/edit)**

It opens empty — the script fills in all four tabs when you run `setUp` in
step 3. Its ID is already built into `Code.gs`, so there is nothing to copy or
paste.

Once step 3 has run, it will have:

| Tab | What it's for |
|---|---|
| **Events** | The index: capacity and price per event, and which tab holds its bookings. The only tab you edit by hand |
| **Summary** | Live totals across every event: paid, awaiting payment, revenue, places left |
| **One tab per event** | Named after the event — people who have paid for it, and nobody else |
| **Pending payment** | Bookings part-way through checkout. They move to their event's tab once paid, or expire after two days |
| **All bookings** | Every booking across every event, in one list |
| **People** | One row per person: what they've booked, what they've paid, dietary and medical notes |
| **Read me** | House rules and what a booking row looks like |

Bookings are kept apart, one tab per event, so you can hand a single event's
list to whoever is running it without exposing the others. A new event gets its
tab automatically the first time someone books it.

> **Want to use a different sheet instead?** Create one, copy the long code
> between `/d/` and `/edit` in its address bar, and add it as a
> `SPREADSHEET_ID` script property in step 3. That overrides the built-in one.

> For an offline copy at any point, use **File → Download** in Google Sheets.

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

## Step 3 — Add your settings and build the sheet

Most of this is already filled in for you. In **⚙ Project Settings**, scroll to
**Script Properties** → **Add script property**, and add the one setting that
can't be guessed:

| Property | Value |
|---|---|
| `SITE_URL` | your live site, e.g. `https://ummatically.com/` |

> **`SITE_URL` must be the public address people actually visit.** Stripe sends
> them back there after paying. A `file:///` path or `localhost` won't work.

These are optional — set one only if you want to override what's already in
`Code.gs`:

| Property | Overrides |
|---|---|
| `SPREADSHEET_ID` | the sheet from step 1 |
| `NOTIFY_EMAIL` | who gets booking alerts (comma-separated for several people) |
| `ORG_NAME` | the name on outgoing emails, currently `Ummatically` |
| `CURRENCY` | the currency, currently `gbp` |
| `BOOKING_MODE` | set to `record-all` to put unpaid attempts straight on the event tab and email you immediately. The default, `paid-only`, holds them back |

**Booking alerts already go to both of you:**
`abuobaydahalyafawe@gmail.com` and `shawon.sheikh247@gmail.com`. Attendees who
reply to a confirmation email reach the first address. To change either, edit
`DEFAULT_OWNERS` at the top of `Code.gs`, or set `NOTIFY_EMAIL` to override
without touching the code.

Now build the spreadsheet:

1. In the editor's function dropdown (top bar), choose **`setUp`**.
2. Click **Run**.
3. Google will ask for permission. Choose your account → you'll see
   **"Google hasn't verified this app"** → click **Advanced** →
   **Go to Ummatically Bookings (unsafe)** → **Allow**.
   That warning is normal: it's *your* script, and Google shows it for anything
   not published to their public marketplace.
4. Look at the **Execution log** at the bottom. It should print your spreadsheet
   name and URL, both booking-alert addresses, your site URL, and
   `Stripe: not configured`.
5. Open the sheet — it now has all four tabs, formatted and ready.

If it prints `NOT SET` for the site URL, fix that Script Property and run it
again. Running `setUp` a second time is harmless: it only creates what's
missing, and never touches booking rows.

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
one, and a row should appear on that event's own tab with status **Enquiry**.

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
2. That's it. Three timers go in:

| Timer | What it does |
|---|---|
| Every 15 minutes | Asks Stripe about anything still pending. Paid ones move to their event tab; anything unpaid after two days is marked **Expired** and its places released |
| Hourly | Rebuilds the **All bookings** and **People** tabs |
| Daily, 4am | Reads the events off your website into the Events tab (see below) |

You can see them under **⏰ Triggers** in the left sidebar.

---

## Running it day to day

### Changing the events on your website

Edit `index.html` as normal, then let the sheet catch up. Two places have to
agree, and they agree on the **Event ID**.

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

**Then run `syncEventsFromSite`** from the Apps Script function dropdown. It
reads your published site and brings the Events tab into line:

| On the site | In the sheet |
|---|---|
| A new event | Gets an Events row and its own bookings tab. Set its Capacity by hand |
| A renamed or repriced event | Name and Price updated in place. Its tab and bookings are untouched |
| An event you removed | Left alone and reported in the log. Past events keep their bookings |

It never overwrites **Capacity** — that column is yours.

It runs itself daily at 4am once you've done step 7, so you can also just edit
the site and leave it. Run it by hand when you want the sheet updated now.

> It reads the **published** site at `SITE_URL`, not your local file. Publish
> your changes first, or it will keep reading the old events.

**Capacity is the one thing you set in the sheet, not on the site.** The
"30 spots remaining" text on the page is just text — the real limit is the
Capacity column. Once Places Held reaches it, the form turns people away and
points them at you for the waiting list. Leave it blank for no limit.

> An event booked from the site but missing from the Events tab is added for you,
> with a tab of its own and no capacity limit. So a typo in `data-event-id`
> shows up as a stray event row rather than a lost booking.

> Renaming a bookings tab is fine, as long as you change its **Bookings Tab**
> cell to match. Otherwise the script will make a fresh tab under the old name.

### Seeing everyone in one place

Bookings are split by event, so three tabs pull them back together:

- **All bookings** — every booking across every event, newest first, filterable.
- **People** — one row per person, matched on email. Their bookings, places,
  total paid, what's outstanding, which events they've been to, and their
  dietary and medical notes gathered up. This is your attendee directory: search
  a name and you have everything about them.
- **Summary** — the numbers rather than the names.

Both rebuild themselves hourly, and immediately whenever a payment lands. They
are generated, so anything you type on them is overwritten — edit a booking on
its own event tab.

To rebuild them now, run **`rebuildDirectory`**.

**In Stripe, the equivalent is Customers.** Every payer is recorded as a proper
Stripe customer, so **Dashboard → Customers** lists everyone who has ever paid
you, with their payment history, total spend, and any refunds. Each payment is
also labelled with the event and the attendee's name, so **Payments** reads as a
list of bookings rather than anonymous amounts.

Use whichever fits the question: **Stripe** for anything about money — who paid,
when, how much, refunds, payouts. **The sheet** for anything about running the
event — dietary needs, medical notes, emergency contacts, who's coming to what.
Deliberately, the medical and emergency details stay out of Stripe.

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
| `Missing Script Property: SITE_URL` | Add it in step 3 — it's the one setting with no default |
| `Sheet tab "Bookings" is missing` | Run **`setUp`** once (step 3) |
| The sheet is still empty | `setUp` hasn't run, or it ran against a different sheet. Its log prints the URL it used — check that's the one you're looking at |
| A booking went to the wrong tab | The tab is chosen by `data-event-id`. Two events sharing an id share a tab — give each its own |
| An event tab appeared unexpectedly | A booking arrived with an id that isn't on the Events tab. Check `data-event-id` in `index.html` against the Events tab |
| Only one of you gets the emails | Check the other address's spam folder, then the `NOTIFY_EMAIL` property and `DEFAULT_OWNERS` in `Code.gs` |
| Emails never arrive | Check spam first. Gmail allows ~100 script emails a day, Workspace ~1,500 — each booking emails both owners and the attendee |
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
