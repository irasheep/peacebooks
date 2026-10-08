const tg = window.Telegram?.WebApp;

const screens = {
    home: document.getElementById("home-screen"),
    catalog: document.getElementById("catalog-screen"),
    book: document.getElementById("book-screen"),
    return: document.getElementById("return-screen"),
};

const greetingElement = document.getElementById("greeting");
const usernameElement = document.getElementById("username");
const avatarElement = document.getElementById("avatar");

const catalogButton = document.getElementById("catalog-button");
const returnButton = document.getElementById("return-button");
const borrowButton = document.getElementById("borrow-button");

const catalogGrid = document.getElementById("catalog-grid");
const catalogMessage = document.getElementById("catalog-message");

const bookCover = document.getElementById("book-cover");
const bookStatus = document.getElementById("book-status");
const bookTitle = document.getElementById("book-title");
const bookAuthor = document.getElementById("book-author");
const bookAnnotation = document.getElementById("book-annotation");
const unavailableNote = document.getElementById("unavailable-note");

const returnBookTitle = document.getElementById("return-book-title");
const returnPhotoContent = document.getElementById("return-photo-content");
const returnStateMessage = document.getElementById("return-state-message");
const returnPhotoInput = document.getElementById("return-photo-input");
const returnPreview = document.getElementById("return-preview");
const returnPreviewImage = document.getElementById("return-preview-image");
const submitReturnButton = document.getElementById("submit-return-button");

let books = [];
let catalogLoaded = false;
let currentScreen = "home";
let selectedBookId = null;
let returnPhotoData = null;

function getInitial(name) {
    if (!name) return "К";
    return name.trim().charAt(0).toUpperCase();
}

function tapFeedback() {
    tg?.HapticFeedback?.impactOccurred("light");
}

