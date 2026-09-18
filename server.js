const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_SECRET = process.env.ADMIN_SECRET || "MY_SUPER_SECRET_KEY_123";

// Map: token -> { username, expires }
const validTokens = new Map();
const activeSessions = new Map(); // token -> username
const players = new Map(); // username -> { ws, x, y, z, world, status }

// Clean expired tokens automatically
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of validTokens.entries()) {
        if (data.expires < now) validTokens.delete(token);
    }
}, 60000);

// API: Skript requests a single-use token
app.post('/api/auth/token', (req, res) => {
    const { username, secret } = req.body;
    if (secret !== ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized" });
    if (!username) return res.status(400).json({ error: "Missing username" });

    const token = crypto.randomBytes(8).toString('hex');
    const expires = Date.now() + (5 * 60 * 1000); // 5 minute link expiration window
    validTokens.set(token, { username, expires });

    const generatedUrl = `https://evs-7cx7.onrender.com/?auth=${token}&user=${encodeURIComponent(username)}`;
    console.log(`[AUTH] Issued single-use token for ${username}`);
    return res.json({ token, url: generatedUrl });
});

// Serve UI ONLY with a valid token
app.get('/', (req, res) => {
    const { auth, user } = req.query;

    if (auth && validTokens.has(auth)) {
        const tokenData = validTokens.get(auth);

        if (tokenData.username === user && tokenData.expires > Date.now()) {
            // BURN TOKEN IMMEDIATELY so page reload fails
            validTokens.delete(auth);
            activeSessions.set(auth, user);
            console.log(`[AUTH] Token ${auth} used and burned for user ${user}`);

            return res.sendFile(path.join(__dirname, 'public', 'index.html'));
        }
    }

    // Stealth 404 for missing or reused tokens
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// WebSocket Connection
wss.on('connection', (ws, req) => {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const username = urlParams.get('user');

    if (!username) {
        ws.close();
        return;
    }

    players.set(username, { ws, x: 0, y: 0, z: 0, world: 'dirtworld', status: 'unmuted' });
    console.log(`[VC] ${username} connected via WebSocket.`);
    broadcastRoster();

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'status_change' && players.has(username)) {
                players.get(username).status = data.status;
                broadcastRoster();
            }

            if (data.target && players.has(data.target)) {
                players.get(data.target).ws.send(JSON.stringify({
                    sender: username,
                    type: data.type,
                    payload: data.payload
                }));
            }
        } catch (e) {
            console.error(e);
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

// Telemetry
app.post('/api/position', (req, res) => {
    const { username, world, x, y, z } = req.body;
    if (username && players.has(username)) {
        const p = players.get(username);
        p.x = x; p.y = y; p.z = z; p.world = world;
    }
    res.sendStatus(200);
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`VC Server running on port ${PORT}`));
