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
 * Builds the whole workbook — Bookings, Events, Summary and Read me — then
 * checks your configuration. Safe to run more than once: it only creates what
 * is missing and never touches booking rows.
 */
function setUp() {
  var spreadsheet = book_();

  buildBookings_(spreadsheet);
  buildEvents_(spreadsheet);
  buildSummary_(spreadsheet);
  buildReadMe_(spreadsheet);

  var blank = spreadsheet.getSheetByName('Sheet1');

  if (blank && spreadsheet.getSheets().length > 1) {
    spreadsheet.deleteSheet(blank);
  }

  spreadsheet.setActiveSheet(spreadsheet.getSheetByName(BOOKINGS_SHEET));

  var report = [
    'Spreadsheet: ' + spreadsheet.getName(),
    'URL: ' + spreadsheet.getUrl(),
    'Booking alerts go to: ' + owners_().join(', '),
    'Site URL: ' + config_('SITE_URL', 'NOT SET'),
    'Stripe: ' + (stripeKey_()
      ? (stripeKey_().indexOf('sk_live') === 0 ? 'LIVE key' : 'test key')
      : 'not configured (bookings recorded, no payment taken)')
  ].join('\n');

  console.log(report);
  return report;
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

function buildBookings_(spreadsheet) {
  var sheet = tab_(spreadsheet, BOOKINGS_SHEET);

  if (sheet.getLastRow() > 0) {
    return; // Already built — leave the bookings alone.
  }

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
      .requireValueInList(['Enquiry', 'Awaiting payment', 'Paid', 'Cancelled', 'Expired', 'Refunded'], true)
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
}

function conditionalFill_(range, value, colour) {
  return SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo(value)
    .setBackground(colour)
    .setRanges([range])
    .build();
}

function buildEvents_(spreadsheet) {
  var sheet = tab_(spreadsheet, EVENTS_SHEET);

  if (sheet.getLastRow() > 0) {
    return;
  }

  headerRow_(sheet,
    ['Event ID', 'Event Name', 'Capacity', 'Price', 'Notes',
     'Places Held', 'Places Paid', 'Remaining', 'Revenue Collected'],
    [240, 320, 75, 65, 180, 90, 90, 90, 130]);

  var events = [
    ['mens-summer-retreat-jul-2026', 'Men of Ihsan × Muslim Alpha Summer Retreat', 30, 115, ''],
    ['womens-taster-day-jul-2026', 'Women of Ihsan — Taster Day', 20, 75, ''],
    ['ikhwan-missions-retreat-jul-2026', 'Ikhwan Missions Retreat', 30, 105, '']
  ];

  sheet.getRange(2, 1, events.length, 5).setValues(events).setFontFamily('Arial').setFontSize(10);
  sheet.getRange(2, 1, events.length, 4).setFontColor(BLUE);
  sheet.getRange(2, 4, events.length, 1).setNumberFormat('£#,##0');

  var places = bookingsRange_('Places');
  var totals = bookingsRange_('Total');
  var ids = bookingsRange_('Event ID');
  var status = bookingsRange_('Status');
  var formulas = [];

  for (var i = 0; i < events.length; i++) {
    var row = i + 2;
    formulas.push([
      '=SUMIFS(' + places + ',' + ids + ',$A' + row + ',' + status + ',"<>Cancelled",' +
        status + ',"<>Expired",' + status + ',"<>Refunded")',
      '=SUMIFS(' + places + ',' + ids + ',$A' + row + ',' + status + ',"Paid")',
      '=MAX($C' + row + '-$F' + row + ',0)',
      '=SUMIFS(' + totals + ',' + ids + ',$A' + row + ',' + status + ',"Paid")'
    ]);
  }

  sheet.getRange(2, 6, events.length, 4).setFormulas(formulas).setFontFamily('Arial').setFontSize(10);
  sheet.getRange(2, 9, events.length, 1).setNumberFormat('£#,##0.00');

  // Notes sit in column K, clear of columns A-C: the capacity check scans those
  // for events, and stray text there would sit among the real rows.
  sheet.setColumnWidth(11, 420);
  sheet.getRange('K1:K3')
    .setValues([
      ['Blue cells are yours to edit. Event ID must match the data-event-id in index.html exactly.'],
      ['Places Held counts everything except cancelled, expired and refunded — that is what the capacity check uses.'],
      ['Add a new event on the first empty row. The last four columns calculate themselves.']
    ])
    .setFontFamily('Arial').setFontSize(9).setFontStyle('italic').setFontColor(GREY)
    .setBackground(null).setFontWeight('normal').setWrap(true);
}

function bookingsRange_(column) {
  var letter = columnLetter_(columnIndex_(column));
  return "Bookings!$" + letter + "$2:$" + letter + "$" + FORMULA_ROWS;
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

  var places = bookingsRange_('Places');
  var totals = bookingsRange_('Total');
  var status = bookingsRange_('Status');
  var refs = bookingsRange_('Reference');

  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidths(2, 4, 110);

  sheet.getRange('A1').setValue('Bookings at a glance')
    .setFontFamily('Arial').setFontSize(14).setFontWeight('bold').setFontColor(NAVY);
  sheet.getRange('A2').setValue('Recalculates automatically as bookings arrive.')
    .setFontFamily('Arial').setFontSize(9).setFontStyle('italic').setFontColor(GREY);

  var metrics = [
    ['Total bookings', '=COUNTA(' + refs + ')', '#,##0'],
    ['Paid', '=COUNTIF(' + status + ',"Paid")', '#,##0'],
    ['Awaiting payment', '=COUNTIF(' + status + ',"Awaiting payment")', '#,##0'],
    ['Enquiries', '=COUNTIF(' + status + ',"Enquiry")', '#,##0'],
    ['Cancelled or expired',
      '=COUNTIF(' + status + ',"Cancelled")+COUNTIF(' + status + ',"Expired")+COUNTIF(' + status + ',"Refunded")',
      '#,##0'],
    ['', '', ''],
    ['Places paid for', '=SUMIFS(' + places + ',' + status + ',"Paid")', '#,##0'],
    ['Revenue collected', '=SUMIFS(' + totals + ',' + status + ',"Paid")', '£#,##0.00'],
    ['Revenue outstanding', '=SUMIFS(' + totals + ',' + status + ',"Awaiting payment")', '£#,##0.00']
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

  sheet.getRange('A14').setValue('Capacity by event')
    .setFontFamily('Arial').setFontSize(11).setFontWeight('bold').setFontColor(NAVY);

  sheet.getRange(15, 1, 1, 5)
    .setValues([['Event', 'Capacity', 'Held', 'Remaining', 'Collected']])
    .setFontFamily('Arial').setFontSize(10).setFontWeight('bold')
    .setFontColor('#ffffff').setBackground(NAVY);

  var rows = [];

  for (var i = 2; i <= 4; i++) {
    rows.push(['=Events!$B' + i, '=Events!$C' + i, '=Events!$F' + i, '=Events!$H' + i, '=Events!$I' + i]);
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
    ['How it works', 'Someone books on the website → this script writes a row on the Bookings tab, emails the organisers, and emails them → Stripe takes the payment → the row flips to Paid.'],
    ['Do not', 'Rename tabs, reorder columns, or rename headers on the Bookings tab. The script writes by column position, so a moved column silently lands the wrong data in the wrong place.'],
    ['Safe to do', 'Sort, filter, hide columns, add new columns to the RIGHT of "Paid At", and change Status by hand to Cancelled or Refunded.'],
    ['Keep row 2 free', 'The Bookings tab is empty on purpose — new bookings append to the first free row, and a placeholder row would count against your event capacity. The example below shows what a real row looks like.'],
    ['Statuses', 'Enquiry — recorded, no payment configured. Awaiting payment — sent to Stripe, not paid yet. Paid — money received. Expired — set automatically after 2 days unpaid. Cancelled / Refunded — set by you.'],
    ['Events tab', 'Edit Capacity and Price there. The website stops taking bookings once Places Held reaches Capacity. Event ID must match index.html exactly.']
  ];

  sheet.getRange(3, 1, notes.length, 2).setValues(notes)
    .setFontFamily('Arial').setFontSize(10).setVerticalAlignment('top').setWrap(true);
  sheet.getRange(3, 1, notes.length, 1).setFontWeight('bold').setFontColor(NAVY);

  var exampleRow = 3 + notes.length + 1;

  sheet.getRange(exampleRow, 1).setValue('Example row')
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
