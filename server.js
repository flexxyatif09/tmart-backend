const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Supabase client — keys sirf yahan server pe hain
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// ─────────────────────────────────────────
// TEST ROUTE
// ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ message: 'Tmart Backend Chal Raha Hai ✅' });
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

  // Profile save karo
  await supabase.from('profiles').insert({
    id: data.user.id,
    full_name,
    phone: phone || ''
  });

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
// AUTH — GET PROFILE (full_name + photo)
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
// AUTH — PROFILE PHOTO UPDATE (Supabase Storage)
// ─────────────────────────────────────────
app.post('/auth/update-photo', authMiddleware, async (req, res) => {
  const { photo_base64 } = req.body;

  if (!photo_base64) return res.status(400).json({ error: 'Photo data nahi mila' });

  try {
    // Base64 se Buffer banao
    const base64Data = photo_base64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    // Extension detect karo
    const match = photo_base64.match(/^data:image\/(\w+);base64,/);
    const ext = match ? match[1] : 'jpg';
    const fileName = `avatars/${req.user.id}.${ext}`;

    // Supabase Storage mein upload karo (bucket: 'profiles')
    const { error: uploadError } = await supabase.storage
      .from('profiles')
      .upload(fileName, buffer, {
        contentType: `image/${ext}`,
        upsert: true  // Purani photo replace ho jayegi
      });

    if (uploadError) return res.status(500).json({ error: uploadError.message });

    // Public URL lo
    const { data: urlData } = supabase.storage
      .from('profiles')
      .getPublicUrl(fileName);

    const photo_url = urlData.publicUrl;

    // Profiles table mein save karo
    await supabase
      .from('profiles')
      .update({ photo_url })
      .eq('id', req.user.id);

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

  // 10% advance calculate karo
  const advance = parseFloat((total_amount * 0.10).toFixed(2));
  const remaining = parseFloat((total_amount - advance).toFixed(2));

  // 6 digit OTP generate karo
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  // Order banao
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

  // Order items save karo
  const orderItems = items.map(item => ({
    order_id: order.id,
    product_id: item.product_id,
    quantity: item.quantity,
    price: item.price
  }));

  await supabase.from('order_items').insert(orderItems);

  res.json({
    message: 'Order ban gaya! Ab advance pay karo.',
    order_id: order.id,
    advance_amount: advance,
    remaining_amount: remaining,
    otp_code: otp  // Real app mein yeh mat bhejo — admin ko dikhao
  });
});

// ─────────────────────────────────────────
// ORDERS — OTP VERIFY KARO
// ─────────────────────────────────────────
app.post('/orders/verify-otp', authMiddleware, async (req, res) => {
  const { order_id, otp_entered } = req.body;

  // DB se order lo
  const { data: order, error } = await supabase
    .from('orders')
    .select('otp_code, otp_verified, user_id')
    .eq('id', order_id)
    .single();

  if (error || !order) return res.status(404).json({ error: 'Order nahi mila' });

  // Sirf apna order verify kare
  if (order.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Yeh tumhara order nahi hai' });
  }

  if (order.otp_verified) {
    return res.status(400).json({ error: 'OTP pehle se verify ho chuka hai' });
  }

  if (order.otp_code !== otp_entered) {
    return res.status(400).json({ error: 'Galat OTP! Dobara try karo.' });
  }

  // OTP sahi — order confirm karo
  await supabase
    .from('orders')
    .update({
      otp_verified: true,
      payment_status: 'advance_paid',
      order_status: 'confirmed'
    })
    .eq('id', order_id);

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

  // Check karo already hai ya nahi
  const { data: existing } = await supabase
    .from('wishlist')
    .select('id')
    .eq('user_id', req.user.id)
    .eq('product_id', product_id)
    .single();

  if (existing) {
    // Remove karo
    await supabase.from('wishlist').delete().eq('id', existing.id);
    return res.json({ message: 'Wishlist se hata diya', wishlisted: false });
  } else {
    // Add karo
    await supabase.from('wishlist').insert({
      user_id: req.user.id,
      product_id
    });
    return res.json({ message: 'Wishlist mein add hua', wishlisted: true });
  }
});

// ─────────────────────────────────────────
// SERVER START
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tmart Backend Port ${PORT} pe chal raha hai ✅`);
});
