/**
 * Ummatically — bookings backend.
 *
 * Receives booking forms from the website, records them in Google Sheets,
 * emails you and the attendee, and takes payment through Stripe Checkout.
 *
 * Configuration lives in Script Properties, never in this file:
 *   SPREADSHEET_ID     required  the id in your Google Sheet's URL
 *   NOTIFY_EMAIL       optional  who gets new-booking alerts; comma-separated for
 *                                several people. Defaults to DEFAULT_OWNERS below.
 *   SITE_URL           required  the public URL of the site, e.g. https://ummatically.com/
 *   STRIPE_SECRET_KEY  optional  sk_test_… or sk_live_…; without it bookings are
 *                                recorded and emailed but no payment is taken
 *   ORG_NAME           optional  defaults to "Ummatically"
 *   CURRENCY           optional  ISO code, defaults to "gbp"
 *
 * See SETUP.md in the repository for the full walkthrough.
 */

/**
 * Who gets told about every booking. Add or remove addresses here, or override
 * the whole list without touching the code by setting a NOTIFY_EMAIL script
 * property (comma-separated). The first address is the one attendees reply to.
 */
var DEFAULT_OWNERS = 'abuobaydahalyafawe@gmail.com, shawon.sheikh247@gmail.com';

/**
 * The Google Sheet this writes to. Override with a SPREADSHEET_ID script
 * property to point at a different one. The id on its own grants nobody
 * access — that is controlled by who the sheet is shared with.
 */
var DEFAULT_SPREADSHEET_ID = '1fYhsyCe3vG76-2qtCUP9ZS_TNwexZDnhGesC2ggh93Y';

/** How far down the sheet the Events and Summary formulas look. */
var FORMULA_ROWS = 5000;

var NAVY = '#00175c';
var GREY = '#666666';
var BLUE = '#0000ff';

/** Only used to migrate a sheet built by an earlier version. */
var LEGACY_BOOKINGS_SHEET = 'Bookings';

var EVENTS_SHEET = 'Events';

/**
 * Where a booking waits while its payment is in progress. Nothing reaches an
 * event's own tab until Stripe confirms the money arrived.
 */
var PENDING_SHEET = 'Pending payment';
var STRIPE_API = 'https://api.stripe.com/v1/';

var COLUMNS = [
  'Timestamp', 'Reference', 'Status', 'Event', 'Event ID', 'Event Date', 'Location',
  'Name', 'Email', 'Phone', 'Age', 'Places', 'Unit Price', 'Total', 'Currency',
  'Emergency Contact', 'Emergency Phone', 'Dietary', 'Medical', 'Heard From', 'Notes',
  'Photo Consent', 'Terms Accepted', 'Stripe Session', 'Stripe Payment', 'Paid At'
];

/* ==========================================================================
   Configuration helpers
   ========================================================================== */

/** The Events tab, which indexes every per-event bookings tab. */
var EVENT_COLUMNS = [
  'Event ID', 'Event Name', 'Capacity', 'Price', 'Bookings Tab', 'Notes',
  'Bookings', 'Paid', 'Awaiting', 'Enquiries', 'Closed',
  'Places Held', 'Places Paid', 'Remaining', 'Revenue Collected', 'Revenue Outstanding'
];

var CLOSED_STATUSES = ['Cancelled', 'Expired', 'Refunded'];

function config_(key, fallback) {
  var value = PropertiesService.getScriptProperties().getProperty(key);
  return value === null || value === '' ? fallback : value;
}

function requiredConfig_(key) {
  var value = config_(key, '');
  if (!value) {
    throw new Error('Missing Script Property: ' + key + '. See SETUP.md step 3.');
  }
  return value;
}

/** The owner addresses, as a list. */
function owners_() {
  var list = config_('NOTIFY_EMAIL', DEFAULT_OWNERS)
    .split(/[,;]/)
    .map(function (address) { return address.trim(); })
    .filter(String);

  if (!list.length) {
    throw new Error('No owner address configured. Set NOTIFY_EMAIL or DEFAULT_OWNERS.');
  }

  return list;
}

/** All owners, ready for a MailApp "to" field. */
function ownerList_() {
  return owners_().join(',');
}

/** A single address for attendees to reply to. */
function replyAddress_() {
  return owners_()[0];
}

/**
 * 'paid-only'  (default) an event's tab holds paid bookings only. Unpaid
 *              attempts wait on the Pending payment tab and the organisers are
 *              emailed when the payment lands, not before.
 * 'record-all' every attempt goes straight to the event's tab and emails the
 *              organisers immediately, paid or not.
 *
 * Free events, and any booking taken while Stripe is not configured, always
 * behave as 'record-all' — there is no payment to wait for.
 */
function bookingMode_() {
  return config_('BOOKING_MODE', 'paid-only') === 'record-all' ? 'record-all' : 'paid-only';
}

function orgName_() {
  return config_('ORG_NAME', 'Ummatically');
}

function currency_() {
  return config_('CURRENCY', 'gbp').toLowerCase();
}

function currencySymbol_() {
  var symbols = { gbp: '£', usd: '$', eur: '€' };
  return symbols[currency_()] || '';
}

function stripeKey_() {
  return config_('STRIPE_SECRET_KEY', '');
}

function siteUrl_() {
  var url = requiredConfig_('SITE_URL');
  return url.indexOf('?') === -1 ? url : url.split('?')[0];
}

/* ==========================================================================
   Web app entry points
   ========================================================================== */

function doGet(e) {
  // Used to check the deployment is alive: .../exec?ping=1
  return json_({ ok: true, service: orgName_() + ' bookings', stripe: !!stripeKey_() });
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    switch (body.action) {
      case 'book':
        return json_(createBooking_(body));
      case 'confirm':
        return json_(confirmBooking_(body.sessionId));
      default:
        return json_({ ok: false, error: 'Unknown action.' });
    }
  } catch (error) {
    console.error(error);
    return json_({ ok: false, error: error.message || 'Unexpected error.' });
  }
}

function json_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ==========================================================================
   Sheet access
   ========================================================================== */

function book_() {
  return SpreadsheetApp.openById(config_('SPREADSHEET_ID', DEFAULT_SPREADSHEET_ID));
}

function columnIndex_(name) {
  var index = COLUMNS.indexOf(name);
  if (index === -1) {
    throw new Error('Unknown column: ' + name);
  }
  return index + 1;
}

function eventColumnIndex_(name) {
  var index = EVENT_COLUMNS.indexOf(name);
  if (index === -1) {
    throw new Error('Unknown Events column: ' + name);
  }
  return index + 1;
}

/* ==========================================================================
   Per-event bookings tabs

   Every event gets its own tab, with the same columns. The Events tab is the
   index: each row names the tab that holds its bookings.
   ========================================================================== */

/** A tab name Google Sheets will accept. */
function safeTabName_(name) {
  var clean = String(name || '')
    .replace(/[\[\]\*\?\/\\:]/g, ' ')
    .replace(/^'+|'+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);

  return clean || 'Event';
}

