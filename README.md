# Kirana Desk

An offline-capable digital dispatch register and analytics tool for Riddhi Siddhi Store, Surya Supplies, and Dhanraj Products. It is designed to replace searching through a paper bill book when reviewing activity; it does not need to print anything.

## Included

- Separate product and customer catalogs for each form.
- Independent record numbers for each form and Indian financial year (1 April–31 March).
- Entries record the customer, date, product, quantity, unit, and optional note. They intentionally do not contain price, GST, or payment fields.
- Searchable history, product/customer analytics, and CSV export for spreadsheet analysis.
- Clearly marked sample products and customer names for each form on a fresh install. Edit or remove these from Products & customers.
- Browser-local IndexedDB storage and manual JSON backup/restore.

## Run locally

Open PowerShell in this folder and run: py -m http.server 8000

Then open http://localhost:8000. Keep the server window open while using the app. On localhost, supported browsers can install it as an app from the browser's install control.

## Data and backups

Records are saved to the browser profile on the computer where the app is used. Export a backup from Backup & restore and copy the JSON file to another device or drive. To use that data on another computer, open the app there and restore the file.

This version does not synchronize the two computers or write backups to the other computer automatically. A hosted HTTPS deployment plus a synchronization service (or a companion process on the backup computer) is needed for shared live data and unattended cross-computer backups. Browser storage is not a substitute for a second copy.

## Online shared workspace (Firebase)

The app includes Firebase Authentication and Cloud Firestore wiring, but it stays in local-only mode until a project config is added. For a live shared workspace:

1. Create a Firebase project and register a Web app in the Firebase Console.
2. Copy the Firebase Web app config into firebase-config.js (start from firebase-config.example.js). The web config is public client configuration; never put a service-account private key in this file.
3. Enable Email/Password sign-in. Create only the family accounts in Firebase Authentication. The app does not offer public self-registration.
4. Create a Cloud Firestore database. The app's rules restrict reads and writes to signed-in users in this dedicated project.
5. Install the Firebase CLI, run firebase login, select the project with firebase use --add, then run firebase deploy --only hosting,firestore:rules.

The app syncs products, customers, and records through Firestore. Bill numbers use an online transaction so separate devices cannot assign the same number. While offline, cached records remain readable and ordinary catalog edits queue for sync; creating a newly numbered record requires an internet connection. Firebase Authentication and Firestore's web cache require the Firebase SDK to load when the app starts.

Firebase Hosting serves the static PWA over HTTPS. Firebase's current setup guide requires a Firebase project before Hosting setup and deploys the static app with the Firebase CLI: https://firebase.google.com/docs/hosting/quickstart

