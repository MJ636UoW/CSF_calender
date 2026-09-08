/**
 * CSF Event Planning & Approval System
 * Production-Ready Google Apps Script Backend
 * 
 * Supports:
 * - Google Account authentication & session detection
 * - Role-Based Access Control: 'admin' and 'member' only
 * - Admin User Management (assigning member/admin roles)
 * - Admin approval gate (only approved events visible to all members)
 * - "Arrange Google Meet" integration
 * - Daily morning event notification digest sent to all members
 * - Real-time comments / thoughts per event
 * - Venue and time conflict detection
 * - Google Calendar synchronization
 */

const SHEETS = {
  EVENTS: 'Events',
  COMMENTS: 'Comments',
  USERS: 'Users',
  SETTINGS: 'Settings'
};

const ROLES = {
  ADMIN: 'admin',
  MEMBER: 'member'
};

/**
 * Serves the web app
 */
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('CSF Event Calendar & Approval Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Initializes and verifies all required sheets and column headers.
 * Self-healing: adds missing columns and sheets automatically.
 */
function setupProject() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. Ensure Sheets exist
  const requiredSheets = [
    {
      name: SHEETS.EVENTS,
      headers: [
        'EventID', 'Title', 'Type', 'Date', 'StartTime', 'EndTime',
        'Venue', 'Coordinator', 'Speaker', 'Audience', 'ExpectedParticipants',
        'Description', 'AlternativeDate', 'SubmittedBy', 'SubmittedEmail',
        'Status', 'AdminComment', 'DecisionBy', 'DecisionDate', 'CreatedAt',
        'CalendarEventID', 'Guide', 'ArrangeMeet', 'MeetLink'
      ]
    },
    {
      name: SHEETS.COMMENTS,
      headers: ['CommentID', 'EventID', 'StaffName', 'StaffEmail', 'Comment', 'CreatedAt']
    },
    {
      name: SHEETS.USERS,
      headers: ['Name', 'Email', 'Role', 'Status', 'CreatedAt']
    },
    {
      name: SHEETS.SETTINGS,
      headers: ['Setting', 'Value'],
      defaults: [
        ['AppTitle', 'CSF Event Planning & Approval System'],
        ['CalendarId', ''],
        ['DailyDigestHour', '8'],
        ['SendDigestIfEmpty', 'false'],
        ['RequireApprovalForVisibility', 'true']
      ]
    }
  ];

  requiredSheets.forEach(item => {
    let sheet = ss.getSheetByName(item.name);
    if (!sheet) {
      sheet = ss.insertSheet(item.name);
    }
    
    // Check and set headers
    const currentHeaders = sheet.getLastColumn() > 0 ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] : [];
    if (currentHeaders.length === 0) {
      sheet.appendRow(item.headers);
      sheet.getRange(1, 1, 1, item.headers.length).setFontWeight('bold').setBackground('#E2E8F0');
    } else {
      // Append any missing headers
      item.headers.forEach(h => {
        if (!currentHeaders.map(String).map(s => s.trim().toLowerCase()).includes(h.toLowerCase())) {
          sheet.getRange(1, sheet.getLastColumn() + 1).setValue(h).setFontWeight('bold').setBackground('#E2E8F0');
        }
      });
    }

    // Insert default settings if Settings sheet is newly populated
    if (item.defaults && sheet.getLastRow() <= 1) {
      item.defaults.forEach(d => sheet.appendRow(d));
    }
  });

  // Ensure current deployer is recorded as an Admin in Users
  const deployerEmail = getCurrentUserEmail_();
  if (deployerEmail) {
    ensureAdminExists_(deployerEmail);
  }

  // Set up automated daily digest trigger
  setupDailyNotificationTrigger();

  return 'Setup completed successfully. Sheets verified, admin initialized, and daily notification trigger configured.';
}

/**
 * Bootstrap data required on frontend load
 */
