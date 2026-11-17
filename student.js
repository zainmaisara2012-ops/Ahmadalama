// Student library: no content is displayed as unlocked before the server authorizes it.
const $ = id => document.getElementById(id);
const ui = {
  setup: $('setup-notice'), toolbar: $('library-toolbar'), grid: $('books-grid'), state: $('library-state'),
  stateKicker: $('state-kicker'), stateTitle: $('state-title'), stateDescription: $('state-description'),
  retryBooks: $('retry-books'), search: $('search-input'), category: $('category-filter'), count: $('results-count'),
  dialog: $('book-dialog'), close: $('close-dialog'), dialogTitle: $('dialog-title'), dialogDescription: $('dialog-description'),
  dialogCategory: $('dialog-category'), status: $('dialog-status'), existing: $('existing-access'), openExisting: $('open-existing'),
  anotherCode: $('use-another-code'), form: $('code-form'), code: $('activation-code'), codeError: $('code-error'),
  activate: $('activate-button'), retryAccess: $('retry-access'), fallback: $('open-fallback'),
  fallbackMessage: $('fallback-message'), fallbackLink: $('fallback-link'), downloadLink: $('download-link')
};

let shared = null;
let sdk = null;
let books = [];
let selectedBook = null;
let dialogRun = 0;
let pendingPopup = null;
let authPromise = null;
const objectUrls = new Set();

function setLibraryState(kicker, title, description, canRetry = false) {
  ui.stateKicker.textContent = kicker;
  ui.stateTitle.textContent = title;
  ui.stateDescription.textContent = description;
  ui.retryBooks.hidden = !canRetry;
  ui.state.hidden = false;
}

