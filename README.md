# Kirana Desk

An offline-capable digital dispatch register and analytics tool for Riddhi Siddhi Store, Surya Supplies, and Sampurn Kirana Shop. It is designed to replace searching through a paper bill book when reviewing activity; it does not need to print anything.

## Included

- Separate product and customer catalogs for each form.
- Independent record numbers for each form and Indian financial year (1 April–31 March).
- Entries record the customer, date, product, quantity, unit, and optional note. They intentionally do not contain price, GST, or payment fields.
- Searchable history, product/customer analytics, and CSV export for spreadsheet analysis.
- Clearly marked sample products and customer names for each form on a fresh install. Edit or remove these from Products & customers.
- Browser-local IndexedDB storage and manual JSON backup/restore.

## Data safety

- **Recycle bin.** Deleting a bill, product, customer, return entry or supply order never erases it. The record is marked `deleted: true` with `deletedAt` / `deletedBy` and hidden from lists, totals, analytics and the Busy export. Backup & restore → **Recycle bin** lists everything deleted, with **Restore**. A deleted bill keeps its number, so the number is never given to a new bill.
- **No edit history.** Editing a bill overwrites it; previous versions are not stored (to save space). Old `history` / `editedAt` / `editedBy` fields from the short-lived edit-history build are dropped when the app opens, when the bill is next saved, and when a backup is restored.
- **Daily backup.** Once a day, on the first open of the app, a full copy (`kirana-backup-YYYY-MM-DD.json`, Recycle bin included) is saved to the automatic backup folder if one is set up, otherwise to Downloads. The Backup page shows **Last backup** and a warning after 3 days without one. It can be turned off per device (e.g. on a phone).
- **Restore** downloads a safety copy of the current data first, never lowers a bill counter, and in the shared workspace writes the restored records back to the cloud.
- **Firestore rules** (`firestore.rules`): only the two family emails can read/create/update; delete is denied for everyone. Paste the file into Firebase console → Firestore Database → Rules → Publish.

Tests: `tests/data-safety.test.mjs` (static/unit) and `tests/data-safety.e2e.test.mjs` (Playwright).

## Keyboard (Busy-style entry)

Every page works without the mouse. Press **?** in the app to see this list.

| Key | What it does |
| --- | --- |
| Enter | Next field. Never presses a delete/remove button. |
| Enter on the last field of the last item line | Adds exactly **one** new line and puts the cursor in its Product box |
| Enter on an empty Product line | Finishes the items and jumps to GST / Note; empty lines are ignored when saving |
| Enter on the last field of a window | Goes to the Save button (Enter again saves) |
| Shift + Enter | Previous field |
| Up / Down, then Enter | Pick from a suggestion list. Enter only fills the box; the next Enter moves on |
| Left / Right on FORM | Switch between the three shops |
| Ctrl + Enter or Ctrl + S | Save the open window (pressing twice still saves once) |
| Ctrl + Delete or Alt + D | Delete the item line / record / bill under the cursor (always asks first) |
| Esc | Close the suggestion list first, then the window (asks if you typed something unsaved) |
| N | New bill (when no window is open) |
| / | Search on Records or Products & customers; Down arrow then Enter opens a result |
| Alt + 1 to 6 | Overview, Records, Supply orders, Products & customers, Analytics, Backup |

Holding Enter down does not repeat actions, and Enter while typing in Hindi/IME composition is ignored.

### Keyboard test

`tests/keyboard.test.mjs` drives every page and window with the keyboard in a real Chromium and checks line counts (exactly +1, no phantom add/delete), saving, delete-with-confirm and console errors. It runs on local data only (the Firebase config is swapped for a blank one inside the test browser, and the sign-in check uses a fake Firebase), so it never touches the shared workspace.

```
npm i -D playwright
npx playwright install chromium
node tests/keyboard.test.mjs                                              # tests this folder
node tests/keyboard.test.mjs https://mtarvecha660-lgtm.github.io/kirana-desk/   # tests the live site
```

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

## Export to Busy

Kirana Desk can turn its bills into **Busy 21 sales vouchers** (XML), so you don't type them again in Busy.
The file format is copied from a real Busy 21 (Rel 13.0) export of sale no. 37 (root `<Sale>`, `iso8859-1`, sale type `L/GST-TaxIncl.`).

> ⚠️ **Do the first import on a BACKUP or TEST company in Busy**, not on the real books. Check a few bills, the stock and the GST report there first. Take a Busy backup before every import.

### In Kirana Desk
1. Open **Export to Busy** (sidebar, or Alt+7).
2. **Busy names** — type them exactly as they are in Busy: sales account (`Sales`), `CGST Output`, `SGST Output`, material centre (`Main Store`), series (`Main`), and the cash party (`Cash`) used for bills with no customer. Party: either the bill's customer (that account must already exist in Busy; use the Customers box to map a Kirana name to a different Busy name) or always the cash party.
3. **Items** — for each product set the Busy item name (blank = same name), tax category (`GST 5%`, `GST 12% to 5%`, `Non-GST`…), HSN and unit. Items with no tax category use *Default tax category*, or the bill's GST % (no GST on the bill → `Non-GST`). Tick **Brand** only for items that have a brand parameter in Busy (Bembino, Fortune…). Press **Save settings**.
4. Pick the **form** (RS = Riddhi Siddhi Store), **from / to** dates, press **↓ Download for Busy**.
   * 1 bill → one file `Sales-RS-2026-27-0041.xml`
   * several bills → a `.zip` with one `.xml` per bill (the way Busy itself writes `Sales-37.xml`). Unzip it into a new empty folder.
   * Bills with a line that has **no price** are skipped and listed on screen. Prices are taken as **including GST**; Busy's CGST/SGST split is reproduced to the paisa.

### One bill only
* Open the bill (Records → ↗) and press **⇩ Export to Busy**, or press **Alt+B** while the bill is open.
* On **Records**, each row has a **⇩** button; Alt+B also works on a row selected with the arrow keys.
* On **Export to Busy → Single bill**, type the bill no. (`RS/2026-27/0041` or just `41`) and press Enter.
* It always downloads **one `.xml`** (never a zip), with the same settings as the range export, including the Busy company name. In Busy: **Add Sale → Paste → choose the file**, or Import Data.
* If a line has no price, nothing downloads and a message names the items that need a price.

**Default price.** Every new item line on a bill starts at price **1** (type the real price over it). Saved bills keep exactly what they had.

### In Busy 21
1. Open the **test company**.
2. **Administration → Data Export Import → Data Export/Import (XML) → Import Data**.
3. Point it to the folder that holds the `.xml` file(s) and press **OK**.
4. Open the imported sales vouchers (Sales register, or Modify voucher) and compare a few bills with Kirana Desk: party, items, qty, amount, CGST/SGST.
5. If Busy reports a missing master (item, unit, account, tax category), create it in Busy or fix the name in Kirana Desk → Export to Busy, and export again.

**Voucher numbers.** By default the Busy voucher number is the full Kirana bill number (`RS/2026-27/0041`), so it never clashes with bills already typed in Busy. Choose *Number only* to send `41` instead.

**Not handled yet:** returns, discounts, round-off, inter-state (IGST) sales — only local, tax-inclusive sales like Busy sale type `L/GST-TaxIncl.`. Busy settings are saved in this browser only (not synced).

Tests: `node tests/busy-export.test.mjs` (compares with the real Busy voucher in `tests/fixtures/busy-sale-37.xml`, party name anonymised) and `node tests/busy-export.e2e.test.mjs` (Playwright: downloads the file and checks it).
