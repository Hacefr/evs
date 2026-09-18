const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Environment Variables / Configurations
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "MY_SUPER_SECRET_KEY_123";

// In-Memory Storage
const activeTokens = new Map(); // token -> { username, createdAt }
const playerPositions = new Map(); // username -> { world, x, y, z, lastSeen }

// Helper function to generate single-use token
function generateOneTimeToken(username) {
    const token = crypto.randomBytes(16).toString('hex');
    activeTokens.set(token, {
        username: username,
        createdAt: Date.now()
    });
    return token;
}

// Clean up expired tokens (older than 5 minutes)
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of activeTokens.entries()) {
        if (now - data.createdAt > 5 * 60 * 1000) {
            activeTokens.delete(token);
        }
    }
}, 60000);

// --------------------------------------------------------------------
// API ENDPOINTS
// --------------------------------------------------------------------

// GET Endpoint: Native Skript compatible token generation
app.get('/api/auth/token', (req, res) => {
    const { username, secret } = req.query;

    if (!secret || secret !== ADMIN_SECRET) {
        return res.status(403).send("UNAUTHORIZED");
    }

    if (!username) {
        return res.status(400).send("MISSING_USERNAME");
    }

    const token = generateOneTimeToken(username);
    res.send(`https://evs-7cx7.onrender.com/connect.html?token=${token}`);
});

// POST Endpoint: Standard JSON token generation
app.post('/api/auth/token', (req, res) => {
    const { username, secret } = req.body;

    if (!secret || secret !== ADMIN_SECRET) {
        return res.status(403).json({ error: "Unauthorized" });
    }

    if (!username) {
        return res.status(400).json({ error: "Missing username parameter" });
    }

    const token = generateOneTimeToken(username);
    res.json({
        token: token,
        url: `https://evs-7cx7.onrender.com/connect.html?token=${token}`
    });
});

// POST Endpoint: Token Validation & Burning
app.post('/api/auth/validate', (req, res) => {
    const { token } = req.body;

    if (!token || !activeTokens.has(token)) {
        return res.status(401).json({ valid: false, error: "Invalid or expired token" });
    }

    const tokenData = activeTokens.get(token);
    
    // Burn token immediately after use
    activeTokens.delete(token);

    res.json({
        valid: true,
        username: tokenData.username
    });
});

// POST Endpoint: Position Telemetry from Minecraft
app.post('/api/position', (req, res) => {
    const { username, world, x, y, z } = req.body;

    if (!username) {
        return res.status(400).json({ error: "Missing username" });
    }

    const posData = {
        world: world || "world",
        x: parseFloat(x) || 0,
        y: parseFloat(y) || 0,
        z: parseFloat(z) || 0,
        lastSeen: Date.now()
    };

    playerPositions.set(username, posData);

    // Broadcast updated positions to connected WebRTC peers
    io.emit('position_update', {
        username: username,
        position: posData
    });

    res.json({ success: true });
});

// GET Endpoint: Fetch current player telemetry state
app.get('/api/positions', (req, res) => {
    const positionsObj = {};
    for (const [user, pos] of playerPositions.entries()) {
        positionsObj[user] = pos;
    }
    res.json(positionsObj);
});

// --------------------------------------------------------------------
// WEBRTC WEBSOCKET SIGNALING
// --------------------------------------------------------------------
io.on('connection', (socket) => {
    let authenticatedUser = null;

    socket.on('join_voice', (data) => {
        authenticatedUser = data.username;
        socket.join('voice_room');
        socket.to('voice_room').emit('peer_joined', { username: authenticatedUser, socketId: socket.id });
    });

    socket.on('signal', (data) => {
        io.to(data.targetSocketId).emit('signal', {
            senderSocketId: socket.id,
            senderUsername: authenticatedUser,
            signalData: data.signalData
        });
    });

    socket.on('disconnect', () => {
        if (authenticatedUser) {
            playerPositions.delete(authenticatedUser);
            io.to('voice_room').emit('peer_left', { username: authenticatedUser, socketId: socket.id });
        }
    });
});

server.listen(PORT, () => {
    console.log(`Proximity Voice Backend running on port ${PORT}`);
});
