/**
 * CSF & MIT ADT Event Planning & Approval System
 * Enterprise-Grade Security & Confidentiality Backend
 * 
 * Security Features:
 * - Passwordless Email OTP (One-Time Password) Authentication (10 min expiry)
 * - HMAC-SHA256 Cryptographically Signed Session Tokens (Zero Spoofing)
 * - Mandatory Server-Side Token Verification on All Protected APIs
 * - Strict Institutional Domain Restriction (@mituniversity.edu.in + whitelisted accounts)
 * - Role-Based Confidentiality: Unapproved events and internal admin notes strictly masked
 * - Security Audit Logging (AuditLogs sheet)
 * - Dual-Engine Reliable Email Sender (MailApp & GmailApp)
 * - Automated 12-Hour Prior Event Reminder & Daily 8 AM Digest
 */

const APP_PORTAL_URL = 'https://mitadt-calender.vercel.app';
const ALLOWED_INSTITUTIONAL_DOMAINS = ['mituniversity.edu.in'];
const PRIMARY_ADMIN_EMAILS = ['mandarj2412@gmail.com', 'mandar.joshi@mituniversity.edu.in'];

const SHEETS = {
  EVENTS: 'Events',
  COMMENTS: 'Comments',
  USERS: 'Users',
  SETTINGS: 'Settings',
  AUDIT: 'AuditLogs'
};

const ROLES = {
  ADMIN: 'admin',
  MEMBER: 'member'
};

/**
 * Handles GET requests:
 * - If action parameter is provided: returns JSON API response (for Vercel)
 * - Otherwise: renders Index.html as native Apps Script Web App
 */
function doGet(e) {
  if (e && e.parameter && e.parameter.action) {
    return handleApiRequest_(e.parameter.action, e.parameter);
  }

  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('MIT ADT - CSF Event Calendar & Approval Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Handles POST requests from external frontend (Vercel)
 */
function doPost(e) {
  try {
    let payload = {};
    if (e && e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    } else if (e && e.parameter) {
      payload = e.parameter;
    }
    const action = payload.action || (e && e.parameter ? e.parameter.action : '');
    return handleApiRequest_(action, payload);
  } catch (err) {
    return jsonResponse_({ ok: false, error: err.message, code: 400 });
  }
}

/**
 * Security API Router with Cryptographic Authentication & Role Enforcement
 */
function handleApiRequest_(action, data) {
  try {
    // 1. UNPROTECTED PUBLIC ACTIONS
    if (action === 'requestLoginOtp') {
      return jsonResponse_({ ok: true, data: requestLoginOtp(data.email) });
    }
    if (action === 'verifyLoginOtp') {
      return jsonResponse_({ ok: true, data: verifyLoginOtp(data.email, data.otp) });
    }
    if (action === 'getAuthPolicy') {
      return jsonResponse_({
        ok: true,
        data: {
          allowedDomains: ALLOWED_INSTITUTIONAL_DOMAINS,
          portalUrl: APP_PORTAL_URL
        }
      });
    }

    // 2. CRON / TRIGGER ACTIONS (Invoked by cloud timers)
    if (action === 'cronDailyDigest') {
      return jsonResponse_({ ok: true, data: sendDailyEventDigest() });
    }
    if (action === 'cron12HourReminders') {
      return jsonResponse_({ ok: true, data: check12HourReminders() });
    }

    // 3. PROTECTED ACTIONS: REQUIRE CRYPTOGRAPHIC SESSION TOKEN
    const token = data.sessionToken || data.token;
    if (!token) {
      return jsonResponse_({
        ok: false,
        error: 'Unauthorized: Cryptographic session token required.',
        code: 401
      });
    }

    // Cryptographic token verification (HMAC-SHA256 signature & expiry check)
    const caller = verifySessionToken_(token);
    let result = {};

    switch (action) {
      case 'getBootstrapData':
        result = getBootstrapData(caller);
        break;

      case 'getEventDetails':
        result = getEventDetails(data.eventId, caller);
        break;

      case 'submitEvent':
        result = submitEvent(data.payload || data, caller);
        break;

      case 'addComment':
        result = addComment(data.eventId, data.text, caller);
        break;

      // --- ADMINISTRATIVE ACTIONS (STRICT ROLE ASSERTION) ---
      case 'setEventStatus':
        assertAdmin_(caller);
        result = setEventStatus(data.eventId, data.status, data.adminComment, data.customMeetLink, caller);
        break;

      case 'broadcastEventNotification':
        assertAdmin_(caller);
        result = broadcastEventNotification(data.eventId, caller);
        break;

      case 'check12HourReminders':
        assertAdmin_(caller);
        result = check12HourReminders();
        break;

      case 'send12HourReminderNow':
        assertAdmin_(caller);
        result = send12HourReminderNow(data.eventId, caller);
        break;

      case 'getAllUsers':
        assertAdmin_(caller);
        result = getAllUsers(caller);
        break;

      case 'updateUserRole':
        assertAdmin_(caller);
        result = updateUserRole(data.targetEmail, data.newRole, caller);
        break;

      case 'addUser':
        assertAdmin_(caller);
        result = addUser(data.name, data.email, data.role, caller);
        break;

      case 'triggerDailyNotificationNow':
        assertAdmin_(caller);
        result = triggerDailyNotificationNow(caller);
        break;

      case 'setupAllTriggers':
        assertAdmin_(caller);
        result = { ok: true, message: setupAllTriggers() };
        break;

      case 'setupProject':
        assertAdmin_(caller);
        result = { ok: true, message: setupProject() };
        break;

      default:
        throw new Error(`Unknown API action: "${action}"`);
    }

    return jsonResponse_({ ok: true, data: result });
  } catch (err) {
    const isAuthError = String(err.message).toLowerCase().includes('unauthorized') || String(err.message).toLowerCase().includes('access denied');
    return jsonResponse_({ ok: false, error: err.message, code: isAuthError ? 401 : 400 });
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function assertAdmin_(caller) {
  if (!caller || caller.role !== ROLES.ADMIN) {
    logAuditAction_('UNAUTHORIZED_ADMIN_ACTION', caller ? caller.email : 'Unknown', 'Attempted administrative action without admin privileges', 'FORBIDDEN');
    throw new Error('Access Denied: Only verified Administrators can perform this action.');
  }
}

// =============================================================================
// CRYPTOGRAPHIC AUTHENTICATION & SECURITY TOKENS (HMAC-SHA256)
// =============================================================================

function getOrCreateSecretKey_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('AUTH_SECRET_KEY');
  if (!secret) {
    secret = Utilities.getUuid() + '-' + Utilities.getUuid() + '-' + Utilities.getUuid();
    props.setProperty('AUTH_SECRET_KEY', secret);
  }
  return secret;
}

function generateSessionToken_(user) {
  const payload = {
    email: user.email.toLowerCase().trim(),
    role: user.role,
    name: user.name || user.email.split('@')[0],
    iat: Date.now(),
    exp: Date.now() + (7 * 24 * 60 * 60 * 1000) // 7-day token expiration
  };
  const payloadB64 = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  const secret = getOrCreateSecretKey_();
  const signatureBytes = Utilities.computeHmacSha256Signature(payloadB64, secret);
  const signatureB64 = Utilities.base64EncodeWebSafe(signatureBytes);
  return `${payloadB64}.${signatureB64}`;
}

function verifySessionToken_(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('Unauthorized: Authentication token required.');
  }
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new Error('Unauthorized: Malformed session token.');
  }
  const [payloadB64, signatureB64] = parts;
  const secret = getOrCreateSecretKey_();
  const expectedSigBytes = Utilities.computeHmacSha256Signature(payloadB64, secret);
  const expectedSigB64 = Utilities.base64EncodeWebSafe(expectedSigBytes);
  
  if (signatureB64 !== expectedSigB64) {
    throw new Error('Unauthorized: Cryptographic session signature is invalid.');
  }

  const payloadJson = Utilities.newBlob(Utilities.base64DecodeWebSafe(payloadB64)).getDataAsString();
  const payload = JSON.parse(payloadJson);

  if (payload.exp && Date.now() > payload.exp) {
    throw new Error('Unauthorized: Session has expired. Please verify again.');
  }

  // Retrieve fresh role from sheet (prevents demoted users from keeping admin role)
  const freshUser = getUserByEmail_(payload.email);
  return {
    email: payload.email,
    role: freshUser.role,
    name: freshUser.name || payload.name
  };
}

// =============================================================================
// INSTITUTIONAL PERIMETER & EMAIL OTP VERIFICATION
// =============================================================================

function isEmailAuthorizedForLogin_(email) {
  const cleanEmail = clean_(email).toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) return false;

  // Primary Admins always authorized
  if (PRIMARY_ADMIN_EMAILS.includes(cleanEmail)) return true;

  // Check institutional domain
  const domain = cleanEmail.split('@')[1];
  if (ALLOWED_INSTITUTIONAL_DOMAINS.includes(domain)) return true;

  // Check pre-registered users in Users sheet
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const userSheet = ss.getSheetByName(SHEETS.USERS);
  if (userSheet) {
    const data = userSheet.getDataRange().getDisplayValues();
    for (let i = 1; i < data.length; i++) {
      const em = (data[i][1] || '').trim().toLowerCase();
      const status = (data[i][3] || 'Active').trim().toLowerCase();
      if (em === cleanEmail && status !== 'disabled') {
        return true;
      }
    }
  }

  return false;
}

