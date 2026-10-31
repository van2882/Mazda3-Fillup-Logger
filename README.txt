FILL-UP LOGGER (installable phone app)

What it does: you add a receipt photo and a dashboard photo. The phone reads the date, store,
price, litres, amount and Trip A km. You check the numbers and tap Log. It sends them into your
Google Form, so they land in the hidden "Form Responses 1" tab and the Mazda3 Fuel Tracker.
Trip A goes on the previous fill-up row, same as the form does.

Everything (photo reading included) runs on the phone. No photo leaves it.

PUT IT ONLINE (once, ~5 minutes, free). It must be served over https to install on Android.

Option A - Netlify Drop (easiest)
 1. Open https://app.netlify.com/drop on your computer and sign in (free).
 2. Drag this whole folder onto the page.
 3. You get an https address. Open it on your phone.

Option B - GitHub Pages
 1. Make a new public repository, upload every file in this folder to its root.
 2. Settings > Pages > deploy from the main branch, root folder.
 3. Open https://<your-name>.github.io/<repo>/ on your phone.

INSTALL ON YOUR PHONE
 Open the address in Chrome, then menu (three dots) > "Install app" (or "Add to Home screen").
 Open it once while online so it can save the reading engine (about 9 MB). After that it works
 offline: fill-ups are kept on the phone and sent when you are back online.

NOTES
 - Always check the numbers against the photos. Warnings show when price x litres does not match the amount.
 - If you log a mistake, fix it in the hidden "Form Responses 1" tab of your sheet.
 - To change the form or field IDs, edit config.js.
