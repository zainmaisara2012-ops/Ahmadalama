import { auth, db, storage, configured, whatsappNumber } from '../shared/firebase.js';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { collection, doc, getDoc, getDocs, serverTimestamp, writeBatch, runTransaction, updateDoc, deleteDoc } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { ref, uploadBytes, deleteObject } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js';

// The UI is not an authorization boundary. Firebase rules must enforce admin access
// and protect bookContent, codes, and the corresponding Storage objects.
const $ = (id) => document.getElementById(id);
const state = {
  books: [], codes: [], booksLoaded: false, codesLoaded: false,
  admin: null, authVersion: 0, authReady: false, authChecking: false,
  loginBusy: false, bookBusy: false, codeBusy: false,
  editingBook: null, editingContent: null,
};
const SVG_NS = 'http://www.w3.org/2000/svg';
const codePattern = /^[A-Z0-9-]{8,64}$/;
const colorPattern = /^#[0-9a-f]{6}$/i;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
function showMessage(id, text, kind = '') {
  const box = $(id);
  box.textContent = text;
  box.className = `notice${id === 'app-message' ? ' app-notice' : ''}${kind ? ` notice-${kind}` : ''}`;
  box.hidden = !text;
}
function clearMessage(id) { showMessage(id, ''); }
function readableError(error) {
  const code = error?.code || '';
  const messages = {
    'auth/invalid-credential': 'البريد الإلكتروني أو كلمة المرور غير صحيحين.',
    'auth/invalid-email': 'صيغة البريد الإلكتروني غير صحيحة.',
    'auth/user-disabled': 'هذا الحساب معطّل.',
    'auth/too-many-requests': 'محاولات كثيرة. حاول مرة أخرى لاحقًا.',
    'auth/network-request-failed': 'تعذّر الاتصال. تحقّق من الإنترنت وحاول مجددًا.',
    'auth/operation-not-allowed': 'تسجيل الدخول بالبريد وكلمة المرور غير مفعّل في Firebase Authentication.',
    'permission-denied': 'رفضت قواعد Firebase هذه العملية. تحقّق من صلاحية المدير والقواعد المنشورة.',
    'unavailable': 'خدمة Firebase غير متاحة حاليًا أو الاتصال مقطوع.',
    'storage/unauthorized': 'تعذّر الوصول إلى التخزين. تحقّق من قواعد Storage وصلاحية المدير.',
    'storage/unauthenticated': 'انتهت جلسة المصادقة. سجّل الدخول مجددًا.',
    'storage/quota-exceeded': 'تجاوز التخزين الحصة المتاحة.',
    'storage/retry-limit-exceeded': 'تعذّر الاتصال بالتخزين. تحقّق من الشبكة وإعدادات Firebase Storage وخطة Blaze.',
    'storage/bucket-not-found': 'لم يُعثر على حاوية التخزين. أعد إعداد Firebase Storage وخطة Blaze.',
    'storage/no-default-bucket': 'حاوية التخزين غير مهيّأة. تحقّق من إعدادات Firebase وخطة Blaze.',
  };
  return messages[code] || `تعذّرت العملية. تحقّق من الاتصال وإعدادات Firebase ثم حاول مجددًا${code ? ` (${code})` : ''}.`;
}
function updateLoginButton() {
  $('login-submit').disabled = !configured || !state.authReady || state.authChecking || state.loginBusy;
  $('login-submit').firstChild.textContent = state.loginBusy || state.authChecking ? 'جارٍ التحقق… ' : 'تسجيل الدخول ';
}
function showLogin() {
  $('app-view').hidden = true;
  $('login-view').hidden = false;
}
function showApp(user) {
  $('admin-email').textContent = user.email || 'حساب المدير';
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  clearMessage('login-message');
}
function clearPrivateState() {
  state.admin = null;
  state.books = [];
  state.codes = [];
  state.booksLoaded = false;
  state.codesLoaded = false;
  state.editingBook = null;
  state.editingContent = null;
  for (const id of ['book-dialog', 'code-dialog']) if ($(id).open) $(id).close();
  $('book-form').reset();
  $('code-form').reset();
  $('recent-books').replaceChildren();
  $('books-list').replaceChildren();
  $('codes-list').replaceChildren();
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!configured || !auth || state.loginBusy || state.authChecking || !state.authReady) return;
  state.loginBusy = true;
  clearMessage('login-message');
  updateLoginButton();
  try {
    // A student session may be anonymous; do not link it to an admin account.
    if (auth.currentUser?.isAnonymous) await signOut(auth);
    await signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value);
    $('password').value = '';
  } catch (error) {
    showMessage('login-message', readableError(error), 'error');
  } finally {
    state.loginBusy = false;
    updateLoginButton();
  }
});

