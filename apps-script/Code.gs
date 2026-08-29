/**
 * Ummatically — bookings backend.
 *
 * Receives booking forms from the website, records them in Google Sheets,
 * emails you and the attendee, and takes payment through Stripe Checkout.
 *
 * Configuration lives in Script Properties, never in this file:
 *   SPREADSHEET_ID     required  the id in your Google Sheet's URL
 *   NOTIFY_EMAIL       required  where new-booking alerts are sent
 *   SITE_URL           required  the public URL of the site, e.g. https://ummatically.com/
 *   STRIPE_SECRET_KEY  optional  sk_test_… or sk_live_…; without it bookings are
 *                                recorded and emailed but no payment is taken
 *   ORG_NAME           optional  defaults to "Ummatically"
 *   CURRENCY           optional  ISO code, defaults to "gbp"
 *
 * See SETUP.md in the repository for the full walkthrough.
 */

var BOOKINGS_SHEET = 'Bookings';
var EVENTS_SHEET = 'Events';
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
  return SpreadsheetApp.openById(requiredConfig_('SPREADSHEET_ID'));
}

function sheet_(name) {
  var sheet = book_().getSheetByName(name);
  if (!sheet) {
    throw new Error('Sheet tab "' + name + '" is missing. Run setUp() once — SETUP.md step 3.');
  }
  return sheet;
}

