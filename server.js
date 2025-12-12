// server.js — FINAL VERCEL-COMPATIBLE VERSION (2025)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ——— DATABASE: Vercel KV (Redis) or fallback to memory ———
let store = { tokens: null, lastRefresh: 0 };

if (process.env.KV_REDIS_URL || process.env.KV_URL) {
  const { createClient } = require('redis');
  const client = createClient({
    url: process.env.KV_REDIS_URL || process.env.KV_URL
  });
  client.on('error', err => console.log('Redis Error:', err));

  (async () => {
    try {
      await client.connect();
      const data = await client.get('toiletbowl-db');
      if (data) store = JSON.parse(data);
      console.log('Loaded tokens from Vercel KV');
    } catch (err) {
      console.log('KV connect failed, using memory only');
    }
  })();

  global.saveStore = async () => {
    try {
      await client.set('toiletbowl-db', JSON.stringify(store));
    } catch (err) {
      console.log('Failed to save to KV');
    }
  };
} else {
  global.saveStore = async () => {}; // no-op locally
}

// ——— TOKEN HELPERS ———
async function getAccessToken() {
  const now = Date.now();
  if (store.tokens?.access_token && store.lastRefresh > now - 3500000) {
    return store.tokens.access_token;
  }
  const rt = store.tokens?.refresh_token;
  if (!rt) throw new Error("Not logged in");

  const auth = Buffer.from(`${process.env.YAHOO_CLIENT_ID}:${process.env.YAHOO_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post('https://api.login.yahoo.com/oauth2/get_token', new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: rt
  }), {
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  store.tokens = {
    access_token: res.data.access_token,
    refresh_token: res.data.refresh_token || rt
  };
  store.lastRefresh = now;
  await saveStore();
  return res.data.access_token;
}

// ——— ROUTES ———
const BASE_URL = process.env.VERCEL_URL 
  ? `https://${process.env.VERCEL_URL}`
  : (process.env.NGROK_URL || 'http://localhost:3000');

app.get('/login-popup', (req, res) => {
  const redirectUri = `${BASE_URL}/callback-popup`;
  const params = new URLSearchParams({
    client_id: process.env.YAHOO_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'fspt-r',
    state: 'toiletbowl2025'
  });
  const authUrl = `https://api.login.yahoo.com/oauth2/request_auth?${params}`;
  
  res.send(`<!DOCTYPE html>
<html><body style="margin:0;background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:80px">
  <h2>Connecting to Yahoo Fantasy...</h2>
  <p>Redirecting...</p>
  <script>setTimeout(()=>location="${authUrl}",800)</script>
</body></html>`);
});

app.get('/callback-popup', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) throw new Error("No code received");

    const auth = Buffer.from(`${process.env.YAHOO_CLIENT_ID}:${process.env.YAHOO_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await axios.post('https://api.login.yahoo.com/oauth2/get_token', new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${BASE_URL}/callback-popup`
    }), {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    store.tokens = {
      access_token: tokenRes.data.access_token,
      refresh_token: tokenRes.data.refresh_token
    };
    store.lastRefresh = Date.now();
    await saveStore();

    res.send('<script>if(opener) opener.loginSuccess(); else alert("Success!"); window.close();</script>');
  } catch (err) {
    console.error('Callback error:', err.message);
    res.send(`<script>if(opener) opener.loginFailed?.(); window.close();</script>`);
  }
});

app.get('/api/yahoo', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing url" });

  try {
    const token = await getAccessToken();
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    res.json(response.data);
  } catch (err) {
    console.error('Yahoo API error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

module.exports = app;