function escapeHtml(value = "") {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function setScreen(name) {
    Object.entries(screens).forEach(([screenName, element]) => {
        element.classList.toggle("is-active", screenName === name);
    });

    currentScreen = name;
    window.scrollTo({ top: 0, behavior: "auto" });

    if (tg?.BackButton) {
        if (name === "home") {
            tg.BackButton.hide();
        } else {
            tg.BackButton.show();
        }
    }
}

function handleTelegramBack() {
    if (currentScreen === "book") {
        showCatalog();
        return;
    }

    if (currentScreen === "catalog" || currentScreen === "return") {
        setScreen("home");
    }
}

function bookStatusClass(status) {
    return status === "На полке" ? "is-available" : "is-unavailable";
}

function renderCatalog() {
    catalogGrid.innerHTML = books
        .map((book) => {
            const title = escapeHtml(book.title || "Без названия");
            const author = escapeHtml(book.author || "Автор не указан");
            const status = escapeHtml(book.status || "Статус не указан");
            const cover = escapeHtml(book.cover || "");
            const coverMarkup = cover
                ? `<img class="catalog-cover" src="${cover}" alt="Обложка книги «${title}»" loading="lazy">`
                : `<div class="catalog-cover cover-placeholder">Нет обложки</div>`;

            return `
                <button class="book-card" type="button" data-book-id="${escapeHtml(book.id)}">
                    <div class="catalog-cover-wrap">
                        ${coverMarkup}
                    </div>
                    <div class="book-card-copy">
                        <h3>${title}</h3>
                        <p>${author}</p>
                        <span class="status-badge ${bookStatusClass(book.status)}">${status}</span>
                    </div>
                </button>
            `;
        })
        .join("");

    catalogMessage.hidden = books.length > 0;

    if (!books.length) {
        catalogMessage.textContent = "Пока в каталоге нет книг.";
    }

    catalogGrid.querySelectorAll(".book-card").forEach((card) => {
        card.addEventListener("click", () => {
            tapFeedback();
            showBook(card.dataset.bookId);
        });
    });
}

async function loadCatalog() {
    if (catalogLoaded) return;

    catalogMessage.hidden = false;
    catalogMessage.textContent = "Загружаю книги…";

    try {
        const response = await fetch("/api/books");

        if (!response.ok) {
            throw new Error(`Catalog request failed: ${response.status}`);
        }

        const data = await response.json();
        books = Array.isArray(data.books) ? data.books : [];
        catalogLoaded = true;
        renderCatalog();
    } catch (error) {
        console.error(error);
        catalogMessage.hidden = false;
        catalogMessage.textContent = "Не удалось загрузить каталог. Попробуй обновить приложение.";
    }
}

async function showCatalog() {
    setScreen("catalog");
    await loadCatalog();
}

function showBook(bookId) {
    const book = books.find((item) => item.id === bookId);
    if (!book) return;

    selectedBookId = book.id;

    bookTitle.textContent = book.title || "Без названия";
    bookAuthor.textContent = book.author || "Автор не указан";
    bookAnnotation.textContent = book.annotation || "Аннотация пока не добавлена.";
    bookStatus.textContent = book.status || "Статус не указан";
    bookStatus.className = `status-badge ${bookStatusClass(book.status)}`;

    if (book.cover) {
        bookCover.src = book.cover;
        bookCover.alt = `Обложка книги «${book.title || ""}»`;
        bookCover.parentElement.classList.remove("is-placeholder");
    } else {
        bookCover.removeAttribute("src");
        bookCover.alt = "";
        bookCover.parentElement.classList.add("is-placeholder");
    }

    const available = book.status === "На полке";
    borrowButton.hidden = !available;
    unavailableNote.hidden = available;

    setScreen("book");
}

if (tg) {
    tg.ready();
    tg.expand();

    const user = tg.initDataUnsafe?.user;

    if (user) {
        const firstName = user.first_name || "читатель";

        greetingElement.textContent = `Привет, ${firstName}!`;
        avatarElement.textContent = getInitial(firstName);

        if (user.username) {
            usernameElement.textContent = `@${user.username}`;
        } else {
            usernameElement.textContent = "Рада видеть тебя в библиотеке.";
        }
    }

    tg.BackButton?.onClick(handleTelegramBack);
}

catalogButton.addEventListener("click", () => {
    tapFeedback();
    showCatalog();
});

function showMessage(message) {
    if (tg?.showAlert) {
        tg.showAlert(message);
    } else {
        alert(message);
    }
}

function formatDueDate(isoDate) {
    return new Intl.DateTimeFormat("ru-RU", {
        day: "numeric",
        month: "long",
        year: "numeric",
    }).format(new Date(isoDate));
}

async function borrowBook(qrText) {
    const book = books.find((item) => item.id === selectedBookId);

    if (!book) {
        showMessage("Не удалось найти выбранную книгу.");
        return;
    }

    if (!tg?.initData) {
        showMessage("Выдача работает только внутри Telegram.");
        return;
    }

    try {
        const response = await fetch("/api/borrow", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                initData: tg.initData,
                qrText,
                bookId: selectedBookId,
            }),
        });

        const data = await response.json();

        if (!response.ok) {
            if (data.code === "WRONG_QR") {
                showMessage("Это не QR «Книг Мира» в кофейне МИР.");
                return;
            }

            if (data.code === "ACTIVE_LOAN") {
                showMessage("У тебя уже есть активная книга. Сначала верни её.");
                return;
            }

            if (data.code === "BOOK_UNAVAILABLE") {
                showMessage("Эту книгу уже взяли. Обнови каталог и выбери другую.");
                catalogLoaded = false;
                return;
            }

            if (data.code === "AUTH_FAILED") {
                showMessage("Не удалось подтвердить Telegram-профиль. Закрой и заново открой Mini App.");
                return;
            }

            if (data.code === "CONFIG_ERROR") {
                showMessage("Выдача книг ещё не до конца настроена на сервере.");
                return;
            }

            if (data.code === "NOTION_ERROR") {
                const stageNames = {
                    check_active_loan: "проверка Loans",
                    get_book: "чтение книги",
                    ensure_user: "создание пользователя",
                    set_book_status: "смена статуса книги",
                    create_loan: "создание займа",
                };
                const stage = stageNames[data.stage] || data.stage || "Notion";
                const status = data.notionStatus ? ` · Notion ${data.notionStatus}` : "";
                showMessage(`Не удалось оформить выдачу. Шаг: ${stage}${status}.`);
                return;
            }

            throw new Error(data.error || `Borrow failed: ${response.status}`);
        }

        tg?.HapticFeedback?.notificationOccurred("success");

        book.status = "На руках";
        catalogLoaded = false;
        showBook(book.id);

        showMessage(
            `Готово! «${book.title}» теперь у тебя до ${formatDueDate(data.dueAt)}.`
        );
    } catch (error) {
        console.error(error);
        tg?.HapticFeedback?.notificationOccurred("error");
        showMessage("Не удалось оформить выдачу. Попробуй ещё раз.");
    }
}

