# 📚 Reviewer Web Application

A full-featured, modern web application for students to create, share, and discover study notes and reviewers. Built with Node.js, Bootstrap CSS, and Supabase.

![Version](https://img.shields.io/badge/version-1.0.0-pink)
![License](https://img.shields.io/badge/license-MIT-pink)

## ✨ Features

### 🔐 Authentication System
- **Secure Sign Up & Login** - Email + Password authentication
- **Email Verification** - Automatic verification (configurable)
- **Role-Based Access Control** - Student and Admin roles
- **Protected Routes** - Dashboard only accessible when logged in
- **Session Management** - Secure session handling with httpOnly cookies

### 👨‍🎓 Student Dashboard
- **Subject Management** - Create, edit, and delete subjects
- **Reviewer Creation** - Rich text editor with formatting options
  - Bold, italic, underline, strikethrough
  - Headings (H1, H2, H3)
  - Bullet lists and numbered lists
  - Code blocks
  - Color and background highlighting
  - Links
- **Privacy Controls** - Choose to make reviewers public or private
- **Real-time Stats** - Track total subjects, reviewers, and public content

### 🌍 Public Reviewer Viewing
- **Browse All Reviewers** - View all public study materials
- **Advanced Search** - Search by title, subject, or content
- **Filter Options** - Filter by subject or student
- **Responsive Grid Layout** - Beautiful card-based design
- **Detailed View** - Full reviewer content in modal popup

### 💬 Chat System
- **General Chat** - Global chat room for all registered students
- **Online Chat** - Chat with currently active users
- **Real-time Updates** - Messages update automatically
- **Online Status** - See who's currently online
- **Timestamp Display** - Smart time formatting (Just now, 5m ago, etc.)

### 👑 Admin Dashboard
- **User Management**
  - View all users
  - Promote/demote user roles (Student ↔ Admin)
  - Delete users
  - Search and filter users
- **Reviewer Management**
  - View all reviewers across all students
  - Delete inappropriate content
  - Search and filter reviewers
- **Chat Moderation**
  - View all chat messages (General & Online)
  - Delete inappropriate messages
  - Filter by chat type
- **Analytics Dashboard**
  - Total users (Students & Admins)
  - Total subjects and reviewers
  - Currently online users
  - Real-time statistics

### 🎨 UI/UX Design
- **Light Pink Theme** - Cute, modern, and professional design
- **Fully Responsive** - Mobile, tablet, and desktop friendly
- **Smooth Animations** - Hover effects, transitions, modal animations
- **Interactive Elements** - Beautiful cards, buttons, and forms
- **Professional Typography** - Quicksand font for readability
- **Consistent Design System** - Unified color palette and spacing
- **Dark Mode Friendly** - Easy to customize colors

## 🛠️ Tech Stack

- **Backend**: Node.js + Express.js
- **Frontend**: HTML5 + Bootstrap CSS + Vanilla JavaScript
- **Database**: Supabase (PostgreSQL)
- **Authentication**: Supabase Auth + bcrypt
- **Rich Text Editor**: Quill.js
- **Security**: Helmet, Rate Limiting, CSRF Protection
- **Session Management**: Express-session

## 📋 Prerequisites

Before you begin, ensure you have:

- Node.js (v14 or higher)
- npm or yarn
- Supabase account (free tier works!)
- Git (optional)

## 🚀 Installation & Setup

### 1. Clone or Download the Project

```bash
git clone <repository-url>
cd reviewer-app
```

Or download and extract the ZIP file.

### 2. Install Dependencies

```bash
npm install
```

### 3. Set Up Supabase

#### Create a Supabase Project
1. Go to [https://supabase.com](https://supabase.com)
2. Sign up or log in
3. Click "New Project"
4. Fill in project details:
   - Name: `reviewer-app`
   - Database Password: (choose a strong password)
   - Region: (select closest to you)
5. Wait for project to be created (~2 minutes)

#### Get Your Supabase Credentials
1. In your Supabase dashboard, go to **Settings** > **API**
2. Copy:
   - **Project URL** (under "Project URL")
   - **anon public** key (under "Project API keys")
   - **service_role** key (under "Project API keys")

#### Set Up the Database Schema
1. In Supabase dashboard, go to **SQL Editor**
2. Click "New Query"
3. Copy the entire contents of `database-schema.sql` file
4. Paste into the SQL editor
5. Click "Run" or press Ctrl+Enter
6. Wait for success message

This will create:
- All necessary tables (users, subjects, reviewers, messages, online_users)
- Indexes for performance
- Row Level Security policies
- Triggers and functions
- Sample admin user

### 4. Configure Environment Variables

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

Edit the `.env` file with your Supabase credentials:

```env
# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key_here
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here

# Server Configuration
PORT=3000
NODE_ENV=development

# Session Secret (generate a random string)
SESSION_SECRET=your_super_secret_session_key_change_this_in_production
```

**Security Note**: Generate a strong random SESSION_SECRET:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 5. Start the Application

```bash
# Development mode (with auto-reload)
npm run dev

# Production mode
npm start
```

The app will be running at `http://localhost:3000`

## 👤 Default Admin Account

The database schema includes a default admin account:

- **Email**: `admin@reviewer.com`
- **Password**: `admin123`

**⚠️ IMPORTANT**: Change this password immediately in production!

To change the admin password:
1. Log in with the default credentials
2. Use a tool like pgAdmin or Supabase SQL Editor to update the password hash
3. Or create a new admin account and delete the default one

## 📁 Project Structure

```
reviewer-app/
├── public/                  # Frontend files
│   ├── css/
│   │   └── style.css       # Main stylesheet (pink theme)
│   ├── js/
│   │   ├── dashboard.js    # Dashboard logic
│   │   ├── chat.js         # Chat functionality
│   │   └── admin.js        # Admin panel logic
│   ├── index.html          # Landing page
│   ├── login.html          # Login page
│   ├── register.html       # Registration page
│   ├── dashboard.html      # Student dashboard
│   ├── chat.html           # Chat interface
│   └── admin.html          # Admin dashboard
├── database-schema.sql     # Complete database setup
├── server.js               # Express server & API routes
├── package.json            # Dependencies
├── .env.example            # Environment variables template
└── README.md              # This file
```

## 🔒 Security Features

- **Password Hashing**: bcrypt with salt rounds
- **SQL Injection Protection**: Parameterized queries via Supabase
- **CSRF Protection**: CSRF tokens (via csurf middleware)
- **Rate Limiting**: Prevents brute force attacks
- **Helmet**: Security headers
- **Session Security**: httpOnly cookies
- **Role-Based Access**: Admin and student permissions
- **Input Validation**: Server-side validation for all inputs

## 🌐 Deployment

### Deploy to Heroku

1. Create a Heroku account at [https://heroku.com](https://heroku.com)

2. Install Heroku CLI:
```bash
npm install -g heroku
```

3. Login to Heroku:
```bash
heroku login
```

4. Create a new Heroku app:
```bash
heroku create your-app-name
```

5. Set environment variables:
```bash
heroku config:set SUPABASE_URL=your_url
heroku config:set SUPABASE_ANON_KEY=your_key
heroku config:set SUPABASE_SERVICE_ROLE_KEY=your_service_key
heroku config:set SESSION_SECRET=your_secret
heroku config:set NODE_ENV=production
```

6. Deploy:
```bash
git add .
git commit -m "Deploy to Heroku"
git push heroku main
```

7. Open your app:
```bash
heroku open
```

### Deploy to Vercel

1. Install Vercel CLI:
```bash
npm install -g vercel
```

2. Login:
```bash
vercel login
```

3. Deploy:
```bash
vercel
```

4. Set environment variables in Vercel dashboard

### Deploy to Railway

1. Go to [https://railway.app](https://railway.app)
2. Connect your GitHub repository
3. Add environment variables
4. Deploy automatically on push

## 🎨 Customization

### Change Color Theme

Edit `/public/css/style.css` and modify the CSS variables:

```css
:root {
    /* Change primary pink color */
    --primary-pink: #ff9eb4;
    
    /* Change to blue theme */
    --primary-pink: #4a90e2;
    --primary-pink-light: #6ba3e8;
    --primary-pink-dark: #3a7bc8;
}
```

### Add New Features

The codebase is modular and easy to extend:

- **Add new routes**: Edit `server.js`
- **Add new pages**: Create HTML in `public/`
- **Add new styles**: Edit `public/css/style.css`
- **Add new client logic**: Create JS in `public/js/`

## 📊 Database Management

### Backup Database

```bash
# Using Supabase CLI
supabase db dump -f backup.sql
```

### Reset Database

Run the `database-schema.sql` again to reset all tables.

### Add New Admin

Use Supabase SQL Editor:

```sql
-- Hash a password first (use bcrypt online tool)
INSERT INTO users (email, username, password_hash, role, is_verified)
VALUES (
    'newadmin@example.com',
    'newadmin',
    '$2b$10$hashedpasswordhere',
    'admin',
    true
);
```

## 🐛 Troubleshooting

### Port Already in Use
```bash
# Change PORT in .env file
PORT=3001
```

### Can't Connect to Supabase
- Check if SUPABASE_URL and keys are correct
- Verify Supabase project is active
- Check internet connection

### Sessions Not Working
- Ensure SESSION_SECRET is set
- Check if cookies are enabled in browser
- For production, set `secure: true` in session config

### Database Errors
- Run `database-schema.sql` again
- Check Supabase logs in dashboard
- Verify RLS policies are enabled

## 📝 API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `POST /api/auth/logout` - Logout user
- `GET /api/auth/me` - Get current user

### Subjects
- `GET /api/subjects` - Get user's subjects
- `POST /api/subjects` - Create subject
- `PUT /api/subjects/:id` - Update subject
- `DELETE /api/subjects/:id` - Delete subject

### Reviewers
- `GET /api/subjects/:id/reviewers` - Get subject's reviewers
- `GET /api/reviewers/public` - Get all public reviewers
- `POST /api/reviewers` - Create reviewer
- `PUT /api/reviewers/:id` - Update reviewer
- `DELETE /api/reviewers/:id` - Delete reviewer

### Chat
- `GET /api/messages/:type` - Get messages (general/online)
- `POST /api/messages` - Send message
- `GET /api/online-users` - Get online users
- `POST /api/online-status` - Update online status

### Admin
- `GET /api/admin/analytics` - Get analytics
- `GET /api/admin/users` - Get all users
- `PUT /api/admin/users/:id/role` - Update user role
- `DELETE /api/admin/users/:id` - Delete user
- `GET /api/admin/reviewers` - Get all reviewers
- `DELETE /api/admin/reviewers/:id` - Delete reviewer
- `DELETE /api/admin/messages/:id` - Delete message

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License.

## 🙏 Acknowledgments

- **Supabase** - Amazing backend platform
- **Quill.js** - Rich text editor
- **Bootstrap Icons** - Icon library
- **Google Fonts** - Quicksand font

## 📧 Support

For issues and questions:
- Open an issue on GitHub
- Contact: support@reviewerapp.com

## 🎉 Enjoy!

Happy studying! 📚✨

---

Made with ❤️ by students, for students