function getBootstrapData() {
  const email = getCurrentUserEmail_();
  const currentUser = getUserByEmail_(email);
  const settings = getSettings_();
  const events = getEventsForUser_(currentUser);
  
  return {
    currentUser: currentUser,
    settings: settings,
    events: events,
    serverToday: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  };
}

/**
 * Resolves current user's Google email
 */
function getCurrentUserEmail_() {
  let email = (Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (!email) {
    email = (Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  }
  return email;
}

/**
 * Fetches user profile from Users sheet.
 * If user does not exist:
 * - If spreadsheet owner or first active user -> auto-registers as ADMIN
 * - Otherwise -> auto-registers as MEMBER
 */
function getUserByEmail_(email) {
  if (!email) {
    return { name: 'Guest User', email: '', role: ROLES.MEMBER };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEETS.USERS);
  if (!sheet) {
    setupProject();
    sheet = ss.getSheetByName(SHEETS.USERS);
  }

  const values = sheet.getDataRange().getDisplayValues();
  const headers = values[0].map(h => String(h).trim().toLowerCase());
  const nameIdx = headers.indexOf('name') >= 0 ? headers.indexOf('name') : 0;
  const emailIdx = headers.indexOf('email') >= 0 ? headers.indexOf('email') : 1;
  const roleIdx = headers.indexOf('role') >= 0 ? headers.indexOf('role') : 2;

  // Search existing users
  for (let i = 1; i < values.length; i++) {
    const rowEmail = (values[i][emailIdx] || '').trim().toLowerCase();
    if (rowEmail === email) {
      let rawRole = (values[i][roleIdx] || '').trim().toLowerCase();
      // Map legacy or custom roles strictly to 'admin' or 'member'
      let normalizedRole = (rawRole === 'admin' || rawRole === 'hod') ? ROLES.ADMIN : ROLES.MEMBER;
      let displayName = values[i][nameIdx] || email.split('@')[0];
      return { name: displayName, email: email, role: normalizedRole };
    }
  }

  // Not in Users sheet: Auto-register
  const ownerEmail = (Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  const isOwner = (email === ownerEmail) || (values.length <= 1);
  const assignedRole = isOwner ? ROLES.ADMIN : ROLES.MEMBER;
  const displayName = email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

  sheet.appendRow([displayName, email, assignedRole, 'Active', new Date()]);
  return { name: displayName, email: email, role: assignedRole };
}

/**
 * Ensures at least one admin exists in the Users sheet
 */
function ensureAdminExists_(adminEmail) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.USERS);
  const values = sheet.getDataRange().getDisplayValues();
  
  let found = false;
  let hasAnyAdmin = false;

  for (let i = 1; i < values.length; i++) {
    const rowEmail = (values[i][1] || '').trim().toLowerCase();
    const rowRole = (values[i][2] || '').trim().toLowerCase();
    if (rowRole === 'admin' || rowRole === 'hod') hasAnyAdmin = true;
    if (rowEmail === adminEmail) {
      found = true;
      if (rowRole !== 'admin') {
        sheet.getRange(i + 1, 3).setValue(ROLES.ADMIN);
      }
    }
  }

  if (!found) {
    sheet.appendRow(['Admin', adminEmail, ROLES.ADMIN, 'Active', new Date()]);
  }
}

/**
 * Fetch settings key-value map
 */
function getSettings_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.SETTINGS);
  if (!sheet) return {};
  const v = sheet.getDataRange().getValues(), out = {};
  for (let i = 1; i < v.length; i++) {
    if (v[i][0]) out[String(v[i][0]).trim()] = v[i][1];
  }
  return out;
}

/**
 * Get all raw events from sheet
 */
function getAllRawEvents_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.EVENTS);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const h = data[0];
  return data.slice(1).filter(r => r[0]).map(r => rowToObject_(h, r));
}

/**
 * Retrieves events with strict role visibility:
 * - Admin: Sees ALL events (Approved, Pending, Rejected)
 * - Member: Sees ALL Approved events + their own submitted events (even if Pending/Rejected)
 */
