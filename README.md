# Ummatically

The Ummatically website — a single self-contained page, plus the backend that
takes event bookings and payments.

| File | What it is |
|---|---|
| `index.html` | The whole site — markup, styles and scripts in one file, no build step |
| `images/` | Photographs, logo and icons. Referenced by `index.html`, so keep the folder alongside it |
| `privacy.html` | Privacy policy, covering the health information the booking form collects |
| `waiver.html` | Horse riding and archery waiver. Linked from the booking form, which cannot be submitted without accepting it |
| `waiver.pdf` | The same waiver, generated from `waiver.html`, attached to booking emails |
| `apps-script/Code.gs` | The backend: records bookings, emails you and the attendee, takes payment through Stripe |
| `apps-script/appsscript.json` | Apps Script project manifest (permissions and deployment settings) |
| `SETUP.md` | **Start here.** Step-by-step guide to connecting the sheet, the emails and Stripe |

The live spreadsheet is
**[Ummatically Bookings](https://docs.google.com/spreadsheets/d/1fYhsyCe3vG76-2qtCUP9ZS_TNwexZDnhGesC2ggh93Y/edit)**
in Google Drive. Running `setUp` in the Apps Script project builds an Events index, a Summary, a
Read me, one bookings tab per event, a Pending payment tab, and two gathered
views — **All bookings** and **People** — so everyone can be seen in one place.

Booking alerts go to `abuobaydahalyafawe@gmail.com` and
`shawon.sheikh247@gmail.com` — change that via `DEFAULT_OWNERS` in
`apps-script/Code.gs` or a `NOTIFY_EMAIL` script property.

## Booking flow

Someone clicks **Book Now** → fills the form on the page → the booking waits on
**Pending payment** and they get a "finish up" email → Stripe Checkout takes the
payment → the booking moves onto its event's tab, both organisers are emailed,
and the attendee gets their confirmation.

An event's tab therefore lists people who have actually paid. Set
`BOOKING_MODE=record-all` to record and email every attempt instead.

`syncEventsFromSite` reads the Book Now buttons off the published site and
brings the Events tab into line — new events, renames and price changes — daily,
or on demand.

Until `endpoint` is filled in (SETUP.md step 5) the buttons fall back to the old
Google Form, so the site is never left with a dead button.

Once connected, the event cards ask the sheet how many places are actually left
and update themselves; a full event's button becomes an inert "Fully booked". If
the sheet cannot be reached the printed numbers are left alone.

## Editing an event

Event details live on the **Book Now** button itself in `index.html`:

```html
<a class="btn btn--accent btn--block" href="https://forms.gle/FAQ1xaUneawNjMB89"
   data-book
   data-event-id="mens-summer-retreat-jul-2026"
   data-event-title="Men of Ihsan × Muslim Alpha Summer Retreat"
   data-event-type="brothers retreat"
   data-event-price="115"
   data-event-date="Jul 25, 2026 · 2 Days"
   data-event-location="Bromsgrove, Worcestershire">Book Now</a>
```

Capacity and price also go on the **Events** tab of the spreadsheet, matched by
`data-event-id` — which is also what decides the tab a booking lands on. A new
event gets its own tab automatically. See SETUP.md for the details.

## Local preview

No server needed — open `index.html` in a browser, with the `images/` folder
beside it. To test the booking form
locally, temporarily paste your Apps Script `/exec` URL into `endpoint` and set
`SITE_URL` to a real published address, since Stripe cannot redirect back to a
`file://` path.
