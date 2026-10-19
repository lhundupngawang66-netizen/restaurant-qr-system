import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(__dirname));

// ---------- MONGODB MODELS ----------
const MenuSchema = new mongoose.Schema({ restaurantId: String, categories: Array, dishes: Array });
const Menu = mongoose.model('Menu', MenuSchema);

const ConfigSchema = new mongoose.Schema({ restaurantId: String, data: Object });
const Config = mongoose.model('Config', ConfigSchema);

const OrderSchema = new mongoose.Schema({ restaurantId: String, data: Object });
const Order = mongoose.model('Order', OrderSchema);

const SubscriberSchema = new mongoose.Schema({ restaurantId: String, name: String, email: String, points: Number, date: Date });
const Subscriber = mongoose.model('Subscriber', SubscriberSchema);

// ---------- HELPERS ----------
function getRestaurantId(req) {
  return req.headers['x-restaurant'] || 'everest';
}

async function getConfig(id) {
  const c = await Config.findOne({ restaurantId: id });
  return c ? c.data : null;
}

// ---------- PUBLIC API ----------
app.get('/api/config', async (req, res) => {
  const id = getRestaurantId(req);
  const config = await getConfig(id);
  if (!config) return res.status(404).json({ error: 'Restaurant not found' });
  const { adminPassword, superAdminPassword, ...safe } = config;
  res.json(safe);
});

app.get('/api/menu', async (req, res) => {
  const id = getRestaurantId(req);
  const menu = await Menu.findOne({ restaurantId: id });
  res.json(menu ? { categories: menu.categories, dishes: menu.dishes } : { categories: [], dishes: [] });
});

app.post('/api/orders', async (req, res) => {
  const id = getRestaurantId(req);
  const orderData = { ...req.body, id: Date.now(), createdAt: new Date().toISOString(), status: 'new' };
  await Order.create({ restaurantId: id, data: orderData });
  res.json({ ok: true, orderId: orderData.id });
});

app.get('/api/orders/:id', async (req, res) => {
  const id = getRestaurantId(req);
  const orderId = Number(req.params.id);
  const order = await Order.findOne({ restaurantId: id, 'data.id': orderId });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order.data);
});