function getEventsForUser_(user) {
  const allEvents = getAllRawEvents_();
  if (user.role === ROLES.ADMIN) {
    return allEvents;
  }
  const userEmail = (user.email || '').toLowerCase();
  return allEvents.filter(e => {
    if (e.Status === 'Approved') return true;
    if (userEmail && (e.SubmittedEmail || '').toLowerCase() === userEmail) return true;
    return false;
  });
}

/**
 * Get single event details with associated comments
 */
function getEventDetails(eventId) {
  const email = getCurrentUserEmail_();
  const user = getUserByEmail_(email);
  const event = findEventById_(eventId);
  if (!event) throw new Error('Event not found.');

  // Check authorization
  if (user.role !== ROLES.ADMIN && event.Status !== 'Approved' && (event.SubmittedEmail || '').toLowerCase() !== user.email.toLowerCase()) {
    throw new Error('Access denied to view this unapproved event.');
  }

  return {
    event: event,
    comments: getCommentsForEvent_(eventId)
  };
}

/**
 * Submit / Propose an Event (Open to Members and Admins for today or future dates)
 */
function submitEvent(payload) {
  const email = getCurrentUserEmail_();
  const user = getUserByEmail_(email);
  validateEventPayload_(payload);

  const eventId = 'EVT-' + Utilities.getUuid().slice(0, 8).toUpperCase();
  const now = new Date();
  const conflicts = findConflicts_(payload, null);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.EVENTS);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = indexMap_(headers);

  // Build row according to headers
  const row = new Array(headers.length).fill('');
  setVal_(row, idx.EventID, eventId);
  setVal_(row, idx.Title, clean_(payload.title));
  setVal_(row, idx.Type, clean_(payload.type));
  setVal_(row, idx.Date, parseDateOnly_(payload.date));
  setVal_(row, idx.StartTime, clean_(payload.startTime));
  setVal_(row, idx.EndTime, clean_(payload.endTime));
  setVal_(row, idx.Venue, clean_(payload.venue));
  setVal_(row, idx.Coordinator, clean_(payload.coordinator || user.name));
  setVal_(row, idx.Speaker, clean_(payload.speaker));
  setVal_(row, idx.Audience, clean_(payload.audience));
  setVal_(row, idx.ExpectedParticipants, Number(payload.expectedParticipants || 0));
  setVal_(row, idx.Description, clean_(payload.description));
  setVal_(row, idx.AlternativeDate, payload.alternativeDate ? parseDateOnly_(payload.alternativeDate) : '');
  setVal_(row, idx.SubmittedBy, user.name);
  setVal_(row, idx.SubmittedEmail, email);
  setVal_(row, idx.Status, 'Pending');
  setVal_(row, idx.AdminComment, '');
  setVal_(row, idx.DecisionBy, '');
  setVal_(row, idx.DecisionDate, '');
  setVal_(row, idx.CreatedAt, now);
  setVal_(row, idx.CalendarEventID, '');
  setVal_(row, idx.Guide, clean_(payload.guide));
  setVal_(row, idx.ArrangeMeet, payload.arrangeMeet ? 'TRUE' : 'FALSE');
  setVal_(row, idx.MeetLink, clean_(payload.meetLink));

  sheet.appendRow(row);

  return {
    ok: true,
    eventId: eventId,
    conflicts: conflicts,
    message: 'Event proposed successfully. It will appear on the general calendar once approved by an Admin.'
  };
}

/**
 * Add a comment or thought to an event
 */
function addComment(eventId, text) {
  const email = getCurrentUserEmail_();
  const user = getUserByEmail_(email);
  const cleanComment = clean_(text);
  if (!cleanComment) throw new Error('Comment cannot be empty.');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.COMMENTS);
  const commentId = 'COM-' + Utilities.getUuid().slice(0, 8).toUpperCase();
  
  sheet.appendRow([commentId, eventId, user.name, email, cleanComment, new Date()]);
  return getCommentsForEvent_(eventId);
}