if (!configured || !auth || !db) {
  $('configuration-notice').hidden = false;
  $('email').disabled = true;
  $('password').disabled = true;
  state.authReady = true;
  updateLoginButton();
} else {
  onAuthStateChanged(auth, async (user) => {
    const version = ++state.authVersion;
    state.authReady = true;
    state.authChecking = !!user;
    showLogin();
    clearPrivateState();
    updateLoginButton();
    if (!user) {
      if ($('login-message').dataset.checking === 'true') clearMessage('login-message');
      $('login-message').dataset.checking = 'false';
      return;
    }
    if (user.isAnonymous) {
      try {
        await signOut(auth);
        if (version === state.authVersion) state.authChecking = false;
        showMessage('login-message', 'تم تسجيل الخروج من جلسة الطالب. يمكنك الآن تسجيل دخول المدير.');
      } catch (error) {
        if (version === state.authVersion) state.authChecking = false;
        showMessage('login-message', `تعذّر إنهاء جلسة الطالب. ${readableError(error)}`, 'error');
      }
      updateLoginButton();
      return;
    }
    $('login-message').dataset.checking = 'true';
    showMessage('login-message', 'جارٍ التحقق من صلاحية حساب الإدارة…');
    try {
      const adminSnapshot = await getDoc(doc(db, 'admins', user.uid));
      if (version !== state.authVersion || auth.currentUser?.uid !== user.uid) return;
      if (!adminSnapshot.exists()) {
        $('login-message').dataset.checking = 'false';
        await signOut(auth);
        showMessage('login-message', 'هذا الحساب لا يملك صلاحية الإدارة. أضف وثيقة admins بمعرّف المستخدم في Firestore.', 'error');
        return;
      }
      state.admin = user;
      state.authChecking = false;
      $('login-message').dataset.checking = 'false';
      showApp(user);
      selectView('overview');
      await refreshData();
    } catch (error) {
      if (version !== state.authVersion) return;
      // Failure to read the admin record never grants access.
      $('login-message').dataset.checking = 'false';
      try { await signOut(auth); } catch (_) { /* Keep the dashboard hidden even if sign-out fails. */ }
      showMessage('login-message', `تعذّر التحقق من صلاحية المدير، ولم تُفتح لوحة الإدارة. ${readableError(error)}`, 'error');
    } finally {
      if (version === state.authVersion) state.authChecking = false;
      updateLoginButton();
    }
  }, (error) => {
    ++state.authVersion;
    clearPrivateState();
    showLogin();
    state.authReady = true;
    state.authChecking = false;
    showMessage('login-message', `تعذّر التحقق من جلسة الدخول. ${readableError(error)}`, 'error');
    updateLoginButton();
  });
}

$('logout-button').addEventListener('click', async () => {
  try { await signOut(auth); } catch (error) { showMessage('app-message', `تعذّر تسجيل الخروج. ${readableError(error)}`, 'error'); }
});

const viewTitles = { overview: 'نظرة عامة', books: 'إدارة الكتب', codes: 'أكواد التفعيل' };
function selectView(view) {
  if (!Object.hasOwn(viewTitles, view)) return;
  for (const name of Object.keys(viewTitles)) $(`view-${name}`).hidden = name !== view;
  document.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('page-title').textContent = viewTitles[view];
  window.scrollTo({ top: 0, behavior: 'auto' });
}
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => selectView(button.dataset.view)));
document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => selectView(button.dataset.go)));

