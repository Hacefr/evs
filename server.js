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

const validTokens = new Map();
const players = new Map(); // username -> { ws, x, y, z, world, status }

// Clean up expired tokens
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of validTokens.entries()) {
        if (data.expires < now) validTokens.delete(token);
    }
}, 60000);

// API Endpoint: Issue Auth Token
app.post('/api/auth/token', (req, res) => {
    const { username, secret } = req.body;
    if (secret !== ADMIN_SECRET) return res.status(403).json({ error: "Unauthorized" });
    if (!username) return res.status(400).json({ error: "Missing username" });

    const token = crypto.randomBytes(4).toString('hex');
    const expires = Date.now() + (10 * 60 * 1000);
    validTokens.set(token, { username, expires });

    const generatedUrl = `https://evs-7cx7.onrender.com/?auth=${token}&user=${username}`;
    console.log(`[AUTH] Token issued for ${username}`);
    return res.json({ token, url: generatedUrl });
});

// API Endpoint: Position Telemetry
app.post('/api/position', (req, res) => {
    const { username, world, x, y, z } = req.body;
    if (username && players.has(username)) {
        const p = players.get(username);
        p.x = x; p.y = y; p.z = z; p.world = world;
    }
    res.sendStatus(200);
});

// WebSocket Connection & Signaling
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
            
            // Status changes (mute/unmute)
            if (data.type === 'status_change') {
                if (players.has(username)) {
                    players.get(username).status = data.status;
                    broadcastRoster();
                }
            }

            // WebRTC Signaling relay (offer, answer, candidate)
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

    ws.on('close', () => {
        players.delete(username);
        console.log(`[VC] ${username} disconnected.`);
        broadcastRoster();
    });
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

// Web UI Root Route (Stealth Fallback vs Real UI)
app.get('/', (req, res) => {
    const { auth, user } = req.query;
    if (auth && validTokens.has(auth)) {
        const tokenData = validTokens.get(auth);
        if (tokenData.username === user && tokenData.expires > Date.now()) {
            return res.sendFile(path.join(__dirname, 'public', 'index.html'));
        }
    }
    // Stealth Apache 404 screen
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`VC Server running on port ${PORT}`));
