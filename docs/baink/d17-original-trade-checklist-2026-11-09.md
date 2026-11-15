# Finishing the original aldi-test Trade (D-17): owner checklist

For the owner of the aldi-test accounts. Rahul's D-17 answer (9 Nov 2026): our own
test accounts prove the path first, and the Aldi retest follows without waiting.
This checklist applies only after the no-install send is switched on in production
for test-tagged accounts (`remaining_work.md`, W4). Until then, step 0 fails and you
should stop there.

Nothing in this list asks for a password, a seed or a private key to be typed
anywhere except your own browser's sign-in. UAIN staff never move AI$ between
production accounts for you; you do every signing step yourself.

**Who is who.** The *buyer* (payer) is the account that received the Trade payment
request. The *seller* (recipient) is the account that created it. If one person owns
both accounts, use two browser profiles, one per account.

## 0. Check the path is on (both accounts, 1 minute)

1. Open BAINK and sign in.
2. Go to **Wallet → Send money**.
3. At the top you should see **Pay**, with no "not switched on yet" note. If the note is
   there, stop: the path is not live yet.

## 1. Seller: set up receiving (once)

1. Signed in as the seller, on **Send money**, open **Set up receiving**.
2. Choose **Set up receiving** (nothing to install: your browser derives a receiving
   key from your member key and registers only its viewing key; updated 9 Nov 2026).
   If you already run an AI$ wallet you may instead paste its 86-character address
   and choose **Save**.
3. The panel then reads **Receiving is set up**.

## 2. Buyer: release the old, never-sent payment attempt

The original Trade payment sits at *awaiting agreement* with nothing sent
(`sendAttemptedAt` empty), so nothing can have been paid.

1. Signed in as the buyer, open **Send money**. Under **Earlier wallet payment
   attempts** (updated 9 Nov 2026: the device wallet is retired), find the payment for
   the original Trade.
2. Choose **Release**. Releasing is allowed whenever nothing was sent, even after both
   people agreed. The Trade request stays open.

If the old payment is not listed, it was not a never-sent attempt: stop and tell
Rahul; do not pay again.

## 3. Buyer: pay the Trade request from the browser

1. Still on **Send money**, under **Pay → Requests to pay**, find the Trade request
   (seller's address, amount, Trade memo). Choose **Pay this**. The recipient and the
   amount fill in and cannot be edited.
2. Choose **Sign and pay**. Your browser signs the payment (amount, recipient, a
   one-time number and an expiry of one hour).
3. Keep the page open. The status moves through **Preparing** (up to a minute while
   the proof is built) and, if the checker is busy, **Waiting for the checker**, which
   continues on its own.
4. At **Needs your signature** the page checks that the prepared payment is exactly
   what you signed (amount, your account, the network) and signs it for you. If you
   closed the page, reopen **Send money** and it continues.
5. The status moves to **Sending**, **On its way** and then **Delivered** (final on
   the ledger). This usually takes under a minute.

If the page shows **Checking** or **Retrying**, leave it. The server proves whether an
attempt landed before it prepares a new one, so the request is never paid twice. If
it shows **Expired**, nothing was paid: start again from step 3.

## 4. Seller: confirm receipt

1. Signed in as the seller, open **Send money**.
2. Under **Your payments**, the payment reads **Received**. Choose **Confirm received**.
   Your browser signs the confirmation.
3. It reads **Paid**. The Trade request now shows **paid** in **Incoming requests**
   (buyer) and in the seller's request list.

## 5. Tell us; we verify read-only

Post in the usual channel that the Trade is paid, with the time. A UAIN engineer then
checks, read-only, that the request shows `paid=true` with settlement
`native-server-send`, the ledger record exists for the payment's effects, and the
buyer's public balance dropped by exactly the amount. Nobody else signs anything.

## If something goes wrong

| You see | Meaning | Do |
|---|---|---|
| "The recipient has not set up receiving yet" | Step 1 not done | Seller does step 1 |
| "payment_request_locked" | The old payment attempt still holds the request | Buyer does step 2 |
| "payment_request_expired" | The request passed its expiry (old requests: 17 Nov 2026) | Seller sends new terms and a new request |
| "Your proven AI$ balance does not cover this" | Public balance too low | Earn or wait for an award first |
| "Refused by the checker" | The checker declined it; nothing was paid | Tell Rahul with the time |