function millis(value) {
  try { return typeof value?.toMillis === 'function' ? value.toMillis() : 0; } catch (_) { return 0; }
}
function str(value, fallback = '') { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }
function titleOf(book) { return str(book?.title, 'كتاب بلا عنوان'); }
function categoryOf(book) { return str(book?.category, 'بدون تصنيف'); }
function safeColor(value) { return typeof value === 'string' && colorPattern.test(value) ? value : '#1d6857'; }
function bookThumb(book) {
  const thumb = node('span', 'book-thumb');
  thumb.style.backgroundColor = safeColor(book.color);
  thumb.append(icon('book'));
  return thumb;
}
function actionButton(label, iconName, handler, danger = false) {
  const button = node('button', `icon-button${danger ? ' danger' : ''}`);
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(icon(iconName));
  button.addEventListener('click', handler);
  return button;
}
function empty(message) { return node('p', 'empty-state', message); }
function renderData() {
  $('stat-books').textContent = state.booksLoaded ? String(state.books.length) : '—';
  $('stat-codes').textContent = state.codesLoaded ? String(state.codes.length) : '—';
  $('stat-active').textContent = state.codesLoaded ? String(state.codes.filter((code) => code.active === true).length) : '—';
  $('books-count').textContent = state.booksLoaded ? String(state.books.length) : '—';
  $('codes-count').textContent = state.codesLoaded ? String(state.codes.length) : '—';
  renderRecent(); renderBooks(); renderCodes();
}
function renderRecent() {
  const container = $('recent-books');
  container.replaceChildren();
  if (!state.booksLoaded) { container.append(node('p', 'empty-inline', 'تعذّر تحميل الكتب.')); return; }
  if (!state.books.length) { container.append(node('p', 'empty-inline', 'لم تضف كتبًا بعد. أضف أول كتاب لمكتبتك.')); return; }
  for (const book of state.books.slice(0, 3)) {
    const row = node('div', 'recent-row');
    const details = node('div');
    details.append(node('strong', '', titleOf(book)), node('small', '', categoryOf(book)));
    row.append(bookThumb(book), details);
    container.append(row);
  }
}
function renderBooks() {
  const container = $('books-list');
  container.replaceChildren();
  if (!state.booksLoaded) { container.append(empty('تعذّر تحميل الكتب. تحقّق من الاتصال ثم أعد تحميل الصفحة.')); return; }
  const search = $('book-search').value.trim().toLocaleLowerCase();
  const books = state.books.filter((book) => `${titleOf(book)} ${categoryOf(book)}`.toLocaleLowerCase().includes(search));
  if (!books.length) { container.append(empty(search ? 'لا توجد كتب تطابق البحث.' : 'لا توجد كتب بعد. ابدأ بإضافة كتابك الأول.')); return; }
  for (const book of books) {
    const row = node('article', 'book-row');
    const details = node('div', 'book-details');
    details.append(node('strong', '', titleOf(book)), node('small', '', `${categoryOf(book)}${str(book.description) ? ` · ${str(book.description)}` : ''}`));
    const actions = node('div', 'row-actions');
    actions.append(actionButton(`تعديل ${titleOf(book)}`, 'edit', () => openBook(book)), actionButton(`حذف ${titleOf(book)}`, 'trash', () => removeBook(book), true));
    row.append(bookThumb(book), details, actions);
    container.append(row);
  }
}
function renderCodes() {
  const container = $('codes-list');
  container.replaceChildren();
  if (!state.codesLoaded) { container.append(empty('تعذّر تحميل الأكواد. تحقّق من الاتصال ثم أعد تحميل الصفحة.')); return; }
  const search = $('code-search').value.trim().toLocaleLowerCase();
  const titles = new Map(state.books.map((book) => [book.id, titleOf(book)]));
  const bookLabel = (code) => titles.get(code.bookId) || (state.booksLoaded ? 'كتاب محذوف أو غير متاح' : 'تعذّر تحميل اسم الكتاب');
  const codes = state.codes.filter((code) => `${code.id} ${bookLabel(code)}`.toLocaleLowerCase().includes(search));
  if (!codes.length) { container.append(empty(search ? 'لا توجد أكواد تطابق البحث.' : 'لا توجد أكواد بعد. أنشئ كودًا للكتاب الذي تريد مشاركته.')); return; }
  for (const code of codes) {
    const row = node('article', 'code-row');
    const details = node('div', 'code-details');
    details.append(node('strong', 'code-value', code.id), node('small', '', bookLabel(code)));
    const active = code.active === true;
    const badge = node('span', `status-pill ${active ? 'active' : 'inactive'}`, active ? 'نشط' : 'غير نشط');
    const actions = node('div', 'row-actions');
    const toggle = node('button', 'mini-button', active ? 'تعطيل' : 'تفعيل');
    toggle.type = 'button';
    toggle.addEventListener('click', () => toggleCode(code, toggle));
    actions.append(actionButton(`نسخ الكود ${code.id}`, 'copy', () => copyCode(code.id)), toggle, actionButton(`حذف الكود ${code.id}`, 'trash', () => removeCode(code), true));
    row.append(details, badge, actions);
    container.append(row);
  }
}
$('book-search').addEventListener('input', renderBooks);
$('code-search').addEventListener('input', renderCodes);

