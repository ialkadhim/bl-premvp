# Event Booking Backend

### 🔧 Setup for Railway

1. Upload this project to a GitHub repo or deploy via Railway CLI.
2. In Railway:
   - Click "New Project" → "Deploy from GitHub"
   - Add environment variables from `.env.example`
   - DO NOT add a `PORT` variable.
3. Once deployed, test:
   - `/api/seed` → should return `{ "message": "Seeded user" }`
   - `/api/login` → POST with `lastName=Park` and `membershipNumber=12345`