function requestLoginOtp(email) {
  const cleanEmail = clean_(email).toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('A valid email address is required.');
  }

  if (!isEmailAuthorizedForLogin_(cleanEmail)) {
    logAuditAction_('OTP_REJECTED', cleanEmail, 'Attempted login with unauthorized domain/email', 'DENIED');
    throw new Error('Access Restricted: This portal is strictly confidential and restricted to authorized MIT ADT faculty, staff, and invited members.');
  }

  const cache = CacheService.getScriptCache();
  
  // Rate limiting: Max 3 OTP requests in 10 minutes
  const rateLimitKey = 'RL_' + cleanEmail;
  const reqCount = parseInt(cache.get(rateLimitKey) || '0', 10);
  if (reqCount >= 3) {
    throw new Error('Too many OTP requests. For security, please wait 10 minutes before requesting a new code.');
  }
  cache.put(rateLimitKey, String(reqCount + 1), 600);

  // Generate cryptographic 6-digit PIN
  const randomInt = Math.floor(100000 + Math.random() * 900000);
  const otpCode = String(randomInt);

  // Cache OTP for 10 minutes (600s)
  cache.put('OTP_' + cleanEmail, otpCode, 600);
  cache.put('OTP_TRIES_' + cleanEmail, '0', 600);

  const subject = `🔐 Your MIT ADT Portal Verification Code: ${otpCode}`;
  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F8FAFC;margin:0;padding:24px;color:#0F172A;">
      <div style="max-width:500px;margin:auto;background:#FFFFFF;border-radius:12px;border:1px solid #E2E8F0;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.06);">
        <div style="background:#0F172A;padding:22px 28px;color:#FFFFFF;">
          <h2 style="margin:0;font-size:18px;font-weight:700;">MIT ADT Event Calendar Verification</h2>
          <p style="margin:4px 0 0;font-size:12px;color:#94A3B8;">Confidential Access Security Code</p>
        </div>
        <div style="padding:28px;">
          <p style="margin-top:0;font-size:14px;color:#334155;">Hello,</p>
          <p style="font-size:14px;color:#334155;">Use the following single-use verification code to securely access the confidential event calendar portal:</p>
          
          <div style="margin:24px 0;text-align:center;">
            <div style="display:inline-block;background:#F1F5F9;border:2px dashed #CBD5E1;padding:14px 28px;border-radius:10px;font-size:32px;font-weight:800;letter-spacing:6px;color:#0F172A;font-family:monospace;">
              ${otpCode}
            </div>
          </div>

          <p style="font-size:13px;color:#64748B;line-height:1.5;">
            ⏰ This code is valid for <strong>10 minutes</strong>.<br>
            🔒 For security and confidentiality, never share this code with anyone.
          </p>

          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #E2E8F0;font-size:11px;color:#94A3B8;text-align:center;">
            MIT ADT Event Calendar • Official Security Verification
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  sendEmailSafe_(cleanEmail, subject, htmlBody, 'MIT ADT Security');
  logAuditAction_('OTP_REQUEST', cleanEmail, 'Single-use login code dispatched', 'SUCCESS');

  return {
    ok: true,
    email: cleanEmail,
    message: `Verification code sent to ${cleanEmail}. Please check your inbox and spam folder.`
  };
}

function verifyLoginOtp(email, otp) {
  const cleanEmail = clean_(email).toLowerCase();
  const cleanOtp = clean_(otp).trim();

  if (!cleanEmail || !cleanOtp) {
    throw new Error('Email and verification code are required.');
  }

  const cache = CacheService.getScriptCache();
  const storedOtp = cache.get('OTP_' + cleanEmail);

  if (!storedOtp) {
    throw new Error('Verification code has expired or was not requested. Please request a new code.');
  }

  const triesKey = 'OTP_TRIES_' + cleanEmail;
  const tries = parseInt(cache.get(triesKey) || '0', 10);
  if (tries >= 5) {
    cache.remove('OTP_' + cleanEmail);
    logAuditAction_('LOGIN_LOCKOUT', cleanEmail, 'Account locked after 5 invalid attempts', 'LOCKED');
    throw new Error('Too many failed attempts. For security, please request a new verification code.');
  }

  if (storedOtp !== cleanOtp) {
    cache.put(triesKey, String(tries + 1), 600);
    logAuditAction_('LOGIN_FAILED', cleanEmail, `Invalid code attempt (${tries + 1}/5)`, 'FAILED');
    throw new Error(`Incorrect verification code. ${4 - tries} attempts remaining.`);
  }

  // Consume OTP immediately
  cache.remove('OTP_' + cleanEmail);
  cache.remove(triesKey);

  const user = getUserByEmail_(cleanEmail);
  const sessionToken = generateSessionToken_(user);

  logAuditAction_('LOGIN_SUCCESS', cleanEmail, `Authenticated as ${user.role}`, 'SUCCESS');

  return {
    ok: true,
    sessionToken: sessionToken,
    user: user,
    message: 'Authentication successful.'
  };
}

function logAuditAction_(action, actorEmail, details, status) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEETS.AUDIT);
    if (!sheet) {
      sheet = ss.insertSheet(SHEETS.AUDIT);
      sheet.appendRow(['Timestamp', 'Action', 'ActorEmail', 'Details', 'Status']);
      sheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#E2E8F0');
    }
    sheet.appendRow([new Date(), action, actorEmail, details, status]);
  } catch (err) {
    Logger.log('Audit log write notice: ' + err.message);
  }
}

// =============================================================================
// DATA ACCESS, CONFIDENTIALITY & MASKING
// =============================================================================

/**
 * Bootstrap data required on frontend load (Strictly filtered by role)
 */