/** Every row of the Events tab, as objects. */
function eventRows_() {
  var sheet = book_().getSheetByName(EVENTS_SHEET);

  if (!sheet || sheet.getLastRow() < 2) {
    return [];
  }

  var width = Math.min(sheet.getLastColumn(), EVENT_COLUMNS.length);
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
  var rows = [];

  values.forEach(function (row, index) {
    var id = String(row[eventColumnIndex_('Event ID') - 1] || '').trim();

    if (!id) {
      return;
    }

    rows.push({
      row: index + 2,
      id: id,
      name: String(row[eventColumnIndex_('Event Name') - 1] || '').trim(),
      capacity: row[eventColumnIndex_('Capacity') - 1],
      tab: String(row[eventColumnIndex_('Bookings Tab') - 1] || '').trim()
    });
  });

  return rows;
}

/** The tabs that hold bookings, newest events last. */
function eventTabs_() {
  var spreadsheet = book_();

  return eventRows_()
    .map(function (event) { return event.tab; })
    .filter(function (name) { return name && spreadsheet.getSheetByName(name); });
}

/** The staging tab, created on first use. */
function pendingSheet_() {
  var spreadsheet = book_();

  return spreadsheet.getSheetByName(PENDING_SHEET)
    || buildBookingsTab_(spreadsheet, PENDING_SHEET, '#b8791f');
}

/**
 * The bookings tab for an event, creating it — and its Events row — the first
 * time that event is booked.
 */
function eventSheet_(eventId, eventTitle) {
  var spreadsheet = book_();
  var events = eventRows_();
  var match = null;

  for (var i = 0; i < events.length; i++) {
    if (events[i].id === eventId) {
      match = events[i];
      break;
    }
  }

  var wanted = safeTabName_((match && match.name) || eventTitle || eventId);

  if (match && match.tab && spreadsheet.getSheetByName(match.tab)) {
    return spreadsheet.getSheetByName(match.tab);
  }

  // Never hand two events the same tab.
  var taken = {};

  events.forEach(function (event) {
    if (event.id !== eventId && event.tab) {
      taken[event.tab] = true;
    }
  });

  var name = wanted;
  var suffix = 2;

  // Only step aside for a tab that belongs to a *different* event. A tab left
  // behind by this same event — its Events row deleted, say — is reused, so an
  // event never ends up with its bookings split across two tabs.
  while (taken[name] || !tabFreeFor_(spreadsheet.getSheetByName(name), eventId)) {
    name = wanted.slice(0, 86) + ' (' + suffix + ')';
    suffix++;
  }

  var sheet = spreadsheet.getSheetByName(name) || buildBookingsTab_(spreadsheet, name);

  registerEventTab_(eventId, eventTitle, name, match);

  return sheet;
}

/** True when a tab is absent, empty, or already holds this event's bookings. */
function tabFreeFor_(sheet, eventId) {
  if (!sheet || sheet.getLastRow() < 2) {
    return true;
  }

  var ids = sheet.getRange(2, columnIndex_('Event ID'), sheet.getLastRow() - 1, 1).getValues();

  for (var i = 0; i < ids.length; i++) {
    var id = String(ids[i][0]).trim();

    if (id && id !== eventId) {
      return false;
    }
  }

  return true;
}

/** Records the tab name against the event, adding the event row if it is new. */
function registerEventTab_(eventId, eventTitle, tabName, match) {
  var sheet = book_().getSheetByName(EVENTS_SHEET);

  if (!sheet) {
    return;
  }

  if (match) {
    sheet.getRange(match.row, eventColumnIndex_('Bookings Tab')).setValue(tabName);
    writeEventFormulas_(sheet, match.row, tabName);
    return;
  }

  var row = Math.max(sheet.getLastRow() + 1, 2);

  sheet.getRange(row, 1, 1, 6).setValues([[
    eventId,
    safeTabName_(eventTitle || eventId),
    '',              // capacity: blank means uncapped
    '',              // price: for your reference only
    tabName,
    'Added automatically on the first booking.'
  ]]).setFontFamily('Arial').setFontSize(10);

  sheet.getRange(row, 1, 1, 4).setFontColor(BLUE);
  writeEventFormulas_(sheet, row, tabName);
}

/* ==========================================================================
   Booking
   ========================================================================== */

function createBooking_(body) {
  if (body.website) {
    return { ok: false, error: 'Rejected.' };
  }

  var clean = sanitise_(body);
  var problems = validate_(clean);

  if (problems.length) {
    return { ok: false, error: problems[0] };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    var remaining = spotsRemaining_(clean.eventId);

    if (remaining !== null && remaining < clean.places) {
      return {
        ok: false,
        error: remaining <= 0
          ? 'This event is now fully booked. Please email us to join the waiting list.'
          : 'Only ' + remaining + ' place(s) left for this event.'
      };
    }

    var ref = reference_();
    var session = null;

    if (stripeKey_() && clean.total > 0) {
      session = createCheckoutSession_(clean, ref);
    }

    // With no payment to wait for there is nothing to hold back.
    var holding = session && bookingMode_() === 'paid-only';
    var target = holding
      ? pendingSheet_()
      : eventSheet_(clean.eventId, clean.eventTitle);

    appendBooking_(target, clean, ref, session);

    if (holding) {
      // The organisers hear about this once the money lands, in markPaid_.
      emailAttendee_(clean, ref, 'pending');
    } else {
      notifyOwner_(clean, ref, session ? 'Awaiting payment' : 'Enquiry');
      emailAttendee_(clean, ref, session ? 'pending' : 'recorded');
    }

    return session
      ? { ok: true, ref: ref, checkoutUrl: session.url }
      : { ok: true, ref: ref };
  } finally {
    lock.releaseLock();
  }
}

function sanitise_(body) {
  var trim = function (value, max) {
    return String(value === undefined || value === null ? '' : value).trim().slice(0, max || 500);
  };

  var places = Math.min(Math.max(parseInt(body.places, 10) || 1, 1), 10);
  var unitPrice = Math.max(parseFloat(body.unitPrice) || 0, 0);

  return {
    eventId: trim(body.eventId, 80),
    eventTitle: trim(body.eventTitle, 200),
    eventDate: trim(body.eventDate, 120),
    eventLocation: trim(body.eventLocation, 160),
    name: trim(body.name, 120),
    email: trim(body.email, 160).toLowerCase(),
    phone: trim(body.phone, 40),
    age: trim(body.age, 6),
    places: places,
    unitPrice: unitPrice,
    total: Math.round(unitPrice * places * 100) / 100,
    emergencyName: trim(body.emergencyName, 120),
    emergencyPhone: trim(body.emergencyPhone, 40),
    dietary: trim(body.dietary, 400),
    medical: trim(body.medical, 1000),
    heardFrom: trim(body.heardFrom, 80),
    notes: trim(body.notes, 1000),
    photoConsent: !!body.photoConsent,
    terms: !!body.terms
  };
}

