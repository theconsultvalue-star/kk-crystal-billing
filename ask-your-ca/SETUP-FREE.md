# Free setup guide: Ask your CA

About 20 minutes, ₹0. You need three free accounts: **GitHub** (already have), **Neon** (database) and **Render** (runs the app).

## Step 1: Put the app on your main branch (2 min)
1. Open **github.com** → your `kk-crystal-billing` repository.
2. Click **Compare & pull request** on the banner for `claude/intelligent-dijkstra-66ag1i`.
3. Click **Create pull request** → **Merge pull request** → **Confirm merge**.

## Step 2: Free database on Neon (5 min)
1. Go to **neon.tech** → **Sign up** with GitHub or Google.
2. Create a project:
   - **Name:** `ask-your-ca`
   - **Region:** **Asia Pacific (Singapore)**
3. Click **Connect** and copy the **connection string**. It looks like:
   `postgresql://neondb_owner:xxxx@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`
4. Keep it private, like a password. The app creates its own tables on first start.

## Step 3: Run the app on Render (10 min)
1. Go to **render.com** → sign up with **GitHub** → allow access to `kk-crystal-billing`.
2. Click **New +** → **Web Service** → choose **kk-crystal-billing**.
3. Fill in:

| Field | Value |
|---|---|
| Name | `ask-your-ca` |
| Region | Singapore |
| Branch | `main` |
| Root Directory | `ask-your-ca` |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | **Free** |

4. Under **Environment Variables**, add:

| Key | Value |
|---|---|
| `DATABASE_URL` | the Neon connection string |
| `ASKCA_USERS` | `YourName:password1,Sita:password2,Arjun:password3` (your name **first** = owner) |
| `SESSION_SECRET` | any long random text, e.g. `q8Lm2Zr7Tx4Vn9Kc3Pw6Jd1` |

   Don't add `ANTHROPIC_API_KEY` yet.
5. Click **Create Web Service**. Wait until the log shows `Using Postgres (DATABASE_URL).` and `Ask your CA running at …`.
6. Your link appears at the top, e.g. **https://ask-your-ca.onrender.com**.

## Step 4: Try it (3 min)
1. Open the link and log in.
2. Go to **Clients** → **+ Add client**. Add one real client with a contact and a note.
3. A yellow message saying the advisor isn't switched on yet is expected.

## Step 5: Give it to the team
1. Send each person the link and their own name and password.
2. On their phone:
   - **Android:** **☰** → **Install app on this device**
   - **iPhone (Safari):** **Share** → **Add to Home Screen**

## Good to know
- **Sleeps when idle.** The free plan sleeps after about 15 minutes unused, so the first open then takes around a minute. Data is never lost; it lives in Neon.
- **Add a person or change a password:** Render → service → **Environment** → edit `ASKCA_USERS` → **Save**.
- **Switch on the advisor later:** add `ANTHROPIC_API_KEY` in the same place. Everything else stays as it is.
- **Stuck?** Send a screenshot, or the error from Render's **Logs** tab.
