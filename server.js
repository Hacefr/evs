const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.json());

// Enable automatic extension resolution so /connect routes directly to public/connect.html
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ==========================================
// CONFIGURATION OPTIONS
// ==========================================
const ENABLE_PRIVATE_CALLS = true; // Set to false to disable private calls globally

// Store active voice tokens: token -> { username, expires }
const activeTokens = new Map();

// ==========================================
// REST API ENDPOINTS
// ==========================================

// Endpoint for Minecraft plugin / HTTP request to generate a token
app.post('/api/auth/token', (req, res) => {
    const { username, secret } = req.body;
    
    // Simple shared secret check
    if (secret !== process.env.VOICE_SECRET && secret !== 'MY_SUPER_SECRET_KEY_123') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    if (!username) {
        return res.status(400).json({ error: 'Username required' });
    }

    const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
    activeTokens.set(token, {
        username: username,
        expires: Date.now() + (1000 * 60 * 15) // 15-minute expiration
    });

    res.json({ token: token });
});

// Endpoint for connect.html to validate token
app.post('/api/auth/validate', (req, res) => {
    const { token } = req.body;
    const tokenData = activeTokens.get(token);

    if (!tokenData) {
        return res.json({ valid: false, error: 'Invalid token' });
    }

    if (Date.now() > tokenData.expires) {
        activeTokens.delete(token);
        return res.json({ valid: false, error: 'Token expired' });
    }

    res.json({ valid: true, username: tokenData.username });
});

// ==========================================
// SOCKET.IO REAL-TIME SIGNALING
// ==========================================

// socket.id -> { username, inPrivateCall }
const connectedUsers = new Map();

io.on('connection', (socket) => {
    const username = socket.handshake.auth.username || 'Anonymous';
    
    connectedUsers.set(socket.id, {
        username: username,
        inPrivateCall: false
    });

    console.log(`User connected: ${username} (${socket.id})`);

    // Send global config state to the new client
    socket.emit('config_state', { privateCallsEnabled: ENABLE_PRIVATE_CALLS });

    // Send existing peers to the newly connected user
    const peerList = [];
    connectedUsers.forEach((data, id) => {
        if (id !== socket.id) {
            peerList.push({
                socketId: id,
                username: data.username,
                inPrivateCall: data.inPrivateCall
            });
        }
    });
    socket.emit('all_peers', peerList);

    // Broadcast new user to all other connected clients
    socket.broadcast.emit('peer_joined', {
        socketId: socket.id,
        username: username
    });

    // WebRTC Signaling Forwarder (Offers, Answers, ICE Candidates)
    socket.on('signal', ({ targetSocketId, signalData }) => {
        io.to(targetSocketId).emit('signal', {
            senderSocketId: socket.id,
            senderUsername: username,
            signalData: signalData
        });
    });

    // ------------------------------------------
    // PRIVATE CALL SYSTEM
    // ------------------------------------------

    socket.on('request_private_call', ({ targetSocketId }) => {
        if (!ENABLE_PRIVATE_CALLS) {
            socket.emit('call_error', { message: 'Private calls are currently disabled.' });
            return;
        }

        io.to(targetSocketId).emit('call_invite', {
            senderSocketId: socket.id,
            senderUsername: username
        });
    });

    socket.on('accept_private_call', ({ targetSocketId }) => {
        if (!ENABLE_PRIVATE_CALLS) return;

        // Update call status state
        if (connectedUsers.has(socket.id)) connectedUsers.get(socket.id).inPrivateCall = true;
        if (connectedUsers.has(targetSocketId)) connectedUsers.get(targetSocketId).inPrivateCall = true;

        // Notify caller that invite was accepted
        io.to(targetSocketId).emit('call_accepted', { targetSocketId: socket.id });

        // Broadcast updated status badge to all connected clients
        io.emit('player_status_change', { socketId: socket.id, inPrivateCall: true });
        io.emit('player_status_change', { socketId: targetSocketId, inPrivateCall: true });
    });

    socket.on('decline_private_call', ({ targetSocketId }) => {
        io.to(targetSocketId).emit('call_declined', { targetSocketId: socket.id });
    });

    socket.on('end_private_call', ({ targetSocketId }) => {
        // Clear call status state
        if (connectedUsers.has(socket.id)) connectedUsers.get(socket.id).inPrivateCall = false;
        if (connectedUsers.has(targetSocketId)) connectedUsers.get(targetSocketId).inPrivateCall = false;

        // Notify private partner that call ended
        io.to(targetSocketId).emit('private_call_ended', { socketId: socket.id });

        // Broadcast updated status badge to all connected clients
        io.emit('player_status_change', { socketId: socket.id, inPrivateCall: false });
        io.emit('player_status_change', { socketId: targetSocketId, inPrivateCall: false });
    });

    // ------------------------------------------
    // DISCONNECT HANDLER
    // ------------------------------------------
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${username} (${socket.id})`);
        connectedUsers.delete(socket.id);
        
        io.emit('peer_left', { socketId: socket.id });
    });
});

// Periodic token cleanup every 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of activeTokens.entries()) {
        if (now > data.expires) {
            activeTokens.delete(token);
        }
    }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Voice server running on port ${PORT}`);
});
