const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Main Entry Point
app.get('/', (req, res) => {
    const token = req.query.auth;

    // Only allow access if an auth query string is present
    if (token) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        // Return 404 status and fake broken page to automated crawlers
        res.status(404).sendFile(path.join(__dirname, 'public', 'fake_404.html'));
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