async function refreshData() {
  if (!state.admin) return;
  const uid = state.admin.uid;
  const version = state.authVersion;
  const [booksResult, codesResult] = await Promise.allSettled([
    getDocs(collection(db, 'books')), getDocs(collection(db, 'codes')),
  ]);
  if (!state.admin || state.admin.uid !== uid || state.authVersion !== version) return;
  state.booksLoaded = booksResult.status === 'fulfilled';
  state.codesLoaded = codesResult.status === 'fulfilled';
  if (state.booksLoaded) state.books = booksResult.value.docs.map((item) => ({ ...item.data(), id: item.id })).sort((a, b) => millis(b.createdAt) - millis(a.createdAt));
  else state.books = [];
  if (state.codesLoaded) state.codes = codesResult.value.docs.map((item) => ({ ...item.data(), id: item.id })).sort((a, b) => millis(b.createdAt) - millis(a.createdAt));
  else state.codes = [];
  renderData();
  const errors = [];
  if (!state.booksLoaded) errors.push(`الكتب: ${readableError(booksResult.reason)}`);
  if (!state.codesLoaded) errors.push(`الأكواد: ${readableError(codesResult.reason)}`);
  if (errors.length) showMessage('app-message', `تعذّر تحديث بعض البيانات. ${errors.join(' ')}`, 'error');
  return errors.length ? `تعذّر تحديث عرض البيانات. ${errors.join(' ')}` : '';
}

function setFormBusy(kind, busy) {
  state[`${kind}Busy`] = busy;
  const form = $(`${kind}-form`);
  for (const control of form.querySelectorAll('button, input, textarea, select')) control.disabled = busy;
  if (kind === 'book') $('save-book').textContent = busy ? 'جارٍ الحفظ…' : 'حفظ الكتاب';
  else $('save-code').textContent = busy ? 'جارٍ الإنشاء…' : 'إنشاء الكود';
}
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => {
  const dialog = $(button.dataset.close);
  if ((dialog.id === 'book-dialog' && state.bookBusy) || (dialog.id === 'code-dialog' && state.codeBusy)) return;
  dialog.close();
});
for (const id of ['book-dialog', 'code-dialog']) $(id).addEventListener('cancel', (event) => {
  if ((id === 'book-dialog' && state.bookBusy) || (id === 'code-dialog' && state.codeBusy)) event.preventDefault();
});