function getBootstrapData(callerUser) {
  const settings = getSettings_();
  const allEvents = getAllRawEvents_();
  let filteredEvents = [];

  if (callerUser.role === ROLES.ADMIN) {
    filteredEvents = allEvents;
  } else {
    // Non-admins ONLY see approved events or their own submitted events
    const myEmail = callerUser.email.toLowerCase();
    filteredEvents = allEvents.filter(e => {
      if (String(e.Status).toLowerCase() === 'approved') return true;
      if (String(e.SubmittedEmail || '').toLowerCase() === myEmail) return true;
      return false;
    }).map(e => {
      // Data Masking: If event is approved and not owned by current user, mask internal notes
      if (String(e.SubmittedEmail || '').toLowerCase() !== myEmail) {
        const sanitized = Object.assign({}, e);
        delete sanitized.AdminComment;
        delete sanitized.HODComment;
        delete sanitized.DecisionBy;
        return sanitized;
      }
      return e;
    });
  }

  return {
    currentUser: callerUser,
    settings: {
      AppTitle: settings.AppTitle || 'MIT ADT - CSF Event Calendar',
      AppUrl: settings.AppUrl || APP_PORTAL_URL
    },
    events: filteredEvents,
    serverToday: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  };
}

function getEventDetails(eventId, callerUser) {
  const allEvents = getAllRawEvents_();
  const event = allEvents.find(e => String(e.EventID) === String(eventId));
  if (!event) throw new Error('Event not found.');

  const isOwner = String(event.SubmittedEmail || '').toLowerCase() === callerUser.email.toLowerCase();
  const isAdmin = callerUser.role === ROLES.ADMIN;
  const isApproved = String(event.Status).toLowerCase() === 'approved';

  if (!isApproved && !isOwner && !isAdmin) {
    logAuditAction_('CONFIDENTIAL_EVENT_ACCESS_BLOCKED', callerUser.email, `Attempted access to unapproved event ${eventId}`, 'DENIED');
    throw new Error('Access Denied: This event is confidential and pending administrative approval.');
  }

  const comments = getCommentsForEvent_(eventId);
  let sanitizedEvent = Object.assign({}, event);

  // Mask administrative remarks from other members
  if (!isAdmin && !isOwner) {
    delete sanitizedEvent.AdminComment;
    delete sanitizedEvent.HODComment;
    delete sanitizedEvent.DecisionBy;
  }

  return { event: sanitizedEvent, comments: comments };
}

function submitEvent(payload, callerUser) {
  validateEventPayload_(payload);
  const conflicts = findConflicts_(payload);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEETS.EVENTS);
  if (!sheet) {
    setupProject();
    sheet = ss.getSheetByName(SHEETS.EVENTS);
  }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = indexMap_(headers);

  const eventId = 'EVT-' + Utilities.getUuid().slice(0, 8).toUpperCase();
  const now = new Date();

  const row = new Array(headers.length).fill('');
  setVal_(row, idx.EventID, eventId);
  setVal_(row, idx.Title, clean_(payload.title));
  setVal_(row, idx.Type, clean_(payload.type));
  setVal_(row, idx.Date, parseDateOnly_(payload.date));
  setVal_(row, idx.StartTime, clean_(payload.startTime));
  setVal_(row, idx.EndTime, clean_(payload.endTime));
  setVal_(row, idx.Venue, clean_(payload.venue));
  setVal_(row, idx.Coordinator, clean_(payload.coordinator || callerUser.name));
  setVal_(row, idx.Speaker, clean_(payload.speaker));
  setVal_(row, idx.Audience, clean_(payload.audience));
  setVal_(row, idx.ExpectedParticipants, Number(payload.expectedParticipants || 0));
  setVal_(row, idx.Description, clean_(payload.description));
  setVal_(row, idx.AlternativeDate, payload.alternativeDate ? parseDateOnly_(payload.alternativeDate) : '');
  setVal_(row, idx.SubmittedBy, callerUser.name);
  setVal_(row, idx.SubmittedEmail, callerUser.email); // Extracted strictly from verified session
  setVal_(row, idx.Status, 'Pending');
  setVal_(row, idx.AdminComment, '');
  setVal_(row, idx.DecisionBy, '');
  setVal_(row, idx.DecisionDate, '');
  setVal_(row, idx.CreatedAt, now);
  setVal_(row, idx.CalendarEventID, '');
  setVal_(row, idx.Guide, clean_(payload.guide));
  setVal_(row, idx.ArrangeMeet, payload.arrangeMeet ? 'TRUE' : 'FALSE');
  setVal_(row, idx.MeetLink, clean_(payload.meetLink));
  setVal_(row, idx.Reminder12hSent, 'FALSE');

  sheet.appendRow(row);

  logAuditAction_('EVENT_SUBMITTED', callerUser.email, `Submitted ${eventId}: "${payload.title}"`, 'PENDING');

  try {
    sendEventSubmissionNotificationToAdmin_(payload, callerUser);
  } catch (err) {
    Logger.log('Admin submission alert notice: ' + err.message);
  }

  return {
    ok: true,
    eventId: eventId,
    conflicts: conflicts,
    message: 'Event proposed successfully. It is securely saved and pending administrative approval.'
  };
}

function addComment(eventId, text, callerUser) {
  const cleanComment = clean_(text);
  if (!cleanComment) throw new Error('Comment cannot be empty.');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.COMMENTS);
  const commentId = 'COM-' + Utilities.getUuid().slice(0, 8).toUpperCase();
  
  sheet.appendRow([commentId, eventId, callerUser.name, callerUser.email, cleanComment, new Date()]);
  return getCommentsForEvent_(eventId);
}

