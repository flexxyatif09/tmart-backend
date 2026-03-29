const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// ─────────────────────────────────────────
// FIREBASE ADMIN INIT (FCM ke liye)
// ─────────────────────────────────────────
const admin = require('firebase-admin');
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Supabase client — keys sirf yahan server pe hain
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// FCM Tokens in-memory store
const fcmTokens = [];

// ─────────────────────────────────────────
// TEST ROUTE
// ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ message: 'JNGMart Backend Chal Raha Hai ✅' });
});

// ─────────────────────────────────────────
// AUTH — SIGNUP
// ─────────────────────────────────────────
app.post('/auth/signup', async (req, res) => {
  const { full_name, email, password, phone } = req.body;

  if (!email || !password || !full_name) {
    return res.status(400).json({ error: 'Naam, email aur password zaroori hai' });
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });

  if (error) return res.status(400).json({ error: error.message });

  const { error: profileError } = await supabase.from('profiles').upsert({
    id: data.user.id,
    full_name,
    phone: phone || ''
  }, { onConflict: 'id' });

  if (profileError) {
    console.error('Profile insert error:', profileError.message);
  }

  res.json({ message: 'Account ban gaya!', user_id: data.user.id });
});

// ─────────────────────────────────────────
// AUTH — LOGIN
// ─────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email aur password daalo' });
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) return res.status(401).json({ error: 'Galat email ya password' });

  res.json({
    message: 'Login ho gaya!',
    token: data.session.access_token,
    user: {
      id: data.user.id,
      email: data.user.email
    }
  });
});

// ─────────────────────────────────────────
// MIDDLEWARE — TOKEN CHECK
// ─────────────────────────────────────────
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Login zaroori hai' });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid token' });

  req.user = data.user;
  next();
}

// ─────────────────────────────────────────
// AUTH — GET PROFILE
// ─────────────────────────────────────────
app.get('/auth/me', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('full_name, phone, photo_url')
    .eq('id', req.user.id)
    .single();

  if (error) return res.status(404).json({ error: 'Profile nahi mila' });

  res.json({
    id: req.user.id,
    email: req.user.email,
    full_name: data.full_name || '',
    phone: data.phone || '',
    photo_url: data.photo_url || null
  });
});

// ─────────────────────────────────────────
// AUTH — PROFILE PHOTO UPDATE
// ─────────────────────────────────────────
app.post('/auth/update-photo', authMiddleware, async (req, res) => {
  const { photo_base64 } = req.body;

  if (!photo_base64) return res.status(400).json({ error: 'Photo data nahi mila' });

  try {
    const base64Data = photo_base64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const match = photo_base64.match(/^data:image\/(\w+);base64,/);
    const ext = match ? match[1] : 'jpg';
    const fileName = `avatars/${req.user.id}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('profiles')
      .upload(fileName, buffer, {
        contentType: `image/${ext}`,
        upsert: true
      });

    if (uploadError) return res.status(500).json({ error: uploadError.message });

    const { data: urlData } = supabase.storage
      .from('profiles')
      .getPublicUrl(fileName);

    const photo_url = urlData.publicUrl;

    const { error: updateError } = await supabase
      .from('profiles')
      .update({ photo_url })
      .eq('id', req.user.id);

    if (updateError) {
      return res.status(500).json({ error: 'DB update failed: ' + updateError.message });
    }

    res.json({ message: 'Photo update ho gayi!', photo_url });
  } catch (e) {
    res.status(500).json({ error: 'Photo upload failed: ' + e.message });
  }
});

// ─────────────────────────────────────────
// PRODUCTS — SABHI PRODUCTS
// ─────────────────────────────────────────
app.get('/products', async (req, res) => {
  const { category } = req.query;

  let query = supabase.from('products').select('*').eq('in_stock', true);
  if (category && category !== 'all') query = query.eq('category', category);

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  res.json(data);
});

// ─────────────────────────────────────────
// PRODUCTS — SINGLE PRODUCT
// ─────────────────────────────────────────
app.get('/products/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ error: 'Product nahi mila' });
  res.json(data);
});

// ─────────────────────────────────────────
// PRODUCTS — SEARCH
// ─────────────────────────────────────────
app.get('/products/search/:query', async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .ilike('name', `%${req.params.query}%`)
    .eq('in_stock', true);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─────────────────────────────────────────
// ORDERS — ORDER PLACE KARO
// ─────────────────────────────────────────
app.post('/orders/place', authMiddleware, async (req, res) => {
  const { items, total_amount, address } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'Cart khali hai' });
  }

  const advance = parseFloat((total_amount * 0.10).toFixed(2));
  const remaining = parseFloat((total_amount - advance).toFixed(2));
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .insert({
      user_id: req.user.id,
      total_amount,
      advance_amount: advance,
      remaining_amount: remaining,
      otp_code: otp,
      payment_status: 'pending',
      order_status: 'placed'
    })
    .select()
    .single();

  if (orderError) return res.status(500).json({ error: orderError.message });

  const orderItems = items.map(item => ({
    order_id: order.id,
    product_id: item.product_id,
    quantity: item.quantity,
    price: item.price
  }));

  await supabase.from('order_items').insert(orderItems);

  // ── Order place hone pe user ko notification bhejo ──
  try {
    const userTokens = fcmTokens.filter(t => t.userId === req.user.id);
    if (userTokens.length > 0) {
      await admin.messaging().sendEachForMulticast({
        notification: {
          title: '🛒 Order Place Ho Gaya!',
          body: `Order #${order.id.slice(0,6).toUpperCase()} confirm hai. Ab advance pay karo.`,
        },
        data: { type: 'order' },
        android: { notification: { sound: 'default', channelId: 'jngmart_channel' } },
        tokens: userTokens.map(t => t.token),
      });
    }
  } catch (fcmErr) {
    console.error('Order notification error:', fcmErr.message);
  }

  res.json({
    message: 'Order ban gaya! Ab advance pay karo.',
    order_id: order.id,
    advance_amount: advance,
    remaining_amount: remaining,
    otp_code: otp
  });
});

