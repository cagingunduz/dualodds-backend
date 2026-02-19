const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'DualOdds backend running ✅' });
});

// Stripe webhook — must use raw body
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Payment successful → activate plan
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerEmail = session.customer_details?.email;
    const amountPaid = session.amount_total; // in cents

    // Determine plan based on amount
    let plan = 'basic';
    if (amountPaid >= 7999) plan = 'elite';
    else if (amountPaid >= 4999) plan = 'pro';
    else if (amountPaid >= 2999) plan = 'basic';

    console.log(`✅ Payment received: ${customerEmail} → ${plan}`);

    // Find user in Supabase by email and update their plan
    const { data: users, error } = await supabase.auth.admin.listUsers();
    if (!error) {
      const user = users.users.find(u => u.email === customerEmail);
      if (user) {
        await supabase.auth.admin.updateUserById(user.id, {
          user_metadata: { plan }
        });
        console.log(`✅ Plan updated for ${customerEmail}: ${plan}`);
      }
    }
  }

  // Subscription cancelled → remove plan
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const customer = await stripe.customers.retrieve(subscription.customer);
    const customerEmail = customer.email;

    const { data: users } = await supabase.auth.admin.listUsers();
    if (users) {
      const user = users.users.find(u => u.email === customerEmail);
      if (user) {
        await supabase.auth.admin.updateUserById(user.id, {
          user_metadata: { plan: 'none' }
        });
        console.log(`❌ Plan removed for ${customerEmail}`);
      }
    }
  }

  res.json({ received: true });
});

app.use(express.json());

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 DualOdds backend running on port ${PORT}`));