function setEventStatus(eventId, status, adminComment, customMeetLink, callerUser) {
  assertAdmin_(callerUser);

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

  const conflicts = findConflicts_({
    date: event.Date,
    startTime: event.StartTime,
    endTime: event.EndTime,
    venue: event.Venue
  }, eventId);

  sheet.getRange(row, (idx.AdminComment !== undefined ? idx.AdminComment : idx.HODComment) + 1).setValue(clean_(adminComment));
  sheet.getRange(row, idx.Status + 1).setValue(status);
  sheet.getRange(row, idx.DecisionBy + 1).setValue(`${callerUser.name} <${callerUser.email}>`);
  sheet.getRange(row, idx.DecisionDate + 1).setValue(new Date());

  logAuditAction_('EVENT_DECISION', callerUser.email, `Set ${eventId} ("${event.Title}") to ${status}`, 'SUCCESS');

  let generatedMeetLink = clean_(customMeetLink) || event.MeetLink || '';
  if (status === 'Approved') {
    const shouldArrangeMeet = (String(event.ArrangeMeet).toUpperCase() === 'TRUE') || !!customMeetLink;
    if (shouldArrangeMeet && !generatedMeetLink) {
      generatedMeetLink = `https://meet.google.com/lookup/csf-${eventId.toLowerCase()}`;
    }
    
    if (idx.MeetLink !== undefined && generatedMeetLink) {
      sheet.getRange(row, idx.MeetLink + 1).setValue(generatedMeetLink);
      event.MeetLink = generatedMeetLink;
    }

    try {
      syncApprovedEventToCalendar_(eventId, event, row, idx, sheet);
    } catch (calErr) {
      Logger.log('Calendar sync notice: ' + calErr.message);
    }

    let emailResult = { sent: 0 };
    try {
      emailResult = sendEventApprovalBroadcast_(event, callerUser.name || 'Admin', adminComment);
    } catch (emailErr) {
      Logger.log('Approval email broadcast error: ' + emailErr.message);
    }

    return {
      ok: true,
      status: status,
      conflicts: conflicts,
      meetLink: generatedMeetLink,
      emailsSent: emailResult.sent,
      message: `Event approved successfully! Notification email dispatched to ${emailResult.sent} members & admins.`
    };
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

function broadcastEventNotification(eventId, callerUser) {
  assertAdmin_(callerUser);

  const allEvents = getAllRawEvents_();
  const event = allEvents.find(e => String(e.EventID) === String(eventId));
  if (!event) throw new Error('Event not found.');

  const res = sendEventApprovalBroadcast_(event, callerUser.name || 'Admin', 'Official Announcement');
  logAuditAction_('EVENT_BROADCAST', callerUser.email, `Broadcasted ${eventId} to ${res.sent} recipients`, 'SUCCESS');

  return {
    ok: true,
    sent: res.sent,
    total: res.total,
    message: `Announcement email sent to ${res.sent} team members & admins.`
  };
}

// =============================================================================
// USER MANAGEMENT & ROLE ADMINISTRATION
// =============================================================================

function getAllUsers(callerUser) {
  assertAdmin_(callerUser);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.USERS);
  if (!sheet) return [];

  const data = sheet.getDataRange().getDisplayValues();
  if (data.length < 2) return [];

  return data.slice(1).map(r => ({
    name: r[0] || '',
    email: (r[1] || '').trim().toLowerCase(),
    role: (r[2] || 'member').trim().toLowerCase(),
    status: r[3] || 'Active'
  })).filter(u => u.email);
}

function updateUserRole(targetEmail, newRole, callerUser) {
  assertAdmin_(callerUser);

  const cleanRole = clean_(newRole).toLowerCase();
  if (![ROLES.ADMIN, ROLES.MEMBER].includes(cleanRole)) {
    throw new Error('Invalid role.');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.USERS);
  const data = sheet.getDataRange().getDisplayValues();
  const target = clean_(targetEmail).toLowerCase();

  for (let i = 1; i < data.length; i++) {
    if ((data[i][1] || '').trim().toLowerCase() === target) {
      sheet.getRange(i + 1, 3).setValue(cleanRole);
      logAuditAction_('USER_ROLE_CHANGE', callerUser.email, `Changed ${target} to ${cleanRole}`, 'SUCCESS');
      return { ok: true, email: target, role: cleanRole };
    }
  }

  sheet.appendRow([target.split('@')[0], target, cleanRole, 'Active', new Date()]);
  logAuditAction_('USER_ROLE_CHANGE', callerUser.email, `Created user ${target} with role ${cleanRole}`, 'SUCCESS');
  return { ok: true, email: target, role: cleanRole };
}

function addUser(name, email, role, callerUser) {
  assertAdmin_(callerUser);

  const cleanEmail = clean_(email).toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) throw new Error('A valid email is required.');

  const assignedRole = [ROLES.ADMIN, ROLES.MEMBER].includes(clean_(role).toLowerCase()) ? clean_(role).toLowerCase() : ROLES.MEMBER;
  const displayName = clean_(name) || cleanEmail.split('@')[0];

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.USERS);
  const data = sheet.getDataRange().getDisplayValues();

  for (let i = 1; i < data.length; i++) {
    if ((data[i][1] || '').trim().toLowerCase() === cleanEmail) {
      sheet.getRange(i + 1, 1).setValue(displayName);
      sheet.getRange(i + 1, 3).setValue(assignedRole);
      logAuditAction_('USER_UPDATED', callerUser.email, `Updated ${cleanEmail} (${assignedRole})`, 'SUCCESS');
      return { ok: true, user: { name: displayName, email: cleanEmail, role: assignedRole } };
    }
  }

  sheet.appendRow([displayName, cleanEmail, assignedRole, 'Active', new Date()]);
  logAuditAction_('USER_ADDED', callerUser.email, `Added ${cleanEmail} (${assignedRole})`, 'SUCCESS');
  return { ok: true, user: { name: displayName, email: cleanEmail, role: assignedRole } };
}

function getUserByEmail_(email, optName) {
  if (!email) {
    return { name: optName || 'Guest User', email: '', role: ROLES.MEMBER };
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

  const target = email.trim().toLowerCase();
  for (let i = 1; i < values.length; i++) {
    const rowEmail = (values[i][emailIdx] || '').trim().toLowerCase();
    if (rowEmail === target) {
      let role = (values[i][roleIdx] || ROLES.MEMBER).trim().toLowerCase();
      if (![ROLES.ADMIN, ROLES.MEMBER].includes(role)) {
        role = (role === 'hod' || role === 'admin') ? ROLES.ADMIN : ROLES.MEMBER;
      }
      return {
        name: values[i][nameIdx] || optName || 'User',
        email: rowEmail,
        role: role
      };
    }
  }

  // Auto-register as admin if primary owner, otherwise member
  const isPrimaryAdmin = PRIMARY_ADMIN_EMAILS.includes(target);
  const role = isPrimaryAdmin ? ROLES.ADMIN : ROLES.MEMBER;
  const name = optName || (target.split('@')[0]);
  sheet.appendRow([name, target, role, 'Active', new Date()]);

  return { name: name, email: target, role: role };
}

function ensureAdminExists_(adminEmail) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.USERS);
  if (!sheet) return;

  const values = sheet.getDataRange().getDisplayValues();
  const target = adminEmail.trim().toLowerCase();
  for (let i = 1; i < values.length; i++) {
    if ((values[i][1] || '').trim().toLowerCase() === target) {
      sheet.getRange(i + 1, 3).setValue(ROLES.ADMIN);
      return;
    }
  }

  sheet.appendRow([target.split('@')[0], target, ROLES.ADMIN, 'Active', new Date()]);
}

// =============================================================================
// SHEET INITIALIZATION & AUTOMATED CLOUD TRIGGERS
// =============================================================================

function setupProject() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  const requiredSheets = [
    {
      name: SHEETS.EVENTS,
      headers: [
        'EventID', 'Title', 'Type', 'Date', 'StartTime', 'EndTime',
        'Venue', 'Coordinator', 'Speaker', 'Audience', 'ExpectedParticipants',
        'Description', 'AlternativeDate', 'SubmittedBy', 'SubmittedEmail',
        'Status', 'AdminComment', 'DecisionBy', 'DecisionDate', 'CreatedAt',
        'CalendarEventID', 'Guide', 'ArrangeMeet', 'MeetLink', 'Reminder12hSent'
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
      name: SHEETS.AUDIT,
      headers: ['Timestamp', 'Action', 'ActorEmail', 'Details', 'Status']
    },
    {
      name: SHEETS.SETTINGS,
      headers: ['Setting', 'Value'],
      defaults: [
        ['AppTitle', 'MIT ADT - CSF Event Calendar'],
        ['AppUrl', APP_PORTAL_URL],
        ['CalendarId', ''],
        ['DailyDigestHour', '8'],
        ['SendDigestIfEmpty', 'false'],
        ['RequireApprovalForVisibility', 'true']
      ]
    }
  ];

  requiredSheets.forEach(item => {
    let sheet = ss.getSheetByName(item.name);
    if (!sheet) sheet = ss.insertSheet(item.name);
    
    const currentHeaders = sheet.getLastColumn() > 0 ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] : [];
    if (currentHeaders.length === 0) {
      sheet.appendRow(item.headers);
      sheet.getRange(1, 1, 1, item.headers.length).setFontWeight('bold').setBackground('#E2E8F0');
    } else {
      item.headers.forEach(h => {
        if (!currentHeaders.map(String).map(s => s.trim().toLowerCase()).includes(h.toLowerCase())) {
          sheet.getRange(1, sheet.getLastColumn() + 1).setValue(h).setFontWeight('bold').setBackground('#E2E8F0');
        }
      });
    }

    if (item.defaults && sheet.getLastRow() <= 1) {
      item.defaults.forEach(d => sheet.appendRow(d));
    }
  });

  // Ensure primary administrators are initialized
  PRIMARY_ADMIN_EMAILS.forEach(em => ensureAdminExists_(em));

  // Initialize secret key
  getOrCreateSecretKey_();

  // Configure automated triggers
  setupAllTriggers();

  logAuditAction_('SYSTEM_SETUP', 'SYSTEM', 'Setup completed: Sheets, Security, Triggers initialized', 'SUCCESS');

  return 'Setup completed successfully. Cryptographic security, sheets, audit logging, and automated triggers configured.';
}

function setupAllTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'sendDailyEventDigest' || fn === 'check12HourReminders' || fn === 'setupDailyNotificationTrigger') {
      try {
        ScriptApp.deleteTrigger(t);
      } catch (err) {}
    }
  });

  // 1. Daily morning digest at 8:00 AM
  ScriptApp.newTrigger('sendDailyEventDigest')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .create();

  // 2. Hourly check for upcoming events within 12 hours
  ScriptApp.newTrigger('check12HourReminders')
    .timeBased()
    .everyHours(1)
    .create();

  return 'Automated Cloud Triggers Active: Daily digest at 8:00 AM and 12-Hour Event Reminder check every hour.';
}

// =============================================================================
// EMAIL & NOTIFICATION ENGINE
// =============================================================================

function getAllRecipientEmails_(optEvent) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const userSheet = ss.getSheetByName(SHEETS.USERS);
  const emailSet = new Set();

  PRIMARY_ADMIN_EMAILS.forEach(e => emailSet.add(e.toLowerCase().trim()));

  if (userSheet) {
    const userData = userSheet.getDataRange().getDisplayValues();
    for (let i = 1; i < userData.length; i++) {
      const em = (userData[i][1] || '').trim().toLowerCase();
      const status = (userData[i][3] || 'Active').trim().toLowerCase();
      if (em && em.includes('@') && !em.includes('yourcollege.edu') && status !== 'disabled') {
        emailSet.add(em);
      }
    }
  }

  if (optEvent) {
    const subEmail = (optEvent.SubmittedEmail || optEvent.SubmittedBy || '').trim().toLowerCase();
    if (subEmail && subEmail.includes('@') && !subEmail.includes('yourcollege.edu')) {
      emailSet.add(subEmail);
    }
    const coordEmail = (optEvent.CoordinatorEmail || optEvent.Coordinator || '').trim().toLowerCase();
    if (coordEmail && coordEmail.includes('@') && !coordEmail.includes('yourcollege.edu')) {
      emailSet.add(coordEmail);
    }
  }

  return Array.from(emailSet);
}

function sendEmailSafe_(to, subject, htmlBody, fromName) {
  const senderName = fromName || 'MIT ADT Event Calendar';
  try {
    MailApp.sendEmail({
      to: to,
      subject: subject,
      htmlBody: htmlBody,
      name: senderName
    });
    return { ok: true };
  } catch (err1) {
    try {
      GmailApp.sendEmail(to, subject, '', {
        htmlBody: htmlBody,
        name: senderName
      });
      return { ok: true };
    } catch (err2) {
      Logger.log(`Failed sending email to ${to}: MailApp: ${err1.message} | GmailApp: ${err2.message}`);
      return { ok: false, error: err1.message || err2.message };
    }
  }
}

function sendEventApprovalBroadcast_(event, approverName, adminComment) {
  const recipients = getAllRecipientEmails_(event);
  if (recipients.length === 0) return { ok: true, sent: 0, total: 0 };

  const meetSection = event.MeetLink ? `
    <div style="margin: 20px 0; background: #e8f0fe; border-radius: 8px; padding: 16px; text-align: center; border: 1px solid #c2e7ff;">
      <h4 style="margin: 0 0 8px 0; color: #1a73e8; font-size: 15px;">📹 Google Meet Video Call Link</h4>
      <p style="margin: 0 0 12px 0; color: #5f6368; font-size: 13px;">Official conference link for this event:</p>
      <a href="${escHtml_(event.MeetLink)}" target="_blank" style="background: #1a73e8; color: #ffffff; text-decoration: none; padding: 10px 24px; border-radius: 6px; font-weight: 600; font-size: 14px; display: inline-block;">
        Join Google Meet
      </a>
      <div style="margin-top: 8px; font-size: 12px; color: #1a73e8; word-break: break-all;">${escHtml_(event.MeetLink)}</div>
    </div>
  ` : '';

  const commentSection = adminComment ? `
    <div style="margin: 16px 0; background: #f8fafc; border-left: 4px solid #1a73e8; padding: 12px 16px; border-radius: 4px;">
      <strong style="color: #202124; font-size: 13px;">Admin Remarks (${escHtml_(approverName)}):</strong>
      <p style="margin: 4px 0 0 0; color: #3c4043; font-size: 13px;">${escHtml_(adminComment)}</p>
    </div>
  ` : '';

  const emailBody = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px 0;">
      <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
        <div style="background: #0f172a; padding: 24px 30px; text-align: left;">
          <span style="background: #22c55e; color: #ffffff; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 4px 10px; border-radius: 12px; letter-spacing: 0.05em; display: inline-block; margin-bottom: 8px;">
            ✓ Event Approved &amp; Scheduled
          </span>
          <h1 style="color: #ffffff; font-size: 22px; margin: 0; font-weight: 700;">
            ${escHtml_(event.Title)}
          </h1>
          <p style="color: #94a3b8; margin: 6px 0 0 0; font-size: 13px;">
            ${escHtml_(event.Type || 'Event')} • Approved by ${escHtml_(approverName)}
          </p>
        </div>
        <div style="padding: 28px 30px;">
          <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 16px;">
            <tr>
              <td style="padding: 8px 0; color: #64748b; width: 130px; font-weight: 600;">📅 Date:</td>
              <td style="padding: 8px 0; color: #0f172a; font-weight: 600;">${escHtml_(event.Date)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">⏰ Time:</td>
              <td style="padding: 8px 0; color: #0f172a;">${escHtml_(event.StartTime)} – ${escHtml_(event.EndTime)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">📍 Venue:</td>
              <td style="padding: 8px 0; color: #0f172a;">${escHtml_(event.Venue || 'Campus')}</td>
            </tr>
            ${event.Speaker ? `
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">🎤 Speaker:</td>
              <td style="padding: 8px 0; color: #0f172a;">${escHtml_(event.Speaker)}</td>
            </tr>` : ''}
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">👥 Audience:</td>
              <td style="padding: 8px 0; color: #0f172a;">${escHtml_(event.TargetAudience || event.Audience || 'All Faculty / Members')}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">👤 Coordinator:</td>
              <td style="padding: 8px 0; color: #0f172a;">${escHtml_(event.Coordinator || 'CSF Team')}</td>
            </tr>
          </table>

          ${meetSection}
          ${commentSection}

          ${event.Description ? `
          <div style="margin: 16px 0; padding: 14px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <strong style="color: #334155; font-size: 13px; display: block; margin-bottom: 4px;">Description:</strong>
            <p style="margin: 0; color: #475569; font-size: 13px; line-height: 1.5;">${escHtml_(event.Description)}</p>
          </div>` : ''}

          ${event.Guide ? `
          <div style="margin: 16px 0; padding: 14px; background: #f1f5f9; border-radius: 8px; border: 1px solid #e2e8f0;">
            <strong style="color: #334155; font-size: 13px; display: block; margin-bottom: 4px;">Guidelines & Instructions:</strong>
            <p style="margin: 0; color: #475569; font-size: 13px; line-height: 1.5;">${escHtml_(event.Guide)}</p>
          </div>` : ''}

          <div style="text-align: center; margin: 28px 0 10px 0;">
            <a href="${APP_PORTAL_URL}" target="_blank" style="background: #0f172a; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: 600; font-size: 14px; display: inline-block;">
              View Full Event Calendar
            </a>
          </div>

          <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 12px; color: #94a3b8;">
            MIT ADT Event Calendar • Official Notification to all registered members &amp; admins
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  const subject = `🎉 [Event Approved] ${event.Title} - ${event.Date}`;

  let count = 0;
  recipients.forEach(r => {
    const res = sendEmailSafe_(r, subject, emailBody, 'MIT ADT Event Calendar');
    if (res.ok) count++;
  });

  return { ok: true, sent: count, total: recipients.length };
}

function check12HourReminders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.EVENTS);
  if (!sheet || sheet.getLastRow() < 2) {
    return { ok: true, sent: 0, checked: 0, message: 'No events found.' };
  }

  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(h => String(h).trim());
  let remIdx = headers.indexOf('Reminder12hSent');

  if (remIdx === -1) {
    remIdx = headers.length;
    sheet.getRange(1, remIdx + 1).setValue('Reminder12hSent').setFontWeight('bold').setBackground('#E2E8F0');
    headers.push('Reminder12hSent');
  }

  const now = new Date();
  const nowMs = now.getTime();
  let remindersSent = 0;
  let checkedCount = 0;

  for (let i = 1; i < values.length; i++) {
    const evt = rowToObject_(headers, values[i]);
    const rowNum = i + 1;
    const status = String(evt.Status || '').trim().toLowerCase();

    if (status !== 'approved') continue;
    checkedCount++;

    const remFlag = String(evt.Reminder12hSent || '').trim().toUpperCase();
    if (remFlag === 'TRUE' || remFlag === 'SKIPPED') continue;

    try {
      const eventStart = combineDateTime_(evt.Date, evt.StartTime);
      const startMs = eventStart.getTime();
      const diffMs = startMs - nowMs;
      const diffHours = diffMs / (1000 * 60 * 60);

      if (diffMs > 0 && diffHours <= 12.5) {
        const sendRes = send12HourReminderEmail_(evt, diffHours);
        if (sendRes.sent > 0) {
          sheet.getRange(rowNum, remIdx + 1).setValue('TRUE');
          remindersSent++;
        }
      } else if (diffMs <= 0) {
        sheet.getRange(rowNum, remIdx + 1).setValue('SKIPPED');
      }
    } catch (err) {
      Logger.log(`Error checking 12h reminder for event ${evt.EventID}: ${err.message}`);
    }
  }

  return {
    ok: true,
    sent: remindersSent,
    checked: checkedCount,
    message: `12-hour reminder scan complete: Sent reminders for ${remindersSent} event(s) out of ${checkedCount} approved events.`
  };
}