function selectedType() { return document.querySelector('input[name="content-type"]:checked')?.value || 'link'; }
function updateContentFields() {
  const pdf = selectedType() === 'pdf';
  $('pdf-fields').hidden = !pdf;
  $('link-fields').hidden = pdf;
  $('book-url').required = !pdf;
}
document.querySelectorAll('input[name="content-type"]').forEach((input) => input.addEventListener('change', updateContentFields));
function canonicalPdf(id) { return `books/${id}/book.pdf`; }
function verifiedOldPdf(book, content) { return content?.type === 'pdf' && content.storagePath === canonicalPdf(book.id); }
async function openBook(book = null) {
  if (!state.admin) return;
  let content = null;
  if (book) {
    showMessage('app-message', 'جارٍ تحميل محتوى الكتاب…');
    try {
      const snap = await getDoc(doc(db, 'bookContent', book.id));
      if (!state.admin) return;
      content = snap.exists() ? snap.data() : null;
      clearMessage('app-message');
    } catch (error) {
      showMessage('app-message', `تعذّر تحميل محتوى الكتاب للتعديل. ${readableError(error)}`, 'error');
      return;
    }
  }
  state.editingBook = book;
  state.editingContent = content;
  $('book-form').reset();
  clearMessage('book-message');
  $('book-dialog-title').textContent = book ? 'تعديل الكتاب' : 'إضافة كتاب جديد';
  $('book-title').value = book ? str(book.title) : '';
  $('book-category').value = book ? str(book.category) : '';
  $('book-description').value = book ? str(book.description) : '';
  const color = book ? safeColor(book.color) : '#1d6857';
  if (![...$('book-color').options].some((option) => option.value === color)) {
    const option = node('option', '', 'اللون الحالي'); option.value = color; $('book-color').append(option);
  }
  $('book-color').value = color;
  const type = content?.type === 'pdf' ? 'pdf' : 'link';
  document.querySelector(`input[name="content-type"][value="${type}"]`).checked = true;
  $('book-url').value = content?.type === 'link' ? str(content.url) : '';
  $('pdf-hint').textContent = book && verifiedOldPdf(book, content) ? 'يوجد ملف PDF محفوظ. اترك الحقل فارغًا للاحتفاظ به، أو اختر ملفًا لاستبداله.' : 'اختر ملف PDF لإضافته إلى التخزين الخاص.';
  updateContentFields();
  if (book && content?.type === 'pdf' && !verifiedOldPdf(book, content)) showMessage('book-message', 'مسار ملف PDF الحالي غير متوقع؛ اختر ملفًا جديدًا أو استخدم رابطًا آمنًا.', 'warning');
  $('book-dialog').showModal();
}
document.querySelectorAll('[data-open-book]').forEach((button) => button.addEventListener('click', () => openBook()));
function httpsUrl(raw) {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : null;
  } catch (_) { return null; }
}
async function deletePdf(path) {
  try { await deleteObject(ref(storage, path)); return null; }
  catch (error) { return error?.code === 'storage/object-not-found' ? null : error; }
}
$('book-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.admin || state.bookBusy) return;
  clearMessage('book-message');
  const title = $('book-title').value.trim();
  const category = $('book-category').value.trim();
  const description = $('book-description').value.trim();
  const color = safeColor($('book-color').value);
  if (!title || !category) { showMessage('book-message', 'يرجى إدخال عنوان الكتاب وتصنيفه.', 'error'); return; }
  const book = state.editingBook;
  const oldContent = state.editingContent;
  const bookRef = book ? doc(db, 'books', book.id) : doc(collection(db, 'books'));
  const path = canonicalPdf(bookRef.id);
  const type = selectedType();
  const file = $('book-pdf').files[0];
  let content;
  if (type === 'link') {
    const url = httpsUrl($('book-url').value);
    if (!url) { showMessage('book-message', 'أدخل رابطًا صالحًا يبدأ بـ https:// دون بيانات دخول في الرابط.', 'error'); return; }
    content = { type: 'link', url };
  } else {
    if (!file && !(book && verifiedOldPdf(book, oldContent))) { showMessage('book-message', 'اختر ملف PDF لإضافة محتوى الكتاب.', 'error'); return; }
    if (file && !(file.type === 'application/pdf' || (!file.type && /\.pdf$/i.test(file.name)))) { showMessage('book-message', 'يُسمح بملفات PDF فقط.', 'error'); return; }
    if (file && file.size > 50 * 1024 * 1024) { showMessage('book-message', 'حجم ملف PDF يتجاوز الحد المسموح به: 50 ميغابايت.', 'error'); return; }
    if (file && !storage) { showMessage('book-message', 'التخزين غير مهيّأ. استخدم رابط HTTPS أو فعّل Firebase Storage وخطة Blaze.', 'error'); return; }
    content = { type: 'pdf', storagePath: path };
  }
  setFormBusy('book', true);
  let uploaded = false;
  let committed = false;
  try {
    if (type === 'pdf' && file) {
      await uploadBytes(ref(storage, path), file, { contentType: 'application/pdf' });
      uploaded = true;
    }
    const batch = writeBatch(db);
    const metadata = { title, description, category, color };
    if (book) batch.set(bookRef, metadata, { merge: true });
    else batch.set(bookRef, { ...metadata, createdAt: serverTimestamp() });
    batch.set(doc(db, 'bookContent', bookRef.id), content);
    await batch.commit();
    committed = true;
    let warning = '';
    if (book && type === 'link' && oldContent?.type === 'pdf') {
      if (verifiedOldPdf(book, oldContent)) {
        const deletionError = await deletePdf(path);
        if (deletionError) warning = `حُفظ الرابط، لكن تعذّر حذف ملف PDF السابق من التخزين؛ احذفه يدويًا عند الحاجة. ${readableError(deletionError)}`;
      } else warning = 'حُفظ الرابط، لكن مسار ملف PDF السابق غير متوقع؛ راجع التخزين واحذفه يدويًا عند الحاجة.';
    }
    $('book-dialog').close();
    const refreshWarning = await refreshData();
    showMessage('app-message', `${warning || (book ? 'تم حفظ تعديلات الكتاب بنجاح.' : 'تمت إضافة الكتاب بنجاح.')} ${refreshWarning || ''}`.trim(), warning || refreshWarning ? 'warning' : 'success');
  } catch (error) {
    let detail = '';
    if (uploaded && !committed) {
      if (book && verifiedOldPdf(book, oldContent)) {
        detail = ' رُفع الملف الجديد فوق الملف السابق، لكن لم تُحفظ بيانات الكتاب؛ راجع محتوى الكتاب قبل إعادة المحاولة.';
      } else {
        const cleanupError = await deletePdf(path);
        detail = cleanupError ? ` رُفع الملف لكن لم تُحفظ بيانات الكتاب وتعذّر تنظيف الملف؛ راجع التخزين واحذف ${path} يدويًا.` : ' رُفع الملف لكن تعذّر حفظ البيانات، وقد حُذف الملف المرفوع.';
      }
    }
    showMessage('book-message', `${readableError(error)}${detail}`, 'error');
  } finally { setFormBusy('book', false); }
});