// ─────────────────────────────────────────
// ORDERS — OTP VERIFY KARO
// ─────────────────────────────────────────
app.post('/orders/verify-otp', authMiddleware, async (req, res) => {
  const { order_id, otp_entered } = req.body;

  const { data: order, error } = await supabase
    .from('orders')
    .select('otp_code, otp_verified, user_id')
    .eq('id', order_id)
    .single();

  if (error || !order) return res.status(404).json({ error: 'Order nahi mila' });

  if (order.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Yeh tumhara order nahi hai' });
  }

  if (order.otp_verified) {
    return res.status(400).json({ error: 'OTP pehle se verify ho chuka hai' });
  }

  if (order.otp_code !== otp_entered) {
    return res.status(400).json({ error: 'Galat OTP! Dobara try karo.' });
  }

  await supabase
    .from('orders')
    .update({
      otp_verified: true,
      payment_status: 'advance_paid',
      order_status: 'confirmed'
    })
    .eq('id', order_id);

  // ── OTP verify hone pe delivery notification ──
  try {
    const userTokens = fcmTokens.filter(t => t.userId === req.user.id);
    if (userTokens.length > 0) {
      await admin.messaging().sendEachForMulticast({
        notification: {
          title: '✅ Order Confirmed!',
          body: 'Payment confirm ho gayi. Aapka order taiyar ho raha hai!',
        },
        data: { type: 'order' },
        android: { notification: { sound: 'default', channelId: 'jngmart_channel' } },
        tokens: userTokens.map(t => t.token),
      });
    }
  } catch (fcmErr) {
    console.error('OTP notification error:', fcmErr.message);
  }

  res.json({ message: '🎉 Order Confirm Ho Gaya!' });
});

// ─────────────────────────────────────────
// ORDERS — USER KE SAARE ORDERS
// ─────────────────────────────────────────
app.get('/orders', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('orders')
    .select(`*, order_items(*, products(name, image_url))`)
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─────────────────────────────────────────
// ORDERS — SINGLE ORDER DETAIL
// ─────────────────────────────────────────
app.get('/orders/:id', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('orders')
    .select(`*, order_items(*, products(name, image_url, price))`)
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single();

  if (error) return res.status(404).json({ error: 'Order nahi mila' });
  res.json(data);
});

// ─────────────────────────────────────────
// ADMIN — PENDING PAYMENTS DEKHO
// ─────────────────────────────────────────
app.get('/admin/pending-orders', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Admin access nahi hai' });
  }

  const { data, error } = await supabase
    .from('orders')
    .select(`*, profiles(full_name, phone)`)
    .eq('payment_status', 'pending')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─────────────────────────────────────────
