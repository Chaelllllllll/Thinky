# User Settings Implementation

This document describes the notification preferences and Two-Factor Authentication (2FA) features implemented in the Thinky application.

## Features Implemented

### 1. Notification Preferences
Users can control which types of notifications they receive:
- **General Chat Messages**: Toggle to receive/disable notifications from general chat
- **Private Messages**: Toggle to receive/disable notifications from private/direct messages

**Database Schema:**
```sql
ALTER TABLE users
    ADD COLUMN notif_general_chat BOOLEAN DEFAULT TRUE,
    ADD COLUMN notif_private_messages BOOLEAN DEFAULT TRUE;
```

**API Endpoints:**
- `GET /api/auth/settings` - Get current user settings
- `PUT /api/auth/settings/notifications` - Update notification preferences

### 2. Two-Factor Authentication (2FA)

Two methods of 2FA are supported:

#### a) Google Authenticator (TOTP)
- Uses time-based one-time passwords (TOTP) via the speakeasy library
- QR code generated for easy setup
- 6-digit codes rotated every 30 seconds

**Database Schema:**
```sql
ALTER TABLE users
    ADD COLUMN two_factor_enabled BOOLEAN DEFAULT FALSE,
    ADD COLUMN two_factor_secret TEXT;
```

**API Endpoints:**
- `POST /api/auth/2fa/google/enable` - Request QR code for Google Authenticator setup
- `POST /api/auth/2fa/google/verify` - Verify TOTP code and activate 2FA
- `POST /api/auth/2fa/google/disable` - Disable Google Authenticator

#### b) Email Verification Codes
- 6-digit codes sent to user's email on login
- Codes expire after 10 minutes
- One-time use codes

**Database Schema:**
```sql
CREATE TABLE email_2fa_codes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code VARCHAR(6) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

**API Endpoints:**
- `POST /api/auth/2fa/email/enable` - Enable email-based 2FA
- `POST /api/auth/2fa/email/disable` - Disable email-based 2FA

### 3. Enhanced Login Flow
The login process now checks for 2FA:
1. User enters email and password
2. If 2FA is enabled, return `requires2FA: true` with available methods
3. Display 2FA modal with appropriate method(s)
4. User enters verification code
5. Code verified via `POST /api/auth/2fa/verify`
6. Session created and user logged in

## Setup Instructions

### 1. Run Database Migration
```bash
psql -h [your-supabase-host] -U postgres -d postgres -f db/migrations/20260201_add_user_settings.sql
```

Or via Supabase SQL Editor:
- Copy contents of `db/migrations/20260201_add_user_settings.sql`
- Run in SQL Editor

### 2. Install Dependencies
```bash
npm install speakeasy qrcode
```

### 3. Configure Email (for Email 2FA)
Ensure these environment variables are set in `.env`:
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=noreply@thinky.app
```

### 4. Restart Server
```bash
npm start
```

## Usage

### Accessing Settings
1. Click on user profile/settings icon
2. Navigate to:
   - **Notifications Tab**: Toggle notification preferences
   - **Security Tab**: Enable/disable 2FA methods

### Enabling Google Authenticator
1. Go to Settings → Security
2. Click "Enable Google Authenticator"
3. Scan QR code with Google Authenticator app
4. Enter 6-digit code from app
5. Click "Verify & Enable"

### Enabling Email 2FA
1. Go to Settings → Security
2. Click "Enable Email 2FA"
3. Confirm in dialog
4. Done! Codes will be sent on login

### Logging in with 2FA
1. Enter email and password
2. If 2FA enabled, modal appears
3. Enter code from:
   - Google Authenticator app, OR
   - Email (check your inbox)
4. Click verify button
5. Logged in!

## Security Notes

- TOTP secrets are stored encrypted in the database
- Email codes expire after 10 minutes
- Email codes are single-use only
- Both 2FA methods can be enabled simultaneously for maximum security
- 2FA can be bypassed if the user loses access to both methods (admin intervention required)

## File Changes

### Backend (server.js)
- Added 2FA verification endpoints
- Modified login flow to check for 2FA
- Added notification settings endpoints
- Integrated speakeasy for TOTP generation
- Added email sending for 2FA codes

### Frontend
- **settings.js**: Updated to use backend APIs instead of localStorage
- **login.html**: Added 2FA verification modal and flow
- **chat.html**: Settings modal with Notifications and Security tabs
- **dashboard.html**: Settings modal with Notifications and Security tabs

### Database
- **Migration file**: `db/migrations/20260201_add_user_settings.sql`
- Adds notification preference columns
- Adds 2FA columns to users table
- Creates email_2fa_codes table

## Testing

### Test Notification Settings
1. Open Settings → Notifications
2. Toggle switches
3. Click "Save Changes"
4. Refresh page and verify settings persist

### Test Google Authenticator
1. Enable Google Authenticator in Settings
2. Use a TOTP app (Google Authenticator, Authy, etc.)
3. Log out and log back in
4. Verify 2FA modal appears and accepts code

### Test Email 2FA
1. Ensure SMTP is configured
2. Enable Email 2FA in Settings
3. Log out and log back in
4. Check email for code
5. Enter code in 2FA modal

## Troubleshooting

**QR Code not appearing:**
- Check browser console for errors
- Verify `speakeasy` and `qrcode` packages installed
- Check server logs for errors

**Email not received:**
- Verify SMTP configuration in `.env`
- Check spam/junk folder
- Verify `mailTransporter` is configured (check server logs)
- Test SMTP connection: `npm test` (if test script added)

**2FA verification failing:**
- Ensure system clock is synchronized (TOTP requires accurate time)
- Check code hasn't expired (email codes: 10 min, TOTP: 30 sec window)
- Verify code entered correctly (no spaces)

**Database errors:**
- Ensure migration ran successfully
- Check Supabase logs for errors
- Verify RLS policies allow user access to their own settings

## Future Enhancements

- Recovery codes for 2FA backup
- SMS-based 2FA
- Backup email for 2FA
- 2FA session remember for trusted devices
- Admin interface to reset user 2FA
- Audit log for 2FA enable/disable events
