# FormPilot Transition Guide: Local to Cloud Multi-Tenant

## 1. The Core Problem: Single-Tenancy
**Current State:** The database (`formpilot.db`) currently hardcodes `id=1` for the profile and resume. It assumes there is only ever one user.
**The Risk:** If deployed as-is, User A and User B would overwrite each other's data. User A would see User B's profile.
**The Goal:** Transition the architecture so the backend can serve thousands of users simultaneously, keeping their data strictly isolated and secure, without forcing them to create traditional accounts with passwords.

## 2. Security & Authentication Strategy
**Requirement:** Users must feel their data is secure, but we want to avoid OAuth/passwords.
**Solution: "Device Key" Authentication**
- When the extension is installed, it generates a strong, random `Device Key` (e.g., a UUID v4).
- This key is stored securely in the browser's local storage.
- The user is completely anonymous to the server. No email or password is required.
- **Data Isolation:** Every request to the backend includes this `Device Key` in the headers (e.g., `X-Device-ID`). The backend uses this key as the primary identifier (Foreign Key) for all database operations. User A can never access User B's data because they don't have User B's Device Key.
- **Data Safety:** We will communicate over HTTPS (encrypting data in transit). To give users peace of mind, the extension will display their "Recovery Key" in the Settings page, explaining that their data is tied exclusively to this key and their device.

## 3. Step-by-Step Implementation Plan

### Phase A: Database Schema Evolution
*What we are changing:* Moving away from `id=1` to user-specific IDs.
- **db.py:** 
  - Change `profile` table PK from `id (Integer)` to `user_id (String)`.
  - Change `resume` table PK from `id (Integer)` to `user_id (String)`.
  - Update `corrections` table to include `user_id (String)` so corrections are scoped to the user, not shared globally.

### Phase B: Backend API Updates
*What we are changing:* Routing data requests to the correct user sandbox.
- **main.py:**
  - Introduce a FastAPI dependency to extract `X-Device-ID` from HTTP headers.
  - Update `/profile` GET/POST: Filter by `user_id == device_id` instead of `id == 1`.
  - Update `/resume/upload` and `/resume` GET: Filter by `user_id == device_id`.
  - Update `/corrections`: Filter by `user_id == device_id`.
  - Replace the deprecated `@app.on_event("startup")` with the modern `lifespan` context manager.

### Phase C: Extension Identity & Connectivity
*What we are changing:* Generating the key and pointing the extension to the cloud.
- **background.js:**
  - Add an installation listener (`chrome.runtime.onInstalled`) to generate a `crypto.randomUUID()` and save it to `chrome.storage.local`.
- **popup.js & content_script.js:**
  - Modify all `fetch()` and `chrome.runtime.sendMessage` calls to retrieve the `Device Key` and attach it to API requests.
- **constants.js / background.js:**
  - Update `API_BASE` to point to the production server URL.
- **manifest.json:**
  - Ensure `host_permissions` points to the new production backend.

### Phase D: Deployment Strategy
*What we are doing:* Getting the code onto the internet.
- **Database:** Migrate from local SQLite to a serverless PostgreSQL database (e.g., Neon.tech) so data persists across server restarts.
- **Backend:** Host the FastAPI app on a free/cheap platform (e.g., Render.com or Railway.app).
- **Frontend:** Publish the extension zip to the Chrome Web Store and Microsoft Edge Add-ons.
