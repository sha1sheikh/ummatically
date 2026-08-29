# Ummatically

The Ummatically website — a single self-contained page, plus the backend that
takes event bookings and payments.

| File | What it is |
|---|---|
| `index.html` | The whole site. Styles, scripts and images are inlined, so it runs from any static host with no build step |
| `bookings.xlsx` | The bookings spreadsheet — upload it to Google Drive and convert it to a Google Sheet |
| `apps-script/Code.gs` | The backend: records bookings, emails you and the attendee, takes payment through Stripe |
| `apps-script/appsscript.json` | Apps Script project manifest (permissions and deployment settings) |
| `SETUP.md` | **Start here.** Step-by-step guide to connecting the sheet, the emails and Stripe |

## Booking flow

Someone clicks **Book Now** → fills the form on the page → Apps Script writes a
row to the sheet, emails you and emails them → Stripe Checkout takes payment →
they land back on the site and the row flips to **Paid**.

Until `endpoint` is filled in (SETUP.md step 5) the buttons fall back to the old
Google Form, so the site is never left with a dead button.

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
`data-event-id`. See SETUP.md for the details.

## Local preview

No server needed — open `index.html` in a browser. To test the booking form
locally, temporarily paste your Apps Script `/exec` URL into `endpoint` and set
`SITE_URL` to a real published address, since Stripe cannot redirect back to a
`file://` path.
