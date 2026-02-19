const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ── Validate env variables on startup ──────
const required = ['STRIPE_SECRET_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
required.forEach(key => {
  if (!process.env[key]) {
    console.error(`❌ Missing environment variable: ${key}`);
    process.exit(1);
  }
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Health check ────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'DualOdds backend running ✅' });
});

// ── Stripe webhook ──────────────────────────
// IMPORTANT: must be before express.json()
app.post('/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.error('❌ STRIPE_WEBHOOK_SECRET not set');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      // ── Payment successful → activate plan ──
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const customerEmail = session.customer_details?.email;
        const amountPaid = session.amount_total;

        let plan = 'basic';
        if (amountPaid >= 7999) plan = 'elite';
        else if (amountPaid >= 4999) plan = 'pro';
        else if (amountPaid >= 2999) plan = 'basic';

        console.log(`💳 Payment: ${customerEmail} → ${plan} ($${amountPaid / 100})`);
        await updateUserPlan(customerEmail, plan);
      }

      // ── Subscription cancelled → remove plan ──
      if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        const customer = await stripe.customers.retrieve(sub.customer);
        console.log(`❌ Cancelled: ${customer.email}`);
        await updateUserPlan(customer.email, 'none');
      }
    } catch (err) {
      console.error('Handler error:', err.message);
    }

    res.json({ received: true });
  }
);

app.use(express.json());

// ── Helper: update user plan in Supabase ────
async function updateUserPlan(email, plan) {
  try {
    const { data, error } = await supabase.auth.admin.listUsers();
    if (error) throw error;

    const user = data.users.find(u => u.email === email);
    if (!user) {
      console.error(`User not found: ${email}`);
      return;
    }

    await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: { plan }
    });
    console.log(`✅ Updated ${email} → plan: ${plan}`);
  } catch (err) {
    console.error('updateUserPlan error:', err.message);
  }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 DualOdds backend running on port ${PORT}`);
});