async function removeBook(book) {
  if (!state.admin || !window.confirm(`هل تريد حذف «${titleOf(book)}» ومحتواه؟ ستبقى أكواد هذا الكتاب، ويمكنك حذفها أو تعطيلها يدويًا من صفحة الأكواد.`)) return;
  try {
    showMessage('app-message', 'جارٍ حذف الكتاب…');
    const contentSnap = await getDoc(doc(db, 'bookContent', book.id));
    const content = contentSnap.exists() ? contentSnap.data() : null;
    const batch = writeBatch(db);
    batch.delete(doc(db, 'books', book.id));
    batch.delete(doc(db, 'bookContent', book.id));
    await batch.commit();
    let warning = '';
    if (content?.type === 'pdf') {
      if (verifiedOldPdf(book, content)) {
        const deletionError = await deletePdf(content.storagePath);
        if (deletionError) warning = `حُذف الكتاب ومحتواه من قاعدة البيانات، لكن تعذّر حذف ملف PDF من التخزين. احذف ${content.storagePath} يدويًا. ${readableError(deletionError)}`;
      } else warning = 'حُذف الكتاب ومحتواه من قاعدة البيانات، لكن مسار ملف PDF غير متوقع؛ راجع التخزين واحذف الملف يدويًا.';
    }
    const refreshWarning = await refreshData();
    showMessage('app-message', `${warning || 'حُذف الكتاب ومحتواه.'} أكواد الكتاب لم تُحذف؛ أزلها أو عطّلها بشكل منفصل عند الحاجة. ${refreshWarning || ''}`.trim(), warning || refreshWarning ? 'warning' : 'success');
  } catch (error) { showMessage('app-message', `لم يكتمل حذف الكتاب. ${readableError(error)}`, 'error'); }
}