// ADDRESSES — LIST
// ─────────────────────────────────────────
app.get('/addresses', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('addresses')
    .select('*')
    .eq('user_id', req.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─────────────────────────────────────────
// ADDRESSES — ADD NEW
// ─────────────────────────────────────────
app.post('/addresses', authMiddleware, async (req, res) => {
  const { label, full_address, phone } = req.body;

  const { data, error } = await supabase
    .from('addresses')
    .insert({ user_id: req.user.id, label, full_address, phone })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─────────────────────────────────────────
// WISHLIST — TOGGLE
// ─────────────────────────────────────────
app.post('/wishlist/toggle', authMiddleware, async (req, res) => {
  const { product_id } = req.body;

  const { data: existing } = await supabase
    .from('wishlist')
    .select('id')
    .eq('user_id', req.user.id)
    .eq('product_id', product_id)
    .single();

  if (existing) {
    await supabase.from('wishlist').delete().eq('id', existing.id);
    return res.json({ message: 'Wishlist se hata diya', wishlisted: false });
  } else {
    await supabase.from('wishlist').insert({
      user_id: req.user.id,
      product_id
    });
    return res.json({ message: 'Wishlist mein add hua', wishlisted: true });
  }
});

// ═════════════════════════════════════════
// FCM — DEVICE TOKEN SAVE KARO
// App se aayega — user ke device ka token
// POST /api/fcm-token
// Body: { token, userId }
// ═════════════════════════════════════════
app.post('/api/fcm-token', async (req, res) => {
  try {
    const { token, userId } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required hai' });

    const exists = fcmTokens.find(t => t.token === token);
    if (!exists) {
      fcmTokens.push({ token, userId: userId || 'guest', createdAt: Date.now() });
      console.log(`FCM Token saved. Total devices: ${fcmTokens.length}`);
    }

    res.json({ success: true, message: 'Token save ho gaya' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════
// FCM — SABKO NOTIFICATION BHEJO
// Admin panel se call hoga
// POST /api/send-notification
// Body: { title, body, type, imageUrl }
// ═════════════════════════════════════════
app.post('/api/send-notification', async (req, res) => {
  // Admin key check
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Admin access nahi hai' });
  }

  try {
    const { title, body, type = 'general', imageUrl, targetUserId } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'Title aur body required hai' });
    }

    let targets = fcmTokens;
    if (targetUserId) {
      targets = fcmTokens.filter(t => t.userId === targetUserId);
    }

    if (targets.length === 0) {
      return res.json({ success: true, sent: 0, message: 'Koi registered device nahi' });
    }

    const tokenList = targets.map(t => t.token);

    const message = {
      notification: {
        title,
        body,
        ...(imageUrl && { imageUrl }),
      },
      data: { type },
      android: {
        notification: {
          sound: 'default',
          priority: 'high',
          channelId: 'jngmart_channel',
        },
      },
      tokens: tokenList,
    };

    const response = await admin.messaging().sendEachForMulticast(message);

    // Failed tokens hata do
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const failedToken = tokenList[idx];
        const i = fcmTokens.findIndex(t => t.token === failedToken);
        if (i !== -1) fcmTokens.splice(i, 1);
      }
    });

    res.json({
      success: true,
      sent: response.successCount,
      failed: response.failureCount,
      total: tokenList.length,
    });

  } catch (err) {
    console.error('FCM Send Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════
// FCM — TOPIC NOTIFICATION (sabko ek saath)
// POST /api/send-topic-notification
// Body: { title, body, topic }
// ═════════════════════════════════════════
app.post('/api/send-topic-notification', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Admin access nahi hai' });
  }

  try {
    const { title, body, topic = 'all_users', imageUrl } = req.body;

    const message = {
      notification: { title, body, ...(imageUrl && { imageUrl }) },
      data: { type: 'broadcast' },
      android: {
        notification: { sound: 'default', priority: 'high', channelId: 'jngmart_channel' },
      },
      topic,
    };

    const response = await admin.messaging().send(message);
    res.json({ success: true, messageId: response });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════
// FCM — REGISTERED DEVICES COUNT
// GET /api/fcm-tokens
// ═════════════════════════════════════════
app.get('/api/fcm-tokens', async (req, res) => {
  res.json({ count: fcmTokens.length });
});

// ─────────────────────────────────────────
// SERVER START
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`JNGMart Backend Port ${PORT} pe chal raha hai ✅`);
});
