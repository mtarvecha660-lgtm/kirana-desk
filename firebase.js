import { firebaseConfig } from './firebase-config.js';

const configured = Boolean(firebaseConfig &&
  firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('REPLACE_') &&
  firebaseConfig.projectId && !firebaseConfig.projectId.startsWith('REPLACE_') &&
  firebaseConfig.appId && !firebaseConfig.appId.startsWith('REPLACE_'));

if (!configured) {
  window.KiranaCloud = { configured: false, user: null };
} else {
  const SDK = 'https://www.gstatic.com/firebasejs/12.17.0/';
  const [{ initializeApp }, authSdk, storeSdk] = await Promise.all([
    import(SDK + 'firebase-app.js'),
    import(SDK + 'firebase-auth.js'),
    import(SDK + 'firebase-firestore.js')
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = authSdk.getAuth(app);
  let firestore;
  try {
    firestore = storeSdk.initializeFirestore(app, {
      localCache: storeSdk.persistentLocalCache({
        tabManager: storeSdk.persistentMultipleTabManager()
      })
    });
  } catch {
    firestore = storeSdk.getFirestore(app);
  }
  const root = ['workspaces', 'kiranaDesk'];
  const collectionFor = name => storeSdk.collection(firestore, ...root, name);
  const docFor = (name, key) => storeSdk.doc(firestore, ...root, name, key);

  window.KiranaCloud = {
    configured: true,
    get user() { return auth.currentUser; },
    onAuthChange(callback) { return authSdk.onAuthStateChanged(auth, callback); },
    signIn(email, password) { return authSdk.signInWithEmailAndPassword(auth, email, password); },
    signOut() { return authSdk.signOut(auth); },
    async list(name) {
      const snapshot = await storeSdk.getDocs(collectionFor(name));
      return snapshot.docs.map(item => Object.assign({}, item.data(), { id: item.id }));
    },
    write(name, item) {
      return storeSdk.setDoc(docFor(name, item.id), item);
    },
    delete(name, key) {
      return storeSdk.deleteDoc(docFor(name, key));
    },
    listen(callback, onError) {
      return ['bills', 'counters', 'products', 'customers', 'supplyorders'].map(name =>
        storeSdk.onSnapshot(collectionFor(name), snapshot => {
          callback(name, snapshot.docs.map(item => Object.assign({}, item.data(), { id: item.id })));
        }, onError)
      );
    },
    async createBill(data) {
      const startYear = new Date(data.date + 'T12:00:00').getMonth() >= 3
        ? new Date(data.date + 'T12:00:00').getFullYear()
        : new Date(data.date + 'T12:00:00').getFullYear() - 1;
      const year = startYear + '-' + String(startYear + 1).slice(-2);
      const prefix = { sampurn: 'SK', surya: 'SS', dhanraj: 'DP' }[data.businessId] || 'SK';
      const counterId = data.businessId + ':' + year;
      const counterRef = docFor('counters', counterId);
      const billRef = docFor('bills', data.id);
      return storeSdk.runTransaction(firestore, async transaction => {
        const counter = await transaction.get(counterRef);
        const sequence = (counter.exists() ? counter.data().lastNumber : 0) + 1;
        const bill = Object.assign({}, data, {
          financialYear: year,
          sequence,
          billNumber: prefix + '/' + year + '/' + String(sequence).padStart(4, '0'),
          createdAt: new Date().toISOString()
        });
        transaction.set(counterRef, { id: counterId, businessId: data.businessId, financialYear: year, lastNumber: sequence });
        transaction.set(billRef, bill);
        return bill;
      });
    }
  };
}
