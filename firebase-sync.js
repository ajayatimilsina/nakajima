import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInAnonymously, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js';
import { get, getDatabase, onValue, push, ref, remove, runTransaction, set, update } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-database.js';
import { deleteObject, getDownloadURL, getStorage, ref as storageRef, uploadBytes } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-storage.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAk81HxCeRB3IGekGcsE9OVHmi1sFdLwYM',
  authDomain: 'ajimaru-bcbef.firebaseapp.com',
  databaseURL: 'https://ajimaru-bcbef-default-rtdb.firebaseio.com',
  projectId: 'ajimaru-bcbef',
  storageBucket: 'ajimaru-bcbef.firebasestorage.app',
  messagingSenderId: '893250502168',
  appId: '1:893250502168:web:76740b65a9ca60953fcd6d',
  measurementId: 'G-H39ZKMVY25'
};

const STAFF_EMAIL = 'ajayatimilsina1@gmail.com';
const CUSTOMER_ORDER_KEYS = 'hh_customer_order_keys';
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);
const storage = getStorage(app);
const ownOrders = new Map();
const customerListeners = new Set();
const watchedOrders = new Map();
let staffOrdersListener = null;

function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function isStaff(user) {
  return Boolean(user && !user.isAnonymous && user.email?.toLowerCase() === STAFF_EMAIL);
}

function normalizeMenu(menu) {
  const values = (Array.isArray(menu) ? menu : Object.values(menu || {})).filter(item => item && typeof item === 'object');
  return values.map(item => {
    const options = (Array.isArray(item.o) ? item.o : Object.values(item.o || {}))
      .filter(option => option && typeof option === 'object' && option.n)
      .map(option => ({ n: String(option.n), p: Number(option.p) || 0 }));
    const record = {
      id: Number(item.id),
      cat: String(item.cat || ''),
      n: String(item.n || ''),
      p: Number(item.p),
      e: String(item.e || '')
    };
    if (typeof item.d === 'string' && item.d) record.d = item.d;
    if (typeof item.photo === 'string' && item.photo.startsWith('https://')) record.photo = item.photo;
    if (Number.isFinite(Number(item.memberPrice))) record.memberPrice = Number(item.memberPrice);
    if (item.x) record.x = true;
    if (options.length) record.o = options;
    return record;
  }).sort((a, b) => a.id - b.id);
}

function menuRecord(menu) {
  return Object.fromEntries(normalizeMenu(menu).map(item => [String(item.id), item]));
}

function customerOrderKeys() {
  try {
    const keys = JSON.parse(localStorage.getItem(CUSTOMER_ORDER_KEYS) || '[]');
    return Array.isArray(keys) ? keys.filter(key => typeof key === 'string') : [];
  } catch (error) {
    return [];
  }
}

function publishCustomerOrders() {
  const orders = [...ownOrders.values()].sort((a, b) => a.t - b.t);
  customerListeners.forEach(listener => listener(orders));
}

function watchCustomerOrder(key, uid) {
  if (watchedOrders.has(key)) return;
  const unsubscribe = onValue(ref(database, `orders/${key}`), snapshot => {
    const order = snapshot.val();
    if (order && order.customerUid === uid) ownOrders.set(key, { ...order, key });
    else ownOrders.delete(key);
    publishCustomerOrders();
  }, error => {
    // 削除済み・他ユーザーの注文はルール上読めないため、保存済みキーから外して無視する
    if (/permission/i.test(`${error.code} ${error.message}`)) {
      watchedOrders.get(key)?.();
      watchedOrders.delete(key);
      ownOrders.delete(key);
      try {
        localStorage.setItem(CUSTOMER_ORDER_KEYS, JSON.stringify(customerOrderKeys().filter(saved => saved !== key)));
      } catch (storageError) {}
      publishCustomerOrders();
      return;
    }
    emit('firebase-sync-error', { message: error.message });
  });
  watchedOrders.set(key, unsubscribe);
}

async function ensureCustomer() {
  if (!auth.currentUser) await signInAnonymously(auth);
  return auth.currentUser;
}