/**
 * Admin Action: Approve or Reject an event
 * Only users with role === 'admin' can execute this.
 */
function setEventStatus(eventId, status, adminComment, customMeetLink) {
  const email = getCurrentUserEmail_();
  const user = getUserByEmail_(email);
  
  if (user.role !== ROLES.ADMIN) {
    throw new Error('Access denied: Only an Admin can approve or reject events.');
  }
  if (!['Approved', 'Rejected'].includes(status)) {
    throw new Error('Invalid status.');
  }
  if (status === 'Rejected' && !clean_(adminComment)) {
    throw new Error('A rejection reason is required so the organizer knows what to adjust.');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.EVENTS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idx = indexMap_(headers);

  let row = -1;
  let event = null;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idx.EventID]) === String(eventId)) {
      row = i + 1;
      event = rowToObject_(headers, data[i]);
      break;
    }
  }
  if (row < 0 || !event) throw new Error('Event not found.');

  // Detect any venue/time conflicts
  const conflicts = findConflicts_({
    date: event.Date,
    startTime: event.StartTime,
    endTime: event.EndTime,
    venue: event.Venue
  }, eventId);

  // Update Status and Decision fields
  sheet.getRange(row, (idx.AdminComment !== undefined ? idx.AdminComment : idx.HODComment) + 1).setValue(clean_(adminComment));
  sheet.getRange(row, idx.Status + 1).setValue(status);
  sheet.getRange(row, idx.DecisionBy + 1).setValue(`${user.name} <${email}>`);
  sheet.getRange(row, idx.DecisionDate + 1).setValue(new Date());

  // Handle Google Meet & Calendar Sync
  let generatedMeetLink = clean_(customMeetLink) || event.MeetLink || '';
  if (status === 'Approved') {
    // If arrange meet was requested and no link yet, create Google Meet room link
    const shouldArrangeMeet = (String(event.ArrangeMeet).toUpperCase() === 'TRUE') || !!customMeetLink;
    if (shouldArrangeMeet && !generatedMeetLink) {
      // Standard dedicated Google Meet room identifier for this event
      generatedMeetLink = `https://meet.google.com/lookup/csf-${eventId.toLowerCase()}`;
    }
    
    if (idx.MeetLink !== undefined && generatedMeetLink) {
      sheet.getRange(row, idx.MeetLink + 1).setValue(generatedMeetLink);
      event.MeetLink = generatedMeetLink;
    }

    // Sync to Google Calendar
    try {
      syncApprovedEventToCalendar_(eventId, event, row, idx, sheet);
    } catch (calErr) {
      Logger.log('Calendar sync notice: ' + calErr.message);
    }
  } else if (status === 'Rejected' && event.CalendarEventID) {
    try {
      removeCalendarEvent_(event.CalendarEventID);
      sheet.getRange(row, idx.CalendarEventID + 1).setValue('');
    } catch (delErr) {
      Logger.log('Calendar event removal notice: ' + delErr.message);
    }
  }

  return {
    ok: true,
    status: status,
    conflicts: conflicts,
    meetLink: generatedMeetLink
  };
}

/**
 * Synchronize approved event to Google Calendar
 */
