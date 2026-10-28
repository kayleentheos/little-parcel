# Little Parcel

Make a handmade gift box (letter, song, keychain, verse tin, mini-room), seal it, and send a link.

- `index.html` — the whole site
- `birthday.html` — a birthday gift parcel (letter, record, cake, phone call, typewriter list, picture board); open `/birthday.html`
- `api/box.js` — saves and loads parcels (Upstash Redis via the Vercel Marketplace)

Deploy: import this folder into Vercel, then add **Upstash Redis** under Storage and connect it to the project, then redeploy.
