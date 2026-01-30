# 🚀 Deployment Guide - Reviewer App

This guide covers deploying your Reviewer App to various platforms.

## Table of Contents
1. [Heroku Deployment](#heroku-deployment)
2. [Vercel Deployment](#vercel-deployment)
3. [Railway Deployment](#railway-deployment)
4. [DigitalOcean Deployment](#digitalocean-deployment)
5. [AWS EC2 Deployment](#aws-ec2-deployment)

---

## Heroku Deployment

### Prerequisites
- Heroku account (free tier available)
- Git installed
- Heroku CLI installed

### Step-by-Step Instructions

1. **Install Heroku CLI** (if not already installed)
   ```bash
   # macOS
   brew tap heroku/brew && brew install heroku
   
   # Windows (use installer from heroku.com)
   # Linux
   curl https://cli-assets.heroku.com/install.sh | sh
   ```

2. **Login to Heroku**
   ```bash
   heroku login
   ```

3. **Initialize Git Repository** (if not already done)
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   ```

4. **Create Heroku App**
   ```bash
   heroku create reviewer-app-unique-name
   ```

5. **Add Heroku PostgreSQL** (Optional - if not using Supabase)
   ```bash
   heroku addons:create heroku-postgresql:hobby-dev
   ```

6. **Set Environment Variables**
   ```bash
   heroku config:set SUPABASE_URL="your_supabase_url"
   heroku config:set SUPABASE_ANON_KEY="your_anon_key"
   heroku config:set SUPABASE_SERVICE_ROLE_KEY="your_service_role_key"
   heroku config:set SESSION_SECRET="your_random_secret"
   heroku config:set NODE_ENV="production"
   ```

7. **Deploy to Heroku**
   ```bash
   git push heroku main
   ```
   
   Or if using master branch:
   ```bash
   git push heroku master
   ```

8. **Open Your App**
   ```bash
   heroku open
   ```

9. **View Logs** (for debugging)
   ```bash
   heroku logs --tail
   ```

### Heroku Specific Configuration

Add a `Procfile` in your project root:
```
web: node server.js
```

---

## Vercel Deployment

### Prerequisites
- Vercel account
- Git repository (GitHub, GitLab, or Bitbucket)

### Step-by-Step Instructions

1. **Install Vercel CLI**
   ```bash
   npm install -g vercel
   ```

2. **Login to Vercel**
   ```bash
   vercel login
   ```

3. **Configure vercel.json**
   Create a `vercel.json` file in your project root:
   ```json
   {
     "version": 2,
     "builds": [
       {
         "src": "server.js",
         "use": "@vercel/node"
       }
     ],
     "routes": [
       {
         "src": "/(.*)",
         "dest": "server.js"
       }
     ],
     "env": {
       "NODE_ENV": "production"
     }
   }
   ```

4. **Deploy**
   ```bash
   vercel
   ```
   
   Follow the prompts to configure your project.

5. **Set Environment Variables**
   - Go to Vercel Dashboard
   - Select your project
   - Go to Settings > Environment Variables
   - Add all required variables:
     - `SUPABASE_URL`
     - `SUPABASE_ANON_KEY`
     - `SUPABASE_SERVICE_ROLE_KEY`
     - `SESSION_SECRET`
     - `NODE_ENV` (set to "production")

6. **Deploy Again** (after setting env vars)
   ```bash
   vercel --prod
   ```

---

## Railway Deployment

### Prerequisites
- Railway account
- GitHub account

### Step-by-Step Instructions

1. **Go to Railway.app**
   Visit [https://railway.app](https://railway.app)

2. **Sign Up / Login**
   Use your GitHub account

3. **Create New Project**
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Authorize Railway to access your repositories
   - Select your reviewer-app repository

4. **Add Environment Variables**
   - Click on your deployment
   - Go to "Variables" tab
   - Add:
     ```
     SUPABASE_URL=your_url
     SUPABASE_ANON_KEY=your_key
     SUPABASE_SERVICE_ROLE_KEY=your_service_key
     SESSION_SECRET=your_secret
     NODE_ENV=production
     PORT=3000
     ```

5. **Deploy**
   - Railway will automatically deploy on push to main branch
   - First deployment starts automatically

6. **Get Your URL**
   - Go to Settings > Domains
   - Railway provides a free domain
   - Or connect your custom domain

---

## DigitalOcean Deployment

### Prerequisites
- DigitalOcean account
- Basic Linux knowledge

### Step-by-Step Instructions

1. **Create a Droplet**
   - Choose Ubuntu 22.04 LTS
   - Select $6/month plan (or higher)
   - Choose datacenter region
   - Add SSH key
   - Create droplet

2. **SSH into Droplet**
   ```bash
   ssh root@your_droplet_ip
   ```

3. **Install Node.js**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   sudo apt-get install -y npm
   ```

4. **Install Git**
   ```bash
   sudo apt-get install git
   ```

5. **Clone Your Repository**
   ```bash
   cd /var/www
   git clone your_repository_url
   cd reviewer-app
   ```

6. **Install Dependencies**
   ```bash
   npm install --production
   ```

7. **Set Environment Variables**
   ```bash
   nano .env
   ```
   
   Paste your environment variables and save (Ctrl+X, Y, Enter)

8. **Install PM2** (Process Manager)
   ```bash
   sudo npm install -g pm2
   ```

9. **Start Application**
   ```bash
   pm2 start server.js --name "reviewer-app"
   pm2 save
   pm2 startup
   ```

10. **Install Nginx** (Reverse Proxy)
    ```bash
    sudo apt-get install nginx
    ```

11. **Configure Nginx**
    ```bash
    sudo nano /etc/nginx/sites-available/reviewer-app
    ```
    
    Add configuration:
    ```nginx
    server {
        listen 80;
        server_name your_domain.com;

        location / {
            proxy_pass http://localhost:3000;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_cache_bypass $http_upgrade;
        }
    }
    ```

12. **Enable Site**
    ```bash
    sudo ln -s /etc/nginx/sites-available/reviewer-app /etc/nginx/sites-enabled/
    sudo nginx -t
    sudo systemctl restart nginx
    ```

13. **Configure Firewall**
    ```bash
    sudo ufw allow 'Nginx Full'
    sudo ufw enable
    ```

14. **Setup SSL with Let's Encrypt** (Optional but recommended)
    ```bash
    sudo apt-get install certbot python3-certbot-nginx
    sudo certbot --nginx -d your_domain.com
    ```

---

## AWS EC2 Deployment

### Prerequisites
- AWS account
- Basic AWS knowledge

### Step-by-Step Instructions

1. **Launch EC2 Instance**
   - Go to EC2 Dashboard
   - Click "Launch Instance"
   - Choose Ubuntu Server 22.04 LTS
   - Select t2.micro (free tier eligible)
   - Configure security group:
     - SSH (22) - Your IP
     - HTTP (80) - Anywhere
     - HTTPS (443) - Anywhere
     - Custom TCP (3000) - Anywhere (temporary)
   - Download key pair (.pem file)

2. **Connect to Instance**
   ```bash
   chmod 400 your-key.pem
   ssh -i "your-key.pem" ubuntu@your-instance-public-dns
   ```

3. **Update System**
   ```bash
   sudo apt-get update
   sudo apt-get upgrade -y
   ```

4. **Install Node.js**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

5. **Clone and Setup** (Same as DigitalOcean steps 5-14)

---

## Post-Deployment Checklist

After deploying to any platform:

- [ ] Test all features (login, register, dashboard, chat)
- [ ] Verify environment variables are set correctly
- [ ] Check database connection
- [ ] Test file uploads (if applicable)
- [ ] Verify SSL/HTTPS is working
- [ ] Check logs for any errors
- [ ] Test on different devices and browsers
- [ ] Set up monitoring (optional)
- [ ] Configure backups (recommended)
- [ ] Change default admin password
- [ ] Update CORS settings if needed

---

## Troubleshooting

### Common Issues

1. **Port Binding Issues**
   - Ensure PORT environment variable is set
   - Some platforms require specific port bindings

2. **Database Connection Errors**
   - Verify Supabase credentials
   - Check firewall/security group settings
   - Ensure database is accessible from deployment region

3. **Session Issues**
   - Set `secure: false` for HTTP in development
   - Set `secure: true` for HTTPS in production
   - Verify SESSION_SECRET is set

4. **Build Failures**
   - Check Node.js version compatibility
   - Verify all dependencies are in package.json
   - Check build logs for specific errors

5. **Static Files Not Loading**
   - Verify file paths are correct
   - Check Express static middleware configuration
   - Ensure files are included in deployment

---

## Monitoring & Maintenance

### Recommended Tools

1. **Uptime Monitoring**
   - UptimeRobot (free)
   - Pingdom
   - StatusCake

2. **Error Tracking**
   - Sentry
   - Rollbar
   - LogRocket

3. **Analytics**
   - Google Analytics
   - Plausible
   - Simple Analytics

4. **Performance Monitoring**
   - New Relic
   - DataDog
   - AppSignal

---

## Security Best Practices

1. **Use HTTPS** - Always use SSL/TLS in production
2. **Strong Secrets** - Use cryptographically secure random strings
3. **Update Dependencies** - Regularly update packages
4. **Rate Limiting** - Already implemented, verify it's working
5. **Input Validation** - Server-side validation for all inputs
6. **Secure Headers** - Helmet middleware is configured
7. **Database Security** - Use Supabase RLS policies
8. **Backup Regularly** - Set up automatic database backups

---

## Need Help?

- Check application logs
- Review Supabase dashboard for database errors
- Consult platform-specific documentation
- Open an issue on GitHub

---

Happy Deploying! 🚀