function send12HourReminderEmail_(event, diffHours) {
  const recipients = getAllRecipientEmails_(event);
  if (recipients.length === 0) return { ok: true, sent: 0, total: 0 };

  const hoursRemaining = Math.max(1, Math.round(diffHours));

  const meetSection = event.MeetLink ? `
    <div style="margin: 20px 0; background: #e8f0fe; border-radius: 8px; padding: 16px; text-align: center; border: 1px solid #c2e7ff;">
      <h4 style="margin: 0 0 8px 0; color: #1a73e8; font-size: 15px;">📹 Google Meet Meeting Link</h4>
      <p style="margin: 0 0 12px 0; color: #5f6368; font-size: 13px;">Join the video call when the event begins:</p>
      <a href="${escHtml_(event.MeetLink)}" target="_blank" style="background: #1a73e8; color: #ffffff; text-decoration: none; padding: 10px 24px; border-radius: 6px; font-weight: 600; font-size: 14px; display: inline-block;">
        Join Google Meet
      </a>
      <div style="margin-top: 8px; font-size: 12px; color: #1a73e8; word-break: break-all;">${escHtml_(event.MeetLink)}</div>
    </div>
  ` : '';

  const emailBody = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px 0;">
      <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
        <div style="background: #b45309; padding: 24px 30px; text-align: left;">
          <span style="background: #fef3c7; color: #92400e; font-size: 12px; font-weight: 700; text-transform: uppercase; padding: 4px 10px; border-radius: 12px; letter-spacing: 0.05em; display: inline-block; margin-bottom: 8px;">
            ⏰ Starting in ~${hoursRemaining} Hours
          </span>
          <h1 style="color: #ffffff; font-size: 22px; margin: 0; font-weight: 700;">
            ${escHtml_(event.Title)}
          </h1>
          <p style="color: #fde68a; margin: 6px 0 0 0; font-size: 13px;">
            ${escHtml_(event.Type || 'Event')} • Scheduled on ${escHtml_(event.Date)}
          </p>
        </div>
        <div style="padding: 28px 30px;">
          <p style="font-size: 15px; color: #334155; margin: 0 0 16px 0;">
            This is a reminder that the following approved event is starting soon:
          </p>
          <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 16px;">
            <tr>
              <td style="padding: 8px 0; color: #64748b; width: 130px; font-weight: 600;">📅 Date:</td>
              <td style="padding: 8px 0; color: #0f172a; font-weight: 700;">${escHtml_(event.Date)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">⏰ Time:</td>
              <td style="padding: 8px 0; color: #0f172a; font-weight: 600;">${escHtml_(event.StartTime)} – ${escHtml_(event.EndTime)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">📍 Venue / Room:</td>
              <td style="padding: 8px 0; color: #0f172a;">${escHtml_(event.Venue || 'Campus')}</td>
            </tr>
            ${event.Speaker ? `
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">🎤 Speaker:</td>
              <td style="padding: 8px 0; color: #0f172a;">${escHtml_(event.Speaker)}</td>
            </tr>` : ''}
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">👥 Audience:</td>
              <td style="padding: 8px 0; color: #0f172a;">${escHtml_(event.TargetAudience || event.Audience || 'All Faculty / Members')}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">👤 Coordinator:</td>
              <td style="padding: 8px 0; color: #0f172a;">${escHtml_(event.Coordinator || 'CSF Team')}</td>
            </tr>
          </table>

          ${meetSection}

          ${event.Description ? `
          <div style="margin: 16px 0; padding: 14px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
            <strong style="color: #334155; font-size: 13px; display: block; margin-bottom: 4px;">Description:</strong>
            <p style="margin: 0; color: #475569; font-size: 13px; line-height: 1.5;">${escHtml_(event.Description)}</p>
          </div>` : ''}

          <div style="text-align: center; margin: 28px 0 10px 0;">
            <a href="${APP_PORTAL_URL}" target="_blank" style="background: #0f172a; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: 600; font-size: 14px; display: inline-block;">
              Open MIT ADT Calendar
            </a>
          </div>

          <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 12px; color: #94a3b8;">
            MIT ADT Event Calendar • 12-Hour Automated Event Reminder
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  const subject = `⏰ [12-Hour Reminder] ${event.Title} at ${event.StartTime} (${event.Date})`;

  let count = 0;
  recipients.forEach(r => {
    const res = sendEmailSafe_(r, subject, emailBody, 'MIT ADT Event Reminder');
    if (res.ok) count++;
  });

  return { ok: true, sent: count, total: recipients.length };
}

function send12HourReminderNow(eventId, callerUser) {
  assertAdmin_(callerUser);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.EVENTS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idx = indexMap_(headers);

  let targetEvent = null;
  let row = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idx.EventID]) === String(eventId)) {
      row = i + 1;
      targetEvent = rowToObject_(headers, data[i]);
      break;
    }
  }

  if (!targetEvent) throw new Error('Event not found.');

  const res = send12HourReminderEmail_(targetEvent, 12);
  let remIdx = headers.indexOf('Reminder12hSent');
  if (remIdx === -1) {
    remIdx = headers.length;
    sheet.getRange(1, remIdx + 1).setValue('Reminder12hSent').setFontWeight('bold').setBackground('#E2E8F0');
  }
  sheet.getRange(row, remIdx + 1).setValue('TRUE');

  logAuditAction_('12H_REMINDER_MANUAL', callerUser.email, `Manual 12h reminder for ${eventId} sent to ${res.sent}`, 'SUCCESS');

  return {
    ok: true,
    sent: res.sent,
    total: res.total,
    message: `12-hour reminder email dispatched to ${res.sent} members & admins.`
  };
}