function startBorrowQrGate() {
    tapFeedback();

    if (!tg?.showScanQrPopup) {
        showMessage("Сканирование QR доступно внутри актуальной версии Telegram.");
        return;
    }

    tg.showScanQrPopup(
        { text: "Отсканируй QR «Книг Мира» на стене кофейни" },
        (qrText) => {
            borrowBook(qrText);
            return true;
        }
    );
}

function resetReturnScreen() {
    returnPhotoData = null;
    returnBookTitle.textContent = "Проверяю твою текущую книгу…";
    returnPhotoContent.hidden = true;
    returnStateMessage.hidden = false;
    returnStateMessage.textContent = "Загружаю данные…";
    returnPhotoInput.value = "";
    returnPreview.hidden = true;
    returnPreviewImage.removeAttribute("src");
    submitReturnButton.hidden = true;
    submitReturnButton.disabled = false;
    submitReturnButton.innerHTML = 'Отправить возврат <span aria-hidden="true">→</span>';
}

async function showReturnScreen() {
    tapFeedback();
    resetReturnScreen();
    setScreen("return");

    if (!tg?.initData) {
        returnStateMessage.textContent = "Возврат работает только внутри Telegram.";
        return;
    }

    try {
        const response = await fetch("/api/my-loan", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ initData: tg.initData }),
        });

        const data = await response.json();

        if (!response.ok) {
            if (data.code === "AUTH_FAILED") {
                returnStateMessage.textContent =
                    "Не удалось подтвердить Telegram-профиль. Закрой и заново открой Mini App.";
                return;
            }

            throw new Error(data.error || `Current loan failed: ${response.status}`);
        }

        if (!data.loan) {
            returnBookTitle.textContent = "Сейчас у тебя нет активной книги.";
            returnStateMessage.textContent =
                "Когда возьмёшь книгу, здесь можно будет отправить её возврат.";
            return;
        }

        returnBookTitle.textContent = `Возвращаешь «${data.loan.bookTitle}»`;

        if (data.loan.status === "return_pending") {
            returnStateMessage.textContent =
                "Возврат уже отправлен на проверку. До подтверждения книга остаётся у тебя в системе.";
            return;
        }

        returnPhotoContent.hidden = false;
        returnStateMessage.hidden = true;
    } catch (error) {
        console.error(error);
        returnStateMessage.textContent =
            "Не удалось загрузить данные о книге. Попробуй ещё раз.";
    }
}

function loadImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();

        image.onload = () => {
            URL.revokeObjectURL(url);
            resolve(image);
        };

        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("Не удалось открыть изображение"));
        };

        image.src = url;
    });
}