async function startCustomer(onOrders) {
  customerListeners.add(onOrders);
  const user = await ensureCustomer();
  customerOrderKeys().forEach(key => watchCustomerOrder(key, user.uid));
  publishCustomerOrders();
  return () => customerListeners.delete(onOrders);
}

async function createCustomerOrder(order) {
  const user = await ensureCustomer();
  const orderRef = push(ref(database, 'orders'));
  const record = { ...order, customerUid: user.uid };
  await set(orderRef, record);
  const keys = customerOrderKeys();
  if (!keys.includes(orderRef.key)) {
    keys.push(orderRef.key);
    localStorage.setItem(CUSTOMER_ORDER_KEYS, JSON.stringify(keys));
  }
  watchCustomerOrder(orderRef.key, user.uid);
  return { ...record, key: orderRef.key };
}

async function signInStaff() {
  const result = await signInWithPopup(auth, new GoogleAuthProvider());
  if (!isStaff(result.user)) {
    await signOut(auth);
    throw new Error(`Staff access is limited to ${STAFF_EMAIL}.`);
  }
  return result.user;
}

async function ensureMenu(defaultMenu) {
  if (!isStaff(auth.currentUser)) throw new Error('Staff sign-in required.');
  const menuRef = ref(database, 'menu');
  const snapshot = await get(menuRef);
  if (!snapshot.exists()) await set(menuRef, menuRecord(defaultMenu));
}

async function saveMenu(menu) {
  if (!isStaff(auth.currentUser)) throw new Error('Staff sign-in required.');
  await set(ref(database, 'menu'), menuRecord(menu));
}

async function uploadMenuPhoto(menuId, file) {
  if (!isStaff(auth.currentUser)) throw new Error('Staff sign-in required.');
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('写真はJPG、PNG、WebP形式を選択してください。');
  }
  if (file.size > 5 * 1024 * 1024) throw new Error('写真は5MB以下にしてください。');
  const extension = file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1];
  const photoRef = storageRef(storage, `menu-photos/${menuId}/${Date.now()}.${extension}`);
  await uploadBytes(photoRef, file, { contentType: file.type });
  return getDownloadURL(photoRef);
}

async function deleteMenuPhoto(photoUrl) {
  if (!isStaff(auth.currentUser)) throw new Error('Staff sign-in required.');
  if (typeof photoUrl !== 'string' || !photoUrl.startsWith('https://')) throw new Error('Invalid menu photo URL.');
  await deleteObject(storageRef(storage, photoUrl));
}

onValue(ref(database, 'menu'), snapshot => {
  emit('firebase-menu', { menu: snapshot.exists() ? normalizeMenu(snapshot.val()) : null });
}, error => emit('firebase-sync-error', { message: error.message }));

function listenForStaffOrders(user) {
  if (!isStaff(user) || staffOrdersListener) return;
  const ordersRef = ref(database, 'orders');
  let initial = true;
  const stop = onValue(ordersRef, snapshot => {
    const orders = [];
    snapshot.forEach(child => orders.push({ ...child.val(), key: child.key }));
    orders.sort((a, b) => a.t - b.t);
    emit('firebase-orders', { orders, initial });
    initial = false;
  }, error => emit('firebase-sync-error', { message: error.message }));
  staffOrdersListener = stop;
}

onAuthStateChanged(auth, user => {
  const staff = isStaff(user);
  if (staff) listenForStaffOrders(user);
  else if (staffOrdersListener) {
    staffOrdersListener();
    staffOrdersListener = null;
  }
  emit('firebase-auth-changed', { isStaff: staff, email: staff ? user.email : '' });
});

window.firebaseSync = {
  createCustomerOrder,
  deleteMenuPhoto,
  ensureMenu,
  saveMenu,
  signInStaff,
  signOut: () => signOut(auth),
  uploadMenuPhoto,
  updateOrder: (key, patch) => update(ref(database, `orders/${key}`), patch),
  claimKitchenPrint: async key => {
    const result = await runTransaction(ref(database, `orders/${key}`), order => {
      if (!order || order.kitchenPrinted) return;
      order.kitchenPrinted = true;
      return order;
    });
    return result.committed;
  },
  deleteOrder: key => remove(ref(database, `orders/${key}`)),
  startCustomer
};

emit('firebase-sync-ready', {});