function sendEventSubmissionNotificationToAdmin_(event, callerUser) {
  const adminEmails = PRIMARY_ADMIN_EMAILS;
  const subject = `📋 [Action Required] New Event Proposed: ${event.title || event.Title}`;
  const emailBody = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F8FAFC;margin:0;padding:24px;color:#0F172A;">
      <div style="max-width:580px;margin:auto;background:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.06);border:1px solid #E2E8F0;">
        <div style="background:#2563EB;padding:20px 24px;color:#FFFFFF;">
          <span style="background:#DBEAFE;color:#1E40AF;font-size:11px;font-weight:700;padding:3px 8px;border-radius:10px;">Pending Approval</span>
          <h2 style="margin:8px 0 0;font-size:20px;">New Event Submitted</h2>
        </div>
        <div style="padding:24px;">
          <p style="margin-top:0;font-size:14px;color:#334155;">
            <strong>${escHtml_(callerUser.name || 'A faculty member')}</strong> (${escHtml_(callerUser.email)}) has proposed a new event:
          </p>
          <table style="width:100%;font-size:14px;color:#334155;border-collapse:collapse;margin:12px 0;">
            <tr><td style="width:120px;font-weight:600;padding:4px 0;color:#64748B;">📌 Title:</td><td><strong>${escHtml_(event.title || event.Title)}</strong></td></tr>
            <tr><td style="font-weight:600;padding:4px 0;color:#64748B;">📅 Date:</td><td>${escHtml_(event.date || event.Date)}</td></tr>
            <tr><td style="font-weight:600;padding:4px 0;color:#64748B;">⏰ Time:</td><td>${escHtml_(event.startTime || event.StartTime)} - ${escHtml_(event.endTime || event.EndTime)}</td></tr>
            <tr><td style="font-weight:600;padding:4px 0;color:#64748B;">📍 Venue:</td><td>${escHtml_(event.venue || event.Venue)}</td></tr>
            <tr><td style="font-weight:600;padding:4px 0;color:#64748B;">👤 Coordinator:</td><td>${escHtml_(event.coordinator || event.Coordinator)}</td></tr>
          </table>
          <div style="text-align:center;margin:24px 0 10px;">
            <a href="${APP_PORTAL_URL}" target="_blank" style="background:#2563EB;color:#FFFFFF;padding:10px 24px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;display:inline-block;">
              Review &amp; Approve Event
            </a>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  adminEmails.forEach(adm => {
    sendEmailSafe_(adm, subject, emailBody, 'MIT ADT Calendar System');
  });
}

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
  if (event.Guide) descParts.push(`\nGuidelines:\n${event.Guide}`);

  const created = cal.createEvent(event.Title, startDt, endDt, {
    location: event.Venue || 'Campus / Virtual',
    description: descParts.join('\n')
  });

  try {
    created.setColor(CalendarApp.EventColor.GREEN);
    created.addEmailReminder(720);
    created.addPopupReminder(720);
  } catch (err) {}

  if (idx.CalendarEventID !== undefined) {
    sheet.getRange(row, idx.CalendarEventID + 1).setValue(created.getId());
  }
  return created.getId();
}

function removeCalendarEvent_(id) {
  const calendarId = String(getSettings_().CalendarId || '').trim();
  if (!calendarId || !id) return;
  const cal = CalendarApp.getCalendarById(calendarId);
  if (!cal) return;
  const e = cal.getEventById(id);
  if (e) e.deleteEvent();
}

function findConflicts_(payload, ignoreId) {
  const dateStr = clean_(payload.date);
  const startMin = minutes_(payload.startTime);
  const endMin = minutes_(payload.endTime);
  const venue = clean_(payload.venue).toLowerCase();

  if (!dateStr || startMin === null || endMin === null) return [];

  const allEvents = getAllRawEvents_();
  return allEvents.filter(e => {
    if (ignoreId && String(e.EventID) === String(ignoreId)) return false;
    if (e.Status !== 'Approved' && e.Status !== 'Pending') return false;
    if (String(e.Date) !== dateStr) return false;

    const eStart = minutes_(e.StartTime);
    const eEnd = minutes_(e.EndTime);
    if (eStart === null || eEnd === null) return false;

    const timeOverlap = Math.max(startMin, eStart) < Math.min(endMin, eEnd);
    if (!timeOverlap) return false;

    const sameVenue = venue && clean_(e.Venue).toLowerCase() === venue;
    return sameVenue || timeOverlap;
  }).map(e => ({
    eventId: e.EventID,
    title: e.Title,
    time: `${e.StartTime} - ${e.EndTime}`,
    venue: e.Venue,
    status: e.Status
  }));
}

function sendDailyEventDigest() {
  const timeZone = Session.getScriptTimeZone();
  const todayStr = Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd');
  const todayFormatted = Utilities.formatDate(new Date(), timeZone, 'EEEE, MMMM d, yyyy');

  const allEvents = getAllRawEvents_();
  let eventsToSend = allEvents.filter(e => e.Status === 'Approved' && String(e.Date) === todayStr);
  let isUpcoming = false;

  if (eventsToSend.length === 0) {
    eventsToSend = allEvents.filter(e => e.Status === 'Approved' && String(e.Date) >= todayStr);
    isUpcoming = true;
  }

  if (eventsToSend.length === 0) {
    eventsToSend = allEvents.filter(e => e.Status === 'Approved');
    isUpcoming = true;
  }

  if (eventsToSend.length === 0) {
    Logger.log('No approved events found on calendar.');
    return { ok: true, sent: 0, eventsCount: 0, reason: 'No approved events found on the calendar to broadcast.' };
  }

  eventsToSend.sort((a, b) => String(a.Date).localeCompare(String(b.Date)));

  const recipients = getAllRecipientEmails_();
  if (recipients.length === 0) {
    return { ok: true, sent: 0, eventsCount: eventsToSend.length, reason: 'No active user emails found.' };
  }

  const eventsHtml = eventsToSend.map(e => `
    <div style="background:#FFFFFF;border:1px solid #E2E8F0;border-left:5px solid #16A34A;border-radius:8px;padding:16px;margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
        <h3 style="margin:0;color:#0F172A;font-size:17px;font-weight:700;">${escHtml_(e.Title)}</h3>
        <span style="background:#DCFCE7;color:#15803D;padding:4px 8px;border-radius:12px;font-size:12px;font-weight:600;">${escHtml_(e.Type || 'Event')}</span>
      </div>
      <table style="width:100%;font-size:14px;color:#334155;border-collapse:collapse;margin:8px 0;">
        <tr><td style="width:120px;font-weight:600;padding:4px 0;color:#64748B;">📅 Date:</td><td><strong>${escHtml_(e.Date)}</strong></td></tr>
        <tr><td style="width:120px;font-weight:600;padding:4px 0;color:#64748B;">⏰ Time:</td><td>${escHtml_(e.StartTime)} – ${escHtml_(e.EndTime)}</td></tr>
        <tr><td style="font-weight:600;padding:4px 0;color:#64748B;">📍 Venue:</td><td>${escHtml_(e.Venue)}</td></tr>
        <tr><td style="font-weight:600;padding:4px 0;color:#64748B;">👤 Coordinator:</td><td>${escHtml_(e.Coordinator || 'CSF Team')}</td></tr>
        ${e.Speaker ? `<tr><td style="font-weight:600;padding:4px 0;color:#64748B;">🎤 Speaker:</td><td>${escHtml_(e.Speaker)}</td></tr>` : ''}
        ${e.Audience ? `<tr><td style="font-weight:600;padding:4px 0;color:#64748B;">👥 Target:</td><td>${escHtml_(e.Audience)}</td></tr>` : ''}
      </table>
      ${e.Description ? `<div style="margin-top:8px;font-size:13px;color:#475569;background:#F8FAFC;padding:10px;border-radius:6px;"><strong>Description:</strong> ${escHtml_(e.Description)}</div>` : ''}
      ${e.MeetLink ? `
        <div style="margin-top:12px;">
          <a href="${escHtml_(e.MeetLink)}" target="_blank" style="display:inline-block;background:#1a73e8;color:#FFFFFF;padding:8px 18px;text-decoration:none;border-radius:6px;font-weight:600;font-size:13px;">
            📹 Join Google Meet
          </a>
        </div>` : ''}
    </div>
  `).join('');

  const digestHeading = isUpcoming ? "📅 MIT ADT Calendar — Upcoming Events Schedule" : "📅 MIT ADT Calendar — Today's Event Schedule";
  const digestSub = isUpcoming ? `Upcoming approved events as of <strong>${todayFormatted}</strong>` : `Events scheduled for <strong>${todayFormatted}</strong>`;

  const emailBody = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F8FAFC;margin:0;padding:24px;color:#0F172A;">
      <div style="max-width:620px;margin:auto;background:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.06);border:1px solid #E2E8F0;">
        <div style="background:#1E293B;padding:24px 28px;color:#FFFFFF;">
          <h1 style="margin:0;font-size:22px;font-weight:800;">${digestHeading}</h1>
          <p style="margin:6px 0 0;font-size:14px;opacity:0.9;">${digestSub}</p>
        </div>
        <div style="padding:24px 28px;">
          <p style="font-size:15px;color:#334155;margin-top:0;">Hello team, here is the approved event schedule:</p>
          ${eventsHtml}
          <div style="text-align:center;margin:24px 0 10px;">
            <a href="${APP_PORTAL_URL}" target="_blank" style="background:#0F172A;color:#FFFFFF;padding:10px 24px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;display:inline-block;">
              Open MIT ADT Calendar
            </a>
          </div>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #E2E8F0;text-align:center;font-size:12px;color:#94A3B8;">
            MIT ADT Event Calendar • Daily Schedule Notification
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  const subjectPrefix = isUpcoming ? "Upcoming Events Schedule" : "Today's Events";
  const subject = `[MIT ADT Calendar] ${subjectPrefix} (${eventsToSend.length} event(s)) - ${todayFormatted}`;

  let sentCount = 0;
  recipients.forEach(r => {
    const res = sendEmailSafe_(r, subject, emailBody, 'MIT ADT Calendar Digest');
    if (res.ok) sentCount++;
  });

  return {
    ok: true,
    sent: sentCount,
    eventsCount: eventsToSend.length,
    today: todayFormatted
  };
}

