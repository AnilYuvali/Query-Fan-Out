require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, './')));

// Proxy endpoint for Gemini API
app.post('/api/analyze', async (req, res) => {
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: { message: 'GEMINI_API_KEY is not configured in .env' } });
    }

    // Validation: Check if payload is correct
    if (!req.body.contents || !Array.isArray(req.body.contents)) {
        return res.status(400).json({ error: { message: 'Invalid payload: "contents" must be an array.' } });
    }

    const firstPartText = req.body.contents[0]?.parts?.[0]?.text;
    if (!firstPartText || firstPartText.trim() === '') {
        return res.status(400).json({ error: { message: 'Invalid payload: "contents.parts" is empty or text is missing.' } });
    }

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        
        console.log('Forwarding request to Gemini API...');
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(req.body)
        });

        const data = await response.json();
        
        if (!response.ok) {
            console.error('Gemini API Error details:', JSON.stringify(data, null, 2));
            return res.status(response.status).json(data);
        }

        res.json(data);
    } catch (error) {
        console.error('Proxy Error:', error);
        res.status(500).json({ error: 'Failed to communicate with Gemini API', details: error.message });
    }
});

// Fallback to index.html for SPA behavior
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
    console.log(`API Key is ${GEMINI_API_KEY ? 'Configured' : 'MISSING'}`);
});