function configureWhatsApp(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  const valid = /^[1-9][0-9]{6,14}$/.test(digits);
  document.querySelectorAll('.whatsapp-link').forEach(link => {
    if (valid) {
      link.href = `https://wa.me/${digits}?text=${encodeURIComponent('مرحباً أستاذ أحمد، أود الاستفسار عن الكتب.')}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.classList.remove('is-disabled');
      link.removeAttribute('aria-disabled');
      link.removeAttribute('title');
    } else {
      link.removeAttribute('href');
      link.classList.add('is-disabled');
      link.setAttribute('aria-disabled', 'true');
    }
  });
  $('whatsapp-help').hidden = valid;
}

function withTimeout(promise, milliseconds = 20000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => {
      const error = new Error('Timed out');
      error.code = 'app/timeout';
      reject(error);
    }, milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

function readableError(error, permissionMessage = 'تعذّر التحقق من صلاحية الوصول. تأكّد من رمزك أو تواصل معنا للمساعدة.') {
  const code = String(error?.code || '');
  if (code.includes('permission-denied') || code.includes('unauthorized')) return permissionMessage;
  if (code === 'app/timeout' || code.includes('unavailable') || code.includes('network-request-failed')) return 'استغرقت العملية وقتًا أطول من المتوقع أو تعذّر الاتصال. تحقّق من الإنترنت ثم حاول مجددًا.';
  if (code.includes('operation-not-allowed') || code.includes('admin-restricted-operation')) return 'تسجيل دخول الطلاب غير مفعّل حاليًا. يرجى التواصل مع إدارة المكتبة.';
  if (code.startsWith('auth/')) return 'تعذّر تسجيل الدخول إلى المكتبة. تحقّق من الاتصال وحاول مجددًا.';
  if (code === 'app/missing-content') return 'محتوى هذا الكتاب غير متاح حاليًا. يرجى المحاولة لاحقًا أو التواصل معنا.';
  if (code === 'app/invalid-content') return 'تعذّر فتح محتوى هذا الكتاب. يرجى التواصل مع إدارة المكتبة.';
  return 'حدثت مشكلة أثناء فتح الكتاب. تحقّق من الاتصال وحاول مجددًا، أو تواصل معنا.';
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function timestampValue(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  return 0;
}

async function loadBooks() {
  if (!shared?.configured || !shared.db || !sdk) return;
  ui.toolbar.hidden = true;
  ui.grid.replaceChildren();
  setLibraryState('لحظة من فضلك', 'نُحضّر لك المكتبة', 'جارٍ التحقق من الكتب المتاحة...');
  try {
    const snapshot = await withTimeout(sdk.getDocs(sdk.collection(shared.db, 'books')));
    books = snapshot.docs.map(item => {
      const data = item.data();
      return {
        id: item.id,
        title: text(data.title, 'كتاب دون عنوان'),
        description: text(data.description),
        category: text(data.category, 'كتاب تعليمي'),
        color: text(data.color),
        createdAt: timestampValue(data.createdAt)
      };
    }).sort((a, b) => b.createdAt - a.createdAt);
    if (!books.length) {
      setLibraryState('صفحة جديدة', 'المكتبة تستعدّ لاستقبالك', 'لم تُضف كتب إلى المكتبة بعد. عد لزيارتنا قريبًا.');
      return;
    }
    const currentCategory = ui.category.value;
    ui.category.replaceChildren(new Option('كل التصنيفات', ''));
    [...new Set(books.map(book => book.category))].sort((a, b) => a.localeCompare(b, 'ar')).forEach(category => {
      ui.category.add(new Option(category, category));
    });
    if ([...ui.category.options].some(option => option.value === currentCategory)) ui.category.value = currentCategory;
    ui.toolbar.hidden = false;
    renderBooks();
  } catch (error) {
    console.error('Books could not be loaded:', error);
    setLibraryState('حدثت مشكلة بسيطة', 'تعذّر تحميل الكتب', 'تحقّق من اتصالك بالإنترنت وحاول مرة أخرى. إن استمرت المشكلة، تواصل مع إدارة المكتبة.', true);
  }
}

function coverColor(value) {
  const palette = { emerald: '#315b47', green: '#315b47', olive: '#6c7955', gold: '#ac8950', amber: '#ac8950', navy: '#344d5c', blue: '#43677a', ink: '#344a42', rose: '#986d68', burgundy: '#805350', purple: '#6e6178', brown: '#80664e', teal: '#3c6f69' };
  const color = value.toLowerCase();
  if (palette[color]) return palette[color];
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color)) return color;
  return '#426751';
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function makeCard(book, index) {
  const card = element('article', 'book-card');
  const cover = element('div', 'book-cover');
  cover.setAttribute('aria-hidden', 'true');
  const coverObject = element('div', 'cover-object');
  coverObject.style.setProperty('--book-color', coverColor(book.color));
  const coverTop = element('div', 'cover-top');
  coverTop.append(element('span', '', 'ENGLISH LIBRARY'), element('span', '', '✳'));
  coverObject.append(coverTop, element('div', 'cover-title', book.title), element('div', 'cover-bottom', `AHMAD AL-A’MA  /  ${String(index + 1).padStart(2, '0')}`));
  cover.append(coverObject);
  const meta = element('div', 'book-meta');
  meta.append(element('p', 'book-category', book.category), element('h3', 'book-title', book.title), element('p', 'book-description', book.description || 'اضغط لعرض تفاصيل الكتاب وفتحه.'));
  const button = element('button', 'book-open', 'افتح الكتاب');
  button.type = 'button';
  button.setAttribute('aria-label', `افتح كتاب ${book.title}`);
  const arrow = element('span', '', '←');
  arrow.setAttribute('aria-hidden', 'true');
  button.append(arrow);
  button.addEventListener('click', () => openBookDialog(book));
  meta.append(button);
  card.append(cover, meta);
  return card;
}

function renderBooks() {
  const query = ui.search.value.trim().toLocaleLowerCase('ar');
  const category = ui.category.value;
  const filtered = books.filter(book => (!category || book.category === category) && (!query || `${book.title} ${book.description} ${book.category}`.toLocaleLowerCase('ar').includes(query)));
  ui.count.textContent = `${filtered.length.toLocaleString('ar')} ${filtered.length === 1 ? 'كتاب' : 'كتب'}`;
  ui.grid.replaceChildren(...filtered.map(makeCard));
  if (!filtered.length) setLibraryState('جرّب بحثًا آخر', 'لم نجد كتبًا مطابقة', 'جرّب تعديل كلمة البحث أو اختيار تصنيف مختلف.');
  else ui.state.hidden = true;
}

async function ensureUser() {
  if (!shared?.configured || !shared.auth) {
    const error = new Error('Firebase is not configured'); error.code = 'app/not-configured'; throw error;
  }
  if (!authPromise) {
    authPromise = (async () => {
      // Wait for Firebase to restore a previous session before creating an anonymous one.
      const restored = await withTimeout(new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        unsubscribe = sdk.onAuthStateChanged(shared.auth, user => { unsubscribe(); resolve(user); }, error => { unsubscribe(); reject(error); });
      }));
      if (restored) return restored;
      const credential = await withTimeout(sdk.signInAnonymously(shared.auth));
      return credential.user;
    })().catch(error => { authPromise = null; throw error; });
  }
  const user = await authPromise;
  // Do not reuse a stale user if the session has subsequently changed.
  if (shared.auth.currentUser?.uid !== user.uid) { authPromise = null; return ensureUser(); }
  return user;
}

function isCurrent(run) { return ui.dialog.open && run === dialogRun; }
function setDialogStatus(message = '', isError = false) {
  ui.status.textContent = message;
  ui.status.classList.toggle('error', isError);
}
function setBusy(busy) {
  ui.activate.disabled = busy;
  ui.openExisting.disabled = busy;
  ui.retryAccess.disabled = busy;
  ui.anotherCode.disabled = busy;
  ui.code.disabled = busy;
  ui.dialog.setAttribute('aria-busy', String(busy));
}
function showCodeForm() {
  ui.existing.hidden = true;
  ui.form.hidden = false;
}
function appError(code) { const error = new Error(code); error.code = code; return error; }
function isPermissionError(error) { return /permission-denied|unauthorized/.test(String(error?.code || '')); }

async function readContent(bookId) {
  // Server-only reads avoid treating a stale offline cache as a current entitlement.
  const snapshot = await withTimeout(sdk.getDocFromServer(sdk.doc(shared.db, 'bookContent', bookId)));
  if (!snapshot.exists()) throw appError('app/missing-content');
  const data = snapshot.data();
  if (data.type === 'pdf' && typeof data.storagePath === 'string' && data.storagePath.trim()) return { type: 'pdf', storagePath: data.storagePath.trim() };
  if (data.type === 'link' && typeof data.url === 'string') {
    try {
      const url = new URL(data.url);
      if (url.protocol === 'https:' || url.protocol === 'http:') return { type: 'link', url: url.href };
    } catch { /* Invalid URL is reported below. */ }
  }
  throw appError('app/invalid-content');
}

async function checkExisting(run) {
  const bookId = selectedBook.id;
  ui.form.hidden = true;
  ui.existing.hidden = true;
  ui.retryAccess.hidden = true;
  ui.fallback.hidden = true;
  ui.codeError.textContent = '';
  setBusy(true);
  setDialogStatus('نتحقق من إمكانية وصولك إلى هذا الكتاب...');
  try {
    await ensureUser();
    if (!isCurrent(run)) return;
    await readContent(bookId);
    if (!isCurrent(run)) return;
    setDialogStatus('');
    ui.existing.hidden = false;
  } catch (error) {
    if (!isCurrent(run)) return;
    if (isPermissionError(error)) {
      setDialogStatus('أدخل رمز التفعيل الخاص بهذا الكتاب للمتابعة.');
      showCodeForm();
    } else {
      setDialogStatus(readableError(error), true);
      ui.retryAccess.hidden = false;
      // A code may still be entered when a transient pre-check fails.
      showCodeForm();
    }
  } finally {
    if (isCurrent(run)) setBusy(false);
  }
}

function openBookDialog(book) {
  selectedBook = book;
  const run = ++dialogRun;
  ui.dialogTitle.textContent = book.title;
  ui.dialogDescription.textContent = book.description || 'استخدم رمز التفعيل الخاص بك للوصول إلى هذا الكتاب.';
  ui.dialogCategory.textContent = book.category;
  ui.code.value = '';
  ui.codeError.textContent = '';
  ui.fallback.hidden = true;
  if (!ui.dialog.open) ui.dialog.showModal();
  checkExisting(run);
}

function openPendingWindow() {
  let popup = null;
  try {
    // This is called synchronously in the user's click/submit handler, before any await.
    popup = window.open('', '_blank');
    if (popup) {
      popup.document.title = 'جارٍ فتح الكتاب';
      popup.document.documentElement.lang = 'ar';
      popup.document.documentElement.dir = 'rtl';
      const message = popup.document.createElement('p');
      message.textContent = 'جارٍ التحقق وتجهيز كتابك... يمكنك العودة إلى المكتبة إذا لم تكتمل العملية.';
      message.style.cssText = 'font:16px/2 sans-serif;color:#173d30;padding:30px';
      popup.document.body.replaceChildren(message);
    }
  } catch { /* A fallback link is shown if the browser blocks the window. */ }
  pendingPopup = popup;
  return popup;
}
function closePendingWindow(popup) {
  try { if (popup && !popup.closed) popup.close(); } catch { /* Already closed or inaccessible. */ }
  if (pendingPopup === popup) pendingPopup = null;
}

async function deliverContent(content, popup, run) {
  let href;
  if (content.type === 'pdf') {
    if (!shared.storage) throw appError('app/invalid-content');
    const blob = await withTimeout(sdk.getBlob(sdk.ref(shared.storage, content.storagePath)), 45000);
    if (!isCurrent(run)) { closePendingWindow(popup); return false; }
    href = URL.createObjectURL(blob);
    objectUrls.add(href);
    // Give PDF viewers and the download link time to use the in-memory URL.
    window.setTimeout(() => { URL.revokeObjectURL(href); objectUrls.delete(href); }, 60 * 60 * 1000);
    ui.downloadLink.href = href;
    ui.downloadLink.hidden = false;
  } else {
    href = content.url;
    ui.downloadLink.hidden = true;
    ui.downloadLink.removeAttribute('href');
  }
  let opened = false;
  if (popup && !popup.closed) {
    try {
      popup.opener = null;
      popup.location.replace(href);
      opened = true;
    } catch { closePendingWindow(popup); }
  }
  if (pendingPopup === popup) pendingPopup = null;
  ui.fallbackLink.href = href;
  ui.fallbackMessage.textContent = opened ? 'فُتح المحتوى في نافذة جديدة. يمكنك فتحه مجددًا من الرابط أدناه.' : 'المحتوى جاهز. إذا حظر المتصفح النافذة، استخدم الرابط أدناه لفتحه.';
  ui.fallback.hidden = false;
  setDialogStatus('تم التحقق من إمكانية الوصول إلى الكتاب.');
  return true;
}

async function openAuthorizedBook(popup, run, code = null) {
  const bookId = selectedBook.id;
  setBusy(true);
  ui.retryAccess.hidden = true;
  ui.codeError.textContent = '';
  ui.fallback.hidden = true;
  setDialogStatus(code ? 'نتحقق من الرمز ونجهّز الكتاب...' : 'نتحقق من صلاحية الوصول ونجهّز الكتاب...');
  try {
    const user = await ensureUser();
    if (!isCurrent(run)) { closePendingWindow(popup); return; }
    if (code !== null) {
      await withTimeout(sdk.setDoc(sdk.doc(shared.db, 'access', user.uid, 'books', bookId), { code }));
    }
    if (!isCurrent(run)) { closePendingWindow(popup); return; }
    const content = await readContent(bookId);
    if (!isCurrent(run)) { closePendingWindow(popup); return; }
    const delivered = await deliverContent(content, popup, run);
    if (!delivered || !isCurrent(run)) return;
    ui.form.hidden = true;
    ui.existing.hidden = false;
  } catch (error) {
    closePendingWindow(popup);
    if (!isCurrent(run)) return;
    const permissionMessage = 'تعذّر فتح الكتاب. قد يكون رمز التفعيل غير صحيح أو موقوفًا؛ تحقّق منه أو تواصل معنا.';
    setDialogStatus(readableError(error, permissionMessage), true);
    if (isPermissionError(error)) showCodeForm();
    else ui.retryAccess.hidden = false;
  } finally {
    if (isCurrent(run)) setBusy(false);
  }
}

ui.search.addEventListener('input', renderBooks);
ui.category.addEventListener('change', renderBooks);
ui.retryBooks.addEventListener('click', () => { if (sdk && shared?.configured) loadBooks(); else window.location.reload(); });
ui.close.addEventListener('click', () => ui.dialog.close());
ui.dialog.addEventListener('close', () => { dialogRun++; if (pendingPopup) closePendingWindow(pendingPopup); selectedBook = null; });
ui.anotherCode.addEventListener('click', () => { ui.fallback.hidden = true; setDialogStatus(''); showCodeForm(); ui.code.focus(); });
ui.retryAccess.addEventListener('click', () => checkExisting(dialogRun));
ui.openExisting.addEventListener('click', () => {
  const popup = openPendingWindow();
  openAuthorizedBook(popup, dialogRun);
});
ui.form.addEventListener('submit', event => {
  event.preventDefault();
  const code = ui.code.value.trim().toUpperCase();
  ui.code.value = code;
  if (!/^[A-Z0-9-]{8,64}$/.test(code)) {
    ui.codeError.textContent = 'أدخل رمزًا من ٨ إلى ٦٤ حرفًا أو رقمًا إنجليزيًا، ويمكن استخدام الشرطة (-).';
    ui.code.focus();
    return;
  }
  const popup = openPendingWindow();
  openAuthorizedBook(popup, dialogRun, code);
});
window.addEventListener('pagehide', () => { objectUrls.forEach(url => URL.revokeObjectURL(url)); objectUrls.clear(); });

async function initialize() {
  try {
    const [firebase, authModule, firestoreModule, storageModule] = await Promise.all([
      import('./shared/firebase.js'),
      import('https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js'),
      import('https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js')
    ]);
    shared = firebase;
    sdk = { ...authModule, ...firestoreModule, ...storageModule };
    configureWhatsApp(shared.whatsappNumber);
    if (!shared.configured || !shared.db || !shared.auth) {
      ui.setup.hidden = false;
      setLibraryState('صفحة جديدة', 'المكتبة تستعدّ لاستقبالك', 'ستظهر الكتب هنا فور اكتمال إعداد المكتبة وإضافتها.');
      return;
    }
    await loadBooks();
  } catch (error) {
    console.error('Library initialization failed:', error);
    configureWhatsApp('');
    setLibraryState('حدثت مشكلة بسيطة', 'تعذّر تجهيز المكتبة', 'تعذّر الاتصال بخدمات المكتبة. تحقّق من اتصالك بالإنترنت وحاول مجددًا.', true);
  }
}
initialize();