function validate_(data) {
  var problems = [];

  if (!data.name) {
    problems.push('Please give your name.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) {
    problems.push('Please give a valid email address.');
  }
  if (data.phone.replace(/[^0-9]/g, '').length < 7) {
    problems.push('Please give a contact number.');
  }
  if (!data.emergencyName || !data.emergencyPhone) {
    problems.push('Please give an emergency contact.');
  }
  if (!data.terms) {
    problems.push('Please accept the booking terms.');
  }
  if (!data.eventTitle) {
    problems.push('That event could not be identified.');
  }

  return problems;
}

function reference_() {
  var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var suffix = '';

  for (var i = 0; i < 4; i++) {
    suffix += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyMM');
  return 'UMM-' + stamp + '-' + suffix;
}

function appendBooking_(sheet, data, ref, session) {
  sheet.appendRow([
    new Date(),
    ref,
    session ? 'Awaiting payment' : 'Enquiry',
    data.eventTitle,
    data.eventId,
    data.eventDate,
    data.eventLocation,
    data.name,
    data.email,
    data.phone,
    data.age,
    data.places,
    data.unitPrice,
    data.total,
    currency_().toUpperCase(),
    data.emergencyName,
    data.emergencyPhone,
    data.dietary,
    data.medical,
    data.heardFrom,
    data.notes,
    data.photoConsent ? 'Yes' : 'No',
    data.terms ? 'Yes' : 'No',
    session ? session.id : '',
    '',
    ''
  ]);
}

/* ==========================================================================
   Capacity
   ========================================================================== */

/**
 * Places left for an event, or null when the Events tab gives it no capacity
 * (in which case bookings are never turned away).
 */
function spotsRemaining_(eventId) {
  if (!eventId) {
    return null;
  }

  var events = eventRows_();
  var match = null;

  for (var i = 0; i < events.length; i++) {
    if (events[i].id === eventId) {
      match = events[i];
      break;
    }
  }

  if (!match) {
    return null;
  }

  var capacity = parseInt(match.capacity, 10);

  if (isNaN(capacity)) {
    return null;
  }

  return Math.max(capacity - placesTaken_(match), 0);
}

/**
 * Places held for an event: those confirmed on its own tab, plus any still
 * waiting on the staging tab. Payments in progress have to count, or two people
 * could take the same last place.
 */
function placesTaken_(event) {
  var spreadsheet = book_();
  var taken = 0;

  if (event.tab) {
    taken += placesOnSheet_(spreadsheet.getSheetByName(event.tab), null);
  }

  return taken + placesOnSheet_(spreadsheet.getSheetByName(PENDING_SHEET), event.id);
}

/** Open places on one sheet, optionally limited to a single event. */
function placesOnSheet_(sheet, eventId) {
  if (!sheet || sheet.getLastRow() < 2) {
    return 0;
  }

  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, COLUMNS.length).getValues();
  var statusCol = columnIndex_('Status') - 1;
  var placesCol = columnIndex_('Places') - 1;
  var idCol = columnIndex_('Event ID') - 1;
  var taken = 0;

  rows.forEach(function (row) {
    if (eventId && String(row[idCol]).trim() !== eventId) {
      return;
    }
    if (CLOSED_STATUSES.indexOf(String(row[statusCol])) !== -1) {
      return;
    }
    taken += parseInt(row[placesCol], 10) || 0;
  });

  return taken;
}

/* ==========================================================================
   Stripe
   ========================================================================== */

function stripe_(path, payload, method) {
  var options = {
    method: method || (payload ? 'post' : 'get'),
    headers: { Authorization: 'Bearer ' + stripeKey_() },
    muteHttpExceptions: true
  };

  if (payload) {
    options.payload = payload;
  }

  var response = UrlFetchApp.fetch(STRIPE_API + path, options);
  var parsed = JSON.parse(response.getContentText());

  if (response.getResponseCode() >= 400) {
    var message = (parsed.error && parsed.error.message) || 'Stripe request failed.';
    throw new Error('Stripe: ' + message);
  }

  return parsed;
}

function createCheckoutSession_(data, ref) {
  var site = siteUrl_();
  var separator = site.indexOf('?') === -1 ? '?' : '&';

  var payload = {
    'mode': 'payment',
    // Without this, Checkout records a one-off "guest" and the payer never
    // appears under Customers in the Stripe dashboard.
    'customer_creation': 'always',
    'success_url': site + separator + 'booking=success&session_id={CHECKOUT_SESSION_ID}',
    'cancel_url': site + separator + 'booking=cancelled',
    'client_reference_id': ref,
    'customer_email': data.email,
    'line_items[0][quantity]': data.places,
    'line_items[0][price_data][currency]': currency_(),
    'line_items[0][price_data][unit_amount]': Math.round(data.unitPrice * 100),
    'line_items[0][price_data][product_data][name]': data.eventTitle,
    'metadata[reference]': ref,
    'metadata[eventId]': data.eventId,
    'metadata[name]': data.name,
    'metadata[phone]': data.phone,
    'metadata[places]': data.places,
    'payment_intent_data[description]': data.eventTitle + ' — ' + data.name
      + ' (' + data.places + ' place' + (data.places === 1 ? '' : 's') + ')'
  };

  var description = [data.eventDate, data.eventLocation].filter(String).join(' · ');

  if (description) {
    payload['line_items[0][price_data][product_data][description]'] = description;
  }

  return stripe_('checkout/sessions', payload);
}

/**
 * Marks a booking paid. Safe to call from the browser: the answer comes from
 * Stripe, not from whoever made the request.
 */
function confirmBooking_(sessionId) {
  if (!sessionId) {
    return { ok: false, error: 'Missing session id.' };
  }
  if (!stripeKey_()) {
    return { ok: false, error: 'Payments are not configured.' };
  }

  var session = stripe_('checkout/sessions/' + encodeURIComponent(sessionId));

  if (session.payment_status !== 'paid') {
    return { ok: false, error: 'Payment is not complete yet.' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    var marked = markPaid_(session);
    return { ok: true, ref: marked.ref, status: 'Paid' };
  } finally {
    lock.releaseLock();
  }
}

function markPaid_(session) {
  var found = findBySession_(session);

  if (!found) {
    return { ref: session.client_reference_id || '' };
  }

  var sheet = found.sheet;
  var row = found.row;
  var statusCol = columnIndex_('Status');
  var alreadyPaid = String(sheet.getRange(row, statusCol).getValue()) === 'Paid';

  sheet.getRange(row, statusCol).setValue('Paid');
  sheet.getRange(row, columnIndex_('Stripe Payment')).setValue(session.payment_intent || '');
  sheet.getRange(row, columnIndex_('Paid At')).setValue(new Date());

  var values = sheet.getRange(row, 1, 1, COLUMNS.length).getValues()[0];
  var ref = values[columnIndex_('Reference') - 1];

  // A booking that was waiting on payment now belongs on its event's tab.
  if (sheet.getName() === PENDING_SHEET) {
    var record = rowToBooking_(values);

    eventSheet_(record.eventId, record.eventTitle).appendRow(values);
    sheet.deleteRow(row);
  }

  if (!alreadyPaid) {
    var booking = rowToBooking_(values);
    emailAttendee_(booking, ref, 'paid');
    notifyOwner_(booking, ref, 'PAID');
  }

  rebuildDirectory();

  return { ref: ref };
}

/**
 * Locates the booking a Stripe session belongs to. The session carries its
 * event id, so this normally opens exactly one tab; the sweep over every tab
 * is the fallback for a session created before that metadata existed.
 */
function findBySession_(session) {
  var eventId = (session.metadata && session.metadata.eventId) || '';
  var names = [PENDING_SHEET];

  if (eventId) {
    eventRows_().forEach(function (event) {
      if (event.id === eventId && event.tab) {
        names.push(event.tab);
      }
    });
  }

  eventTabs_().forEach(function (name) {
    if (names.indexOf(name) === -1) {
      names.push(name);
    }
  });

  var spreadsheet = book_();
  var sessionCol = columnIndex_('Stripe Session');

  for (var i = 0; i < names.length; i++) {
    var sheet = spreadsheet.getSheetByName(names[i]);

    if (!sheet || sheet.getLastRow() < 2) {
      continue;
    }

    var ids = sheet.getRange(2, sessionCol, sheet.getLastRow() - 1, 1).getValues();

    for (var j = 0; j < ids.length; j++) {
      if (String(ids[j][0]) === session.id) {
        return { sheet: sheet, row: j + 2 };
      }
    }
  }

  return null;
}

function rowToBooking_(row) {
  var at = function (name) {
    return row[columnIndex_(name) - 1];
  };

  return {
    eventTitle: at('Event'),
    eventId: at('Event ID'),
    eventDate: at('Event Date'),
    eventLocation: at('Location'),
    name: at('Name'),
    email: at('Email'),
    phone: at('Phone'),
    age: at('Age'),
    places: at('Places'),
    unitPrice: at('Unit Price'),
    total: at('Total'),
    emergencyName: at('Emergency Contact'),
    emergencyPhone: at('Emergency Phone'),
    dietary: at('Dietary'),
    medical: at('Medical'),
    heardFrom: at('Heard From'),
    notes: at('Notes'),
    photoConsent: at('Photo Consent') === 'Yes',
    terms: true
  };
}

/**
 * Catches anyone who paid but closed the tab before returning to the site, and
 * expires stale holds. Runs on a timer — see installTriggers().
 */
function reconcilePendingBookings() {
  if (!stripeKey_()) {
    return;
  }

  var spreadsheet = book_();
  var statusCol = columnIndex_('Status');
  var sessionCol = columnIndex_('Stripe Session');
  var stampCol = columnIndex_('Timestamp');
  var cutoff = Date.now() - 1000 * 60 * 60 * 24 * 2;

  [PENDING_SHEET].concat(eventTabs_()).forEach(function (name) {
    var sheet = spreadsheet.getSheetByName(name);

    if (!sheet || sheet.getLastRow() < 2) {
      return;
    }

    // Bottom upwards, because a payment moves its row off the staging tab and
    // would otherwise shift the rows still to be checked.
    for (var row = sheet.getLastRow(); row >= 2; row--) {
      var values = sheet.getRange(row, 1, 1, COLUMNS.length).getValues()[0];

      if (String(values[statusCol - 1]) !== 'Awaiting payment' || !values[sessionCol - 1]) {
        continue;
      }

      try {
        var session = stripe_('checkout/sessions/' + encodeURIComponent(values[sessionCol - 1]));

        if (session.payment_status === 'paid') {
          markPaid_(session);
        } else if (session.status === 'expired'
            || new Date(values[stampCol - 1]).getTime() < cutoff) {
          sheet.getRange(row, statusCol).setValue('Expired');
        }
      } catch (error) {
        console.error('Reconcile failed on "' + name + '" row ' + row + ': ' + error.message);
      }
    }
  });
}

/* ==========================================================================
   Email
   ========================================================================== */

function escape_(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function money_(amount) {
  return currencySymbol_() + (Math.round((parseFloat(amount) || 0) * 100) / 100).toFixed(2);
}

function rows_(pairs) {
  return pairs.filter(function (pair) {
    return pair[1] !== '' && pair[1] !== null && pair[1] !== undefined;
  }).map(function (pair) {
    return '<tr>' +
      '<td style="padding:6px 16px 6px 0;color:#5b6472;vertical-align:top;white-space:nowrap">' + escape_(pair[0]) + '</td>' +
      '<td style="padding:6px 0;color:#00175c"><strong>' + escape_(pair[1]) + '</strong></td>' +
      '</tr>';
  }).join('');
}

function shell_(heading, intro, body, footer) {
  return '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#00175c">' +
    '<h2 style="margin:0 0 8px;font-size:20px">' + escape_(heading) + '</h2>' +
    '<p style="margin:0 0 20px;color:#5b6472;font-size:14px;line-height:1.6">' + intro + '</p>' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #d3dced;border-bottom:1px solid #d3dced;padding:8px 0">' + body + '</table>' +
    (footer ? '<p style="margin:20px 0 0;color:#5b6472;font-size:13px;line-height:1.6">' + footer + '</p>' : '') +
    '<p style="margin:24px 0 0;color:#8b93a1;font-size:12px">' + escape_(orgName_()) + '</p>' +
    '</div>';
}

function notifyOwner_(data, ref, state) {
  var subject = '[' + state + '] ' + data.name + ' — ' + data.eventTitle + ' (' + ref + ')';

  var body = rows_([
    ['Reference', ref],
    ['Status', state],
    ['Event', data.eventTitle],
    ['When', data.eventDate],
    ['Where', data.eventLocation],
    ['Places', data.places],
    ['Total', money_(data.total)],
    ['Name', data.name],
    ['Email', data.email],
    ['Phone', data.phone],
    ['Age', data.age],
    ['Emergency contact', data.emergencyName + ' — ' + data.emergencyPhone],
    ['Dietary', data.dietary],
    ['Medical', data.medical],
    ['Heard from', data.heardFrom],
    ['Notes', data.notes],
    ['Photo consent', data.photoConsent ? 'Yes' : 'No']
  ]);

  MailApp.sendEmail({
    to: ownerList_(),
    replyTo: data.email,
    subject: subject,
    htmlBody: shell_('New booking', 'Recorded in your bookings sheet.', body)
  });
}

function emailAttendee_(data, ref, state) {
  var org = orgName_();
  var summary = rows_([
    ['Reference', ref],
    ['Event', data.eventTitle],
    ['When', data.eventDate],
    ['Where', data.eventLocation],
    ['Places', data.places],
    ['Total', money_(data.total)]
  ]);

  var copy = {
    paid: {
      subject: 'Your place is confirmed — ' + data.eventTitle,
      heading: 'You are booked in',
      intro: 'As-salamu alaykum ' + escape_(data.name) + ',<br><br>Your payment has gone through and your place is confirmed. We look forward to having you with us, in sha Allah.',
      footer: 'Keep this email for your records. Reply to it if anything changes or if you need to cancel.'
    },
    pending: {
      subject: 'Complete your booking — ' + data.eventTitle,
      heading: 'Almost there',
      intro: 'As-salamu alaykum ' + escape_(data.name) + ',<br><br>We have your details. Your place is confirmed once payment is complete — if you closed the payment page, just reply to this email and we will send you a fresh link.',
      footer: 'Places are held on a first-paid basis.'
    },
    recorded: {
      subject: 'We have your booking request — ' + data.eventTitle,
      heading: 'Request received',
      intro: 'As-salamu alaykum ' + escape_(data.name) + ',<br><br>Jazakum Allahu khayran for your interest. We have your details and will be in touch shortly to confirm your place and arrange payment.',
      footer: 'Reply to this email if you need to change anything.'
    }
  }[state];

  MailApp.sendEmail({
    to: data.email,
    replyTo: replyAddress_(),
    name: org,
    subject: copy.subject,
    htmlBody: shell_(copy.heading, copy.intro, summary, copy.footer)
  });
}

/* ==========================================================================
   One-off setup — run these by hand from the Apps Script editor
   ========================================================================== */

/**
 * Builds the workbook: an Events index, one bookings tab per event, plus
 * Summary and Read me. Safe to run more than once — it only creates what is
 * missing and never touches booking rows.
 */
function setUp() {
  var spreadsheet = book_();

  buildEvents_(spreadsheet);
  pendingSheet_();
  migrateFromSingleTab_(spreadsheet);

  eventRows_().forEach(function (event) {
    eventSheet_(event.id, event.name);
  });

  buildSummary_(spreadsheet);
  rebuildDirectory();
  buildReadMe_(spreadsheet);

  var blank = spreadsheet.getSheetByName('Sheet1');

  if (blank && spreadsheet.getSheets().length > 1 && blank.getLastRow() === 0) {
    spreadsheet.deleteSheet(blank);
  }

  orderTabs_(spreadsheet);
  spreadsheet.setActiveSheet(spreadsheet.getSheetByName(EVENTS_SHEET));

  var report = [
    'Spreadsheet: ' + spreadsheet.getName(),
    'URL: ' + spreadsheet.getUrl(),
    'Bookings tabs: ' + (eventTabs_().join(', ') || 'none yet'),
    'Booking alerts go to: ' + owners_().join(', '),
    'Site URL: ' + config_('SITE_URL', 'NOT SET'),
    'Stripe: ' + (stripeKey_()
      ? (stripeKey_().indexOf('sk_live') === 0 ? 'LIVE key' : 'test key')
      : 'not configured (bookings recorded, no payment taken)')
  ].join('\n');

  console.log(report);
  return report;
}

/** Events, Summary and Read me first; the per-event tabs after them. */
function orderTabs_(spreadsheet) {
  ['Read me', PEOPLE_SHEET, ALL_SHEET, 'Summary', EVENTS_SHEET].forEach(function (name) {
    var sheet = spreadsheet.getSheetByName(name);

    if (sheet) {
      spreadsheet.setActiveSheet(sheet);
      spreadsheet.moveActiveSheet(1);
    }
  });
}

function tab_(spreadsheet, name) {
  return spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
}

function headerRow_(sheet, labels, widths) {
  sheet.getRange(1, 1, 1, labels.length)
    .setValues([labels])
    .setFontFamily('Arial')
    .setFontSize(10)
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setBackground(NAVY)
    .setVerticalAlignment('middle')
    .setWrap(true);

  sheet.setRowHeight(1, 34);
  sheet.setFrozenRows(1);

  widths.forEach(function (width, index) {
    sheet.setColumnWidth(index + 1, width);
  });
}

/** Creates one event's bookings tab, formatted and ready. */
function buildBookingsTab_(spreadsheet, name, colour) {
  var sheet = spreadsheet.insertSheet(name);

  headerRow_(sheet, COLUMNS,
    [130, 110, 120, 260, 210, 150, 170, 150, 190, 120, 50, 55, 80, 80, 70,
     150, 120, 170, 210, 130, 210, 100, 100, 210, 210, 130]);

  var depth = sheet.getMaxRows() - 1;

  sheet.getRange(2, columnIndex_('Timestamp'), depth, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.getRange(2, columnIndex_('Paid At'), depth, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.getRange(2, columnIndex_('Unit Price'), depth, 2).setNumberFormat('£#,##0.00');

  var statusRange = sheet.getRange(2, columnIndex_('Status'), depth, 1);

  statusRange.setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(['Enquiry', 'Awaiting payment', 'Paid'].concat(CLOSED_STATUSES), true)
      .setAllowInvalid(true)
      .setHelpText('Set by the script. Change it by hand only to cancel or refund.')
      .build());

  sheet.setConditionalFormatRules([
    conditionalFill_(statusRange, 'Paid', '#d6f0dc'),
    conditionalFill_(statusRange, 'Awaiting payment', '#fdf0cc'),
    conditionalFill_(statusRange, 'Cancelled', '#f5d9d6'),
    conditionalFill_(statusRange, 'Expired', '#f5d9d6'),
    conditionalFill_(statusRange, 'Refunded', '#f5d9d6')
  ]);

  if (!sheet.getFilter()) {
    sheet.getRange(1, 1, sheet.getMaxRows(), COLUMNS.length).createFilter();
  }

  sheet.setTabColor(colour || NAVY);

  return sheet;
}

function conditionalFill_(range, value, colour) {
  return SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo(value)
    .setBackground(colour)
    .setRanges([range])
    .build();
}

/**
 * Moves rows written by an earlier single-tab version onto the per-event tabs,
 * then parks the old tab as "Bookings (archived)". No-op on a fresh sheet.
 */
function migrateFromSingleTab_(spreadsheet) {
  var legacy = spreadsheet.getSheetByName(LEGACY_BOOKINGS_SHEET);

  if (!legacy || legacy.getLastRow() < 2) {
    return 0;
  }

  var rows = legacy.getRange(2, 1, legacy.getLastRow() - 1, COLUMNS.length).getValues();
  var idCol = columnIndex_('Event ID') - 1;
  var titleCol = columnIndex_('Event') - 1;
  var moved = 0;

  rows.forEach(function (row) {
    if (!row[columnIndex_('Reference') - 1]) {
      return;
    }

    eventSheet_(String(row[idCol]).trim(), String(row[titleCol]).trim()).appendRow(row);
    moved++;
  });

  if (moved) {
    legacy.setName(LEGACY_BOOKINGS_SHEET + ' (archived)');
    console.log('Moved ' + moved + ' booking(s) off the old single tab. It is now "'
      + LEGACY_BOOKINGS_SHEET + ' (archived)" and can be deleted once you have checked it.');
  }

  return moved;
}

function buildEvents_(spreadsheet) {
  var sheet = tab_(spreadsheet, EVENTS_SHEET);

  if (sheet.getLastRow() > 0) {
    return;
  }

  headerRow_(sheet, EVENT_COLUMNS,
    [240, 300, 75, 65, 200, 180, 80, 60, 80, 80, 70, 90, 90, 90, 130, 130]);

  // Titles match index.html exactly, so the first syncEventsFromSite() finds
  // nothing to rename.
  var events = [
    ['mens-summer-retreat-jul-2026',
      'Men of Ihsan × Muslim Alpha Summer Retreat with Gabriel Al-Romaani', 30, 115],
    ['womens-taster-day-jul-2026', 'Women of Ihsan – Taster Day', 20, 75],
    ['ikhwan-missions-retreat-jul-2026',
      'Ikhwan Missions Retreat with Muslims of Ihsan', 30, 105]
  ];

  events.forEach(function (event, index) {
    var row = index + 2;
    sheet.getRange(row, 1, 1, 4).setValues([event])
      .setFontFamily('Arial').setFontSize(10).setFontColor(BLUE);
    sheet.getRange(row, 4).setNumberFormat('£#,##0');
  });

  sheet.setColumnWidth(18, 420);
  sheet.getRange('R1:R3')
    .setValues([
      ['Blue cells are yours to edit. Event ID must match the data-event-id in index.html exactly.'],
      ['Bookings Tab is filled in automatically — it names the tab holding that event’s bookings.'],
      ['Add a new event on the first empty row. Its tab appears when the first booking arrives, or when you run setUp again.']
    ])
    .setFontFamily('Arial').setFontSize(9).setFontStyle('italic').setFontColor(GREY)
    .setFontWeight('normal').setWrap(true);
}

/** A column of one sheet, as an absolute range. */
function sheetRange_(tabName, column) {
  var letter = columnLetter_(columnIndex_(column));

  return "'" + String(tabName).replace(/'/g, "''") + "'!$" + letter + '$2:$' + letter
    + '$' + FORMULA_ROWS;
}

/**
 * The per-event roll-up formulas. Confirmed bookings live on the event's own
 * tab; anything still paying sits on the staging tab, so most figures are the
 * two added together.
 */
function writeEventFormulas_(sheet, row, tabName) {
  var status = sheetRange_(tabName, 'Status');
  var places = sheetRange_(tabName, 'Places');
  var totals = sheetRange_(tabName, 'Total');
  var refs = sheetRange_(tabName, 'Reference');

  var waitStatus = sheetRange_(PENDING_SHEET, 'Status');
  var waitPlaces = sheetRange_(PENDING_SHEET, 'Places');
  var waitTotals = sheetRange_(PENDING_SHEET, 'Total');
  var waitIds = sheetRange_(PENDING_SHEET, 'Event ID');
  var thisEvent = waitIds + ',$' + columnLetter_(eventColumnIndex_('Event ID')) + row;

  var openOn = function (range) {
    return CLOSED_STATUSES.map(function (value) {
      return range + ',"<>' + value + '"';
    }).join(',');
  };

  var closedOn = function (range) {
    return CLOSED_STATUSES.map(function (value) {
      return 'COUNTIF(' + range + ',"' + value + '")';
    }).join('+');
  };

  var capacity = '$' + columnLetter_(eventColumnIndex_('Capacity')) + row;
  var held = '$' + columnLetter_(eventColumnIndex_('Places Held')) + row;

  sheet.getRange(row, eventColumnIndex_('Bookings'), 1, 10).setFormulas([[
    '=COUNTA(' + refs + ')+COUNTIF(' + thisEvent + ')',
    '=COUNTIF(' + status + ',"Paid")',
    '=COUNTIFS(' + thisEvent + ',' + waitStatus + ',"Awaiting payment")',
    '=COUNTIF(' + status + ',"Enquiry")',
    '=' + closedOn(status) + '+COUNTIFS(' + thisEvent + ',' + waitStatus + ',"Expired")'
      + '+COUNTIFS(' + thisEvent + ',' + waitStatus + ',"Cancelled")',
    '=SUMIFS(' + places + ',' + openOn(status) + ')'
      + '+SUMIFS(' + waitPlaces + ',' + thisEvent + ',' + openOn(waitStatus) + ')',
    '=SUMIFS(' + places + ',' + status + ',"Paid")',
    '=IF(' + capacity + '="","",MAX(' + capacity + '-' + held + ',0))',
    '=SUMIFS(' + totals + ',' + status + ',"Paid")',
    '=SUMIFS(' + waitTotals + ',' + thisEvent + ',' + waitStatus + ',"Awaiting payment")'
  ]]).setFontFamily('Arial').setFontSize(10);

  sheet.getRange(row, eventColumnIndex_('Revenue Collected'), 1, 2).setNumberFormat('£#,##0.00');
}

function columnLetter_(index) {
  var letter = '';

  while (index > 0) {
    var remainder = (index - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    index = (index - remainder - 1) / 26;
  }

  return letter;
}

function buildSummary_(spreadsheet) {
  var sheet = tab_(spreadsheet, 'Summary');

  if (sheet.getLastRow() > 0) {
    return;
  }

  var total = function (column) {
    var letter = columnLetter_(eventColumnIndex_(column));
    return '=SUM(' + EVENTS_SHEET + '!$' + letter + '$2:$' + letter + '$500)';
  };

  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidths(2, 4, 110);

  sheet.getRange('A1').setValue('Bookings at a glance')
    .setFontFamily('Arial').setFontSize(14).setFontWeight('bold').setFontColor(NAVY);
  sheet.getRange('A2').setValue('Totals across every event. Each event has its own tab.')
    .setFontFamily('Arial').setFontSize(9).setFontStyle('italic').setFontColor(GREY);

  var metrics = [
    ['Total bookings', total('Bookings'), '#,##0'],
    ['Paid', total('Paid'), '#,##0'],
    ['Awaiting payment', total('Awaiting'), '#,##0'],
    ['Enquiries', total('Enquiries'), '#,##0'],
    ['Cancelled or expired', total('Closed'), '#,##0'],
    ['', '', ''],
    ['Places paid for', total('Places Paid'), '#,##0'],
    ['Revenue collected', total('Revenue Collected'), '£#,##0.00'],
    ['Revenue outstanding', total('Revenue Outstanding'), '£#,##0.00']
  ];

  metrics.forEach(function (metric, index) {
    var row = 4 + index;

    if (!metric[0]) {
      return;
    }

    sheet.getRange(row, 1).setValue(metric[0]).setFontFamily('Arial').setFontSize(10);
    sheet.getRange(row, 2).setFormula(metric[1])
      .setFontFamily('Arial').setFontSize(10).setFontWeight('bold')
      .setNumberFormat(metric[2]).setHorizontalAlignment('right');
  });

  sheet.getRange('A14').setValue('By event')
    .setFontFamily('Arial').setFontSize(11).setFontWeight('bold').setFontColor(NAVY);

  sheet.getRange(15, 1, 1, 5)
    .setValues([['Event', 'Capacity', 'Held', 'Remaining', 'Collected']])
    .setFontFamily('Arial').setFontSize(10).setFontWeight('bold')
    .setFontColor('#ffffff').setBackground(NAVY);

  var column = function (name, row) {
    return '=IF(' + EVENTS_SHEET + '!$A' + row + '="","",' + EVENTS_SHEET + '!$'
      + columnLetter_(eventColumnIndex_(name)) + row + ')';
  };

  var rows = [];

  for (var i = 2; i <= 21; i++) {
    rows.push([
      column('Event Name', i), column('Capacity', i), column('Places Held', i),
      column('Remaining', i), column('Revenue Collected', i)
    ]);
  }

  sheet.getRange(16, 1, rows.length, 5).setFormulas(rows).setFontFamily('Arial').setFontSize(10);
  sheet.getRange(16, 5, rows.length, 1).setNumberFormat('£#,##0.00');
  sheet.getRange(15, 1, rows.length + 1, 5).setBorder(null, null, true, null, null, true, '#d3dced', null);
}

function buildReadMe_(spreadsheet) {
  var sheet = tab_(spreadsheet, 'Read me');

  if (sheet.getLastRow() > 0) {
    return;
  }

  sheet.setColumnWidth(1, 170);
  sheet.setColumnWidth(2, 660);

  sheet.getRange('A1').setValue('Ummatically — event bookings')
    .setFontFamily('Arial').setFontSize(14).setFontWeight('bold').setFontColor(NAVY);

  var notes = [
    ['How it works', 'Someone books on the website → this script writes a row on that event’s own tab, emails the organisers, and emails them → Stripe takes the payment → the row flips to Paid.'],
    ['One tab per event', 'Every event has its own bookings tab, listed in the Bookings Tab column of the Events tab. A new event gets its tab automatically on its first booking.'],
    ['Do not', 'Reorder or rename the columns on an event tab. The script writes by column position, so a moved column silently lands the wrong data in the wrong place. Renaming a tab is fine only if you update its Bookings Tab cell to match.'],
    ['Safe to do', 'Sort, filter, hide columns, add new columns to the RIGHT of "Paid At", and change Status by hand to Cancelled or Refunded.'],
    ['Statuses', 'Enquiry — recorded, no payment configured. Awaiting payment — sent to Stripe, not paid yet. Paid — money received. Expired — set automatically after 2 days unpaid. Cancelled / Refunded — set by you.'],
    ['Events tab', 'Edit Event ID, Event Name, Capacity and Price there — the blue columns. Everything to the right of Notes counts itself from that event’s tab. Leave Capacity blank for an uncapped event.'],
    ['Summary tab', 'Adds up every event. It reads the Events tab, so it picks up new events on its own.']
  ];

  sheet.getRange(3, 1, notes.length, 2).setValues(notes)
    .setFontFamily('Arial').setFontSize(10).setVerticalAlignment('top').setWrap(true);
  sheet.getRange(3, 1, notes.length, 1).setFontWeight('bold').setFontColor(NAVY);

  var exampleRow = 3 + notes.length + 1;

  sheet.getRange(exampleRow, 1).setValue('What a booking row looks like')
    .setFontFamily('Arial').setFontSize(11).setFontWeight('bold').setFontColor(NAVY);

  sheet.getRange(exampleRow + 1, 1, 1, COLUMNS.length).setValues([COLUMNS])
    .setFontFamily('Arial').setFontSize(9).setFontWeight('bold')
    .setFontColor('#ffffff').setBackground(NAVY);

  sheet.getRange(exampleRow + 2, 1, 1, COLUMNS.length).setValues([[
    '2026-06-02 14:31', 'UMM-2606-K3F9', 'Paid',
    'Women of Ihsan – Taster Day', 'womens-taster-day-jul-2026', 'Jul 19, 2026 · 1 Day',
    'B60, Worcestershire', 'Aisha Rahman', 'aisha@example.com', '07700 900123', '27', 2,
    75, 150, 'GBP', 'Mariam Rahman', '07700 900456', 'Nut allergy', 'None', 'Instagram',
    '', 'Yes', 'Yes', 'cs_test_a1b2c3', 'pi_3Nx4y5', '2026-06-02 14:33'
  ]]).setFontFamily('Arial').setFontSize(9);
}

/* ==========================================================================
   Everyone in one place

   Bookings live on their event's tab. These two tabs gather them up:
   "All bookings" is every booking across every event, and "People" is one row
   per person. Both are rebuilt from scratch, so nothing you type on them
   survives — treat them as read-only.
   ========================================================================== */

var ALL_SHEET = 'All bookings';
var PEOPLE_SHEET = 'People';

var PEOPLE_COLUMNS = [
  'Name', 'Email', 'Phone', 'Bookings', 'Places', 'Paid', 'Outstanding',
  'Events', 'Dietary', 'Medical', 'Emergency Contact', 'First Booked', 'Last Booked'
];

/** Every booking row across every tab, newest first. */
function allBookings_() {
  var spreadsheet = book_();
  var rows = [];

  [PENDING_SHEET].concat(eventTabs_()).forEach(function (name) {
    var sheet = spreadsheet.getSheetByName(name);

    if (!sheet || sheet.getLastRow() < 2) {
      return;
    }

    sheet.getRange(2, 1, sheet.getLastRow() - 1, COLUMNS.length).getValues()
      .forEach(function (row) {
        if (row[columnIndex_('Reference') - 1]) {
          rows.push(row);
        }
      });
  });

  var stamp = columnIndex_('Timestamp') - 1;

  rows.sort(function (a, b) {
    return new Date(b[stamp]).getTime() - new Date(a[stamp]).getTime();
  });

  return rows;
}

/** Rebuilds the "All bookings" and "People" tabs from the event tabs. */
function rebuildDirectory() {
  var spreadsheet = book_();
  var rows = allBookings_();

  writeAllBookings_(spreadsheet, rows);
  writePeople_(spreadsheet, rows);

  var report = rows.length + ' booking(s) gathered into "' + ALL_SHEET + '" and "'
    + PEOPLE_SHEET + '".';

  console.log(report);
  return report;
}

function readOnlyNotice_(sheet, text) {
  sheet.getRange(1, 1).setValue(text)
    .setFontFamily('Arial').setFontSize(9).setFontStyle('italic').setFontColor(GREY);
  sheet.setRowHeight(1, 20);
}

function writeAllBookings_(spreadsheet, rows) {
  var sheet = tab_(spreadsheet, ALL_SHEET);

  sheet.clear();
  sheet.clearConditionalFormatRules();

  if (sheet.getFilter()) {
    sheet.getFilter().remove();
  }

  readOnlyNotice_(sheet, 'Rebuilt automatically — edits here are overwritten. '
    + 'Change a booking on its own event tab.');

  sheet.getRange(2, 1, 1, COLUMNS.length).setValues([COLUMNS])
    .setFontFamily('Arial').setFontSize(10).setFontWeight('bold')
    .setFontColor('#ffffff').setBackground(NAVY).setWrap(true);
  sheet.setFrozenRows(2);

  if (rows.length) {
    sheet.getRange(3, 1, rows.length, COLUMNS.length).setValues(rows)
      .setFontFamily('Arial').setFontSize(10);
    sheet.getRange(3, columnIndex_('Timestamp'), rows.length, 1)
      .setNumberFormat('yyyy-mm-dd hh:mm');
    sheet.getRange(3, columnIndex_('Unit Price'), rows.length, 2)
      .setNumberFormat('£#,##0.00');
    sheet.getRange(2, 1, rows.length + 1, COLUMNS.length).createFilter();
  }

  sheet.setTabColor('#3f7f5f');
}

function writePeople_(spreadsheet, rows) {
  var sheet = tab_(spreadsheet, PEOPLE_SHEET);
  var people = {};
  var order = [];

  var at = function (row, name) {
    return row[columnIndex_(name) - 1];
  };

  rows.forEach(function (row) {
    var email = String(at(row, 'Email') || '').trim().toLowerCase();

    if (!email) {
      return;
    }

    if (!people[email]) {
      people[email] = {
        name: at(row, 'Name'), email: email, phone: at(row, 'Phone'),
        bookings: 0, places: 0, paid: 0, outstanding: 0,
        events: [], dietary: [], medical: [], emergency: '',
        first: null, last: null
      };
      order.push(email);
    }

    var person = people[email];
    var status = String(at(row, 'Status'));
    var places = parseInt(at(row, 'Places'), 10) || 0;
    var total = parseFloat(at(row, 'Total')) || 0;
    var when = new Date(at(row, 'Timestamp'));

    person.bookings++;

    if (CLOSED_STATUSES.indexOf(status) === -1) {
      person.places += places;
    }
    if (status === 'Paid') {
      person.paid += total;
    }
    if (status === 'Awaiting payment') {
      person.outstanding += total;
    }

    [['events', 'Event'], ['dietary', 'Dietary'], ['medical', 'Medical']].forEach(function (pair) {
      var value = String(at(row, pair[1]) || '').trim();

      if (value && person[pair[0]].indexOf(value) === -1) {
        person[pair[0]].push(value);
      }
    });

    var emergency = [at(row, 'Emergency Contact'), at(row, 'Emergency Phone')]
      .filter(String).join(' — ');

    if (emergency) {
      person.emergency = emergency;
    }

    // The most recent booking has the freshest contact details.
    if (!person.last || when > person.last) {
      person.last = when;
      person.name = at(row, 'Name') || person.name;
      person.phone = at(row, 'Phone') || person.phone;
    }
    if (!person.first || when < person.first) {
      person.first = when;
    }
  });

  var table = order.map(function (email) {
    var person = people[email];

    return [
      person.name, person.email, person.phone,
      person.bookings, person.places, person.paid, person.outstanding,
      person.events.join('; '), person.dietary.join('; '), person.medical.join('; '),
      person.emergency, person.first, person.last
    ];
  });

  table.sort(function (a, b) {
    return b[12] - a[12];
  });

  sheet.clear();

  if (sheet.getFilter()) {
    sheet.getFilter().remove();
  }

  readOnlyNotice_(sheet, 'One row per person, rebuilt automatically — edits here are overwritten.');

  sheet.getRange(2, 1, 1, PEOPLE_COLUMNS.length).setValues([PEOPLE_COLUMNS])
    .setFontFamily('Arial').setFontSize(10).setFontWeight('bold')
    .setFontColor('#ffffff').setBackground(NAVY).setWrap(true);
  sheet.setFrozenRows(2);

  [200, 230, 130, 75, 60, 95, 100, 280, 200, 240, 200, 130, 130]
    .forEach(function (width, index) {
      sheet.setColumnWidth(index + 1, width);
    });

  if (table.length) {
    sheet.getRange(3, 1, table.length, PEOPLE_COLUMNS.length).setValues(table)
      .setFontFamily('Arial').setFontSize(10);
    sheet.getRange(3, 6, table.length, 2).setNumberFormat('£#,##0.00');
    sheet.getRange(3, 12, table.length, 2).setNumberFormat('yyyy-mm-dd');
    sheet.getRange(2, 1, table.length + 1, PEOPLE_COLUMNS.length).createFilter();
  }

  sheet.setTabColor('#3f7f5f');
}

/**
 * Reads the events off the live website and brings the Events tab into line:
 * new events get a row and a tab, renamed or repriced ones are updated, and
 * anything still in the sheet but gone from the site is reported so you can
 * decide whether it has simply finished.
 *
 * Your columns are left alone — Capacity is yours, and is never overwritten.
 * Run it by hand after changing events, or let installTriggers() run it daily.
 */
function syncEventsFromSite() {
  var url = siteUrl_();
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });

  if (response.getResponseCode() >= 400) {
    throw new Error('Could not read ' + url + ' (HTTP ' + response.getResponseCode() + ').');
  }

  var found = parseEventsFromHtml_(response.getContentText());

  if (!found.length) {
    throw new Error('No events found at ' + url
      + '. Check SITE_URL points at the page with the Book Now buttons.');
  }

  var sheet = book_().getSheetByName(EVENTS_SHEET);
  var existing = eventRows_();
  var added = [];
  var updated = [];

  found.forEach(function (event) {
    var match = null;

    for (var i = 0; i < existing.length; i++) {
      if (existing[i].id === event.id) {
        match = existing[i];
        break;
      }
    }

    if (!match) {
      eventSheet_(event.id, event.title);

      var row = eventRowFor_(event.id);

      if (row) {
        sheet.getRange(row, eventColumnIndex_('Event Name')).setValue(event.title);
        sheet.getRange(row, eventColumnIndex_('Price')).setValue(event.price);
        sheet.getRange(row, eventColumnIndex_('Notes')).setValue('Added from the website.');
      }

      added.push(event.id);
      return;
    }

    var changes = [];
    var nameCell = sheet.getRange(match.row, eventColumnIndex_('Event Name'));
    var priceCell = sheet.getRange(match.row, eventColumnIndex_('Price'));

    if (event.title && String(nameCell.getValue()) !== event.title) {
      nameCell.setValue(event.title);
      changes.push('name');
    }

    if (event.price !== '' && Number(priceCell.getValue()) !== Number(event.price)) {
      priceCell.setValue(event.price);
      changes.push('price');
    }

    // A tab may not exist yet for an event added straight to the sheet.
    eventSheet_(event.id, event.title);

    if (changes.length) {
      updated.push(event.id + ' (' + changes.join(', ') + ')');
    }
  });

  var onSite = found.map(function (event) { return event.id; });
  var missing = existing.filter(function (event) {
    return onSite.indexOf(event.id) === -1;
  }).map(function (event) { return event.id; });

  var report = [
    'Read ' + found.length + ' event(s) from ' + url,
    'Added: ' + (added.join(', ') || 'none'),
    'Updated: ' + (updated.join(', ') || 'none'),
    'In the sheet but not on the site: ' + (missing.join(', ') || 'none')
      + (missing.length ? ' — past events, or an id changed on the site. Their bookings are untouched.' : '')
  ].join('\n');

  console.log(report);
  return report;
}

/** Pulls the data-event-* attributes off each Book Now button. */
function parseEventsFromHtml_(html) {
  var buttons = html.match(/<a[^>]*\bdata-book\b[^>]*>/g) || [];
  var events = [];
  var seen = {};

  buttons.forEach(function (tag) {
    var attribute = function (name) {
      var match = tag.match(new RegExp('data-event-' + name + '="([^"]*)"'));
      return match ? decodeEntities_(match[1]) : '';
    };

    var id = attribute('id');

    if (!id || seen[id]) {
      return;
    }

    seen[id] = true;

    var price = attribute('price');

    events.push({
      id: id,
      title: attribute('title'),
      price: price === '' ? '' : Number(price),
      date: attribute('date'),
      location: attribute('location')
    });
  });

  return events;
}

function decodeEntities_(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, function (whole, code) { return String.fromCharCode(Number(code)); })
    .replace(/&amp;/g, '&');
}

/** The Events row holding an id, or null. */
function eventRowFor_(eventId) {
  var rows = eventRows_();

  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id === eventId) {
      return rows[i].row;
    }
  }

  return null;
}

/**
 * Sweeps for finished payments every 15 minutes, and reads the website's events
 * into the sheet once a day. Run once.
 */
function installTriggers() {
  var handlers = ['reconcilePendingBookings', 'rebuildDirectory', 'syncEventsFromSite'];

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (handlers.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('reconcilePendingBookings').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('rebuildDirectory').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('syncEventsFromSite').timeBased().everyDays(1).atHour(4).create();

  console.log('Triggers installed: payment sweep every 15 minutes, directory rebuild hourly, '
    + 'website sync daily at 4am.');
}

/** Sends a test booking through the whole flow without touching Stripe. */
function sendTestBooking() {
  var result = createBooking_({
    action: 'book',
    eventId: 'test-event',
    eventTitle: 'Test Event — please ignore',
    eventDate: 'Jan 1, 2030',
    eventLocation: 'Test location',
    name: 'Test Person',
    email: replyAddress_(),
    phone: '07000000000',
    places: 1,
    unitPrice: 0,
    emergencyName: 'Test Contact',
    emergencyPhone: '07000000001',
    terms: true
  });

  console.log(result);
  return result;
}