function syncApprovedEventToCalendar_(eventId, event, row, idx, sheet) {
  const calendarId = String(getSettings_().CalendarId || '').trim();
  if (!calendarId) return '';

  const cal = CalendarApp.getCalendarById(calendarId);
  if (!cal) return '';

  const startDt = combineDateTime_(event.Date, event.StartTime);
  const endDt = combineDateTime_(event.Date, event.EndTime);
  
  const descParts = [
    `CSF Event: ${event.Title}`,
    `Type: ${event.Type || 'Event'}`,
    `Coordinator: ${event.Coordinator || ''}`,
    `Venue: ${event.Venue || ''}`
  ];
  if (event.MeetLink) descParts.push(`Google Meet: ${event.MeetLink}`);
  if (event.Speaker) descParts.push(`Speaker: ${event.Speaker}`);
  if (event.Description) descParts.push(`\nDescription:\n${event.Description}`);
  if (event.Guide) descParts.push(`\nGuidelines/Instructions:\n${event.Guide}`);

  const created = cal.createEvent(event.Title, startDt, endDt, {
    location: event.Venue || 'Campus / Virtual',
    description: descParts.join('\n')
  });

  try {
    created.setColor(CalendarApp.EventColor.GREEN);
  } catch (err) {}

  if (idx.CalendarEventID !== undefined) {
    sheet.getRange(row, idx.CalendarEventID + 1).setValue(created.getId());
  }
  return created.getId();
}

/**
 * Remove event from Google Calendar
 */
function removeCalendarEvent_(id) {
  const calendarId = String(getSettings_().CalendarId || '').trim();
  if (!calendarId || !id) return;
  const cal = CalendarApp.getCalendarById(calendarId);
  if (!cal) return;
  const e = cal.getEventById(id);
  if (e) e.deleteEvent();
}

/**
 * Conflict detection
 */
function findConflicts_(payload, ignoreId) {
  const date = String(payload.date || '');
  const s = minutes_(payload.startTime);
  const en = minutes_(payload.endTime);
  const venue = clean_(payload.venue).toLowerCase();

  if (!date || s === null || en === null) return [];

  return getAllRawEvents_().filter(e => {
    if (ignoreId && String(e.EventID) === String(ignoreId)) return false;
    if (e.Status === 'Rejected' || String(e.Date) !== date) return false;
    const es = minutes_(e.StartTime);
    const ee = minutes_(e.EndTime);
    const timeOverlap = (es !== null && ee !== null && s < ee && en > es);
    const venueOverlap = (!venue || clean_(e.Venue).toLowerCase() === venue);
    return timeOverlap && venueOverlap;
  }).map(e => ({
    eventId: e.EventID,
    title: e.Title,
    time: `${e.StartTime}-${e.EndTime}`,
    venue: e.Venue,
    status: e.Status
  }));
}

/**
 * User Management APIs (Strictly Admin-Only)
 */
function getAllUsers() {
  const email = getCurrentUserEmail_();
  const currentUser = getUserByEmail_(email);
  if (currentUser.role !== ROLES.ADMIN) {
    throw new Error('Access denied: Only an Admin can access User Management.');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.USERS);
  const data = sheet.getDataRange().getDisplayValues();
  if (data.length < 2) return [];

  const headers = data[0].map(h => String(h).trim().toLowerCase());
  const nameIdx = headers.indexOf('name') >= 0 ? headers.indexOf('name') : 0;
  const emailIdx = headers.indexOf('email') >= 0 ? headers.indexOf('email') : 1;
  const roleIdx = headers.indexOf('role') >= 0 ? headers.indexOf('role') : 2;
  const statusIdx = headers.indexOf('status') >= 0 ? headers.indexOf('status') : 3;

  const list = [];
  for (let i = 1; i < data.length; i++) {
    const userEmail = (data[i][emailIdx] || '').trim().toLowerCase();
    if (!userEmail) continue;
    const rawRole = (data[i][roleIdx] || '').trim().toLowerCase();
    const role = (rawRole === 'admin' || rawRole === 'hod') ? ROLES.ADMIN : ROLES.MEMBER;
    list.push({
      name: data[i][nameIdx] || userEmail.split('@')[0],
      email: userEmail,
      role: role,
      status: data[i][statusIdx] || 'Active'
    });
  }
  return list;
}

/**
 * Update user role (Strictly Admin-Only)
 * Only assigns 'admin' or 'member'
 */