app.post('/api/subscribe', async (req, res) => {
  const id = getRestaurantId(req);
  const { name, email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const existing = await Subscriber.findOne({ restaurantId: id, email });
  if (existing) return res.json({ ok: true, message: 'Already subscribed' });
  await Subscriber.create({ restaurantId: id, name: name || 'Anonymous', email, points: 0, date: new Date() });
  res.json({ ok: true, message: 'Subscribed!' });
});

app.get('/api/settings', async (req, res) => {
  const id = getRestaurantId(req);
  const config = await getConfig(id);
  res.json({ payLaterEnabled: config?.payLaterEnabled !== false });
});

// ---------- ADMIN API ----------
async function requireAdmin(req, res, next) {
  const id = getRestaurantId(req);
  const config = await getConfig(id);
  if (!config) return res.status(404).json({ error: 'Restaurant not found' });
  if (config.accessOverride?.enabled !== true && config.subscription?.status !== 'active') {
    return res.status(403).json({ error: 'Subscription expired.' });
  }
  if (req.headers['x-admin-password'] !== config.adminPassword) return res.status(401).json({ error: 'Invalid password' });
  next();
}

app.get('/api/admin/menu', requireAdmin, async (req, res) => {
  const id = getRestaurantId(req);
  const menu = await Menu.findOne({ restaurantId: id });
  res.json(menu ? { categories: menu.categories, dishes: menu.dishes } : { categories: [], dishes: [] });
});

app.post('/api/admin/menu', requireAdmin, async (req, res) => {
  const id = getRestaurantId(req);
  await Menu.findOneAndUpdate({ restaurantId: id }, { categories: req.body.categories, dishes: req.body.dishes }, { upsert: true });
  res.json({ ok: true });
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  const id = getRestaurantId(req);
  const orders = await Order.find({ restaurantId: id });
  res.json(orders.map(o => o.data));
});

app.put('/api/admin/orders/:id/status', requireAdmin, async (req, res) => {
  const id = getRestaurantId(req);
  const orderId = Number(req.params.id);
  const order = await Order.findOne({ restaurantId: id, 'data.id': orderId });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  
  order.data.status = req.body.status;
  order.markModified('data'); // <--- THIS FIXES THE BUG
  await order.save();
  
  res.json({ ok: true, order: order.data });
});

app.put('/api/admin/orders/:id/items', requireAdmin, async (req, res) => {
  const id = getRestaurantId(req);
  const orderId = Number(req.params.id);
  const order = await Order.findOne({ restaurantId: id, 'data.id': orderId });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  
  if (req.body.items.length === 0) {
    order.data.status = 'cancelled';
  } else {
    order.data.items = req.body.items;
    order.data.total = req.body.items.reduce((sum, item) => sum + (item.price * item.qty), 0);
  }
  order.markModified('data'); // <--- THIS FIXES THE BUG
  await order.save();
  
  res.json({ ok: true, order: order.data });
});

app.put('/api/admin/orders/:id/table', requireAdmin, async (req, res) => {
  const id = getRestaurantId(req);
  const orderId = Number(req.params.id);
  const order = await Order.findOne({ restaurantId: id, 'data.id': orderId });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  
  order.data.table = req.body.table;
  order.markModified('data'); // <--- THIS FIXES THE BUG
  await order.save();
  
  res.json({ ok: true, order: order.data });
});

app.put('/api/admin/orders/:id/partial-payment', requireAdmin, async (req, res) => {
  const id = getRestaurantId(req);
  const orderId = Number(req.params.id);
  const order = await Order.findOne({ restaurantId: id, 'data.id': orderId });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  
  order.data.total = req.body.newTotal;
  order.data.paidAmount = (order.data.paidAmount || 0) + req.body.amountPaid;
  order.data.splitDetails = req.body.splitDetails;
  order.markModified('data'); // <--- THIS FIXES THE BUG
  await order.save();
  
  res.json({ ok: true, order: order.data });
});

app.get('/api/admin/subscribers', requireAdmin, async (req, res) => {
  const id = getRestaurantId(req);
  const subs = await Subscriber.find({ restaurantId: id });
  res.json(subs);
});

app.put('/api/admin/subscribers/:email/points', requireAdmin, async (req, res) => {
  const id = getRestaurantId(req);
  const email = decodeURIComponent(req.params.email);
  const sub = await Subscriber.findOne({ restaurantId: id, email });
  if (!sub) return res.status(404).json({ error: 'Not found' });
  sub.points = (sub.points || 0) + Number(req.body.points);
  await sub.save();
  res.json({ ok: true, points: sub.points });
});

app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  const id = getRestaurantId(req);
  const config = await getConfig(id);
  res.json({ payLaterEnabled: config.payLaterEnabled !== false });
});

app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  const id = getRestaurantId(req);
  const configDoc = await Config.findOne({ restaurantId: id });
  if (typeof req.body.payLaterEnabled === 'boolean') {
    configDoc.data.payLaterEnabled = req.body.payLaterEnabled;
    configDoc.markModified('data'); // <--- THIS FIXES THE BUG
    await configDoc.save();
  }
  res.json({ ok: true, settings: { payLaterEnabled: configDoc.data.payLaterEnabled } });
});

// ---------- SUPER ADMIN API ----------
app.get('/api/restaurants', async (req, res) => {
  const password = req.headers['x-super-password'];
  const mainConfig = await getConfig('everest');
  if (!mainConfig) return res.status(404).json({ error: 'Main config not found' });
  if (password !== mainConfig.superAdminPassword) return res.status(401).json({ error: 'Invalid super-admin password' });
  
  const allConfigs = await Config.find();
  const list = allConfigs.map(c => ({
    id: c.restaurantId,
    name: c.data.name,
    subscription: c.data.subscription,
    accessOverride: c.data.accessOverride
  }));
  res.json(list);
});

app.post('/api/restaurants/:id/override', async (req, res) => {
  const password = req.headers['x-super-password'];
  const mainConfig = await getConfig('everest');
  if (password !== mainConfig.superAdminPassword) return res.status(401).json({ error: 'Invalid super-admin password' });
  
  const targetId = req.params.id;
  const configDoc = await Config.findOne({ restaurantId: targetId });
  if (!configDoc) return res.status(404).json({ error: 'Restaurant not found' });
  
  configDoc.data.accessOverride = req.body.accessOverride;
  configDoc.markModified('data'); // <--- THIS FIXES THE BUG
  await configDoc.save();
  
  res.json({ ok: true, config: { id: targetId, accessOverride: configDoc.data.accessOverride } });
});

// ---------- START ----------
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB Atlas');
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ Server running:`);
      console.log(`   Local:    http://localhost:${PORT}`);
    });
  })
  .catch(err => console.error('❌ MongoDB connection error:', err));