function canvasToBlob(canvas, quality) {
    return new Promise((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", quality);
    });
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

async function prepareReturnPhoto(file) {
    if (!file?.type?.startsWith("image/")) {
        throw new Error("Выбери фотографию.");
    }

    const image = await loadImage(file);
    const maxDimension = 1600;
    const originalWidth = image.naturalWidth || image.width;
    const originalHeight = image.naturalHeight || image.height;
    const scale = Math.min(1, maxDimension / Math.max(originalWidth, originalHeight));

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(originalWidth * scale));
    canvas.height = Math.max(1, Math.round(originalHeight * scale));

    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    let blob = null;

    for (const quality of [0.82, 0.7, 0.58]) {
        blob = await canvasToBlob(canvas, quality);
        if (blob && blob.size <= 1.8 * 1024 * 1024) break;
    }

    if (!blob) {
        throw new Error("Не удалось подготовить фотографию.");
    }

    if (blob.size > 2.5 * 1024 * 1024) {
        throw new Error("Фото получилось слишком большим. Попробуй сделать снимок ещё раз.");
    }

    return blobToDataUrl(blob);
}

returnPhotoInput.addEventListener("change", async () => {
    const file = returnPhotoInput.files?.[0];
    if (!file) return;

    submitReturnButton.hidden = true;

    try {
        returnPhotoData = await prepareReturnPhoto(file);
        returnPreviewImage.src = returnPhotoData;
        returnPreview.hidden = false;
        submitReturnButton.hidden = false;
        tg?.HapticFeedback?.notificationOccurred("success");
    } catch (error) {
        console.error(error);
        returnPhotoData = null;
        returnPreview.hidden = true;
        returnPhotoInput.value = "";
        showMessage(error.message || "Не удалось подготовить фото.");
    }
});

async function submitReturnRequest() {
    if (!returnPhotoData) {
        showMessage("Сначала сделай фото книги на полке.");
        return;
    }

    if (!tg?.initData) {
        showMessage("Возврат работает только внутри Telegram.");
        return;
    }

    submitReturnButton.disabled = true;
    submitReturnButton.textContent = "Отправляю фото…";

    try {
        const response = await fetch("/api/return-request", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                initData: tg.initData,
                photoData: returnPhotoData,
            }),
        });

        const data = await response.json();

        if (!response.ok) {
            if (data.code === "NO_ACTIVE_LOAN") {
                showMessage("У тебя нет активной книги для возврата.");
                return;
            }

            if (data.code === "ALREADY_PENDING") {
                showMessage("Этот возврат уже отправлен на проверку.");
                return;
            }

            if (data.code === "BAD_PHOTO") {
                showMessage("Не удалось обработать фото. Попробуй сделать его ещё раз.");
                return;
            }

            if (data.code === "AUTH_FAILED") {
                showMessage("Не удалось подтвердить Telegram-профиль. Закрой и заново открой Mini App.");
                return;
            }

            if (data.code === "NOTION_ERROR") {
                const stageNames = {
                    find_loan: "проверка текущей книги",
                    upload_photo: "загрузка фото",
                    mark_pending: "сохранение возврата",
                };
                const stage = stageNames[data.stage] || data.stage || "Notion";
                const status = data.notionStatus ? ` · Notion ${data.notionStatus}` : "";
                showMessage(`Не удалось отправить возврат. Шаг: ${stage}${status}.`);
                return;
            }

            throw new Error(data.error || `Return request failed: ${response.status}`);
        }

        tg?.HapticFeedback?.notificationOccurred("success");

        returnPhotoData = null;
        returnPhotoContent.hidden = true;
        returnStateMessage.hidden = false;
        returnStateMessage.textContent =
            "Возврат отправлен на проверку. Пока библиотекарь его не подтвердит, книга остаётся «На руках» и новую взять нельзя.";

        showMessage("Фото отправлено. Возврат ждёт подтверждения библиотекаря.");
    } catch (error) {
        console.error(error);
        tg?.HapticFeedback?.notificationOccurred("error");
        showMessage("Не удалось отправить возврат. Попробуй ещё раз.");
    } finally {
        submitReturnButton.disabled = false;
        submitReturnButton.innerHTML = 'Отправить возврат <span aria-hidden="true">→</span>';
    }
}

borrowButton.addEventListener("click", startBorrowQrGate);
returnButton.addEventListener("click", showReturnScreen);
submitReturnButton.addEventListener("click", submitReturnRequest);