function columnIndex_(name) {
  var index = COLUMNS.indexOf(name);
  if (index === -1) {
    throw new Error('Unknown column: ' + name);
  }
  return index + 1;
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

    appendBooking_(clean, ref, session);
    notifyOwner_(clean, ref, session ? 'Awaiting payment' : 'Enquiry');
    emailAttendee_(clean, ref, session ? 'pending' : 'recorded');

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

function appendBooking_(data, ref, session) {
  sheet_(BOOKINGS_SHEET).appendRow([
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
 * Places left for an event, or null when the Events tab does not list it
 * (in which case bookings are never turned away).
 */
function spotsRemaining_(eventId) {
  var sheet = book_().getSheetByName(EVENTS_SHEET);

  if (!sheet || sheet.getLastRow() < 2 || !eventId) {
    return null;
  }

  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  var capacity = null;

  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === eventId) {
      capacity = parseInt(rows[i][2], 10);
      break;
    }
  }

  if (!capacity && capacity !== 0) {
    return null;
  }

  return Math.max(capacity - placesTaken_(eventId), 0);
}

function placesTaken_(eventId) {
  var sheet = sheet_(BOOKINGS_SHEET);

  if (sheet.getLastRow() < 2) {
    return 0;
  }

  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, COLUMNS.length).getValues();
  var idCol = columnIndex_('Event ID') - 1;
  var statusCol = columnIndex_('Status') - 1;
  var placesCol = columnIndex_('Places') - 1;
  var taken = 0;

  rows.forEach(function (row) {
    if (String(row[idCol]).trim() !== eventId) {
      return;
    }
    if (['Cancelled', 'Expired', 'Refunded'].indexOf(String(row[statusCol])) !== -1) {
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
    'metadata[places]': data.places
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
  var sheet = sheet_(BOOKINGS_SHEET);
  var lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return { ref: session.client_reference_id || '' };
  }

  var sessionCol = columnIndex_('Stripe Session');
  var statusCol = columnIndex_('Status');
  var ids = sheet.getRange(2, sessionCol, lastRow - 1, 1).getValues();

  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) !== session.id) {
      continue;
    }

    var row = i + 2;
    var alreadyPaid = String(sheet.getRange(row, statusCol).getValue()) === 'Paid';

    sheet.getRange(row, statusCol).setValue('Paid');
    sheet.getRange(row, columnIndex_('Stripe Payment')).setValue(session.payment_intent || '');
    sheet.getRange(row, columnIndex_('Paid At')).setValue(new Date());

    var ref = sheet.getRange(row, columnIndex_('Reference')).getValue();

    if (!alreadyPaid) {
      var record = rowToBooking_(sheet.getRange(row, 1, 1, COLUMNS.length).getValues()[0]);
      emailAttendee_(record, ref, 'paid');
      notifyOwner_(record, ref, 'PAID');
    }

    return { ref: ref };
  }

  return { ref: session.client_reference_id || '' };
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
 * Catches anyone who paid but closed the tab before returning to the site.
 * Runs on a timer — see installTriggers().
 */
function reconcilePendingBookings() {
  if (!stripeKey_()) {
    return;
  }

  var sheet = sheet_(BOOKINGS_SHEET);
  var lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return;
  }

  var rows = sheet.getRange(2, 1, lastRow - 1, COLUMNS.length).getValues();
  var statusCol = columnIndex_('Status') - 1;
  var sessionCol = columnIndex_('Stripe Session') - 1;
  var stampCol = columnIndex_('Timestamp') - 1;
  var cutoff = Date.now() - 1000 * 60 * 60 * 24 * 2;

  rows.forEach(function (row, index) {
    if (String(row[statusCol]) !== 'Awaiting payment' || !row[sessionCol]) {
      return;
    }

    try {
      var session = stripe_('checkout/sessions/' + encodeURIComponent(row[sessionCol]));

      if (session.payment_status === 'paid') {
        markPaid_(session);
      } else if (session.status === 'expired' || new Date(row[stampCol]).getTime() < cutoff) {
        sheet.getRange(index + 2, statusCol + 1).setValue('Expired');
      }
    } catch (error) {
      console.error('Reconcile failed for row ' + (index + 2) + ': ' + error.message);
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
    to: requiredConfig_('NOTIFY_EMAIL'),
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
    replyTo: requiredConfig_('NOTIFY_EMAIL'),
    name: org,
    subject: copy.subject,
    htmlBody: shell_(copy.heading, copy.intro, summary, copy.footer)
  });
}

/* ==========================================================================
   One-off setup — run these by hand from the Apps Script editor
   ========================================================================== */

/**
 * Creates and formats the sheet tabs, then checks your configuration.
 * Safe to run more than once.
 */
function setUp() {
  var spreadsheet = book_();
  var bookings = spreadsheet.getSheetByName(BOOKINGS_SHEET) || spreadsheet.insertSheet(BOOKINGS_SHEET);

  if (bookings.getLastRow() === 0) {
    bookings.appendRow(COLUMNS);
  }

  var header = bookings.getRange(1, 1, 1, COLUMNS.length);
  header.setFontWeight('bold').setBackground('#00175c').setFontColor('#ffffff');
  bookings.setFrozenRows(1);
  bookings.getRange(2, columnIndex_('Timestamp'), Math.max(bookings.getMaxRows() - 1, 1), 1)
    .setNumberFormat('yyyy-mm-dd hh:mm');
  bookings.getRange(2, columnIndex_('Unit Price'), Math.max(bookings.getMaxRows() - 1, 1), 2)
    .setNumberFormat('#,##0.00');
  bookings.autoResizeColumns(1, COLUMNS.length);

  var events = spreadsheet.getSheetByName(EVENTS_SHEET) || spreadsheet.insertSheet(EVENTS_SHEET);

  if (events.getLastRow() === 0) {
    events.appendRow(['Event ID', 'Event Name', 'Capacity', 'Price', 'Notes']);
    events.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#00175c').setFontColor('#ffffff');
    events.setFrozenRows(1);
    events.appendRow(['mens-summer-retreat-jul-2026', 'Men of Ihsan × Muslim Alpha Summer Retreat', 30, 115, '']);
    events.appendRow(['womens-taster-day-jul-2026', 'Women of Ihsan — Taster Day', 20, 75, '']);
    events.appendRow(['ikhwan-missions-retreat-jul-2026', 'Ikhwan Missions Retreat', 30, 105, '']);
    events.autoResizeColumns(1, 5);
  }

  var report = [
    'Spreadsheet: ' + spreadsheet.getName(),
    'Notify email: ' + config_('NOTIFY_EMAIL', 'NOT SET'),
    'Site URL: ' + config_('SITE_URL', 'NOT SET'),
    'Stripe: ' + (stripeKey_()
      ? (stripeKey_().indexOf('sk_live') === 0 ? 'LIVE key' : 'test key')
      : 'not configured (bookings recorded, no payment taken)')
  ].join('\n');

  console.log(report);
  return report;
}

/** Runs the pending-payment sweep every 15 minutes. Run once. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'reconcilePendingBookings') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('reconcilePendingBookings').timeBased().everyMinutes(15).create();
  console.log('Reconcile trigger installed.');
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
    email: config_('NOTIFY_EMAIL', Session.getEffectiveUser().getEmail()),
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