function updateUserRole(targetEmail, newRole) {
  const adminEmail = getCurrentUserEmail_();
  const adminUser = getUserByEmail_(adminEmail);
  if (adminUser.role !== ROLES.ADMIN) {
    throw new Error('Access denied: Only an Admin can assign roles.');
  }

  const target = clean_(targetEmail).toLowerCase();
  const normalizedRole = clean_(newRole).toLowerCase();
  if (![ROLES.ADMIN, ROLES.MEMBER].includes(normalizedRole)) {
    throw new Error('Invalid role. Allowed roles are "admin" and "member".');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.USERS);
  const data = sheet.getDataRange().getDisplayValues();
  const headers = data[0].map(h => String(h).trim().toLowerCase());
  const emailIdx = headers.indexOf('email') >= 0 ? headers.indexOf('email') : 1;
  const roleIdx = headers.indexOf('role') >= 0 ? headers.indexOf('role') : 2;

  // Prevent demoting the last admin
  if (normalizedRole === ROLES.MEMBER) {
    let adminCount = 0;
    for (let i = 1; i < data.length; i++) {
      const r = (data[i][roleIdx] || '').trim().toLowerCase();
      if (r === 'admin' || r === 'hod') adminCount++;
    }
    if (adminCount <= 1 && (target === adminEmail || data.find(row => (row[emailIdx] || '').toLowerCase() === target && ['admin','hod'].includes((row[roleIdx]||'').toLowerCase())))) {
      throw new Error('Action blocked: Cannot demote the only remaining Admin.');
    }
  }

  let updated = false;
  for (let i = 1; i < data.length; i++) {
    if ((data[i][emailIdx] || '').trim().toLowerCase() === target) {
      sheet.getRange(i + 1, roleIdx + 1).setValue(normalizedRole);
      updated = true;
      break;
    }
  }

  if (!updated) {
    // Add user if not currently in sheet
    sheet.appendRow([target.split('@')[0], target, normalizedRole, 'Active', new Date()]);
  }

  return { ok: true, email: target, role: normalizedRole };
}

/**
 * Add / Invite a user by email (Admin-Only)
 */
function addUser(name, email, role) {
  const adminEmail = getCurrentUserEmail_();
  const adminUser = getUserByEmail_(adminEmail);
  if (adminUser.role !== ROLES.ADMIN) {
    throw new Error('Access denied: Only an Admin can add users.');
  }

  const cleanEmail = clean_(email).toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Please provide a valid email address.');
  }

  const assignedRole = clean_(role).toLowerCase() === ROLES.ADMIN ? ROLES.ADMIN : ROLES.MEMBER;
  const displayName = clean_(name) || cleanEmail.split('@')[0];

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.USERS);
  const data = sheet.getDataRange().getDisplayValues();
  for (let i = 1; i < data.length; i++) {
    if ((data[i][1] || '').trim().toLowerCase() === cleanEmail) {
      throw new Error(`User with email "${cleanEmail}" is already registered.`);
    }
  }

  sheet.appendRow([displayName, cleanEmail, assignedRole, 'Active', new Date()]);
  return { ok: true, user: { name: displayName, email: cleanEmail, role: assignedRole } };
}

/**
 * ==========================================================
 * DAILY NOTIFICATION DIGEST SYSTEM
 * ==========================================================
 */

/**
 * Sends daily email digest of today's approved events to all registered users.
 * Can be run via time-driven trigger or triggered on-demand by Admin.
 */
