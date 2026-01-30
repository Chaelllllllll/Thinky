# 🚀 Quick Start Guide - Reviewer App

Get your Reviewer App up and running in 5 minutes!

## Prerequisites Checklist
- [ ] Node.js installed (v14+)
- [ ] Supabase account created
- [ ] Text editor (VS Code recommended)

## Step 1: Supabase Setup (2 minutes)

1. **Create Project**
   - Go to [supabase.com](https://supabase.com)
   - Click "New Project"
   - Name: `reviewer-app`
   - Create strong database password
   - Wait for project creation

2. **Get Credentials**
   - Settings → API
   - Copy:
     - Project URL
     - `anon` public key
     - `service_role` key

3. **Setup Database**
   - SQL Editor → New Query
   - Copy entire `database-schema.sql` file
   - Paste and Run
   - ✅ Success!

## Step 2: Local Setup (2 minutes)

1. **Install Dependencies**
   ```bash
   cd reviewer-app
   npm install
   ```

2. **Configure Environment**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env`:
   ```env
   SUPABASE_URL=your_project_url_here
   SUPABASE_ANON_KEY=your_anon_key_here
   SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
   SESSION_SECRET=any_random_long_string
   PORT=3000
   ```

## Step 3: Launch! (1 minute)

```bash
npm start
```

Open browser: `http://localhost:3000`

## Step 4: Test It Out

### Create Account
1. Click "Get Started" or "Sign Up"
2. Fill in:
   - Username: `teststudent`
   - Email: `test@example.com`
   - Password: `password123`
3. ✅ Auto-redirected to dashboard

### Try Admin Panel
1. Logout
2. Login with:
   - Email: `admin@reviewer.com`
   - Password: `admin123`
3. ✅ Access admin dashboard

### Create Your First Reviewer
1. Login as student
2. Click "Add Subject"
   - Name: "Mathematics"
   - Description: "Math notes and reviewers"
3. Click "Add Reviewer" on the subject card
   - Title: "Algebra Basics"
   - Content: Use the rich text editor!
4. ✅ Reviewer created and visible on public page

### Test Chat
1. Click "Chat" in sidebar
2. Send a message
3. ✅ Real-time chat working

## Troubleshooting

### Can't connect to Supabase?
- Double-check URL and keys in `.env`
- Ensure Supabase project is active
- Check internet connection

### Port already in use?
```bash
# Use different port
PORT=3001 npm start
```

### Database errors?
- Re-run `database-schema.sql`
- Check Supabase logs
- Verify RLS policies are enabled

## Next Steps

### Customize Your App
- **Change Colors**: Edit `/public/css/style.css` → `:root` variables
- **Add Features**: Follow modular structure in project
- **Deploy**: See `DEPLOYMENT.md` for detailed guides

### Security Checklist
- [ ] Change default admin password
- [ ] Generate strong SESSION_SECRET
- [ ] Set up SSL for production
- [ ] Enable rate limiting
- [ ] Regular database backups

## File Structure Overview

```
reviewer-app/
├── public/              # All frontend files
│   ├── css/            # Stylesheets
│   ├── js/             # JavaScript logic
│   └── *.html          # HTML pages
├── server.js           # Backend server + API
├── database-schema.sql # Database setup
└── README.md          # Full documentation
```

## Common Commands

```bash
# Development (auto-reload)
npm run dev

# Production
npm start

# Install new package
npm install package-name

# Check for updates
npm outdated
```

## Features to Explore

✅ Rich text editor with formatting  
✅ Real-time chat (General & Online)  
✅ Public reviewer browsing with search  
✅ Admin panel with analytics  
✅ Subject & reviewer management  
✅ Role-based access control  
✅ Responsive mobile design  
✅ Beautiful pink theme  

## Getting Help

1. **Check README.md** - Comprehensive documentation
2. **Check DEPLOYMENT.md** - Deployment guides
3. **Review code comments** - Well-documented code
4. **Open an issue** - GitHub issues

## Success Indicators

When everything is working:
- ✅ Login/Register works
- ✅ Dashboard loads with stats
- ✅ Can create subjects/reviewers
- ✅ Public page shows reviewers
- ✅ Chat messages send/receive
- ✅ Admin can manage users
- ✅ No console errors

---

## 🎉 You're Ready!

Your Reviewer App is now running! Start creating and sharing study materials.

**Default Admin Access**:
- Email: `admin@reviewer.com`
- Password: `admin123`
- ⚠️ Change this immediately!

**Tips**:
- Create multiple test accounts to test features
- Try the chat with multiple browser tabs
- Test responsive design on mobile
- Customize the pink theme to your preference

Happy coding! 📚✨

---

Need help? Check the full README.md or DEPLOYMENT.md for detailed information.
