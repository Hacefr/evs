const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

app.use(express.json());

// Set up security secret from environment or fallback
const ADMIN_SECRET = process.env.ADMIN_SECRET || "MY_SUPER_SECRET_KEY_123";

// Storage Maps
const validTokens = new Map(); // token -> { username, expires }
const activeSessions = new Map(); // token -> username
const players = new Map(); // username -> { ws, x, y, z, world, status }

// Automatically purge expired tokens every minute
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of validTokens.entries()) {
        if (data.expires < now) validTokens.delete(token);
    }
}, 60000);

// API Endpoint: Skript requests a single-use token
app.post('/api/auth/token', (req, res) => {
    const { username, secret } = req.body;
    if (secret !== ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized secret" });
    if (!username) return res.status(400).json({ error: "Missing username" });

    const token = crypto.randomBytes(8).toString('hex');
    const expires = Date.now() + (5 * 60 * 1000); // 5-minute link expiration window
    validTokens.set(token, { username, expires });

    const generatedUrl = `https://evs-7cx7.onrender.com/?auth=${token}&user=${encodeURIComponent(username)}`;
    console.log(`[AUTH] Single-use token generated for ${username}`);
    return res.json({ token, url: generatedUrl });
});

// Root Route: Strictly requires valid auth & user query parameters
app.get('/', (req, res) => {
    const { auth, user } = req.query;

    // Reject direct access attempts without parameters
    if (!auth || !user) {
        return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
    }

    // Verify token validity
    if (validTokens.has(auth)) {
        const tokenData = validTokens.get(auth);

        if (tokenData.username === user && tokenData.expires > Date.now()) {
            // BURN TOKEN IMMEDIATELY so reloading or re-opening invalidates it
            validTokens.delete(auth);
            activeSessions.set(auth, user);
            console.log(`[AUTH] Token ${auth} consumed and burned for user ${user}`);

            return res.sendFile(path.join(__dirname, 'public', 'index.html'));
        }
    }

    // Fallback: Expired, invalid, or re-used token triggers 404
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Serve static assets (CSS, JS, images) AFTER root route verification
app.use(express.static(path.join(__dirname, 'public')));

// WebSocket Server Engine
wss.on('connection', (ws, req) => {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const username = urlParams.get('user');

    if (!username) {
        ws.close();
        return;
    }

    players.set(username, { ws, x: 0, y: 0, z: 0, world: 'dirtworld', status: 'unmuted' });
    console.log(`[VC] ${username} connected to voice channel.`);
    broadcastRoster();

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'status_change' && players.has(username)) {
                players.get(username).status = data.status;
                broadcastRoster();
            }

            // WebRTC Signaling Relay (Offers, Answers, ICE Candidates)
            if (data.target && players.has(data.target)) {
                players.get(data.target).ws.send(JSON.stringify({
                    sender: username,
                    type: data.type,
                    payload: data.payload
                }));
            }
        } catch (e) {
            console.error(`[WS Error] ${e.message}`);
        }
    });

    ws.onclose = () => {
        players.delete(username);
        console.log(`[VC] ${username} disconnected.`);
        broadcastRoster();
    };
});

function broadcastRoster() {
    const list = Array.from(players.entries()).map(([name, p]) => ({
        username: name,
        status: p.status
    }));
    
    const payload = JSON.stringify({ type: 'roster', players: list });
    players.forEach((p) => {
        if (p.ws.readyState === 1) p.ws.send(payload);
    });
}

// Telemetry endpoint for player position updates
app.post('/api/position', (req, res) => {
    const { username, world, x, y, z } = req.body;
    if (username && players.has(username)) {
        const p = players.get(username);
        p.x = x; p.y = y; p.z = z; p.world = world;
    }
    res.sendStatus(200);
});

// Start Server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Proximity VC Server online on port ${PORT}`));