function sendDailyEventDigest() {
  const timeZone = Session.getScriptTimeZone();
  const todayStr = Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd');
  const todayFormatted = Utilities.formatDate(new Date(), timeZone, 'EEEE, MMMM d, yyyy');

  // 1. Get all today's approved events
  const allEvents = getAllRawEvents_();
  const todayEvents = allEvents.filter(e => e.Status === 'Approved' && String(e.Date) === todayStr);

  const settings = getSettings_();
  const sendIfEmpty = String(settings.SendDigestIfEmpty || 'false').toLowerCase() === 'true';

  if (todayEvents.length === 0 && !sendIfEmpty) {
    Logger.log('No approved events scheduled for today (' + todayStr + '). Skipping daily digest.');
    return { ok: true, sent: 0, reason: 'No events scheduled for today.' };
  }

  // 2. Gather recipient emails
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const userSheet = ss.getSheetByName(SHEETS.USERS);
  const userData = userSheet.getDataRange().getDisplayValues();
  const emailSet = new Set();

  for (let i = 1; i < userData.length; i++) {
    const email = (userData[i][1] || '').trim().toLowerCase();
    const status = (userData[i][3] || 'Active').trim().toLowerCase();
    if (email && email.includes('@') && status !== 'disabled') {
      emailSet.add(email);
    }
  }

  if (emailSet.size === 0) {
    Logger.log('No active users found to receive the daily digest.');
    return { ok: true, sent: 0, reason: 'No active user emails found.' };
  }

  const recipients = Array.from(emailSet);

  // 3. Build HTML Email
  let eventsHtml = '';
  if (todayEvents.length === 0) {
    eventsHtml = '<p style="color:#64748B;font-style:italic;">There are no scheduled events for today. Enjoy your day!</p>';
  } else {
    eventsHtml = todayEvents.map(e => `
      <div style="background:#FFFFFF;border:1px solid #E2E8F0;border-left:5px solid #16A34A;border-radius:8px;padding:16px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
          <h3 style="margin:0;color:#0F172A;font-size:17px;font-weight:700;">${escHtml_(e.Title)}</h3>
          <span style="background:#DCFCE7;color:#15803D;padding:4px 8px;border-radius:12px;font-size:12px;font-weight:600;">${escHtml_(e.Type || 'Event')}</span>
        </div>
        <table style="width:100%;font-size:14px;color:#334155;border-collapse:collapse;margin:8px 0;">
          <tr><td style="width:120px;font-weight:600;padding:4px 0;color:#64748B;">⏰ Time:</td><td>${escHtml_(e.StartTime)} – ${escHtml_(e.EndTime)}</td></tr>
          <tr><td style="font-weight:600;padding:4px 0;color:#64748B;">📍 Venue:</td><td>${escHtml_(e.Venue)}</td></tr>
          <tr><td style="font-weight:600;padding:4px 0;color:#64748B;">👤 Coordinator:</td><td>${escHtml_(e.Coordinator || 'CSF Team')}</td></tr>
          ${e.Speaker ? `<tr><td style="font-weight:600;padding:4px 0;color:#64748B;">🎤 Speaker:</td><td>${escHtml_(e.Speaker)}</td></tr>` : ''}
        </table>
        ${e.Description ? `<div style="margin-top:8px;font-size:13px;color:#475569;background:#F8FAFC;padding:10px;border-radius:6px;"><strong>Description:</strong> ${escHtml_(e.Description)}</div>` : ''}
        ${e.Guide ? `<div style="margin-top:6px;font-size:13px;color:#475569;background:#F1F5F9;padding:10px;border-radius:6px;"><strong>Guidelines/Instructions:</strong> ${escHtml_(e.Guide)}</div>` : ''}
        ${e.MeetLink ? `
          <div style="margin-top:12px;">
            <a href="${escHtml_(e.MeetLink)}" target="_blank" style="display:inline-block;background:#0284C7;color:#FFFFFF;padding:8px 16px;text-decoration:none;border-radius:6px;font-weight:600;font-size:13px;">
              📹 Join Google Meet
            </a>
          </div>` : ''}
      </div>
    `).join('');
  }

  const emailBody = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F8FAFC;margin:0;padding:24px;color:#0F172A;">
      <div style="max-width:620px;margin:auto;background:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.06);border:1px solid #E2E8F0;">
        <div style="background:linear-gradient(135deg,#1E3A8A,#2563EB);padding:24px 28px;color:#FFFFFF;">
          <h1 style="margin:0;font-size:22px;font-weight:800;">📅 CSF Daily Event Digest</h1>
          <p style="margin:6px 0 0;font-size:14px;opacity:0.9;">Scheduled events for <strong>${todayFormatted}</strong></p>
        </div>
        <div style="padding:24px 28px;">
          <p style="font-size:15px;color:#334155;margin-top:0;">Hello team, here is the official event schedule for today:</p>
          ${eventsHtml}
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #E2E8F0;text-align:center;font-size:12px;color:#94A3B8;">
            CSF Event Planning & Approval Portal • Sent automatically every morning
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  // Send email to all recipients
  const appTitle = settings.AppTitle || 'CSF Event Portal';
  const subject = `[${appTitle}] Today's Events - ${todayFormatted} (${todayEvents.length} scheduled)`;

  // Send via MailApp
  recipients.forEach(r => {
    try {
      MailApp.sendEmail({
        to: r,
        subject: subject,
        htmlBody: emailBody
      });
    } catch (err) {
      Logger.log(`Failed sending digest to ${r}: ${err.message}`);
    }
  });

  return {
    ok: true,
    sent: recipients.length,
    eventsCount: todayEvents.length,
    today: todayFormatted
  };
}

