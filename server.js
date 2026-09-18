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

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "MY_SUPER_SECRET_KEY_123";

const activeTokens = new Map(); // token -> { username, createdAt }
const playerPositions = new Map(); // username -> { world, x, y, z, lastSeen }

function generateOneTimeToken(username) {
    const token = crypto.randomBytes(16).toString('hex');
    activeTokens.set(token, {
        username: username,
        createdAt: Date.now()
    });
    return token;
}

// Clean up tokens older than 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of activeTokens.entries()) {
        if (now - data.createdAt > 5 * 60 * 1000) {
            activeTokens.delete(token);
        }
    }
}, 60000);

// Serve frontend route
app.get('/connect', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'connect.html'));
});

// GET Endpoint for native Skript URL fetching
app.get('/api/auth/token', (req, res) => {
    const { username, secret } = req.query;

    if (!secret || secret !== ADMIN_SECRET) {
        return res.status(403).send("UNAUTHORIZED");
    }

    if (!username) {
        return res.status(400).send("MISSING_USERNAME");
    }

    const token = generateOneTimeToken(username);
    res.send(`https://evs-7cx7.onrender.com/connect?token=${token}`);
});

// POST Endpoint for position telemetry via Skript
app.get('/api/position', (req, res) => {
    const { username, world, x, y, z } = req.query;

    if (!username) {
        return res.status(400).send("MISSING_USERNAME");
    }

    const posData = {
        world: world || "world",
        x: parseFloat(x) || 0,
        y: parseFloat(y) || 0,
        z: parseFloat(z) || 0,
        lastSeen: Date.now()
    };

    playerPositions.set(username, posData);

    io.emit('position_update', {
        username: username,
        position: posData
    });

    res.send("OK");
});

// Validate & Burn Token via Frontend API call
app.post('/api/auth/validate', (req, res) => {
    const { token } = req.body;

    if (!token || !activeTokens.has(token)) {
        return res.status(401).json({ valid: false, error: "Invalid or expired token" });
    }

    const tokenData = activeTokens.get(token);
    activeTokens.delete(token); // Single-use burn

    res.json({
        valid: true,
        username: tokenData.username
    });
});

// Middleware: Authenticate Socket Connection
io.use((socket, next) => {
    const username = socket.handshake.auth.username;
    if (!username) {
        return next(new Error("Authentication failed: Missing username"));
    }
    socket.username = username;
    next();
});

io.on('connection', (socket) => {
    socket.join('voice_room');
    socket.to('voice_room').emit('peer_joined', { username: socket.username, socketId: socket.id });

    socket.on('signal', (data) => {
        io.to(data.targetSocketId).emit('signal', {
            senderSocketId: socket.id,
            senderUsername: socket.username,
            signalData: data.signalData
        });
    });

    socket.on('disconnect', () => {
        playerPositions.delete(socket.username);
        io.to('voice_room').emit('peer_left', { username: socket.username, socketId: socket.id });
    });
});

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
