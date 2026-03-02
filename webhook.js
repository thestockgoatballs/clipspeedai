const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { supabase } = require('../lib/supabase');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PLAN_LIMITS = {
  free: 30,
  starter: 200,
  pro: 600,
  pack3: 900,
  pack4: 1200,
  agency: 1500,
};

/**
 * POST /webhook/stripe
 * Stripe webhook handler for subscription events
 */
router.post('/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        const plan = session.metadata?.plan || 'starter';

        if (userId) {
          await supabase.from('profiles').update({
            plan,
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
            clips_limit: PLAN_LIMITS[plan] || 10,
          }).eq('id', userId);

          console.log(`💳 User ${userId} upgraded to ${plan}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id')
          .eq('stripe_subscription_id', subscription.id);

        if (profiles?.[0]) {
          // Determine plan from price
          const priceId = subscription.items.data[0]?.price?.id;
          let plan = 'free';
          if (priceId === process.env.STRIPE_PRICE_STARTER) plan = 'starter';
          else if (priceId === process.env.STRIPE_PRICE_PRO) plan = 'pro';
          else if (priceId === process.env.STRIPE_PRICE_AGENCY) plan = 'agency';

          await supabase.from('profiles').update({
            plan,
            clips_limit: PLAN_LIMITS[plan],
          }).eq('id', profiles[0].id);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id')
          .eq('stripe_subscription_id', subscription.id);

        if (profiles?.[0]) {
          await supabase.from('profiles').update({
            plan: 'free',
            stripe_subscription_id: null,
            clips_limit: 10,
          }).eq('id', profiles[0].id);

          console.log(`❌ Subscription cancelled for user ${profiles[0].id}`);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        // Reset monthly clip count on successful payment
        const invoice = event.data.object;
        const customerId = invoice.customer;

        const { data: profiles } = await supabase
          .from('profiles')
          .select('id')
          .eq('stripe_customer_id', customerId);

        if (profiles?.[0]) {
          await supabase.from('profiles').update({
            clips_used_this_month: 0,
          }).eq('id', profiles[0].id);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.warn(`⚠️ Payment failed for customer ${invoice.customer}`);
        break;
      }
    }

    res.json({ received: true });

  } catch (err) {
    console.error('Webhook processing error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
