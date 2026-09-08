# 📅 CSF Event Planning & Approval System (Google Sheets + Vercel)

A live, collaborative event planning and institutional calendar web application with **Google Account Login**, **Admin/Member Roles**, **Google Meet Video Integration**, and **Automated Daily Email Notifications**.

---

## 🚀 Live Deployment Architecture

This project uses **Vercel** for fast global web hosting and **Google Apps Script** as the secure serverless backend connected to your Google Sheet and Google Calendar.

```
[ User in Browser / Vercel ]
          │
          ├── (1) Google Identity Services (Sign in with Google Account)
          │
          └── (2) Fetch API requests
                   │
                   ▼
       [ Google Apps Script Web App ]
                   │
         ┌─────────┴─────────┐
         ▼                   ▼
  [ Google Sheet ]   [ Google Calendar / Meet ]
   - Events           - Sync approved events
   - Users & Roles    - Auto Google Meet link
   - Comments         - Daily 8 AM morning digest
```

---

## ⚡ Quick Deployment Guide (Vercel + Google Apps Script)

### Step 1: Set Up Google Sheet & Apps Script Backend
1. Go to [Google Drive](https://drive.google.com).
2. Upload `CSF_Event_Management_Template.xlsx`.
3. Right-click the file → **Open with** → **Google Sheets** (or `File` → `Save as Google Sheets`).
4. In the top menu, click **`Extensions`** → **`Apps Script`**.
   *(If you don't see Extensions, make sure the file is saved as a Google Sheet, not Excel preview!)*
5. Replace `Code.gs` with the content of [`Code.gs`](./Code.gs).
6. In **Project Settings** (gear icon), check *"Show 'appsscript.json' manifest file in editor"*, then replace [`appsscript.json`](./appsscript.json).
7. Select **`setupProject`** in the top dropdown and click **Run** (Grant permissions when prompted).
8. Click the blue **Deploy** button → **New deployment**:
   - Select type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
9. Click **Deploy** and **copy your Web App URL** (ends in `/exec`).

---

### Step 2: Get a Free Google OAuth Client ID (for Google Login)
1. Go to [Google Cloud Console](https://console.cloud.google.com).
2. Create a new project (e.g. `CSF-Calendar`).
3. In the search bar, search for **OAuth consent screen**:
   - Choose User Type: **External** (or **Internal** if your college uses Google Workspace).
   - Fill in App Name (e.g., `CSF Event Calendar`) and your email. Click **Save and Continue**.
4. Go to **Credentials** (left menu) → click **+ Create Credentials** → select **OAuth client ID**.
5. Select Application Type: **Web application**.
6. Under **Authorized JavaScript origins**, click **+ Add URI**:
   - Add `http://localhost` (for testing)
   - Add your Vercel URL (e.g. `https://csf-calendar.vercel.app` — you can also add this after deploying on Vercel).
7. Click **Create** and **copy your Client ID** (e.g., `xxxxxxxxxxxx-xxxxxxxx.apps.googleusercontent.com`).

---

### Step 3: Deploy to Vercel (1 Click)
1. Go to [Vercel](https://vercel.com) and log in with GitHub.
2. Click **Add New...** → **Project**.
3. Import your GitHub repository: `https://github.com/MJ636UoW/CSF_calender`.
4. Leave framework preset as **Other** (static HTML).
5. Click **Deploy**!
6. Once deployed, open your live Vercel website URL.
7. Click the **⚙️ Connection Settings** icon in the top header:
   - Paste your **Google Apps Script Web App URL** from Step 1.
   - Paste your **Google OAuth Client ID** from Step 2.
   - Click **Save & Reconnect**.
8. Go back to Google Cloud Console (Step 2) and ensure your new Vercel domain is added under **Authorized JavaScript origins**.

You are now completely live on Vercel with Google Account Login!

---

## 👥 Role Management (Admin vs Member)

- **`Admin`**:
  - Approves or rejects proposed events.
  - Can open the **"👥 Manage Users & Roles"** panel to assign or change user roles (`Admin` or `Member`).
  - Can click **"📧 Broadcast Today's Digest"** to send morning email summaries on demand.
- **`Member`**:
  - Signs in with Google account.
  - Can browse the calendar and view event guidelines.
  - Can propose new events for today or any future date.
  - Can join Google Meet video meetings with 1 click.
  - Can participate in the comments/thoughts thread.
- **Approval Gate**:
  - Only events approved by an Admin appear on the public calendar for all members.

---

## 📹 Google Meet & Calendar Sync

When an event is submitted with **"📹 Arrange Google Meet"** checked, upon Admin approval:
- A dedicated Google Meet link is linked.
- Attendees see a direct **"📹 Join with Google Meet"** button in the event popup.
- The event automatically synchronizes with your department Google Calendar (configured in the Sheet's `Settings` tab).

---

## 📧 Daily Morning Event Digest

- Automatically sent every morning at 8:00 AM to all registered member emails using Google Apps Script's built-in time-driven trigger.
- Includes times, venue, coordinator, guidelines, and direct Google Meet video links.