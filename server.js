// server.js — BULLETPROOF VERSION WITH LOGGING
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app = express();
const PORT = 3001;

// Manual override — REPLACE WITH YOUR CURRENT NGROK HTTPS URL
const MANUAL_NGROK_URL = 'https://brodie-unremanded-tereasa.ngrok-free.dev'; // ← PUT YOUR REAL ONE HERE!

let NGROK_URL = MANUAL_NGROK_URL || 'http://localhost:3001';

async function detectNgrok() {
  try {
    console.log('Detecting ngrok...');
    const res = await axios.get('http://localhost:4040/api/tunnels', { timeout: 5000 });
    const tunnel = res.data.tunnels.find(t => t.proto === 'https');
    if (tunnel) {
      NGROK_URL = tunnel.public_url;
      console.log(`✓ ngrok detected: ${NGROK_URL}`);
    } else {
      console.log('No HTTPS ngrok tunnel found — using manual URL');
    }
  } catch (err) {
    console.log('ngrok detection failed (not running?):', err.message);
    console.log(`Using manual URL: ${NGROK_URL}`);
    if (NGROK_URL.includes('localhost')) {
      console.log('WARNING: Localhost will cause "invalid redirect uri" — run "ngrok http 3001" and update MANUAL_NGROK_URL');
    }
  }
}

let adapter;

if (process.env.KV_REDIS_URL) {
  const { createClient } = require('redis');
  const client = createClient({
    url: process.env.KV_REDIS_URL || process.env.KV_URL
  });

  client.on('error', err => console.log('Redis Client Error', err));

  // Connect once at startup
  (async () => {
    await client.connect();
  })();

  adapter = {
    read: async () => {
      const data = await client.get('toiletbowl-db');
      return data ? JSON.parse(data) : { tokens: null, lastRefresh: 0 };
    },
    write: async (data) => {
      await client.set('toiletbowl-db', JSON.stringify(data));
    }
  };
} else {
  const FileSync = require('lowdb/adapters/FileSync');
  adapter = new FileSync('db.json');
}

const db = low(adapter);
db.defaults({ tokens: null, lastRefresh: 0 }).write();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function ensureValidToken() {
  const now = Date.now();
  if (db.get('tokens.access_token').value() && db.get('lastRefresh').value() > now - 3500000) {
    return db.get('tokens.access_token').value();
  }
  const rt = db.get('tokens.refresh_token').value();
  if (!rt) throw new Error("Not connected");

  const auth = Buffer.from(`${process.env.YAHOO_CLIENT_ID}:${process.env.YAHOO_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post('https://api.login.yahoo.com/oauth2/get_token', new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: rt
  }), { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' } });

  db.set('tokens', { access_token: res.data.access_token, refresh_token: res.data.refresh_token || rt })
    .set('lastRefresh', now).write();
  return res.data.access_token;
}

// POPUP LOGIN — with error handling
app.get('/login-popup', (req, res) => {
  try {
    const redirectUri = `${NGROK_URL}/callback-popup`;
    const params = new URLSearchParams({
      client_id: process.env.YAHOO_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'fspt-r',
      state: 'toiletbowl2025'
    });
    const authUrl = `https://api.login.yahoo.com/oauth2/request_auth?${params.toString()}`;
    
    console.log('Generated Auth URL:', authUrl); // ← Check this!
    console.log('Redirect URI used:', redirectUri); // ← Verify this matches Yahoo app

    res.send(`<!DOCTYPE html>
<html><body style="margin:0;background:#111;color:#fff;font-family:Arial;text-align:center;padding:60px">
  <h2>Connecting to Yahoo...</h2>
  <p>Redirecting in 1 second...</p>
  <script>setTimeout(() => location.href = "${authUrl}", 1000);</script>
</body></html>`);
  } catch (err) {
    console.error('CRASH in /login-popup:', err); // ← This will show the exact error!
    res.status(500).send(`Error: ${err.message}`);
  }
});

// CALLBACK
app.get('/callback-popup', async (req, res) => {
  try {
    const code = req.query.code;
    console.log('Callback received:', req.query); // ← Logs the full query (code, errors, etc.)
    if (!code) {
      console.log('No code in callback — possible denial or error');
      return res.send('<script>if(opener) opener.loginFailed("Login denied or cancelled"); window.close();</script>');
    }

    const auth = Buffer.from(`${process.env.YAHOO_CLIENT_ID}:${process.env.YAHOO_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await axios.post('https://api.login.yahoo.com/oauth2/get_token', new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${NGROK_URL}/callback-popup`
    }), { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' } });

    db.set('tokens', { access_token: tokenRes.data.access_token, refresh_token: tokenRes.data.refresh_token })
      .set('lastRefresh', Date.now()).write();
    console.log('Tokens saved successfully');

    res.send('<script>if(opener) opener.loginSuccess(); window.close();</script><p>Success! Closing...</p>');
  } catch (err) {
    console.error('Error in /callback-popup:', err.response?.data || err.message);
    res.send(`<script>if(opener) opener.loginFailed("Token exchange failed: ${err.message}"); window.close();</script>`);
  }
});

app.get('/api/yahoo', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing url" });

  try {
    const token = await ensureValidToken();
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    res.json(response.data);
  } catch (err) {
    console.error("Yahoo API ERROR:", err.response?.status, err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.redirect('/toiletbowl.html'));

// Start server
(async () => {
  await detectNgrok();
  app.listen(PORT, () => {
    console.log(`\nServer running on port ${PORT}`);
    console.log(`NGROK URL: ${NGROK_URL}`);
    console.log(`OPEN THIS: ${NGROK_URL}/toiletbowl.html`);
    console.log('Yahoo App Redirect URI must match: ' + NGROK_URL + '/callback-popup');
    if (NGROK_URL.includes('localhost')) {
      console.log('🚨 CRITICAL: Update MANUAL_NGROK_URL with your ngrok HTTPS URL!');
    }
  });
})();