/**
 * Configure automated daily morning trigger
 */
function setupDailyNotificationTrigger() {
  // Clear any existing sendDailyEventDigest triggers
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'sendDailyEventDigest') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // Create daily trigger at 8:00 AM
  ScriptApp.newTrigger('sendDailyEventDigest')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .create();

  return 'Daily morning notification trigger configured for 8:00 AM.';
}

/**
 * Admin action: Manually trigger today's event digest email right now
 */
function triggerDailyNotificationNow() {
  const email = getCurrentUserEmail_();
  const user = getUserByEmail_(email);
  if (user.role !== ROLES.ADMIN) {
    throw new Error('Access denied: Only an Admin can trigger notification broadcasts.');
  }
  return sendDailyEventDigest();
}

/**
 * Helpers & Utilities
 */
function getCommentsForEvent_(eventId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.COMMENTS);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const h = data[0];
  return data.slice(1)
    .filter(r => String(r[1]) === String(eventId))
    .map(r => rowToObject_(h, r));
}

function findEventById_(id) {
  return getAllRawEvents_().find(e => String(e.EventID) === String(id)) || null;
}

function validateEventPayload_(p) {
  ['title', 'type', 'date', 'startTime', 'endTime', 'venue'].forEach(k => {
    if (!clean_(p[k])) throw new Error(`Field "${k}" is required.`);
  });
  const s = minutes_(p.startTime);
  const e = minutes_(p.endTime);
  if (s === null || e === null || e <= s) {
    throw new Error('End time must be later than start time.');
  }
}

function rowToObject_(h, r) {
  const o = {};
  h.forEach((k, i) => {
    let v = r[i];
    if (v instanceof Date) {
      if (['Date', 'AlternativeDate'].includes(k)) {
        v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      } else {
        v = Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
      }
    }
    o[k] = v;
  });
  return o;
}

function setVal_(arr, index, val) {
  if (index !== undefined && index >= 0) arr[index] = val;
}

function indexMap_(h) {
  const m = {};
  h.forEach((x, i) => {
    m[x] = i;
  });
  return m;
}

function clean_(v) {
  return String(v == null ? '' : v).trim();
}

function minutes_(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clean_(t));
  if (!m) return null;
  const h = +m[1];
  const n = +m[2];
  return h >= 0 && h < 24 && n >= 0 && n < 60 ? h * 60 + n : null;
}

function parseDateOnly_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean_(s));
  if (!m) throw new Error('Invalid date format (expected YYYY-MM-DD).');
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

function combineDateTime_(d, t) {
  const x = d instanceof Date ? new Date(d) : parseDateOnly_(String(d));
  const m = minutes_(t);
  x.setHours(Math.floor(m / 60), m % 60, 0, 0);
  return x;
}

function escHtml_(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