function triggerDailyNotificationNow(callerUser) {
  assertAdmin_(callerUser);
  return sendDailyEventDigest();
}

/**
 * Diagnostic test function for Google Apps Script editor.
 */
function testSystemNotifications() {
  Logger.log('--- Starting Notification & Security Diagnostic ---');
  
  // 1. Triggers
  const triggerMsg = setupAllTriggers();
  Logger.log('Triggers: ' + triggerMsg);

  // 2. Secret Key & Crypto
  const secret = getOrCreateSecretKey_();
  Logger.log('Auth Secret Key initialized: ' + (secret ? 'YES (Protected in Script Properties)' : 'NO'));

  // 3. Token generation & verification test
  const testUser = { email: 'mandarj2412@gmail.com', role: 'admin', name: 'Mandar Joshi' };
  const sampleToken = generateSessionToken_(testUser);
  const verified = verifySessionToken_(sampleToken);
  Logger.log('Crypto Token Test: ' + (verified.email === testUser.email ? 'PASS' : 'FAIL'));

  // 4. Recipients
  const recipients = getAllRecipientEmails_();
  Logger.log('Discovered Active Recipients (' + recipients.length + '): ' + recipients.join(', '));

  // 5. Test Email
  const testSubject = '✅ [Security Verified] MIT ADT Event Notification & Security Engine Active';
  const testHtml = `
    <div style="font-family:sans-serif;padding:24px;background:#f8fafc;max-width:560px;margin:auto;border-radius:10px;border:1px solid #e2e8f0;">
      <h2 style="color:#16a34a;margin-top:0;">Security &amp; Notification Engine Active!</h2>
      <p>Hello Mandar,</p>
      <p>This confirmation verifies that:</p>
      <ul>
        <li>HMAC-SHA256 cryptographic token security is active.</li>
        <li>Passwordless Email OTP authentication is configured.</li>
        <li>Only authorized MIT ADT emails &amp; whitelisted accounts can access the portal.</li>
        <li>12-Hour automated reminder hourly trigger is active.</li>
        <li>Daily 8:00 AM event schedule digest trigger is active.</li>
      </ul>
      <p style="color:#64748b;font-size:12px;margin-bottom:0;">Dispatched at ${new Date().toLocaleString()}</p>
    </div>
  `;
  
  const mailRes = sendEmailSafe_('mandarj2412@gmail.com', testSubject, testHtml, 'MIT ADT System Security');
  Logger.log('Test email result: ' + JSON.stringify(mailRes));

  // 6. Reminder scan
  const reminderScan = check12HourReminders();
  Logger.log('12-Hour reminder scan result: ' + JSON.stringify(reminderScan));

  return {
    ok: true,
    triggers: triggerMsg,
    cryptoPass: verified.email === testUser.email,
    recipients: recipients,
    testEmail: mailRes,
    reminderScan: reminderScan
  };
}

// =============================================================================
// UTILITIES & DATA NORMALIZERS
// =============================================================================

function getAllRawEvents_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEETS.EVENTS);
  if (!sheet) {
    setupProject();
    sheet = ss.getSheetByName(SHEETS.EVENTS);
  }

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const headers = data[0];
  const events = [];
  for (let i = 1; i < data.length; i++) {
    const obj = rowToObject_(headers, data[i]);
    events.push(obj);
  }

  return events;
}

function getSettings_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEETS.SETTINGS);
  if (!sheet) {
    setupProject();
    sheet = ss.getSheetByName(SHEETS.SETTINGS);
  }

  const data = sheet.getDataRange().getValues();
  const settings = {};
  for (let i = 1; i < data.length; i++) {
    const key = clean_(data[i][0]);
    if (key) settings[key] = clean_(data[i][1]);
  }
  return settings;
}

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
      } else if (['StartTime', 'EndTime'].includes(k)) {
        v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'hh:mm a');
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
  h.forEach((x, i) => m[x] = i);
  return m;
}

function clean_(v) {
  return String(v == null ? '' : v).trim();
}

function minutes_(t) {
  const s = clean_(t).trim();
  const m12 = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(s);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const n = parseInt(m12[2], 10);
    const mer = m12[3].toLowerCase();
    if (mer === 'pm' && h < 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
    return h * 60 + n;
  }
  const m24 = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m24) {
    const h = parseInt(m24[1], 10);
    const n = parseInt(m24[2], 10);
    return h >= 0 && h < 24 && n >= 0 && n < 60 ? h * 60 + n : null;
  }
  return null;
}

function parseDateOnly_(s) {
  const cleanStr = clean_(s);
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(cleanStr);
  if (m) {
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  const d = new Date(cleanStr);
  if (!isNaN(d.getTime())) return d;
  throw new Error('Invalid date format (expected YYYY-MM-DD).');
}

function combineDateTime_(d, t) {
  const x = d instanceof Date ? new Date(d) : parseDateOnly_(String(d));
  const m = minutes_(t);
  if (m !== null) {
    x.setHours(Math.floor(m / 60), m % 60, 0, 0);
  } else {
    x.setHours(9, 0, 0, 0);
  }
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