function randomCode() {
  if (!globalThis.crypto?.getRandomValues) throw new Error('secure-random-unavailable');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  // Reject values >= 252 to avoid modulo bias (252 is divisible by 36).
  while (result.length < 16) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < 252) result += alphabet[byte % alphabet.length];
      if (result.length === 16) break;
    }
  }
  return result;
}
function generateCode() {
  try { $('code-value').value = randomCode(); clearMessage('code-message'); }
  catch (_) { $('code-value').value = ''; showMessage('code-message', 'التوليد الآمن غير متاح في هذا المتصفح؛ أدخل كودًا يدويًا أو استخدم متصفحًا حديثًا.', 'error'); }
}
function openCode() {
  if (!state.admin) return;
  if (!state.booksLoaded) { showMessage('app-message', 'لا يمكن إنشاء كود قبل تحميل قائمة الكتب بنجاح.', 'error'); return; }
  if (!state.books.length) { selectView('books'); showMessage('app-message', 'أضف كتابًا أولًا لتتمكن من إنشاء كود مرتبط به.', 'warning'); return; }
  $('code-form').reset();
  clearMessage('code-message');
  const select = $('code-book');
  select.replaceChildren();
  const placeholder = node('option', '', 'اختر كتابًا'); placeholder.value = ''; select.append(placeholder);
  for (const book of state.books) { const option = node('option', '', titleOf(book)); option.value = book.id; select.append(option); }
  generateCode();
  $('code-dialog').showModal();
}
document.querySelectorAll('[data-open-code]').forEach((button) => button.addEventListener('click', openCode));
$('generate-code').addEventListener('click', generateCode);
$('code-value').addEventListener('input', () => { $('code-value').value = $('code-value').value.toUpperCase(); });
$('code-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.admin || state.codeBusy) return;
  clearMessage('code-message');
  const code = $('code-value').value.trim().toUpperCase();
  const bookId = $('code-book').value;
  if (!codePattern.test(code)) { showMessage('code-message', 'الكود يجب أن يتكوّن من 8 إلى 64 حرفًا إنجليزيًا كبيرًا أو رقمًا أو شرطة فقط.', 'error'); return; }
  if (!state.books.some((book) => book.id === bookId)) { showMessage('code-message', 'اختر كتابًا من القائمة.', 'error'); return; }
  setFormBusy('code', true);
  try {
    const codeRef = doc(db, 'codes', code);
    // A transaction prevents two simultaneous creators from overwriting the same code.
    await runTransaction(db, async (transaction) => {
      const [existing, bookSnap] = await Promise.all([transaction.get(codeRef), transaction.get(doc(db, 'books', bookId))]);
      if (existing.exists()) throw new Error('code-already-exists');
      if (!bookSnap.exists()) throw new Error('book-no-longer-exists');
      transaction.set(codeRef, { bookId, active: true, createdAt: serverTimestamp() });
    });
    $('code-dialog').close();
    const refreshWarning = await refreshData();
    selectView('codes');
    showMessage('app-message', `تم إنشاء الكود ${code}. يمكن استخدامه أكثر من مرة للكتاب المحدد. ${refreshWarning || ''}`.trim(), refreshWarning ? 'warning' : 'success');
  } catch (error) {
    const message = error?.message === 'code-already-exists' ? 'هذا الكود موجود بالفعل. ولّد كودًا آخر أو أدخل كودًا مختلفًا.' : error?.message === 'book-no-longer-exists' ? 'هذا الكتاب لم يعد موجودًا. أعد تحميل الصفحة واختر كتابًا آخر.' : readableError(error);
    showMessage('code-message', message, 'error');
  } finally { setFormBusy('code', false); }
});
async function toggleCode(code, button) {
  if (!state.admin) return;
  button.disabled = true;
  try {
    await updateDoc(doc(db, 'codes', code.id), { active: code.active !== true });
    const refreshWarning = await refreshData();
    showMessage('app-message', `${code.active === true ? 'تم تعطيل الكود.' : 'تم تفعيل الكود.'} ${refreshWarning || ''}`.trim(), refreshWarning ? 'warning' : 'success');
  } catch (error) { showMessage('app-message', `تعذّر تغيير حالة الكود. ${readableError(error)}`, 'error'); button.disabled = false; }
}
async function removeCode(code) {
  if (!state.admin || !window.confirm(`هل تريد حذف الكود ${code.id} نهائيًا؟ لن يتمكن الطلاب من استخدامه بعد حذفه.`)) return;
  try {
    await deleteDoc(doc(db, 'codes', code.id));
    const refreshWarning = await refreshData();
    showMessage('app-message', `تم حذف الكود. ${refreshWarning || ''}`.trim(), refreshWarning ? 'warning' : 'success');
  } catch (error) { showMessage('app-message', `تعذّر حذف الكود. ${readableError(error)}`, 'error'); }
}
async function copyCode(code) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable');
    await navigator.clipboard.writeText(code);
    showMessage('app-message', 'تم نسخ الكود. يمكنك مشاركته مع طلاب الكتاب.', 'success');
  } catch (_) { showMessage('app-message', `تعذّر النسخ التلقائي. يمكنك تحديد الكود ونسخه يدويًا: ${code}`, 'warning'); }
}

// Shared configuration also exports the teacher's public WhatsApp number; it is
// intentionally not used for administrative authentication or authorization.
void whatsappNumber;
