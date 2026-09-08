# 📅 CSF Event Planning & Approval System (Live Google Web App)

A collaborative event planning and institutional calendar web application powered by **Google Sheets** and **Google Apps Script**.

---

## 🌟 Key Features

- **Google Account Authentication**: Every user logs in seamlessly with their verified Google account.
- **Strict Role-Based Access Control**:
  - **`Admin`**: Approves/rejects proposed events, sets decision notes, manages user roles (`Admin` vs `Member`), and triggers notifications.
  - **`Member`**: Can propose events per day or in future dates, view the calendar, access event guidelines, join Google Meet calls, and participate in discussion threads.
  - **Only Admins can assign roles**: Members cannot alter roles or approve events.
- **Approval-Gated Visibility**:
  - Only events approved by an Admin become live on the public schedule for all members.
  - Members can see their own submissions marked as *Pending* until approved.
- **📹 "Arrange Google Meet" Video Integration**:
  - Check "Arrange Google Meet" when proposing an event.
  - Upon approval, a Google Meet video conference link is linked with a one-click **"Join Google Meet"** button.
- **Event Guidelines & Descriptions**:
  - Full details including event guide, prerequisites, time slots, venue, speaker, and coordinators.
- **⏰ Daily Event Email Notifications**:
  - An automated morning email digest (scheduled daily at 8:00 AM) sent to all registered members detailing all events happening today, their venues, times, and Google Meet links.
  - Admins can also trigger the digest on-demand from the dashboard.

---

## ❓ Where is "Extensions" in Google Sheets?

In Google Sheets on your computer:
1. Look at the top menu bar directly beneath the spreadsheet title:
   `File` | `Edit` | `View` | `Insert` | `Format` | `Data` | `Tools` | **`Extensions`** | `Help`
2. Click **`Extensions`** → click **`Apps Script`**.

> **Note**: If you uploaded an Excel `.xlsx` file to Google Drive and simply opened it in preview, the `Extensions` menu might not show. Make sure to click **"Open with Google Sheets"** (or in the sheet click `File` → `Save as Google Sheets`).

---

## 🚀 Live Deployment Guide (Step-by-Step)

### Step 1: Upload Template to Google Drive
1. Go to [Google Drive](https://drive.google.com).
2. Upload `CSF_Event_Management_Template.xlsx`.
3. Right-click the uploaded file → **Open with** → **Google Sheets** (or File → Save as Google Sheets).

### Step 2: Open Apps Script Editor
1. In your newly created Google Sheet, click **Extensions** in the top menu → **Apps Script**.
2. Rename the project to `CSF Event Portal`.

### Step 3: Copy Code Files
1. **`Code.gs`**:
   - Open `Code.gs` in Apps Script, delete any default code, and copy-paste the entire contents of [`Code.gs`](./Code.gs).
2. **`Index.html`**:
   - Click the **+** (Add a file) icon next to Files → select **HTML**.
   - Name it `Index` (Apps Script will save it as `Index.html`).
   - Delete any default HTML and copy-paste the entire contents of [`Index.html`](./Index.html).
3. **`appsscript.json` (Manifest)**:
   - In Apps Script, click the **Gear Icon** (Project Settings) on the left sidebar.
   - Check the box: **"Show 'appsscript.json' manifest file in editor"**.
   - Return to the **Editor** (`< >` icon on left sidebar).
   - Click `appsscript.json` and replace its content with [`appsscript.json`](./appsscript.json).

### Step 4: Run Initial Setup (One Click)
1. At the top of the Apps Script editor, select the function **`setupProject`** in the dropdown.
2. Click **Run**.
3. Google will prompt: *"Authorization Required"*.
   - Click **Review Permissions**.
   - Choose your Google account.
   - Click **Advanced** → **Go to CSF Event Portal (unsafe)**.
   - Click **Allow** (authorizes Spreadsheet, Calendar, and Mail services).
4. The script will automatically verify all sheets, configure headers, make you the first **`Admin`**, and set up the automated daily morning notification trigger!

### Step 5: Deploy as Live Web App
1. Click the blue **Deploy** button at the top right → **New deployment**.
2. Click the gear icon next to "Select type" → choose **Web app**.
3. Configure the deployment settings:
   - **Description**: `Version 1.0 - Live CSF Calendar`
   - **Execute as**: `User accessing the web app` (or `Me` if sharing without giving spreadsheet permissions).
   - **Who has access**: `Anyone with Google Account` (or `Anyone within your organization` for Google Workspace).
4. Click **Deploy**.
5. Copy the **Web App URL** (ends in `/exec`).
6. Share this URL with your team, faculty, and students!

---

## 👥 Managing Roles (Admin vs Member)

1. **Initial Admin**:
   - The person who deploys the spreadsheet is automatically assigned the **`Admin`** role.
2. **Assigning Roles**:
   - As an Admin, you will see a **"👥 Manage Users"** button in the left sidebar / header of the calendar.
   - Click it to view all registered users.
   - Use the dropdown next to any user's name to switch their role between **`Member`** and **`Admin`**.
   - You can also pre-register colleagues by entering their Name, Google Email, and desired role.
3. **Security**:
   - Server-side validation prevents non-admins from approving events or changing user roles.

---

## 📅 Daily Event Email Digest

- **Automated**: Runs every morning between 7:00 AM – 8:00 AM via Google Apps Script time-driven trigger.
- **Manual Broadcast**: Admins can click **"📧 Broadcast Today's Digest"** in the sidebar to send out reminders immediately for today's approved events.
- Recipients are automatically all active users in the **Users** sheet.

---

## 📹 Google Calendar & Google Meet Sync (Optional)

1. If you want approved events to sync to a shared department Google Calendar:
   - Open Google Calendar → Create a new calendar (e.g. *CSF Events*).
   - Go to Calendar Settings → copy the **Calendar ID** (e.g. `c_xxxxxx@group.calendar.google.com`).
   - Open your Google Sheet → Go to the **Settings** tab → paste the Calendar ID in the row next to `CalendarId`.
2. When an Admin clicks **Approve**, the event automatically syncs to Google Calendar and generates the Google Meet video meeting link.