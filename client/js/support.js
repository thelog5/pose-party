/* BUY ME A RED BULL — the one paper on this board that takes money.

   It is a STRIPE PAYMENT LINK and nothing else: a URL you create once in the
   Stripe dashboard, which opens Stripe's own hosted checkout page in a new
   tab. Deliberately not a Checkout Session minted by our server, and not
   Stripe's embedded buy button:

   - No secret key exists in this repo, so there is nothing here to leak and
     nothing to rate limit. The publishable half of the transaction is a plain
     https URL.
   - No card number, name or address ever touches our page or our server, so
     nothing in privacy.html has to change about payments beyond naming Stripe
     as the processor.
   - The game's frontend is static and is played from static hosts too.
     A server route would make the button dead
     on exactly those copies; a link works everywhere.
   - No Stripe script loads at boot. The page stays as fast as it was.

   SET IT UP (about two minutes, no code):
     1. dashboard.stripe.com  ->  More  ->  Payment Links  ->  New.
     2. Product: a one-off "Red Bull for the developer". Price: whatever a can
        costs. Tick "Let customers choose what to pay" if you want a range,
        and set the minimum there. Currency CAD.
     3. Under "After payment" pick "Show confirmation page" and write a
        thank-you line. Do NOT redirect back into the game: the player is in
        a new tab and the game is still running behind it.
     4. Turn OFF "Collect customers' addresses" unless you ship something.
        Less collected is less to disclose.
     5. Save, copy the https://buy.stripe.com/... URL, paste it below.
     6. The dashboard's TEST mode gives a test link and card 4242 4242 4242
        4242. Try that first; the live link only appears once your account is
        activated (Stripe asks for your identity and a payout bank account).

   Leave SUPPORT_URL empty and the button never renders, so a build without a
   link cannot ship a control that goes nowhere. */
import { $ } from "./dom.js";

export const SUPPORT_URL = "https://buy.stripe.com/fZu28t7bC0RKcMT4JH1kA00";

export function wireSupport(){
  const el = $("homeSupport");
  if(!el) return;
  if(!/^https:\/\//.test(SUPPORT_URL)){ el.remove(); return; }
  el.href = SUPPORT_URL;
  /* Stripe's page is a payment page opened from a game full of other
     people's video, so it gets the strictest opener isolation we can give
     it. `noreferrer` also keeps our room URLs out of Stripe's logs. */
  el.rel = "noopener noreferrer";
  el.setAttribute("aria-label",
    "Buy the developer a Red Bull. Opens Stripe in a new tab.");
  el.hidden = false;
}
