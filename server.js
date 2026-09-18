const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Set your secret key (must match Skript)
const ADMIN_SECRET = process.env.ADMIN_SECRET || "MY_SUPER_SECRET_KEY_123";

// In-memory token store (Token -> { username, expires })
const validTokens = new Map();
const playerPositions = new Map();

// Helper to clean up expired tokens
function cleanupTokens() {
    const now = Date.now();
    for (const [token, data] of validTokens.entries()) {
        if (data.expires < now) {
            validTokens.delete(token);
        }
    }
}
setInterval(cleanupTokens, 60000);

// 1. API Endpoint: Generate secure authentication token (Called by Skript via curl)
app.post('/api/auth/token', (req, res) => {
    const { username, secret } = req.body;

    if (secret !== ADMIN_SECRET) {
        return res.status(403).json({ error: "Unauthorized: Invalid secret key" });
    }

    if (!username) {
        return res.status(400).json({ error: "Missing username" });
    }

    // Generate token valid for 10 minutes
    const token = crypto.randomBytes(4).toString('hex');
    const expires = Date.now() + (10 * 60 * 1000);
    validTokens.set(token, { username, expires });

    const generatedUrl = `https://evs-7cx7.onrender.com/?auth=${token}&user=${username}`;
    console.log(`[AUTH] Issued token for ${username}: ${generatedUrl}`);

    return res.json({ token, url: generatedUrl });
});

// 2. API Endpoint: Position Telemetry Loop (Called every 10 ticks by Skript)
app.post('/api/position', (req, res) => {
    const { username, world, x, y, z } = req.body;
    if (username) {
        playerPositions.set(username, { world, x, y, z, lastUpdate: Date.now() });
    }
    res.sendStatus(200);
});

// 3. Web UI Route: Stealth Fallback vs WebRTC Client
app.get('/', (req, res) => {
    const { auth, user } = req.query;

    if (auth && validTokens.has(auth)) {
        const tokenData = validTokens.get(auth);
        if (tokenData.username === user && tokenData.expires > Date.now()) {
            // Valid token authenticated -> Serve real WebRTC Voice UI
            return res.sendFile(path.join(__dirname, 'public', 'index.html'));
        }
    }

    // Unauthenticated request -> Fall back to Stealth Apache 404 page
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(`Backend server running on port ${PORT}`);
    console.log(`===================================================`);
});
